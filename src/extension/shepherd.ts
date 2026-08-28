/**
 * Shepherd tool — the model-facing `shepherd` tool for the parent pi session.
 *
 * One tool surface:
 *   - spawn/prompt/wait/status/read/close/prune — manage pi agents living in
 *     Herdr panes (machinery in herdr.ts).
 *
 * Registered by index.ts in the parent session only. Launched agents get the
 * in-tab completion extension from shepherd-done.ts instead.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AgentToolResult } from '@earendil-works/pi-agent-core';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { StringEnum } from '@earendil-works/pi-ai';
import { Text } from '@earendil-works/pi-tui';
import { Type, type Static } from 'typebox';
import {
  AgentScopeSchema,
  SpawnParams,
  LifecyclePromptParams,
  WaitParams,
  LifecycleStatusParams,
  LifecycleCloseParams,
} from '../core/types.ts';
import { startAgent, promptAgent, waitPrompts, statusAgent, closeAgent } from '../core/lifecycle.ts';
import { fieldnotesEnabled, loadSettings } from './config.ts';
import { lifecycleRegistry } from '../core/orchestration.ts';
import { formatShepherdCommand, omitMaterializedDefaults } from './cli.ts';
import { resolveOrCreateParentArtifactSession, type ShepherdSession } from '../core/artifact-sessions.ts';
import type { DelegatorModel } from '../core/discovery.ts';
import { discoverAgents, formatAgentList } from '../core/discovery.ts';
import {
  HERDR_SETUP_HINT,
  agentSummaries,
  createHerdrTab,
  formatSummary,
  getHerdrWorkspaceId,
  herdrExec,
  herdrExecSync,
  isHerdrAvailable,
  launchPiInPane,
  loadCreatedPanes,
  paneExists,
  paneIdOf,
  pruneStaleCreatedPanes,
  readPaneTail,
  recordCreatedPane,
  removeCreatedPaneDir,
  setCreatedPaneDir,
  waitForHerdrAgentDetected,
  waitForHerdrShellReady,
} from '../core/herdr.ts';

const execFileAsync = promisify(execFile);
export const SourceSchema = StringEnum(
  ['visible', 'recent', 'recent-unwrapped', 'detection'] as const,
  {
    description: 'Terminal snapshot source for read',
    default: 'recent-unwrapped',
  }
);

const HerdParams = Type.Object({
  action: Type.Literal('herd', {
    description: 'List the live herd: agents detected in Herdr panes.',
  }),
});
const AgentsParams = Type.Object({
  action: Type.Literal('agents', {
    description: 'List all available agents (also called sheep) and their source metadata.',
  }),
  agentScope: Type.Optional(AgentScopeSchema),
});
const ReadParams = Type.Object({
  action: Type.Literal('read', {
    description: 'Read recent terminal output from an agent or pane.',
  }),
  name: Type.String({
    description: 'Agent name, Herdr pane id, or opaque agent id of the target.',
  }),
  lines: Type.Optional(
    Type.Integer({ description: 'Number of recent lines for read (default 40)', default: 40 })
  ),
  source: Type.Optional(SourceSchema),
});
const PruneParams = Type.Object({
  action: Type.Literal('prune', { description: 'Remove stale pi-shepherd pane registrations.' }),
});

/** Parameters for the umbrella control-plane tool. Lifecycle operations have
 * separate flat schemas and registered tools below. */
const AnyShepherdUnion = Type.Union(
  [
    HerdParams,
    AgentsParams,
    SpawnParams,
    LifecyclePromptParams,
    WaitParams,
    LifecycleStatusParams,
    LifecycleCloseParams,
    ReadParams,
    PruneParams,
  ],
  {
    description:
      'Action-discriminated shepherd commands for managing specialized agents (also called sheep), their fieldnotes (artifacts), and their Herdr panes.',
  }
);
export type ShepherdArgs = Static<typeof AnyShepherdUnion>;

function prepareForSchema<T>(input: unknown): T {
  return prepareShepherdArguments(input) as unknown as T;
}

/**
 * Some model/provider tool-call transports encode nested JSON values as
 * strings. Pi validates arguments after this hook, so normalize only known
 * transport-serialization details here. The public lifecycle protocol uses
 * opaque id strings; the legacy `handle` form is accepted here temporarily so
 * existing callers fail soft while migrating.
 */
