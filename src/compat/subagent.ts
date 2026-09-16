import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AgentToolResult, ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { discoverAgents, type AgentConfig, type AgentScope } from '../core/discovery.ts';
import {
  approvedProjectAgentKey,
  closeAgent,
  delegateAgent,
  startAgent,
} from '../core/lifecycle.ts';
import { readSessionTelemetry, sessionTelemetrySince } from '../core/herdr.ts';
import { lifecycleRegistry, type TaskResult } from '../core/orchestration.ts';
import { fieldnotesEnabled, loadSettings } from '../extension/config.ts';
import { resolveOrCreateParentArtifactSession } from '../core/artifact-sessions.ts';
import {
  assertDepthAvailable,
  findOwnershipConflicts,
  interpolatePrevious,
  mapWithConcurrencyLimit,
  MAX_CONCURRENCY,
  MAX_PARALLEL_TASKS,
  ownershipRefusal,
  truncateResult,
  type CompatibilityTask,
} from './contracts.ts';
import {
  createWorktreeLeases,
  releaseWorktreeLeases,
  worktreeSummary,
  type WorktreeLease,
} from './worktree.ts';

const TaskSchema = Type.Object({
  agent: Type.String(),
  task: Type.String(),
  cwd: Type.Optional(Type.String()),
  isolate: Type.Optional(Type.Boolean()),
});
const ChainSchema = Type.Object({
  agent: Type.String(),
  task: Type.String(),
  cwd: Type.Optional(Type.String()),
});
const Parameters = Type.Object({
  agent: Type.Optional(Type.String()),
  task: Type.Optional(Type.String()),
  tasks: Type.Optional(Type.Array(TaskSchema)),
  chain: Type.Optional(Type.Array(ChainSchema)),
  cwd: Type.Optional(Type.String()),
  agentScope: Type.Optional(
    Type.Union([Type.Literal('user'), Type.Literal('project'), Type.Literal('both')])
  ),
  confirmProjectAgents: Type.Optional(Type.Boolean()),
});

type Task = CompatibilityTask;
type Params = {
  agent?: string;
  task?: string;
  tasks?: Task[];
  chain?: Task[];
  cwd?: string;
  agentScope?: AgentScope;
  confirmProjectAgents?: boolean;
};
type Context = {
  cwd: string;
  model?: { provider: string; id: string };
  thinkingLevel?: any;
  hasUI?: boolean;
  ui?: any;
  sessionManager?: { getSessionId(): string; getSessionFile?(): string | undefined };
};

export interface CompatibilityResult {
  agent: string;
  task: string;
  cwd: string;
  status: TaskResult['status'];
  ok: boolean;
  returnCode: number;
  text: string;
  error?: string;
  taskId?: string;
  fullOutputPath?: string;
  fullText?: string;
  model?: string;
  usage?: ReturnType<typeof readSessionTelemetry>['usage'];
  toolCalls?: ReturnType<typeof readSessionTelemetry>['toolCalls'];
}

function durableOutputFile(): string {
  const directory = path.join(os.tmpdir(), 'pi-shepherd-results');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  return path.join(
    directory,
    `result-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`
  );
}

function approvalKey(agent: AgentConfig): string {
  return approvedProjectAgentKey(agent.filePath, agent.contentHash);
}

export function agentWrites(agent: AgentConfig | undefined): boolean {
  return Boolean(
    agent &&
    (!agent.tools ||
      agent.tools.some(tool => tool === 'write' || tool === 'edit' || tool === 'bash'))
  );
}

