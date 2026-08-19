/**
 * Shepherd tool — the model-facing `shepherd` tool for the parent pi session.
 *
 * One tool surface:
 *   - start/prompt/wait/status/read/close/gc — manage pi agents living in
 *     Herdr panes (machinery in herdr.ts).
 *
 * Registered by index.ts in the parent session only. Delegated children get
 * the separate in-tab `shepherd_done` tool from shepherd-done.ts instead.
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
  StartParams,
  LifecyclePromptParams,
  WaitParams,
  LifecycleStatusParams,
  LifecycleCloseParams,
} from './types.ts';
import { startAgent, promptAgent, waitPrompts, statusAgent, closeAgent } from './lifecycle.ts';
import { loadSettings } from './settings.ts';
import { lifecycleRegistry } from './orchestration.ts';
import { resolveOrCreateParentArtifactSession, type ShepherdSession } from './artifact-sessions.ts';
import type { DelegatorModel } from './discovery.ts';
import { discoverAgents, formatAgentList } from './discovery.ts';
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
} from './herdr.ts';

const execFileAsync = promisify(execFile);
const SourceSchema = StringEnum(['visible', 'recent', 'recent-unwrapped', 'detection'] as const, {
  description: 'Terminal snapshot source for read',
  default: 'recent-unwrapped',
});

const ListParams = Type.Object({
  action: Type.Literal('list', { description: 'List Herdr panes and detected agents.' }),
});
const AgentsParams = Type.Object({
  action: Type.Literal('agents', {
    description: 'List available discovered agent definitions and their source metadata.',
  }),
  agentScope: Type.Optional(AgentScopeSchema),
});
const ReadParams = Type.Object({
  action: Type.Literal('read', {
    description: 'Read recent terminal output from a pane or agent.',
  }),
  name: Type.String({ description: 'Agent name, Herdr pane id, or AgentHandle id of the target.' }),
  lines: Type.Optional(
    Type.Integer({ description: 'Number of recent lines for read (default 40)', default: 40 })
  ),
  source: Type.Optional(SourceSchema),
});
const GcParams = Type.Object({
  action: Type.Literal('gc', { description: 'Prune stale pi-shepherd pane registrations.' }),
});

export const ShepherdParams = Type.Union(
  [
    ListParams,
    AgentsParams,
    StartParams,
    LifecyclePromptParams,
    WaitParams,
    LifecycleStatusParams,
    LifecycleCloseParams,
    ReadParams,
    GcParams,
  ],
  {
    description:
      'Action-discriminated shepherd commands for delegating work and managing Herdr panes.',
  }
);

type ShepherdArgs = Static<typeof ShepherdParams>;

/**
 * Some model/provider tool-call transports encode nested JSON objects as a
 * string. Pi validates arguments after this hook, so normalize only known
 * transport-serialization artifacts here while keeping the public schema
 * strict and object-only for handles. Native handles and primitive values
 * remain the canonical form.
 */