export function prepareShepherdArguments(input: unknown): ShepherdArgs {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input as ShepherdArgs;
  const args = { ...(input as Record<string, unknown>) };
  // Compatibility for transcripts produced before lifecycle calls switched to
  // scalar ids. Convert `{ handle: { id: ... } }` (or its JSON encoding) into
  // the current `{ id: ... }` form before schema validation.
  if (!('id' in args) && 'handle' in args) {
    let legacy: unknown = args.handle;
    if (typeof legacy === 'string') {
      try {
        legacy = JSON.parse(legacy);
      } catch {
        // A plain string is already a usable legacy id.
      }
    }
    if (Array.isArray(legacy)) {
      args.id = legacy.map(item =>
        item && typeof item === 'object' && typeof (item as any).id === 'string'
          ? (item as any).id
          : item
      );
    } else if (legacy && typeof legacy === 'object' && typeof (legacy as any).id === 'string') {
      args.id = (legacy as any).id;
    } else {
      args.id = legacy;
    }
    delete args.handle;
  }
  // These values are deliberately not part of the spawn protocol. Settings
  // and the discovered agent definition own them; silently discard legacy
  // callers' copies so they cannot override those sources before validation.
  for (const name of ['agentScope', 'confirmProjectAgents', 'omitSystemPrompt', 'direction']) {
    delete args[name];
  }
  if (typeof args.id === 'string' && args.id.trim().startsWith('[')) {
    try {
      const parsed = JSON.parse(args.id);
      if (Array.isArray(parsed)) args.id = parsed;
    } catch {
      // Leave malformed values untouched for normal schema validation.
    }
  }
  for (const name of ['timeout', 'lines']) {
    const value = args[name];
    if (typeof value === 'string' && /^[-+]?\d+$/.test(value.trim())) {
      args[name] = Number(value.trim());
    }
  }
  return args as ShepherdArgs;
}

function unavailableResult(
  action?: string,
  args?: ShepherdArgs
): AgentToolResult<Record<string, unknown>> {
  return {
    content: [
      { type: 'text', text: `Herd requires a running Herdr session.\n${HERDR_SETUP_HINT}` },
    ],
    details: {
      ...(action && args ? { call: publicToolCall(action, args) } : {}),
      code: 'herdr_unavailable',
      returnCode: 1,
      returnValue: { code: 'herdr_unavailable', error: 'herdr not available', returnCode: 1 },
      error: 'herdr not available',
    },
  };
}

function textResult(
  text: string,
  details: Record<string, unknown>
): AgentToolResult<Record<string, unknown>> {
  return {
    content: [{ type: 'text' as const, text }],
    // Every completed Shepherd operation exposes its return value and a
    // process-style return code. Individual operations can override these for
    // a structured/failed/partial result.
    details: { returnValue: text, returnCode: 0, ...details },
  };
}

/** Keep the opaque lifecycle id easy to copy from model-visible tool text. */
export function formatIdForModel(id: string): string {
  return id;
}

/** Keep the exact public tool invocation visible alongside its result. */
function publicToolCall(
  action: string,
  args: ShepherdArgs,
  defaultCwd = process.cwd()
): Record<string, unknown> {
  const { action: _action, artifactSession: _artifactSession, ...parameters } = args as any;
  const name = ['herd', 'agents', 'prune'].includes(action) ? 'shepherd' : `shepherd_${action}`;
  return { name, arguments: omitMaterializedDefaults(action, parameters, defaultCwd) };
}

function displayAgentName(agentId: string): string {
  try {
    const handle = lifecycleRegistry.getAgent({ id: agentId }).handle;
    return handle.label ? `${handle.agent}: ${handle.label}` : handle.agent;
  } catch {
    return agentId;
  }
}

function formatUserFacingText(result: any): string | undefined {
  const body = result?.content?.[0]?.type === 'text' ? (result.content[0].text ?? '') : undefined;
  const details = result?.details && typeof result.details === 'object' ? result.details : {};
  const call = details.call;
  if (!call?.name) return body;
  // executeShepherd embeds the structured text for non-TUI/API callers. Do
  // not append a second call/return/details block when the renderer sees it.
  if (typeof body === 'string' && body.includes('\ncall:\n')) return body;

  const returnValue = details.returnValue ?? details.result;
  const visibleDetails = Object.entries(details)
    .filter(([key]) => !['call', 'agent', 'label', 'model', 'status', 'artifactSession', 'returnValue', 'result'].includes(key))
    .sort(([left], [right]) => Number(left === 'returnCode') - Number(right === 'returnCode'))
    .map(([key, value]) => {
      let displayKey = key.replace(/[A-Z]/g, letter => ` ${letter.toLowerCase()}`);
      if (key === 'id' && call.name === 'shepherd_spawn') displayKey = 'agent id';
      if (key === 'fieldnote' && call.name === 'shepherd_spawn') displayKey = 'agent fieldnote';
      const displayValue = value === null && key === 'fieldnote'
        ? 'none'
        : typeof value === 'string' ? value : JSON.stringify(value);
      return `   ${displayKey}: ${displayValue ?? 'null'}`;
    });
  const callText = `${call.name} ${JSON.stringify(call.arguments ?? {})}`;
  const renderedReturn = formatReturnValue(returnValue);
  return [
    body ?? '(no output)',
    '',
    'call:',
    `    ${callText}`,
    '',
    'return:',
    `    ${renderedReturn}`,
    ...(visibleDetails.length ? ['', 'details:', ...visibleDetails] : []),
  ].join('\n');
}

function formatReturnValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    const items = value.map(item => JSON.stringify(item));
    return `[${items.join(',\n     ')}]`;
  }
  return JSON.stringify(value ?? null);
}

function withUserFacingContent(result: AgentToolResult<Record<string, unknown>>): AgentToolResult<Record<string, unknown>> {
  const text = formatUserFacingText(result);
  return text === undefined ? result : { ...result, content: [{ type: 'text', text }] };
}

function reusableText(lastComponent: unknown): Text {
  return lastComponent instanceof Text ? lastComponent : new Text('', 0, 0);
}

type ShepherdContext = {
  cwd: string;
  model?: DelegatorModel;
  hasUI?: boolean;
  ui?: any;
  sessionManager?: { getSessionId(): string; getSessionFile?(): string | undefined };
};

function parentArtifactSession(ctx: ShepherdContext): ShepherdSession | undefined {
  // The setting is snapshotted when the parent pi session starts. This means
  // disabling fieldnotes does not change the contract of agents already
  // running in this session; start a new pi session to stop using them.
  if (!fieldnotesEnabled()) return undefined;
  const parentPiSessionId = ctx.sessionManager?.getSessionId();
  if (!parentPiSessionId) throw new Error('Unable to resolve the parent pi session identity.');
  return resolveOrCreateParentArtifactSession({
    parentPiSessionId,
    parentSessionFile: ctx.sessionManager?.getSessionFile?.(),
    projectRoot: ctx.cwd,
  });
}

