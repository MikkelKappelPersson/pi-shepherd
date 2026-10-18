/**
 * Herdr implementation of the Shepherd runtime contract.
 *
 * Thin delegation layer over the moved Herdr primitives: it introduces no new
 * behavior. Every id accepted or returned here is the same opaque lifecycle id
 * the pi-coding-agent surface exposes; Herdr pane ids stay internal to
 * registry lookups (`read` resolves a handle to its pane only for the
 * diagnostic tail).
 *
 * Mapping notes where the contract and the Herdr primitives do not line up
 * exactly are documented on each method.
 */

import type { ShepherdSession } from '../../core/artifact-sessions.ts';
import type { AgentThinkingLevel } from '../../core/discovery.ts';
import { readPaneTail } from './herdr.ts';
import {
  closeAgent,
  delegateAgent,
  sendParentMessage,
  startAgent,
  statusAgent,
} from './lifecycle.ts';
import {
  LifecycleError,
  lifecycleRegistry,
  type AgentLifecycleState,
  type AgentStatus,
  type TaskResult,
  type TaskState,
} from './orchestration.ts';
import type {
  Completion,
  RuntimeProcState,
  RuntimeStatus,
  RuntimeTaskState,
  ShepherdRuntime,
} from '../runtime.ts';

/**
 * Execution context captured by the adapter for the parent session it serves.
 * `spawn` inherits the parent model/thinking level and the fieldnotes session
 * the same way the pi-coding-agent surface does; `delegate` reuses the parent
 * session identity for its broker.
 */
export interface HerdrRuntimeContext {
  cwd?: string;
  model?: { provider: string; id: string };
  thinkingLevel?: AgentThinkingLevel;
  hasUI?: boolean;
  ui?: any;
  sessionId?: string;
  /** Parent fieldnotes session, resolved by the calling surface. */
  artifactSession?: ShepherdSession;
}

function toProcState(state: AgentLifecycleState): RuntimeProcState {
  if (state === 'idle') return 'idle';
  if (state === 'working') return 'working';
  // blocked/done/failed/closed/unknown have no 3-value equivalent.
  return 'unknown';
}

function toTaskState(state: TaskState): RuntimeTaskState {
  switch (state) {
    case 'created':
    case 'running':
      return 'running';
    case 'waiting':
      return 'waiting';
    case 'completed':
      return 'done';
    case 'blocked':
      return 'blocked';
    case 'failed':
    case 'cancelled':
    case 'timed_out':
      return 'failed';
  }
}

function toCompletion(result: TaskResult): Completion {
  const completion: Completion = {
    taskId: result.taskId,
    agentId: result.agentId,
    status: result.status,
    ok: result.ok,
    returnCode: result.returnCode,
    ...(result.text !== undefined ? { text: result.text } : {}),
    ...(result.error !== undefined ? { error: result.error } : {}),
    completedAt: result.completedAt,
  };
  try {
    const handle = lifecycleRegistry.canonicalAgentHandle(result.agentId);
    return {
      ...completion,
      agent: handle.agent,
      ...(handle.label ? { label: handle.label } : {}),
    };
  } catch {
    // Display identity is optional; a retired session simply omits it.
    return completion;
  }
}

function toRuntimeStatus(status: AgentStatus): RuntimeStatus {
  return {
    proc: toProcState(status.state),
    // No open task means no task to run: report the terminal projection.
    task: status.task ? toTaskState(status.task.state) : 'done',
    ...(status.task?.pendingRequestMessageId
      ? { waitingOn: status.task.pendingRequestMessageId }
      : {}),
    ...(status.task?.stale ? { stale: true } : {}),
  };
}

/**
 * Build the Herdr runtime for one parent session context. The adapter holds no
 * state of its own; the lifecycle registries remain the single source of truth.
 */
export function createHerdrRuntime(context: HerdrRuntimeContext = {}): ShepherdRuntime {
  const cwd = context.cwd ?? process.cwd();
  const execContext = {
    cwd,
    model: context.model,
    thinkingLevel: context.thinkingLevel,
    hasUI: context.hasUI,
    ui: context.ui,
    sessionId: context.sessionId,
  };
  return {
    // Delegates to startAgent, which owns discovery, scope, and the
    // project-agent confirmation gate. The definition supplies the name only.
    // Only the opaque id crosses the contract; the internal handle record
    // (pane id included) stays inside the Herdr backend.
    async spawn(def, opts) {
      const handle = await startAgent(
        def.name,
        {
          label: opts.label,
          placement: opts.placement,
          cwd: opts.cwd,
          artifactSession: context.artifactSession,
        },
        execContext
      );
      return handle.id;
    },

    // `requestId` has no Herdr dedup equivalent: the task id is minted by the
    // registry and a retried submit is a second call by design here.
    async delegate(agentId, task, opts) {
      const handle = await delegateAgent(agentId, task, {
        ...(opts.timeoutMin !== undefined ? { timeoutMs: opts.timeoutMin * 60_000 } : {}),
        sessionId: context.sessionId,
      });
      return handle.id;
    },

    // Child-to-parent sends use the child broker surface, not the parent
    // runtime; refuse rather than silently misroute.
    async message(target, msg, opts) {
      if (target === 'parent') {
        throw new LifecycleError(
          'invalid_handle',
          'Herdr runtime adapter cannot address "parent": child-to-parent messages use the child broker surface.'
        );
      }
      const result = sendParentMessage({
        target,
        message: msg,
        taskId: opts.taskId,
        expectsReply: opts.expectsReply,
        replyTo: opts.replyTo,
        delivery: opts.delivery,
      });
      return result.messageId;
    },

    // Closest blocking primitive: waitForTasks settles every task, then each
    // registry result is projected onto the backend-neutral Completion shape.
    async watch(taskIds) {
      const results = await lifecycleRegistry.waitForTasks(taskIds);
      return results.map(toCompletion);
    },

    async status(agentId) {
      return toRuntimeStatus(statusAgent(agentId));
    },

    async close(agentId) {
      closeAgent(agentId);
    },

    // Handle -> pane resolution stays inside the registry; `lines` narrows the
    // fixed 120-line tail after the read because readPaneTail takes no options.
    async read(agentId, opts) {
      const handle = lifecycleRegistry.canonicalAgentHandle(agentId);
      if (!handle.paneId) {
        throw new LifecycleError('unknown_handle', `Agent "${agentId}" has no Herdr pane to read.`);
      }
      const tail = await readPaneTail(handle.paneId);
      const limit = opts?.lines;
      if (limit === undefined || !Number.isFinite(limit) || limit <= 0) return tail;
      const count = Math.trunc(limit);
      if (count <= 0) return '';
      const lines = tail.split('\n');
      while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
      return lines.slice(-count).join('\n');
    },
  };
}