async function runTask(
  task: Task,
  ctx: Context,
  childDepth: number,
  agentScope: AgentScope,
  projectAgentApprovalKey: string | undefined,
  signal?: AbortSignal,
  lease?: WorktreeLease,
  beforeLaunch?: (cwd: string) => Promise<{ approvalKey?: string }>
): Promise<CompatibilityResult> {
  const cwd = task.cwd ?? lease?.cwd ?? ctx.cwd;
  const parentSessionId = ctx.sessionManager?.getSessionId();
  const artifactSession =
    fieldnotesEnabled() && parentSessionId
      ? resolveOrCreateParentArtifactSession({
          parentPiSessionId: parentSessionId,
          projectRoot: ctx.cwd,
        })
      : undefined;
  let agentId: string | undefined;
  let closeConfirmed = false;
  let outcome: CompatibilityResult;
  try {
    if (signal?.aborted) throw new Error('Subagent was aborted before launch.');
    const approval = beforeLaunch ? await beforeLaunch(cwd) : {};
    if (signal?.aborted) throw new Error('Subagent was aborted before launch.');
    const handle = await startAgent(
      task.agent,
      {
        label: `compat-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
        placement: 'tab',
        cwd,
        subagentDepth: childDepth,
        agentScope,
        projectAgentApprovalKey: approval.approvalKey ?? projectAgentApprovalKey,
        artifactSession,
        signal,
      },
      {
        ...ctx,
        sessionId: ctx.sessionManager?.getSessionId(),
        sessionFile: ctx.sessionManager?.getSessionFile?.(),
      }
    );
    agentId = handle.id;
    if (signal?.aborted) throw new Error('Subagent was aborted before delegation.');
    const timeoutMinutes = loadSettings(cwd).timeout;
    const delegated = await delegateAgent(handle, task.task, {
      sessionId: parentSessionId,
      artifactSession,
      reviewScorable: !task.isolate,
      timeoutMs: timeoutMinutes * 60_000,
      signal,
    });
    const result = await new Promise<TaskResult>((resolve, reject) => {
      let disposed = false;
      const detach = lifecycleRegistry.onTaskSettlement(settled => {
        if (settled.taskId !== delegated.id || disposed) return;
        disposed = true;
        signal?.removeEventListener('abort', abort);
        detach();
        resolve(settled);
      });
      const abort = () => {
        if (disposed) return;
        disposed = true;
        detach();
        try {
          lifecycleRegistry.cancelTask(handle, 'Subagent was aborted.');
        } catch {
          // Cancellation may race a terminal task settlement.
        }
        reject(new Error('Subagent was aborted.'));
      };
      if (signal?.aborted) abort();
      else signal?.addEventListener('abort', abort, { once: true });
    });
    const fullOutputPath = lifecycleRegistry.completionResultPath(handle);
    const telemetry = fullOutputPath
      ? sessionTelemetrySince(
          readSessionTelemetry(fullOutputPath),
          lifecycleRegistry.getTask(delegated).telemetryCursor
        )
      : undefined;
    const fullText = telemetry
      ? (telemetry.messages.filter(message => message.role === 'assistant').at(-1)?.content ?? [])
          .filter((part: any) => part?.type === 'text')
          .map((part: any) => part.text)
          .join('\n')
      : '';
    const output = fullText || result.text || result.error || '(no output)';
    let durablePath: string | undefined;
    if (output.length > 50 * 1024) {
      durablePath = durableOutputFile();
      fs.writeFileSync(durablePath, output, { encoding: 'utf8', mode: 0o600 });
    }
    outcome = {
      agent: task.agent,
      task: task.task,
      cwd,
      status: result.status,
      ok: result.ok,
      returnCode: result.returnCode,
      text: truncateResult(output),
      ...(result.error ? { error: result.error } : {}),
      taskId: result.taskId,
      ...(durablePath ? { fullOutputPath: durablePath } : {}),
      fullText,
      ...(telemetry
        ? { model: telemetry.model, usage: telemetry.usage, toolCalls: telemetry.toolCalls }
        : {}),
    };
  } catch (error) {
    const aborted = signal?.aborted === true;
    outcome = {
      agent: task.agent,
      task: task.task,
      cwd,
      status: aborted ? 'cancelled' : 'failed',
      ok: false,
      returnCode: aborted ? 130 : 1,
      text: String((error as Error)?.message ?? error),
      error: String((error as Error)?.message ?? error),
    };
  } finally {
    if (agentId) {
      try {
        closeConfirmed = (await closeAgent(agentId)).confirmedGone;
      } catch {
        // Failed or uncertain termination keeps an isolated worktree intact.
      }
    }
    if (lease && !closeConfirmed) lease.retain = true;
  }
  if (agentId && !closeConfirmed) {
    outcome = {
      ...outcome!,
      status: 'failed',
      ok: false,
      returnCode: 1,
      error: `Agent ${agentId} may still be running; close could not be confirmed.`,
      text: `${outcome!.text}\n\nWarning: agent ${agentId} may still be running; cleanup was retained.`,
    };
  }
  return outcome!;
}

function validateMode(params: Params): 'single' | 'parallel' | 'chain' {
  const single = Boolean(params.agent && params.task);
  const parallel = Boolean(params.tasks?.length);
  const chain = Boolean(params.chain?.length);
  if (Number(single) + Number(parallel) + Number(chain) !== 1) {
    throw new Error('Invalid parameters. Provide exactly one of single, parallel, or chain mode.');
  }
  if (chain) return 'chain';
  if (parallel) return 'parallel';
  return 'single';
}

export function compatibilityResult(
  mode: 'single' | 'parallel' | 'chain',
  results: CompatibilityResult[],
  worktrees?: string
): AgentToolResult<Record<string, unknown>> {
  const failed = mode !== 'parallel' && results.some(item => !item.ok);
  const publicResults = results.map(({ fullText: _fullText, ...item }) => item);
  const last = results.at(-1);
  let body = '(no output)';
  if (mode === 'parallel') {
    body = [
      `Parallel: ${results.filter(item => item.ok).length}/${results.length} succeeded`,
      ...results.map(
        item =>
          `### [${item.agent}] ${item.status}\n\n${item.text}` +
          (item.fullOutputPath ? `\n\nFull output: ${item.fullOutputPath}` : '')
      ),
      worktrees,
    ]
      .filter(Boolean)
      .join('\n\n---\n\n');
  } else if (last) {
    body = `${last.text}${last.fullOutputPath ? `\n\nFull output: ${last.fullOutputPath}` : ''}`;
  }
  const response: AgentToolResult<Record<string, unknown>> = {
    content: [{ type: 'text', text: body }],
    details: {
      mode,
      compatibility: 'shepherd',
      failed,
      results: publicResults,
      ...(worktrees ? { worktrees } : {}),
    },
  };
  return response;
}