export async function doAction(
  args: ShepherdArgs,
  ctx: ShepherdContext,
  signal?: AbortSignal,
  onUpdate?: (partial: AgentToolResult<Record<string, unknown>>) => void
): Promise<AgentToolResult<Record<string, unknown>>> {
  switch (args.action) {
    case 'spawn': {
      const a: any = args;
      // Explicit artifactSession wins (the command adapter pre-resolves it
      // tolerantly); otherwise resolve/require the parent artifact session.
      const artifactSession =
        'artifactSession' in a ? a.artifactSession : parentArtifactSession(ctx);
      // Startup readiness has its own fixed internal grace periods; timeout
      // settings apply only to submitted prompts and their waits.
      const handle = await startAgent(
        a.agent,
        {
          label: a.label,
          placement: a.placement,
          cwd: a.cwd,
          model: a.model,
          artifactSession,
        },
        ctx
      );
      return textResult(
        `spawned ${handle.label ? `${handle.agent}: ${handle.label}` : handle.agent}`,
        {
          id: handle.id,
          agent: handle.agent,
          label: handle.label,
          model: handle.model ?? null,
          returnValue: {
            id: handle.id,
            agent: handle.agent,
            label: handle.label,
            model: handle.model ?? null,
          },
          fieldnote: artifactSession?.sessionRelativePath ?? null,
          ...(artifactSession ? { artifactSession } : {}),
        }
      );
    }
    case 'prompt': {
      const a: any = args;
      // Convert timeout from minutes to milliseconds for internal use.
      // Default: from settings (20 minutes).
      const defaultTimeout = loadSettings(ctx.cwd).timeout;
      const timeoutMinutes = a.timeout ?? defaultTimeout;
      const timeoutMs = timeoutMinutes * 60_000;
      const handle = await promptAgent(a.id ?? a.handle, a.message, { timeout: timeoutMs });
      const agent = lifecycleRegistry.getAgent(handle.agentId).handle;
      const artifact = lifecycleRegistry.promptArtifact(handle);
      return textResult(
        `Prompted ${agent.agent}${agent.label ? `: ${agent.label}` : ''}`,
        {
          id: handle.id,
          returnValue: {
            id: handle.id,
            ...(artifact.artifact ? { artifact: artifact.artifact } : {}),
          },
          ...(artifact.artifact ? { artifact: artifact.artifact } : {}),
          ...(artifact.session ? { artifactSession: artifact.session } : {}),
        }
      );
    }
    case 'wait': {
      const a: any = args;
      // Convert timeout from minutes to milliseconds for internal use.
      // Default: from settings (20 minutes).
      const defaultTimeout = loadSettings(ctx.cwd).timeout;
      const timeoutMinutes = a.timeout ?? defaultTimeout;
      const timeoutMs = timeoutMinutes * 60_000;
      const result = await waitPrompts(a.id ?? a.handle, { timeout: timeoutMs });
      const results = Array.isArray(result) ? result : [result];
      const returnCode = results.find(r => typeof r.returnCode === 'number' && r.returnCode !== 0)?.returnCode ?? 0;
      const names = results.map(item => displayAgentName(item.agentId));
      const summary = `waited for ${names.join(', ')}`;
      return textResult(summary, { returnCode, result, returnValue: result });
    }
    case 'status': {
      const a: any = args;
      const result = statusAgent(a.id ?? a.handle);
      const publicResult = {
        id: result.handle.id,
        state: result.state,
        ...(result.error ? { error: result.error } : {}),
      };
      return textResult(`agent ${publicResult.state}.`, { status: publicResult, returnValue: publicResult });
    }
    case 'close': {
      const a: any = args;
      const handle = closeAgent(a.id ?? a.handle);
      return textResult(`closed ${handle.label ? `${handle.agent}: ${handle.label}` : handle.agent}`, {
        id: handle.id,
        returnValue: { id: handle.id },
      });
    }
    case 'agents': {
      // List available agent definitions for the shepherd's herd.
      const scope = args.agentScope ?? loadSettings(ctx.cwd).agentScope;
      const { agents, projectDirs } = discoverAgents(ctx.cwd, scope, {
        includeBundled: loadSettings(ctx.cwd).includeBundledAgents,
      });
      if (agents.length === 0)
        return textResult(
          `No agent definitions found in ${scope} scope. Do not guess an agent name; add a definition or choose another scope.`,
          { agents: [], projectDirs, scope }
        );
      const lines = agents.map(a => `${a.name} (${a.source}): ${a.description}`);
      return textResult(
        `Available agent names (copy the name exactly; names are case-sensitive):\n${lines.join('\n')}`,
        { agents, projectDirs, scope }
      );
    }

    case 'herd': {
      // Silently drop registrations for panes that no longer exist so a
      // long-lived session doesn't accumulate stale entries.
      pruneStaleCreatedPanes();
      const out = herdrExecSync(['agent', 'list']);
      const agents = agentSummaries(out);
      if (agents.length === 0) return textResult('No agents detected in Herdr.', { agents });
      return textResult(agents.map(formatSummary).join('\n'), { agents });
    }

    case 'read': {
      const target = args.name?.trim();
      if (!target) return textResult('Provide a name/pane target (action=read).', {});
      const lines = args.lines ?? 40;
      const source = args.source ?? 'recent-unwrapped';
      // Resolve a shepherd pane by its recorded paneId or label (same as
      // prompt/close) so `read scout` works after a lifecycle start.
      const created = loadCreatedPanes();
      const match = created.find(p => p.paneId === target || p.name === target);
      let resolved = match?.paneId ?? target;
      // Diagnostics are often invoked from the lifecycle result, where the
      // caller has the opaque agent id rather than the Herdr pane id.
      // Resolve that id only through our in-memory registry; never guess a
      // pane from an arbitrary id.
      if (!match) {
        try {
          resolved = lifecycleRegistry.getAgent({ id: target }).handle.paneId ?? target;
        } catch {
          // Keep the original target so Herdr returns the useful not-found
          // error for unknown names/panes.
        }
      }
      try {
        const { stdout } = await execFileAsync(
          'herdr',
          [
            'agent',
            'read',
            resolved,
            '--source',
            source,
            '--lines',
            String(lines),
            '--format',
            'text',
          ],
          { encoding: 'utf8' }
        );
        return textResult(stdout.trim() || '(no terminal output)', { target, lines, source });
      } catch {
        // Agent detection is dropped once the pane's pi exited — fall back
        // to a plain terminal read so finished runs stay inspectable.
        try {
          const { stdout } = await execFileAsync(
            'herdr',
            [
              'pane',
              'read',
              resolved,
              '--source',
              source,
              '--lines',
              String(lines),
              '--format',
              'text',
            ],
            { encoding: 'utf8' }
          );
          return textResult(stdout.trim() || '(no terminal output)', {
            target,
            lines,
            source,
            fallback: true,
          });
        } catch (error: any) {
          return {
            content: [
              {
                type: 'text',
                text: `Could not read "${target}": ${error?.message ?? String(error)}`,
              },
            ],
            details: { target, error: String(error?.message ?? error) },
          };
        }
      }
    }

    case 'prune': {
      const pruned = pruneStaleCreatedPanes();
      const remaining = loadCreatedPanes().length;
      return textResult(
        pruned === 0
          ? `No stale pi-shepherd panes found (${remaining} registered).`
          : `Removed ${pruned} stale pane registration(s); ${remaining} remain.`,
        { pruned, remaining }
      );
    }

    default:
      return textResult(`Unknown shepherd action: ${String((args as any).action)}`, {});
  }
}