export function prepareShepherdArguments(input: unknown): ShepherdArgs {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input as ShepherdArgs;
  const args = { ...(input as Record<string, unknown>) };
  const handle = args.handle;
  if (typeof handle === 'string') {
    try {
      const parsed: unknown = JSON.parse(handle);
      if (parsed && typeof parsed === 'object') args.handle = parsed;
    } catch {
      // Leave malformed strings untouched so normal schema validation reports a
      // useful object/array type error rather than hiding the bad call.
    }
  }

  // A few tool transports stringify primitive JSON values (and some emit
  // Python-style `True`/`False`). Recover only the fields whose schemas are
  // explicitly boolean/integer; leave all other strings alone so validation
  // remains strict. Native values are copied unchanged.
  for (const name of ['confirmProjectAgents', 'omitSystemPrompt']) {
    const value = args[name];
    if (typeof value === 'string' && /^(true|false)$/i.test(value.trim())) {
      args[name] = value.trim().toLowerCase() === 'true';
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

function unavailableResult(): AgentToolResult<Record<string, unknown>> {
  return {
    content: [
      { type: 'text', text: `Herd requires a running Herdr session.\n${HERDR_SETUP_HINT}` },
    ],
    details: { error: 'herdr not available' },
    isError: true,
  } as AgentToolResult<Record<string, unknown>>;
}

function textResult(
  text: string,
  details: Record<string, unknown>
): AgentToolResult<Record<string, unknown>> {
  return { content: [{ type: 'text' as const, text }], details };
}

/** Keep tool-call previews compact without rendering an empty placeholder. */
function previewText(value: unknown, maxLength = 40): string {
  const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : String(value ?? '');
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

/** Render opaque lifecycle handles as CLI-like ids instead of [object Object]. */
function handlePreview(value: unknown, maxLength = 40): string {
  if (Array.isArray(value)) {
    return `[${value.map(item => handlePreview(item, maxLength)).join(', ')}]`;
  }

  if (value && typeof value === 'object' && 'id' in value) {
    return previewText((value as { id?: unknown }).id, maxLength);
  }

  // A few providers serialize nested handle arguments before they reach the
  // renderer. Keep the display useful even though prepareArguments normalizes
  // them before execution.
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      if (parsed && typeof parsed === 'object') return handlePreview(parsed, maxLength);
    } catch {
      // It may simply be an id, so fall through.
    }
  }

  return previewText(value, maxLength);
}

/** Quote values that would otherwise be ambiguous in a command-like preview. */
function cliValue(value: unknown, maxLength = 80): string {
  const text = previewText(value, maxLength);
  return /[\s"'=]/.test(text) ? JSON.stringify(text) : text;
}

function cliOption(name: string, value: unknown, maxLength = 80): string {
  if (value === undefined || value === null) return '';
  return `--${name}=${cliValue(value, maxLength)}`;
}

/**
 * Show the actual supplied arguments in a compact, CLI-like form. Defaults
 * that were not supplied by the model are intentionally omitted; this makes
 * options such as --timeout visible without dumping handle implementation
 * details (paneId, tabId, workspaceId).
 */
function shepherdCallPreview(args: Record<string, any>, expanded = false): string {
  const valueLimit = expanded ? Number.POSITIVE_INFINITY : 80;
  const idLimit = expanded ? Number.POSITIVE_INFINITY : 48;
  const tokens = ['shepherd', String(args.action ?? 'list')];
  const add = (name: string) => {
    const option = cliOption(name, args[name], valueLimit);
    if (option) tokens.push(option);
  };

  switch (args.action) {
    case 'start':
      tokens.push(cliValue(args.agent, valueLimit));
      for (const name of [
        'agentScope',
        'confirmProjectAgents',
        'cwd',
        'model',
        'omitSystemPrompt',
        'timeout',
      ])
        add(name);
      break;
    case 'prompt':
      tokens.push(handlePreview(args.handle, idLimit));
      if (args.message !== undefined) tokens.push(cliValue(args.message, valueLimit));
      add('timeout');
      break;
    case 'wait':
      tokens.push(handlePreview(args.handle, idLimit));
      add('timeout');
      break;
    case 'status':
    case 'close':
      tokens.push(handlePreview(args.handle, idLimit));
      break;
    case 'agents':
      add('agentScope');
      break;
    case 'read':
      tokens.push(cliValue(args.name, valueLimit));
      for (const name of ['lines', 'source']) add(name);
      break;
  }

  return tokens.filter(Boolean).join(' ');
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

function parentArtifactSession(ctx: ShepherdContext): ShepherdSession {
  const parentPiSessionId = ctx.sessionManager?.getSessionId();
  if (!parentPiSessionId) throw new Error('Unable to resolve the parent pi session identity.');
  return resolveOrCreateParentArtifactSession({
    parentPiSessionId,
    parentSessionFile: ctx.sessionManager?.getSessionFile?.(),
    projectRoot: ctx.cwd,
  });
}

async function doAction(
  args: ShepherdArgs,
  ctx: ShepherdContext,
  signal?: AbortSignal,
  onUpdate?: (partial: AgentToolResult<Record<string, unknown>>) => void
): Promise<AgentToolResult<Record<string, unknown>>> {
  switch (args.action) {
    case 'start': {
      const a: any = args;
      const artifactSession = parentArtifactSession(ctx);
      const handle = await startAgent(a.agent, { ...a, artifactSession }, ctx);
      return textResult(
        `Started idle agent ${a.agent} (${handle.id}). Shared artifact session: ${artifactSession.sessionRelativePath}. Pass the complete details.handle object natively to prompt, status, or close; do not stringify it yourself.`,
        { handle, artifactSession }
      );
    }
    case 'prompt': {
      const a: any = args;
      // Convert timeout from minutes to milliseconds for internal use.
      // Default: from settings (20 minutes).
      const defaultTimeout = loadSettings().timeout;
      const timeoutMinutes = a.timeout ?? defaultTimeout;
      const timeoutMs = timeoutMinutes * 60_000;
      const handle = await promptAgent(a.handle, a.message, { timeout: timeoutMs });
      const artifact = lifecycleRegistry.promptArtifact(handle);
      return textResult(
        `Prompt submitted (${handle.id}); artifact: ${artifact.artifact?.relativePath ?? 'none'}. Call wait with the complete details.handle object natively. For parallel work, pass a native array of complete prompt handle objects.`,
        {
          handle,
          ...(artifact.artifact ? { artifact: artifact.artifact } : {}),
          ...(artifact.session ? { artifactSession: artifact.session } : {}),
        }
      );
    }
    case 'wait': {
      const a: any = args;
      // Convert timeout from minutes to milliseconds for internal use.
      // Default: from settings (20 minutes).
      const defaultTimeout = loadSettings().timeout;
      const timeoutMinutes = a.timeout ?? defaultTimeout;
      const timeoutMs = timeoutMinutes * 60_000;
      const result = await waitPrompts(a.handle, { timeout: timeoutMs });
      return textResult(JSON.stringify(result), { result });
    }
    case 'status': {
      const a: any = args;
      const result = statusAgent(a.handle);
      return textResult(JSON.stringify(result), { status: result });
    }
    case 'close': {
      const a: any = args;
      const handle = closeAgent(a.handle);
      return textResult(`Closed agent ${handle.id}.`, { handle });
    }
    case 'agents': {
      // List discovered agent definitions (for delegation).
      const scope = args.agentScope ?? 'user';
      const { agents, projectDirs } = discoverAgents(ctx.cwd, scope);
      if (agents.length === 0)
        return textResult('No agent definitions found.', { agents: [], projectDirs, scope });
      const lines = agents.map(a => `${a.name} (${a.source}): ${a.description}`);
      return textResult(lines.join('\n'), { agents, projectDirs, scope });
    }

    case 'list': {
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
      // caller has the opaque AgentHandle id rather than the Herdr pane id.
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
            isError: true,
          };
        }
      }
    }

    case 'gc': {
      const pruned = pruneStaleCreatedPanes();
      const remaining = loadCreatedPanes().length;
      return textResult(
        pruned === 0
          ? `No stale pi-shepherd panes to prune (${remaining} registered).`
          : `Pruned ${pruned} stale pane registration(s); ${remaining} remain.`,
        { pruned, remaining }
      );
    }

    default:
      return textResult(`Unknown herd action: ${action}`, {});
  }
}

export const SHEPHERD_TOOL_DESCRIPTION = [
  'Manage specialized agents inside Herdr panes.',
  'Lifecycle handles must be passed as the complete native handle object returned in details.handle; never manually stringify, replace it with an id, or reconstruct it.',
  'Requires a running Herdr session (HERDR_ENV=1 or headless server).',
].join(' ');

export const SHEPHERD_TOOL_PROMPT_SNIPPET = 'Manage specialized agents inside Herdr panes.';

export const SHEPHERD_TOOL_PROMPT_GUIDELINES = [
  'Always start a session with shepherd action=agents to retrieve available agent definitions.',
  'Workflow: Start an idle agent, then prompt it. Wait with the complete prompt details.',
  'Sequential work is better for work that needs context from the previous agents. fx plan and implement this feature: planner -> worker -> reviewer.',
  'Parallel work is better for work that can be done independently. fx research these three topics, or scout these three repos.',
  'For parallel work, call shepherd wait with an array of handle objects.',
  'Agents remain alive after wait and must be explicitly closed. after task is done, close the agent unless told otherwise.',
];

export function registerShepherdTool(pi: ExtensionAPI) {
  pi.registerTool({
    name: 'shepherd',
    label: 'Shepherd (manage Herdr agents)',
    description: SHEPHERD_TOOL_DESCRIPTION,
    promptSnippet: SHEPHERD_TOOL_PROMPT_SNIPPET,
    promptGuidelines: SHEPHERD_TOOL_PROMPT_GUIDELINES,
    parameters: ShepherdParams,
    prepareArguments: prepareShepherdArguments,

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      if (!isHerdrAvailable()) return unavailableResult();
      try {
        return await doAction(params as ShepherdArgs, ctx, signal, onUpdate);
      } catch (error: any) {
        const message = String(error?.message ?? error);
        return {
          content: [{ type: 'text', text: `Herd ${params.action} failed: ${message}` }],
          details: { action: params.action, error: String(error?.message ?? error) },
          isError: true,
        };
      }
    },

    renderCall(args, theme, context) {
      const action = String(args.action ?? 'list');
      const command = shepherdCallPreview(args as Record<string, any>, context.expanded);
      const prefix = `shepherd ${action}`;
      const component = reusableText(context.lastComponent);
      component.setText(
        theme.fg('toolTitle', theme.bold('shepherd ')) +
          theme.fg('accent', action) +
          theme.fg('dim', command.slice(prefix.length))
      );
      return component;
    },

    renderResult(result, { expanded }, theme, context) {
      const text = result.content[0];
      const body = text?.type === 'text' ? (text.text ?? '') : '';
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
    },
  });
}
