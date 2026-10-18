/**
 * Shepherd runtime contract.
 *
 * One backend-neutral surface for the execution substrate behind the
 * `shepherd_*` tools: Herdr panes today, durable owned conversations/tasks as
 * a future opt-in backend. This module is a pure contract — it must not import
 * the `herdr` CLI, `pi-durable`, an implementation module, or anything with
 * side effects.
 *
 * Every id crossing this interface is opaque and session-scoped. An
 * implementation maps an opaque `AgentHandle` internally to either a Herdr
 * `paneId` or a durable `{ conversationId, submissionId, taskId }` triple.
 * Native ids are implementation detail: Herdr pane ids and durable
 * conversation ids must never be returned from `spawn` / `delegate` /
 * `message`, accepted as `AgentHandle` / `TaskId` / `MessageId` inputs, or
 * exposed by `status` / `read`. A Herdr pane id is diagnostic metadata only
 * (for example, the pane `read` tails); it is never a valid opaque id.
 */

import type { AgentConfig } from '../core/discovery.ts';

/** Opaque, session-scoped agent id returned by `spawn`; never a Herdr pane id. */
export type AgentHandle = string;

/** Message-addressing alias for an opaque agent id (`AgentHandle`). */
export type AgentId = AgentHandle;

/** Opaque task id returned by `delegate`; never a native submission id. */
export type TaskId = string;

/** Opaque message id returned by `message`; never a native envelope id. */
export type MessageId = string;

/**
 * Where a spawn is placed. One optional value, matching the public
 * `shepherd_spawn` surface. Durable execution ignores placement; `auto` may
 * honor it for read-only viewer panes.
 */
export type SpawnPlacement = 'pane_right' | 'pane_down' | 'tab' | 'workspace';

/**
 * One settled task in backend-neutral terms: callers see the opaque task and
 * agent ids plus the public result shape, never pane, conversation, or
 * submission ids.
 */
export interface Completion {
  taskId: TaskId;
  agentId: AgentHandle;
  /** Terminal task state; a successful durable `done` maps to `completed`. */
  status: 'completed' | 'blocked' | 'failed' | 'cancelled' | 'timed_out';
  ok: boolean;
  /** Stable process-style outcome: 0 success, 1 failure, 2 blocked, 124 timeout, 130 cancelled. */
  returnCode: number;
  text?: string;
  error?: string;
  completedAt: number;
  /** Agent definition name; display identity only, not an id. */
  agent?: string;
  /** User-supplied label; display identity only, not an id. */
  label?: string;
}

/**
 * Three-value live process state. Backend states with no live equivalent —
 * including terminal states such as done/failed/closed — map to `unknown`;
 * task outcome is carried by `RuntimeTaskState`, never widened here.
 */
export type RuntimeProcState = 'idle' | 'working' | 'unknown';

export type RuntimeTaskState = 'running' | 'waiting' | 'done' | 'blocked' | 'failed';

/**
 * Backend-neutral status for one sheep: process state plus the state of its
 * active task (independent, so an idle process can own a waiting task).
 */
export interface RuntimeStatus {
  proc: RuntimeProcState;
  task: RuntimeTaskState;
  /**
   * Opaque `MessageId` of the request/message being awaited, when the task is
   * parked on a reply. Never a pane, conversation, or submission id.
   */
  waitingOn?: MessageId;
  /** True once the stale-wait monitor has already reminded for this wait episode. */
  stale?: boolean;
}

/**
 * Lifecycle-only runtime. Introspection for `/shepherd herd|agents|prune` and
 * the widget (owned-agent/registry summaries, ownership checks) stays on the
 * concrete runtime module; this interface carries no native ids either.
 */
export interface ShepherdRuntime {
  /** Launch a sheep from a discovered agent definition. */
  spawn(
    def: AgentConfig,
    opts: { cwd?: string; label?: string; placement?: SpawnPlacement }
  ): Promise<AgentHandle>;

  /** Submit a task to an owned sheep. `requestId` dedups retried submissions. */
  delegate(
    agentId: AgentHandle,
    task: string,
    opts: { requestId?: string; timeoutMin?: number }
  ): Promise<TaskId>;

  /** Send a message to an owned sheep or to `parent`. */
  message(
    target: AgentId | 'parent',
    msg: string,
    opts: {
      taskId?: TaskId;
      expectsReply?: boolean;
      replyTo?: MessageId;
      delivery?: 'followUp' | 'steer';
    }
  ): Promise<MessageId>;

  /**
   * Block until every given task settles and return one completion per task.
   * Implementations may reject an empty id list.
   */
  watch(taskIds: TaskId[]): Promise<Completion[]>;

  /** Current process/task state for an owned sheep. */
  status(agentId: AgentHandle): Promise<RuntimeStatus>;

  /** Close/abort an owned sheep. Only shepherd-created work may be closed. */
  close(agentId: AgentHandle): Promise<void>;

  /** Tail human-readable output for an owned sheep. */
  read(agentId: AgentHandle, opts?: { lines?: number }): Promise<string>;
}