/**
 * Shared execution path for every registered shepherd tool: gate on a running
 * Herdr, delegate to doAction() (the single source of truth), and map thrown
 * errors to a friendly text result. `label` is the action verb used in errors.
 */
async function executeShepherd(
  label: string,
  args: ShepherdArgs,
  ctx: any,
  signal?: AbortSignal,
  onUpdate?: (partial: AgentToolResult<Record<string, unknown>>) => void
): Promise<AgentToolResult<Record<string, unknown>>> {
  if (!isHerdrAvailable()) {
    return withUserFacingContent(unavailableResult(label, args));
  }
  try {
    const result = await doAction(args, ctx, signal, onUpdate);
    const details = result.details && typeof result.details === 'object' ? result.details : {};
    return withUserFacingContent({
      ...result,
      details: { call: publicToolCall(label, args, ctx.cwd), ...(details as Record<string, unknown>) },
    });
  } catch (error: any) {
    const message = String(error?.message ?? error);
    const returnCode = typeof error?.returnCode === 'number' ? error.returnCode : 1;
    const code = typeof error?.code === 'string' ? error.code : 'shepherd_error';
    return withUserFacingContent({
      content: [{ type: 'text', text: `Herd ${label} failed (return code ${returnCode}): ${message}` }],
      details: {
        call: publicToolCall(label, args, ctx.cwd),
        action: label,
        code,
        returnCode,
        returnValue: { code, error: message, returnCode },
        error: message,
      },
    });
  }
}