export function registerSubagentCompatibility(pi: ExtensionAPI): void {
  pi.on('tool_result', event => {
    if (event.toolName !== 'subagent' || !event.details || typeof event.details !== 'object') {
      return;
    }
    const details = event.details as Record<string, unknown>;
    if (details.compatibility === 'shepherd' && details.failed === true) {
      return { isError: true };
    }
  });

  pi.registerTool({
    name: 'subagent',
    label: 'Subagent (Shepherd)',
    description:
      'Compatibility interface for single, parallel, and chain delegation through persistent Herdr agents. Parallel calls are limited to 8 tasks and 4 concurrent launches; overlapping writers are refused unless isolated in safe git worktrees.',
    promptSnippet:
      'Delegate bounded work through Shepherd while preserving subagent safety contracts.',
    promptGuidelines: [
      'Use exactly one mode: agent+task, tasks, or chain.',
      'Use isolate on parallel writers that need overlapping files; retained worktrees are reported for explicit integration.',
    ],
    parameters: Parameters,
    async execute(_id, params: Params, signal, _onUpdate, ctx: Context) {
      let leases: WorktreeLease[] = [];
      let leasesReleased = false;
      try {
        const childDepth = assertDepthAvailable();
        const mode = validateMode(params);
        const settings = loadSettings(ctx.cwd);
        if (params.agentScope && params.agentScope !== settings.agentScope) {
          throw new Error('Agent scope is controlled by trusted Shepherd settings.');
        }
        if (
          params.confirmProjectAgents !== undefined &&
          params.confirmProjectAgents !== settings.confirmProjectAgents
        ) {
          throw new Error('Project-agent confirmation is controlled by trusted Shepherd settings.');
        }
        const scope = settings.agentScope;
        let executionTasks: Task[];
        if (mode === 'single') {
          executionTasks = [{ agent: params.agent!, task: params.task!, cwd: params.cwd }];
        } else if (mode === 'parallel') {
          executionTasks = params.tasks!;
        } else {
          executionTasks = params.chain!;
        }
        if (mode === 'parallel' && executionTasks.length > MAX_PARALLEL_TASKS) {
          throw new Error(
            `Too many parallel tasks (${executionTasks.length}). Max is ${MAX_PARALLEL_TASKS}.`
          );
        }
        if (mode === 'parallel') {
          try {
            leases = createWorktreeLeases(
              executionTasks,
              ctx.cwd,
              `${process.pid}-${Date.now().toString(36)}`
            );
          } catch (error) {
            throw new Error(
              `Worktree isolation failed: ${String((error as Error)?.message ?? error)}`
            );
          }
        }
        const byIndex = new Map(leases.map(lease => [lease.index, lease]));
        executionTasks = executionTasks.map((task, index) => ({
          ...task,
          cwd: byIndex.get(index)?.cwd ?? task.cwd ?? ctx.cwd,
        }));
        const requestedAgents = executionTasks.map(task => ({ name: task.agent, cwd: task.cwd! }));
        const resolvedAgents = requestedAgents.map(({ name, cwd }) =>
          discoverAgents(cwd, scope, {
            includeBundled: loadSettings(cwd).includeBundledAgents,
          }).agents.find(agent => agent.name === name)
        );
        const projectAgents = resolvedAgents.filter(
          (agent): agent is AgentConfig => agent?.source === 'project'
        );
        const pendingApprovalKeys = new Map(
          projectAgents.map(agent => [agent.filePath, approvalKey(agent)] as const)
        );
        const confirmProjectAgents = settings.confirmProjectAgents;
        if (projectAgents.length > 0 && confirmProjectAgents) {
          if (!ctx.hasUI) throw new Error('Project-local agents require interactive confirmation.');
          const approved = await ctx.ui.confirm(
            'Run project-local agents?',
            `Agents: ${projectAgents.map(agent => agent.name).join(', ')}`
          );
          if (!approved) throw new Error('Project-local agents were not approved.');
        }
        const approvalKeys = new Set(pendingApprovalKeys.values());
        const approveLaunch = async (
          agentName: string,
          cwd: string
        ): Promise<{ approvalKey?: string }> => {
          const settingsForLaunch = loadSettings(cwd);
          const definition = discoverAgents(cwd, scope, {
            includeBundled: settingsForLaunch.includeBundledAgents,
          }).agents.find(agent => agent.name === agentName);
          if (!definition || definition.source !== 'project') return {};
          const key = approvalKey(definition);
          if (approvalKeys.has(key) && pendingApprovalKeys.get(definition.filePath) === key) {
            return { approvalKey: key };
          }
          if (!settingsForLaunch.confirmProjectAgents) return { approvalKey: key };
          if (!ctx.hasUI) throw new Error('Project-local agents require interactive confirmation.');
          const approved = await ctx.ui.confirm(
            'Run project-local agent?',
            `Agent: ${definition.name}\nSource: ${definition.filePath}`
          );
          if (!approved) throw new Error('Project-local agent was not approved.');
          approvalKeys.add(key);
          return { approvalKey: key };
        };
        if (mode === 'single') {
          const results = [
            await runTask(
              executionTasks[0],
              ctx,
              childDepth,
              scope,
              resolvedAgents[0] && approvalKeys.has(approvalKey(resolvedAgents[0]))
                ? approvalKey(resolvedAgents[0])
                : undefined,
              signal,
              undefined,
              cwd => approveLaunch(params.agent!, cwd)
            ),
          ];
          return compatibilityResult('single', results);
        }
        if (mode === 'chain') {
          const results: CompatibilityResult[] = [];
          let previous = '';
          for (const item of executionTasks) {
            const resolved = resolvedAgents[results.length];
            const current = await runTask(
              { ...item, task: interpolatePrevious(item.task, previous) },
              ctx,
              childDepth,
              scope,
              resolved && approvalKeys.has(approvalKey(resolved))
                ? approvalKey(resolved)
                : undefined,
              signal,
              undefined,
              cwd => approveLaunch(item.agent, cwd)
            );
            results.push(current);
            if (!current.ok) break;
            previous = current.fullText || current.text;
          }
          return compatibilityResult('chain', results);
        }

        const normalized = executionTasks.map((task, index) => ({
          ...task,
          writes: agentWrites(resolvedAgents[index]),
        }));
        const conflicts = findOwnershipConflicts(normalized, ctx.cwd);
        if (conflicts.length > 0) throw new Error(ownershipRefusal(conflicts));

        let results: CompatibilityResult[] = [];
        let failure: unknown;
        try {
          results = await mapWithConcurrencyLimit(
            normalized,
            MAX_CONCURRENCY,
            async (task, index) => {
              if (signal?.aborted) {
                return {
                  agent: task.agent,
                  task: task.task,
                  cwd: task.cwd ?? ctx.cwd,
                  status: 'cancelled',
                  ok: false,
                  returnCode: 130,
                  text: 'Subagent was aborted before launch.',
                };
              }
              return runTask(
                task,
                ctx,
                childDepth,
                scope,
                resolvedAgents[index] && approvalKeys.has(approvalKey(resolvedAgents[index]!))
                  ? approvalKey(resolvedAgents[index]!)
                  : undefined,
                signal,
                byIndex.get(index),
                cwd => approveLaunch(task.agent, cwd)
              );
            }
          );
        } catch (error) {
          failure = error;
        }
        if (failure) for (const lease of leases) lease.retain = true;
        const outcomes = releaseWorktreeLeases(leases);
        leasesReleased = true;
        if (failure) throw failure;
        return compatibilityResult('parallel', results, worktreeSummary(outcomes));
      } finally {
        if (!leasesReleased && leases.length > 0) releaseWorktreeLeases(leases);
      }
    },
  });
}