export function registerShepherdTools(pi: ExtensionAPI) {
  pi.registerTool({
    name: 'shepherd',
    label: 'Shepherd (manage Herdr agents)',
    description: [
      'Shepherd control plane: subagent framework for native Herdr agent orchestration inside Herdr panes.',
      'Terminology: the Shepherd is this parent pi session and acts as the orchestrator; the herd is the collection of agents; agents or subagents are the created workers.',
      'When enabled, fieldnotes are the durable session notes commonly called artifacts: one shared fieldnotes collection (the shepherd.md index) links the individual note assigned to each agent invocation.',
      'This tool only lists: herd (live agents in Herdr), agents (discoverable definitions), prune (drop stale registrations). Lifecycle operations are separate tools: shepherd_spawn creates an idle agent, shepherd_prompt submits work, shepherd_wait collects results, shepherd_status inspects, shepherd_close ends it, shepherd_read reads terminal output. Bundled agent names are scout, planner, worker, and reviewer; call agents before guessing a name.',
      'Lifecycle references are opaque session-scoped ids. Tool results print the id in their text and expose it as details.id; pass it as the top-level id argument, never as a Herdr pane id.',
      'Requires a running Herdr session (HERDR_ENV=1 or headless server).',
    ].join(' '),
    promptSnippet:
      'Shepherd (orchestrator): manage specialized agents (also called sheep) and, when enabled, their fieldnotes (durable artifacts) inside Herdr panes.',
    promptGuidelines: [
      'Use the Shepherd tool family as one lifecycle: discover an agent definition with shepherd/agents, create it with shepherd_spawn, submit work with shepherd_prompt, collect results with shepherd_wait, inspect with shepherd_status or shepherd_read, and explicitly finish with shepherd_close.',
      'After spawn, copy the printed agent id into the top-level id argument of shepherd_prompt, shepherd_status, or shepherd_close. After prompt, copy the printed prompt id into shepherd_wait. For parallel wait, pass an array of prompt ids. Do not use a Herdr pane id; lifecycle ids are session-scoped.',
      'When fieldnotes are enabled, read the shared shepherd.md fieldnotes index before assigning or reviewing work, and write only to the assigned note for note-producing prompts.',
      'Fieldnotes can be enabled or disabled in /shepherd settings; the change applies when the next parent pi session starts.',
      'For sequential work, wait for one result before including its text in the next prompt. For independent work, spawn and prompt multiple agents, then call shepherd_wait once with an array of prompt ids.',
      'Waiting does not close an agent. Close each agent explicitly when it is no longer needed; shepherd_close also cancels its unresolved prompt.',
    ],
    parameters: Type.Object(
      {
        action: StringEnum(['herd', 'agents', 'prune'] as const, {
          description:
            'herd: list live agents detected in Herdr panes. agents: list available agent definitions and source metadata. prune: drop stale pane registrations.',
        }),
        agentScope: Type.Optional(AgentScopeSchema),
      },
      {
        description:
          'Shepherd control plane: subagent framework for native Herdr agent orchestration. List the live herd, discover agent definitions, or prune stale panes.',
      }
    ),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      return executeShepherd(String(params.action), params as ShepherdArgs, ctx, signal, onUpdate);
    },

    renderCall(args, theme, context) {
      const render = formatShepherdCommand(
        String(args.action ?? 'unknown'),
        args as Record<string, any>,
        context.expanded
      );
      const component = reusableText(context.lastComponent);
      component.setText(
        theme.fg('toolTitle', theme.bold('shepherd ')) +
          theme.fg('accent', render.verb) +
          (render.rest ? theme.fg('dim', ` ${render.rest}`) : '')
      );
      return component;
    },

    renderResult: (result, options, theme, context) =>
      renderUserFacingResult(result, options, theme, context),
  });

  pi.registerTool({
    name: 'shepherd_spawn',
    label: 'Shepherd: spawn agent',
    description:
      'Spawn an idle, persistent agent in a Herdr pane (no task submitted). Provide a short task-specific label (for example label: "code review"). Use shepherd({ action: "agents" }) first if you do not know an exact agent name. ' +
      'The result prints an opaque agent id; pass it as the top-level id argument to shepherd_prompt, shepherd_status, or shepherd_close. Defaults to the configured working directory, inherited parent model, and a new tab. Use placement pane_right or pane_down to split the current pane.',
    promptSnippet:
      'Shepherd lifecycle: spawn/prompt/wait/status/close/read pi agents (sheep) in Herdr panes.',
    parameters: Type.Object({
      agent: Type.String({
        description:
          'Exact discovered agent name (case-sensitive). If unsure, call shepherd with action "agents" first.',
      }),
      label: Type.String({ description: 'Short task-specific label (max 64 characters).' }),
      placement: Type.Optional(
        StringEnum(['pane_right', 'pane_down', 'tab', 'workspace'] as const, {
          description:
            'Optional placement: pane_right or pane_down splits the current pane, tab creates a new tab, and workspace creates a new workspace. If omitted, uses a background tab.',
        })
      ),
      cwd: Type.Optional(Type.String({ description: 'Working directory for the child; defaults to the parent cwd.' })),
      model: Type.Optional(Type.String({ description: 'Provider-qualified child model; defaults to the parent model.' })),
    }),
    prepareArguments: input => prepareForSchema<Omit<Static<typeof SpawnParams>, 'action'>>(input),
    execute: (_id, params, signal, onUpdate, ctx) =>
      executeShepherd(
        'spawn',
        { action: 'spawn', ...params } as ShepherdArgs,
        ctx,
        signal,
        onUpdate
      ),
    renderCall(args, theme, context) {
      const render = formatShepherdCommand('spawn', args, context.expanded);
      const component = reusableText(context.lastComponent);
      component.setText(
        theme.fg('toolTitle', theme.bold('shepherd_spawn ')) +
          (render.rest ? theme.fg('dim', render.rest) : '')
      );
      return component;
    },
    renderResult: (result, options, theme, context) =>
      renderSpawnResult(result, options, theme, context),
  });

  pi.registerTool({
    name: 'shepherd_prompt',
    label: 'Shepherd: prompt agent',
    description:
      'Submit one message to a spawned agent and return immediately. Pass the agent id printed by shepherd_spawn as the top-level id argument, not a Herdr pane id. The result prints a prompt id; pass that id to shepherd_wait.',
    promptSnippet:
      'Shepherd lifecycle: spawn/prompt/wait/status/close/read pi agents (sheep) in Herdr panes.',
    parameters: Type.Object({
      id: Type.String({
        description: 'Opaque agent id returned by shepherd_spawn. Do not use a Herdr pane id.',
      }),
      message: Type.String({
        description:
          'Task or question to submit to the spawned agent. Submission returns immediately; use shepherd_wait for the result.',
      }),
      timeout: Type.Optional(
        Type.Integer({
          default: 20,
          description:
            'Optional readiness wait before submission; normally omit. It is capped at 15 seconds internally. The completion timeout belongs to shepherd_wait.',
        })
      ),
    }),
    prepareArguments: input =>
      prepareForSchema<Omit<Static<typeof LifecyclePromptParams>, 'action'>>(input),
    execute: (_id, params, signal, onUpdate, ctx) =>
      executeShepherd(
        'prompt',
        { action: 'prompt', ...params } as ShepherdArgs,
        ctx,
        signal,
        onUpdate
      ),
    renderCall(args, theme, context) {
      const render = formatShepherdCommand('prompt', args, context.expanded);
      const component = reusableText(context.lastComponent);
      component.setText(
        theme.fg('toolTitle', theme.bold('shepherd_prompt ')) +
          (render.rest ? theme.fg('dim', render.rest) : '')
      );
      return component;
    },
    renderResult: (result, options, theme, context) =>
      renderUserFacingResult(result, options, theme, context),
  });

  pi.registerTool({
    name: 'shepherd_wait',
    label: 'Shepherd: wait for prompt',
    description:
      'Wait for one or more prompts to settle. Pass the prompt id printed by shepherd_prompt, or an array of prompt ids for parallel work. Results stay in array input order; waiting does not close agents.',
    promptSnippet:
      'Shepherd lifecycle: spawn/prompt/wait/status/close/read pi agents (sheep) in Herdr panes.',
    parameters: Type.Object({
      id: Type.Union(
        [
          Type.String({
            description:
              'Opaque prompt id returned by shepherd_prompt. Do not use an agent id or pane id.',
          }),
          Type.Array(
            Type.String({
              description:
                'Opaque prompt id returned by shepherd_prompt. Do not use an agent id or pane id.',
            }),
            {
              minItems: 1,
              description: 'Array of opaque prompt ids for parallel waiting.',
            }
          ),
        ],
        {
          description:
            'One opaque prompt id returned by shepherd_prompt, or an array of prompt ids for parallel work. Do not pass an agent id or pane id.',
        }
      ),
      timeout: Type.Optional(
        Type.Integer({
          default: 20,
          description:
            'Maximum time to wait for completion, in minutes (default: 20). Suggested: 1, 2, 5, 10, 20, 30, 60.',
        })
      ),
    }),
    prepareArguments: input => prepareForSchema<Omit<Static<typeof WaitParams>, 'action'>>(input),
    execute: (_id, params, signal, onUpdate, ctx) =>
      executeShepherd('wait', { action: 'wait', ...params } as ShepherdArgs, ctx, signal, onUpdate),
    renderCall(args, theme, context) {
      const render = formatShepherdCommand('wait', args, context.expanded);
      const component = reusableText(context.lastComponent);
      component.setText(
        theme.fg('toolTitle', theme.bold('shepherd_wait ')) +
          (render.rest ? theme.fg('dim', render.rest) : '')
      );
      return component;
    },
    renderResult: (result, options, theme, context) =>
      renderUserFacingResult(result, options, theme, context),
  });

  pi.registerTool({
    name: 'shepherd_status',
    label: 'Shepherd: status of agent',
    description:
      "Inspect an agent's current state without focusing or mutating its Herdr pane. Pass the agent id printed by shepherd_spawn; do not pass a prompt id or Herdr pane id.",
    promptSnippet:
      'Shepherd lifecycle: spawn/prompt/wait/status/close/read pi agents (sheep) in Herdr panes.',
    parameters: Type.Object({
      id: Type.String({
        description: 'Opaque agent id returned by shepherd_spawn. Do not use a Herdr pane id.',
      }),
    }),
    prepareArguments: input =>
      prepareForSchema<Omit<Static<typeof LifecycleStatusParams>, 'action'>>(input),
    execute: (_id, params, signal, onUpdate, ctx) =>
      executeShepherd(
        'status',
        { action: 'status', ...params } as ShepherdArgs,
        ctx,
        signal,
        onUpdate
      ),
    renderCall(args, theme, context) {
      const render = formatShepherdCommand('status', args, context.expanded);
      const component = reusableText(context.lastComponent);
      component.setText(
        theme.fg('toolTitle', theme.bold('shepherd_status ')) +
          (render.rest ? theme.fg('dim', render.rest) : '')
      );
      return component;
    },
    renderResult: (result, options, theme, context) =>
      renderUserFacingResult(result, options, theme, context),
  });

  pi.registerTool({
    name: 'shepherd_close',
    label: 'Shepherd: close agent',
    description:
      'Close an owned agent and cancel any unresolved prompt. Pass the agent id printed by shepherd_spawn, not a Herdr pane id. Waiting does not close agents, so close each agent when finished.',
    promptSnippet:
      'Shepherd lifecycle: spawn/prompt/wait/status/close/read pi agents (sheep) in Herdr panes.',
    parameters: Type.Object({
      id: Type.String({
        description: 'Opaque agent id returned by shepherd_spawn. Do not use a Herdr pane id.',
      }),
    }),
    prepareArguments: input =>
      prepareForSchema<Omit<Static<typeof LifecycleCloseParams>, 'action'>>(input),
    execute: (_id, params, signal, onUpdate, ctx) =>
      executeShepherd(
        'close',
        { action: 'close', ...params } as ShepherdArgs,
        ctx,
        signal,
        onUpdate
      ),
    renderCall(args, theme, context) {
      const render = formatShepherdCommand('close', args, context.expanded);
      const component = reusableText(context.lastComponent);
      component.setText(
        theme.fg('toolTitle', theme.bold('shepherd_close ')) +
          (render.rest ? theme.fg('dim', render.rest) : '')
      );
      return component;
    },
    renderResult: (result, options, theme, context) =>
      renderUserFacingResult(result, options, theme, context),
  });

  pi.registerTool({
    name: 'shepherd_read',
    label: 'Shepherd: read terminal output',
    description:
      'Read recent terminal output for diagnostics. Pass an agent name, Herdr pane id, or an agent id; unlike lifecycle tools, this diagnostic tool intentionally accepts several target forms.',
    promptSnippet:
      'Shepherd lifecycle: spawn/prompt/wait/status/close/read pi agents (sheep) in Herdr panes.',
    parameters: Type.Object({
      name: Type.String({
        description: 'Agent name, Herdr pane id, or opaque agent id of the target.',
      }),
      lines: Type.Optional(
        Type.Integer({ description: 'Number of recent lines for read (default 40)', default: 40 })
      ),
      source: Type.Optional(SourceSchema),
    }),
    prepareArguments: input => prepareForSchema<Omit<Static<typeof ReadParams>, 'action'>>(input),
    execute: (_id, params, signal, onUpdate, ctx) =>
      executeShepherd('read', { action: 'read', ...params } as ShepherdArgs, ctx, signal, onUpdate),
    renderCall(args, theme, context) {
      const render = formatShepherdCommand('read', args, context.expanded);
      const component = reusableText(context.lastComponent);
      component.setText(
        theme.fg('toolTitle', theme.bold('shepherd_read ')) +
          (render.rest ? theme.fg('dim', render.rest) : '')
      );
      return component;
    },
    renderResult: (result, options, theme, context) =>
      renderUserFacingResult(result, options, theme, context),
  });
}

function renderSpawnResult(result: any, options: { expanded?: boolean }, theme: any, context: any) {
  return renderUserFacingResult(result, options, theme, context);
}

/** Render every Shepherd result with the same user-facing structure. */
function renderUserFacingResult(result: any, options: { expanded?: boolean }, theme: any, context: any) {
  const rendered = formatUserFacingText(result);
  if (rendered === undefined) return renderToolResult(result, options, theme, context);
  const component = reusableText(context.lastComponent);
  component.setText(theme.fg('toolOutput', rendered));
  return component;
}

function renderToolResult(result: any, options: { expanded?: boolean }, theme: any, context: any) {
  const text = result.content[0];
  const body = text?.type === 'text' ? (text.text ?? '') : '';
  const expanded = options?.expanded ?? false;
  let rendered: string;
  if (!expanded && body.includes('\n')) {
    const firstLine = body.split('\n')[0];
    rendered =
      theme.fg('accent', firstLine) +
      `\n${theme.fg('muted', `… +${body.split('\n').length - 1} more lines (Ctrl+O to expand)`)}`;
  } else {
    rendered = theme.fg('toolOutput', body || '(no output)');
  }
  const component = reusableText(context.lastComponent);
  component.setText(rendered);
  return component;
}
