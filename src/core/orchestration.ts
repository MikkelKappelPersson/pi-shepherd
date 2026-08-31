/** Low-level agent lifecycle handles and session-scoped registries. */
import { randomUUID } from 'node:crypto';
import type { ArtifactReservation, ShepherdSession } from './artifact-sessions.ts';
import type { ChildCapability } from './messaging.ts';

export type AgentLifecycleState =
  | 'idle'
  | 'working'
  | 'blocked'
  | 'done'
  | 'unknown'
  | 'failed'
  | 'closed';

export type PromptResultStatus = 'idle' | 'done' | 'blocked' | 'failed' | 'timeout' | 'cancelled';

export interface AgentHandle {
  id: string;
  agent: string;
  label: string;
  /** Provider-qualified model actually selected for the child, when known. */
  model?: string;
  paneId?: string;
  tabId?: string;
  workspaceId?: string;
}

/**
 * The model-facing tools use opaque ids. The registry still accepts full
 * internal handles for implementation callers and maintains the complete
 * object behind each id.
 */
/** Public lifecycle calls use the opaque id; internal callers may still hold the full handle. */
export type AgentHandleInput = AgentHandle | string;

export function formatAgentName(agent: string, label?: string): string {
  const trimmed = label?.trim() ?? '';
  return trimmed ? `${agent}: ${trimmed}` : agent;
}

export function validateAgentLabel(value: unknown): string {
  if (value == null) return '';
  if (typeof value !== 'string') throw new Error('Agent label must be a string.');
  const label = value.trim();
  if (!label) return '';
  if (label.length > 64) throw new Error('Agent label must be at most 64 characters.');
  if (!/^[\p{L}\p{N} _.-]+$/u.test(label) || label.includes(':'))
    throw new Error('Agent label may contain only letters, numbers, spaces, _, -, and .; colons and control characters are not allowed.');
  return label;
}

export interface PromptHandle {
  id: string;
  agentId: string;
  createdAt: number;
}

/** Public lifecycle calls use the opaque id; internal callers may still hold the full handle. */
export type PromptHandleInput = PromptHandle | string;

export type TaskState =
  | 'created'
  | 'running'
  | 'waiting'
  | 'completed'
  | 'blocked'
  | 'failed'
  | 'cancelled'
  | 'timed_out';

export type TaskResultStatus = 'completed' | 'blocked' | 'failed' | 'cancelled' | 'timed_out';

export interface TaskHandle {
  id: string;
  agentId: string;
  createdAt: number;
}

/** Public lifecycle calls use the opaque task id; internal callers may hold the handle. */
export type TaskHandleInput = TaskHandle | string;

export interface TaskResult {
  taskId: string;
  agentId: string;
  status: TaskResultStatus;
  ok: boolean;
  /** Stable process-style outcome: 0 success, 1 failure, 2 blocked, 124 timeout, 130 cancelled. */
  returnCode: number;
  text?: string;
  error?: string;
  completedAt: number;
  artifact?: ArtifactReservation;
  artifactSession?: ShepherdSession;
}

export interface TaskRecord {
  taskId: string;
  agentId: string;
  description: string;
  state: TaskState;
  createdAt: number;
  startedAt?: number;
  waitingSince?: number;
  deadlineAt?: number;
  /**
   * Correlation state for the task's single outstanding tracked reply.
   *
   * The Phase 6 initial policy allows exactly one outstanding request per task
   * (the spec permits restricting a task to one outstanding request). This
   * keeps reply correlation deterministic: the reply's `replyTo` must match
   * `pendingReplyMessageId`. The request opens when the child (or parent,
   * for a parent-originated question) sends an `expectsReply` message and is
   * resolved on a matching reply, an explicit cancellation, close, or timeout.
   */
  pendingReplyMessageId?: string;
  pendingReplyTargetAgentId?: string;
  pendingReplyDeadlineAt?: number;
  pendingReplyText?: string;
  pendingRequestIds: string[];
  staleNotifiedAt?: number;
  artifactSession?: ShepherdSession;
  artifact?: ArtifactReservation;
  result?: TaskResult;
}

export interface TaskSettlement {
  status: TaskResultStatus;
  ok?: boolean;
  returnCode?: number;
  text?: string;
  error?: string;
  completedAt?: number;
}

export interface CreateTaskOptions {
  timeoutMs?: number;
  deadlineAt?: number;
  artifactSession?: ShepherdSession;
}

export interface AgentStatus {
  handle: AgentHandle;
  state: AgentLifecycleState;
  paneId?: string;
  tabId?: string;
  workspaceId?: string;
  error?: string;
}

export interface PromptResult {
  promptId: string;
  agentId: string;
  status: PromptResultStatus;
  ok: boolean;
  /** Stable process-style outcome: 0 success, 1 failure, 2 blocked, 124 timeout, 130 cancelled. */
  returnCode?: number;
  text?: string;
  error?: string;
  artifact?: ArtifactReservation;
  artifactSession?: ShepherdSession;
}

/** A prompt completion enriched with the persistent agent's display identity. */
export interface WatcherCompletion extends PromptResult {
  agent?: string;
  label?: string;
}

export interface WatcherRegistration {
  watcherId: string;
  promptIds: string[];
  pending: string[];
  completed: PromptResult[];
}

export interface WatcherNotification {
  watcherId: string;
  completions: WatcherCompletion[];
}

export type PromptWatcherCallback = (completion: WatcherCompletion) => void;

export class LifecycleError extends Error {
  readonly code:
    | 'unknown_handle'
    | 'closed_handle'
    | 'active_prompt'
    | 'active_task'
    | 'unknown_task'
    | 'task_agent_mismatch'
    | 'invalid_handle'
    | 'invalid_task'
    | 'invalid_transition';
  constructor(code: LifecycleError['code'], message: string) {
    super(message);
    this.name = 'LifecycleError';
    this.code = code;
  }
}

interface AgentRecord {
  handle: AgentHandle;
  /** Completion sidecar emitted by the child for each completed prompt. */
  completionSignalPath?: string;
  /** Child JSONL session file; the full last answer is read from it on completion. */
  completionResultPath?: string;
  /** Durable fieldnotes session owned by the parent pi session. */
  artifactSession?: ShepherdSession;
  state: AgentLifecycleState;
  activePromptId?: string;
  /** One active tracked task is reserved independently of prompt records. */
  activeTaskId?: string;
  /** Parent broker capability used to launch and route this child. */
  childCapability?: ChildCapability;
  error?: string;
}

interface TaskRecordInternal extends Omit<TaskRecord, 'pendingRequestIds'> {
  pendingRequestIds: Set<string>;
  settled: boolean;
  onSettled?: (result: TaskResult) => void;
  timeoutId?: ReturnType<typeof setTimeout>;
}

interface PromptRecord {
  handle: PromptHandle;
  artifactSession?: ShepherdSession;
  artifact?: ArtifactReservation;
  onSettled?: (result: PromptResult) => void;
  /** Herdr state sequence before submission; prevents matching pre-submit idle. */
  baselineStateChangeSeq?: number;
  /** Completion sidecar signal before submission; detects fast completions. */
  baselineCompletionSignalId?: string;
  observedWorking: boolean;
  result?: PromptResult;
  settled: boolean;
  resolve: (result: PromptResult) => void;
  promise: Promise<PromptResult>;
  /** Active timeout handle from waitPrompts; cleared on settle. */
  timeoutId?: ReturnType<typeof setTimeout>;
}

/**
 * In-memory registry for one extension process. Public ids are opaque and
 * include a random component, so callers never need to know Herdr pane ids.
 */
function handleId(input: unknown, kind: 'AgentHandle' | 'PromptHandle'): string {
  if (
    (typeof input !== 'string' &&
      (!input || typeof input !== 'object' || Array.isArray(input) || typeof (input as { id?: unknown }).id !== 'string')) ||
    (typeof input === 'string' && input.trim().length === 0)
  ) {
    const syntax =
      kind === 'PromptHandle'
        ? `Correct syntax: { id: "shepherd-prompt-..." } (or { id: ["prompt-a", "prompt-b"] } for parallel wait).`
        : `Correct syntax: { id: "shepherd-agent-..." }.`;
    throw new LifecycleError(
      'invalid_handle',
      `Expected the opaque ${kind === 'PromptHandle' ? 'prompt' : 'agent'} id as a string. Do not pass a quoted JSON object, array, or Herdr pane id. ${syntax}`
    );
  }
  return typeof input === 'string' ? input : (input as { id: string }).id;
}

function taskHandleId(input: unknown): string {
  if (
    (typeof input !== 'string' &&
      (!input || typeof input !== 'object' || Array.isArray(input) || typeof (input as { id?: unknown }).id !== 'string')) ||
    (typeof input === 'string' && input.trim().length === 0)
  ) {
    throw new LifecycleError(
      'invalid_handle',
      'Expected the opaque TaskHandle id as a string. Do not pass a quoted JSON object, array, agent id, or Herdr pane id. Correct syntax: { id: "shepherd-task-..." }. '
    );
  }
  return typeof input === 'string' ? input : (input as { id: string }).id;
}

export class LifecycleRegistry {
  private readonly sessionId = randomUUID().slice(0, 8);
  private readonly agents = new Map<string, AgentRecord>();
  private readonly prompts = new Map<string, PromptRecord>();
  private readonly tasks = new Map<string, TaskRecordInternal>();
  private readonly watchers = new Map<string, {
    promptIds: string[];
    pending: Set<string>;
    callback?: PromptWatcherCallback;
    delivered: Set<string>;
  }>();
  private readonly promptWatchers = new Map<string, Set<string>>();

  private id(kind: 'agent' | 'prompt' | 'task' | 'watch'): string {
    return `shepherd-${kind}-${this.sessionId}-${randomUUID()}`;
  }

  /** Reserve an opaque agent id before a child process is launched. */
  allocateAgentId(): string {
    return this.id('agent');
  }

  registerAgent(
    input: Omit<AgentHandle, 'id'> & { id?: string },
    metadata: {
      completionSignalPath?: string;
      completionResultPath?: string;
      artifactSession?: ShepherdSession;
      childCapability?: ChildCapability;
    } = {}
  ): AgentHandle {
    const label = validateAgentLabel(input.label);
    const display = formatAgentName(input.agent, label);
    if (label && [...this.agents.values()].some(a => formatAgentName(a.handle.agent, a.handle.label) === display))
      throw new Error(`Duplicate agent label "${display}".`);
    const requestedId = input.id;
    if (requestedId !== undefined && (typeof requestedId !== 'string' || !requestedId.trim())) {
      throw new LifecycleError('invalid_handle', 'Agent id must be a non-empty opaque string when supplied internally.');
    }
    if (requestedId && this.agents.has(requestedId)) {
      throw new LifecycleError('invalid_handle', `Agent id "${requestedId}" is already registered.`);
    }
    const handle = { ...input, label, id: requestedId ?? this.id('agent') };
    this.agents.set(handle.id, {
      handle,
      completionSignalPath: metadata.completionSignalPath,
      completionResultPath: metadata.completionResultPath,
      artifactSession: metadata.artifactSession,
      childCapability: metadata.childCapability,
      state: 'idle',
    });
    return { ...handle };
  }

  getAgent(input: AgentHandleInput | unknown): AgentRecord {
    const id = handleId(input, 'AgentHandle');
    const record = this.agents.get(id);
    if (!record)
      throw new LifecycleError(
        'unknown_handle',
        `Unknown agent id "${id}". Lifecycle ids are scoped to this parent session; use the id from the latest spawn result. A Herdr pane id is not an agent id.`
      );
    return record;
  }

  canonicalAgentHandle(input: AgentHandleInput | unknown): AgentHandle {
    return { ...this.getAgent(input).handle };
  }

  attachAgentChildCapability(handle: AgentHandleInput, capability: ChildCapability): void {
    this.getAgent(handle).childCapability = { ...capability };
  }

  agentChildCapability(handle: AgentHandleInput): ChildCapability | undefined {
    const capability = this.getAgent(handle).childCapability;
    return capability ? { ...capability } : undefined;
  }

  status(handle: AgentHandleInput, state?: AgentLifecycleState, error?: string): AgentStatus {
    const record = this.getAgent(handle);
    if (state) record.state = state;
    if (error) record.error = error;
    return {
      handle: { ...record.handle },
      state: record.state,
      ...(record.error ? { error: record.error } : {}),
    };
  }

  /**
   * Update the observed process/agent state without settling an open prompt.
   *
   * This separation is a guardrail for the tracked-task protocol: a child can
   * become idle between turns while a delegated task is waiting for a reply.
   * Future task records must settle only through explicit completion or an
   * explicit failure, cancellation, or timeout path.
   */
  setAgentState(handle: AgentHandleInput, state: AgentLifecycleState, error?: string): void {
    const record = this.getAgent(handle);
    record.state = state;
    record.error = error;
  }

  /**
   * Reserve a tracked task slot without assuming that the child has started
   * running yet. The caller can publish the task and then call
   * setTaskRunning(); reserving first closes the concurrent-delegation race.
   */
  createTask(
    handle: AgentHandleInput,
    description: string,
    options: CreateTaskOptions = {}
  ): TaskHandle {
    const agent = this.getAgent(handle);
    const agentId = agent.handle.id;
    if (agent.state === 'closed') {
      throw new LifecycleError('closed_handle', `Agent "${agentId}" is closed.`);
    }
    if (agent.activeTaskId) {
      throw new LifecycleError(
        'active_task',
        `Agent "${agentId}" already has an active tracked task (${agent.activeTaskId}).`
      );
    }
    if (typeof description !== 'string' || !description.trim()) {
      throw new LifecycleError('invalid_task', 'Task description must not be empty.');
    }
    if (description.length > 100_000) {
      throw new LifecycleError('invalid_task', 'Task description must be at most 100000 characters.');
    }
    if (options.timeoutMs !== undefined &&
      (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 0)) {
      throw new LifecycleError('invalid_task', 'Task timeout must be a non-negative finite number.');
    }
    if (options.deadlineAt !== undefined && !Number.isFinite(options.deadlineAt)) {
      throw new LifecycleError('invalid_task', 'Task deadline must be a finite timestamp.');
    }
    if (options.timeoutMs !== undefined && options.deadlineAt !== undefined) {
      throw new LifecycleError('invalid_task', 'Specify either timeoutMs or deadlineAt, not both.');
    }
    const createdAt = Date.now();
    const task: TaskHandle = { id: this.id('task'), agentId, createdAt };
    const deadlineAt = options.deadlineAt ??
      (options.timeoutMs !== undefined ? createdAt + options.timeoutMs : undefined);
    this.tasks.set(task.id, {
      taskId: task.id,
      agentId,
      description: description.trim(),
      state: 'created',
      createdAt,
      deadlineAt,
      pendingRequestIds: new Set(),
      artifactSession: options.artifactSession,
      settled: false,
    });
    agent.activeTaskId = task.id;
    const record = this.tasks.get(task.id)!;
    if (record.deadlineAt !== undefined) {
      const delay = Math.max(0, record.deadlineAt - Date.now());
      record.timeoutId = setTimeout(() => {
        if (!record.settled) {
          this.settleTask(task.id, {
            status: 'timed_out',
            error: 'Tracked task deadline reached.',
          });
        }
      }, delay);
      (record.timeoutId as any).unref?.();
    }
    return { ...task };
  }

  private taskRecord(input: TaskHandleInput | unknown): TaskRecordInternal {
    const id = taskHandleId(input);
    const record = this.tasks.get(id);
    if (!record) {
      throw new LifecycleError(
        'unknown_task',
        `Unknown task id "${id}". Task ids are scoped to this parent session; use the id returned by shepherd_delegate, not an agent id or Herdr pane id.`
      );
    }
    return record;
  }

  private taskSnapshot(record: TaskRecordInternal): TaskRecord {
    return {
      taskId: record.taskId,
      agentId: record.agentId,
      description: record.description,
      state: record.state,
      createdAt: record.createdAt,
      ...(record.startedAt !== undefined ? { startedAt: record.startedAt } : {}),
      ...(record.waitingSince !== undefined ? { waitingSince: record.waitingSince } : {}),
      ...(record.deadlineAt !== undefined ? { deadlineAt: record.deadlineAt } : {}),
      ...(record.pendingReplyMessageId !== undefined ? { pendingReplyMessageId: record.pendingReplyMessageId } : {}),
      ...(record.pendingReplyTargetAgentId !== undefined ? { pendingReplyTargetAgentId: record.pendingReplyTargetAgentId } : {}),
      ...(record.pendingReplyDeadlineAt !== undefined ? { pendingReplyDeadlineAt: record.pendingReplyDeadlineAt } : {}),
      ...(record.pendingReplyText !== undefined ? { pendingReplyText: record.pendingReplyText } : {}),
      pendingRequestIds: [...record.pendingRequestIds],
      ...(record.staleNotifiedAt !== undefined ? { staleNotifiedAt: record.staleNotifiedAt } : {}),
      ...(record.artifactSession ? { artifactSession: record.artifactSession } : {}),
      ...(record.artifact ? { artifact: record.artifact } : {}),
      ...(record.result ? { result: { ...record.result } } : {}),
    };
  }

  canonicalTaskHandle(input: TaskHandleInput | unknown): TaskHandle {
    const record = this.taskRecord(input);
    return { id: record.taskId, agentId: record.agentId, createdAt: record.createdAt };
  }

  getTask(input: TaskHandleInput | unknown): TaskRecord {
    return this.taskSnapshot(this.taskRecord(input));
  }

  taskResult(input: TaskHandleInput | unknown): TaskResult | undefined {
    const result = this.taskRecord(input).result;
    return result ? { ...result } : undefined;
  }

  /**
   * Verify the child identity before accepting a task lifecycle event. The
   * mailbox will perform the same check at its transport boundary; keeping
   * this assertion in the registry prevents internal callers from bypassing
   * ownership accidentally.
   */
  assertTaskOwner(
    taskInput: TaskHandleInput | unknown,
    agentInput: AgentHandleInput | unknown
  ): TaskRecord {
    const task = this.taskRecord(taskInput);
    const agent = this.getAgent(agentInput);
    if (task.agentId !== agent.handle.id) {
      throw new LifecycleError(
        'task_agent_mismatch',
        `Agent "${agent.handle.id}" does not own task "${task.taskId}".`
      );
    }
    return this.taskSnapshot(task);
  }

  settleTaskForAgent(
    taskInput: TaskHandleInput | unknown,
    agentInput: AgentHandleInput | unknown,
    settlement: TaskSettlement
  ): TaskResult {
    this.assertTaskOwner(taskInput, agentInput);
    return this.settleTask(taskInput, settlement);
  }

  allTasks(): TaskRecord[] {
    return [...this.tasks.values()].map(record => this.taskSnapshot(record));
  }

  activeTaskForAgent(handle: AgentHandleInput): TaskRecord | undefined {
    const agent = this.getAgent(handle);
    return agent.activeTaskId ? this.taskSnapshot(this.taskRecord(agent.activeTaskId)) : undefined;
  }

  setTaskRunning(input: TaskHandleInput | unknown): TaskRecord {
    const record = this.taskRecord(input);
    if (record.settled) {
      throw new LifecycleError('invalid_transition', `Task "${record.taskId}" is already ${record.state}.`);
    }
    if (record.state !== 'created' && record.state !== 'waiting' && record.state !== 'running') {
      throw new LifecycleError('invalid_transition', `Task "${record.taskId}" cannot become running from ${record.state}.`);
    }
    if (record.state === 'waiting' && record.pendingRequestIds.size > 0) {
      throw new LifecycleError(
        'invalid_transition',
        `Task "${record.taskId}" cannot resume while requests are pending.`
      );
    }
    record.state = 'running';
    record.startedAt ??= Date.now();
    record.waitingSince = undefined;
    record.staleNotifiedAt = undefined;
    return this.taskSnapshot(record);
  }

  setTaskWaiting(input: TaskHandleInput | unknown): TaskRecord {
    const record = this.taskRecord(input);
    if (record.settled) {
      throw new LifecycleError('invalid_transition', `Task "${record.taskId}" is already ${record.state}.`);
    }
    if (record.state !== 'running' && record.state !== 'waiting') {
      throw new LifecycleError('invalid_transition', `Task "${record.taskId}" cannot become waiting from ${record.state}.`);
    }
    if (record.pendingRequestIds.size === 0) {
      throw new LifecycleError(
        'invalid_transition',
        `Task "${record.taskId}" cannot become waiting without a pending request.`
      );
    }
    record.state = 'waiting';
    record.waitingSince ??= Date.now();
    return this.taskSnapshot(record);
  }

  addPendingRequest(input: TaskHandleInput | unknown, requestId: string): TaskRecord {
    const record = this.taskRecord(input);
    if (record.settled) {
      throw new LifecycleError('invalid_transition', `Task "${record.taskId}" is already ${record.state}.`);
    }
    if (typeof requestId !== 'string' || !requestId.trim()) {
      throw new LifecycleError('invalid_task', 'Pending request id must not be empty.');
    }
    record.pendingRequestIds.add(requestId);
    return this.taskSnapshot(record);
  }

  resolvePendingRequest(input: TaskHandleInput | unknown, requestId: string): TaskRecord {
    const record = this.taskRecord(input);
    if (record.settled) return this.taskSnapshot(record);
    record.pendingRequestIds.delete(requestId);
    if (record.state === 'waiting' && record.pendingRequestIds.size === 0) {
      record.state = 'running';
      record.waitingSince = undefined;
      record.staleNotifiedAt = undefined;
      record.startedAt ??= Date.now();
    }
    return this.taskSnapshot(record);
  }

  cancelPendingRequest(input: TaskHandleInput | unknown, requestId: string): TaskRecord {
    return this.resolvePendingRequest(input, requestId);
  }

  /**
   * Open the task's single outstanding tracked reply. Opens the pending set and
   * moves the task to `waiting`. If a reply is already outstanding the task is
   * kept waiting for the earlier one (the initial policy allows one outstanding
   * request per task) and the existing reply id is returned so the caller can
   * correlate.
   */
  openPendingRequest(
    input: TaskHandleInput | unknown,
    request: {
      messageId: string;
      targetAgentId?: string;
      deadlineAt?: number;
      text?: string;
    }
  ): TaskRecord {
    const record = this.taskRecord(input);
    if (record.settled) {
      throw new LifecycleError('invalid_transition', `Task "${record.taskId}" is already ${record.state}.`);
    }
    if (record.pendingReplyMessageId !== undefined) {
      throw new LifecycleError(
        'invalid_task',
        `Task "${record.taskId}" already has an outstanding tracked reply (${record.pendingReplyMessageId}).`
      );
    }
    if (record.state === 'created') {
      this.setTaskRunning(input);
    }
    record.pendingReplyMessageId = request.messageId;
    record.pendingReplyTargetAgentId = request.targetAgentId;
    record.pendingReplyText = request.text;
    if (request.deadlineAt !== undefined && Number.isFinite(request.deadlineAt)) {
      record.pendingReplyDeadlineAt = request.deadlineAt;
    }
    this.addPendingRequest(input, request.messageId);
    this.setTaskWaiting(input);
    return this.taskSnapshot(record);
  }

  /**
   * Resolve the task's outstanding tracked reply when the matching reply
   * arrives. The reply's `replyTo` must equal the pending message id; anything
   * else (wrong task, unknown message) leaves the request pending so the owner
   * can still block/cancel it explicitly. Returns correlation metadata so the
   * parent can relay the reply to the asker.
   */
  resolveReplyForTask(
    input: TaskHandleInput | unknown,
    replyTo: string
  ): {
    resolved: boolean;
    taskId: string;
    agentId: string;
    pendingReplyMessageId?: string;
    targetAgentId?: string;
  } {
    const record = this.taskRecord(input);
    const taskId = record.taskId;
    const agentId = record.agentId;
    if (replyTo !== record.pendingReplyMessageId) {
      return {
        resolved: false,
        taskId,
        agentId,
        pendingReplyMessageId: record.pendingReplyMessageId,
        targetAgentId: record.pendingReplyTargetAgentId,
      };
    }
    this.resolvePendingRequest(input, record.pendingReplyMessageId);
    const repliedTo = record.pendingReplyMessageId;
    const targetAgentId = record.pendingReplyTargetAgentId;
    record.pendingReplyMessageId = undefined;
    record.pendingReplyTargetAgentId = undefined;
    record.pendingReplyDeadlineAt = undefined;
    record.pendingReplyText = undefined;
    return { resolved: true, taskId, agentId, pendingReplyMessageId: repliedTo, targetAgentId };
  }

  /**
   * Clear a task's outstanding tracked reply without delivering it (close,
   * explicit timeout, or an invalid reply). Returns when a request was cleared.
   */
  clearPendingReply(input: TaskHandleInput | unknown): TaskRecord {
    const record = this.taskRecord(input);
    if (record.pendingReplyMessageId !== undefined && !record.settled) {
      this.resolvePendingRequest(input, record.pendingReplyMessageId);
    }
    record.pendingReplyMessageId = undefined;
    record.pendingReplyTargetAgentId = undefined;
    record.pendingReplyDeadlineAt = undefined;
    record.pendingReplyText = undefined;
    return this.taskSnapshot(record);
  }

  markTaskStaleNotified(input: TaskHandleInput | unknown, at = Date.now()): TaskRecord {
    const record = this.taskRecord(input);
    if (record.state !== 'waiting') {
      throw new LifecycleError('invalid_transition', `Task "${record.taskId}" is not waiting.`);
    }
    if (!Number.isFinite(at)) throw new LifecycleError('invalid_task', 'Stale notification time must be finite.');
    record.staleNotifiedAt = at;
    return this.taskSnapshot(record);
  }

  clearTaskStaleNotification(input: TaskHandleInput | unknown): TaskRecord {
    const record = this.taskRecord(input);
    record.staleNotifiedAt = undefined;
    return this.taskSnapshot(record);
  }

  attachTaskArtifact(
    input: TaskHandleInput | unknown,
    session: ShepherdSession,
    artifact: ArtifactReservation,
    onSettled?: (result: TaskResult) => void
  ): void {
    const record = this.taskRecord(input);
    record.artifactSession = session;
    record.artifact = artifact;
    record.onSettled = onSettled;
  }

  taskArtifact(input: TaskHandleInput | unknown): {
    session?: ShepherdSession;
    artifact?: ArtifactReservation;
  } {
    const record = this.taskRecord(input);
    return { session: record.artifactSession, artifact: record.artifact };
  }

  settleTask(input: TaskHandleInput | unknown, settlement: TaskSettlement): TaskResult {
    const record = this.taskRecord(input);
    if (record.settled) return { ...record.result! };
    if (!['completed', 'blocked', 'failed', 'cancelled', 'timed_out'].includes(settlement.status)) {
      throw new LifecycleError('invalid_task', `Unknown task result status "${settlement.status}".`);
    }
    const completedAt = settlement.completedAt ?? Date.now();
    if (!Number.isFinite(completedAt)) {
      throw new LifecycleError('invalid_task', 'Task completion time must be finite.');
    }
    const ok = settlement.status === 'completed' && settlement.ok !== false;
    const defaultReturnCode =
      settlement.status === 'cancelled' ? 130 :
      settlement.status === 'timed_out' ? 124 :
      settlement.status === 'blocked' ? 2 :
      ok ? 0 : 1;
    const result: TaskResult = {
      taskId: record.taskId,
      agentId: record.agentId,
      status: settlement.status,
      ok,
      returnCode: settlement.returnCode ?? defaultReturnCode,
      ...(settlement.text !== undefined ? { text: settlement.text } : {}),
      ...(settlement.error !== undefined ? { error: settlement.error } : {}),
      completedAt,
      ...(record.artifact ? { artifact: record.artifact } : {}),
      ...(record.artifactSession ? { artifactSession: record.artifactSession } : {}),
    };
    record.result = result;
    record.state = settlement.status;
    record.settled = true;
    if (record.timeoutId) {
      clearTimeout(record.timeoutId);
      record.timeoutId = undefined;
    }
    record.pendingRequestIds.clear();
    record.waitingSince = undefined;
    record.staleNotifiedAt = undefined;
    record.pendingReplyMessageId = undefined;
    record.pendingReplyTargetAgentId = undefined;
    record.pendingReplyDeadlineAt = undefined;
    record.pendingReplyText = undefined;
    try {
      record.onSettled?.({ ...result });
    } catch {
      /* artifact persistence must not break task settlement */
    }
    const agent = this.agents.get(record.agentId);
    if (agent?.activeTaskId === record.taskId) {
      agent.activeTaskId = undefined;
      if (agent.state !== 'closed') {
        agent.state = settlement.status === 'completed'
          ? 'done'
          : settlement.status === 'blocked'
            ? 'blocked'
            : 'failed';
      }
    }
    return { ...result };
  }

  cancelTask(handle: AgentHandleInput, reason = 'Agent was closed.'): TaskResult | undefined {
    const agent = this.getAgent(handle);
    if (!agent.activeTaskId) return undefined;
    return this.settleTask(agent.activeTaskId, {
      status: 'cancelled',
      ok: false,
      returnCode: 130,
      error: reason,
    });
  }

  createPrompt(
    handle: AgentHandleInput,
    timeoutMs?: number,
    baselineStateChangeSeq?: number,
    baselineCompletionSignalId?: string
  ): PromptHandle {
    const agent = this.getAgent(handle);
    const agentId = agent.handle.id;
    if (agent.state === 'closed')
      throw new LifecycleError('closed_handle', `Agent "${agentId}" is closed.`);
    if (agent.activePromptId) {
      throw new LifecycleError(
        'active_prompt',
        `Agent "${agentId}" already has an unresolved prompt.`
      );
    }
    let resolve!: (result: PromptResult) => void;
    const promise = new Promise<PromptResult>(r => (resolve = r));
    const prompt: PromptHandle = { id: this.id('prompt'), agentId, createdAt: Date.now() };
    this.prompts.set(prompt.id, {
      handle: prompt,
      baselineStateChangeSeq,
      baselineCompletionSignalId,
      observedWorking: false,
      settled: false,
      resolve,
      promise,
    });
    agent.activePromptId = prompt.id;
    agent.state = 'working';
    // Do not arm a timeout here; waitPrompts owns the timeout and will set/extend it.
    // A very long safety net (1h) is set only if wait is never called.
    const safetyTimeoutId = setTimeout(
      () =>
        this.settlePrompt(prompt, {
          promptId: prompt.id,
          agentId: prompt.agentId,
          status: 'timeout',
          ok: false,
          error: 'Prompt timed out (safety net: wait never called).',
        }),
      3_600_000
    );
    this.prompts.get(prompt.id)!.timeoutId = safetyTimeoutId;
    return { ...prompt };
  }

  getPrompt(input: PromptHandleInput | unknown): PromptRecord {
    const id = handleId(input, 'PromptHandle');
    const record = this.prompts.get(id);
    if (!record)
      throw new LifecycleError(
        'unknown_handle',
        `Unknown prompt id "${id}". Lifecycle ids are scoped to this parent session; use the id from the latest prompt result, not an agent id or Herdr pane id.`
      );
    return record;
  }

  canonicalPromptHandle(input: PromptHandleInput | unknown): PromptHandle {
    return { ...this.getPrompt(input).handle };
  }

  /** Return the terminal result when one is already available. */
  promptResult(input: PromptHandleInput | unknown): PromptResult | undefined {
    return this.getPrompt(input).settled ? { ...this.getPrompt(input).result! } : undefined;
  }

  /**
   * Register a one-shot observer for specific prompt invocations. This method
   * is deliberately synchronous: callers receive settled results that already
   * exist and pending ids without waiting for the child.
   */
  watchPrompts(
    handles: PromptHandleInput | PromptHandleInput[],
    callback?: PromptWatcherCallback
  ): WatcherRegistration {
    const values = Array.isArray(handles) ? handles : [handles];
    if (values.length === 0) {
      throw new LifecycleError('invalid_handle', 'Expected one or more opaque prompt ids to watch.');
    }
    const promptIds = values.map(value => this.canonicalPromptHandle(value).id);
    if (new Set(promptIds).size !== promptIds.length) {
      throw new LifecycleError('invalid_handle', 'A watcher cannot contain duplicate prompt ids.');
    }
    const watcherId = this.id('watch');
    const pending = new Set<string>();
    const completed: PromptResult[] = [];
    for (const promptId of promptIds) {
      const prompt = this.prompts.get(promptId)!;
      if (prompt.settled) completed.push({ ...prompt.result! });
      else pending.add(promptId);
    }
    if (pending.size > 0) {
      this.watchers.set(watcherId, {
        promptIds: [...promptIds],
        pending,
        callback,
        delivered: new Set(),
      });
      for (const promptId of pending) {
        let watchers = this.promptWatchers.get(promptId);
        if (!watchers) this.promptWatchers.set(promptId, (watchers = new Set()));
        watchers.add(watcherId);
      }
    }
    return { watcherId, promptIds, pending: [...pending], completed };
  }

  /** Prompt ids that still have at least one active watcher. */
  watchedPromptIds(): string[] {
    return [...this.promptWatchers.keys()];
  }

  /** Remove all watchers during parent session teardown. */
  clearWatchers(): void {
    for (const [watcherId, watcher] of this.watchers) this.removeWatcher(watcherId, watcher);
    this.watchers.clear();
    this.promptWatchers.clear();
  }

  private removeWatcher(watcherId: string, watcher: { pending: Set<string> }): void {
    for (const promptId of watcher.pending) {
      const watchers = this.promptWatchers.get(promptId);
      watchers?.delete(watcherId);
      if (watchers && watchers.size === 0) this.promptWatchers.delete(promptId);
    }
    this.watchers.delete(watcherId);
  }

  wait(handle: PromptHandleInput | unknown): Promise<PromptResult> {
    return this.getPrompt(handle).promise;
  }

  completionSignalPath(handle: AgentHandleInput): string | undefined {
    return this.getAgent(handle).completionSignalPath;
  }

  completionResultPath(handle: AgentHandleInput): string | undefined {
    return this.getAgent(handle).completionResultPath;
  }

  artifactSession(handle: AgentHandleInput): ShepherdSession | undefined {
    return this.getAgent(handle).artifactSession;
  }

  attachPromptArtifact(
    handle: PromptHandleInput,
    session: ShepherdSession,
    artifact: ArtifactReservation,
    onSettled?: (result: PromptResult) => void
  ): void {
    const prompt = this.getPrompt(handle);
    prompt.artifactSession = session;
    prompt.artifact = artifact;
    prompt.onSettled = onSettled;
  }

  promptArtifact(handle: PromptHandleInput): {
    session?: ShepherdSession;
    artifact?: ArtifactReservation;
  } {
    const prompt = this.getPrompt(handle);
    return { session: prompt.artifactSession, artifact: prompt.artifact };
  }

  promptTracking(handle: PromptHandle): {
    baselineStateChangeSeq?: number;
    baselineCompletionSignalId?: string;
    observedWorking: boolean;
  } {
    const record = this.getPrompt(handle);
    return {
      baselineStateChangeSeq: record.baselineStateChangeSeq,
      baselineCompletionSignalId: record.baselineCompletionSignalId,
      observedWorking: record.observedWorking,
    };
  }

  observeWorking(handle: PromptHandle): void {
    this.getPrompt(handle).observedWorking = true;
  }

  settlePrompt(handle: PromptHandle, result: PromptResult): PromptResult {
    const prompt = this.getPrompt(handle);
    if (prompt.settled) return { ...prompt.result! };
    const returnCode = result.returnCode ?? (
      result.status === 'cancelled' ? 130 :
      result.status === 'timeout' ? 124 :
      result.status === 'blocked' ? 2 :
      result.ok ? 0 : 1
    );
    prompt.result = {
      ...result,
      returnCode,
      promptId: prompt.handle.id,
      agentId: prompt.handle.agentId,
      ...(prompt.artifact ? { artifact: prompt.artifact } : {}),
      ...(prompt.artifactSession ? { artifactSession: prompt.artifactSession } : {}),
    };
    prompt.settled = true;
    // Clear any active timeout (safety net from createPrompt or waitPrompts).
    if (prompt.timeoutId) {
      clearTimeout(prompt.timeoutId);
      prompt.timeoutId = undefined;
    }
    try {
      prompt.onSettled?.({ ...prompt.result });
    } catch {
      /* persistence must not break lifecycle settlement */
    }
    // Notify each watcher exactly once, using the prompt id as the primary
    // correlation key. Settlement is still authoritative in the prompt
    // record; a callback failure must never affect waiters or artifacts.
    const watcherIds = [...(this.promptWatchers.get(prompt.handle.id) ?? [])];
    this.promptWatchers.delete(prompt.handle.id);
    const agentForWatcher = this.agents.get(prompt.handle.agentId)?.handle;
    for (const watcherId of watcherIds) {
      const watcher = this.watchers.get(watcherId);
      if (!watcher || watcher.delivered.has(prompt.handle.id)) continue;
      watcher.delivered.add(prompt.handle.id);
      watcher.pending.delete(prompt.handle.id);
      try {
        watcher.callback?.({
          ...prompt.result,
          ...(agentForWatcher ? { agent: agentForWatcher.agent, label: agentForWatcher.label } : {}),
        });
      } catch {
        /* notification delivery must not break lifecycle settlement */
      }
      if (watcher.pending.size === 0) this.watchers.delete(watcherId);
    }
    const agent = this.agents.get(prompt.handle.agentId);
    if (agent?.activePromptId === prompt.handle.id) {
      agent.activePromptId = undefined;
      if (agent.state !== 'closed') agent.state = result.ok ? 'done' : 'failed';
    }
    prompt.resolve({ ...prompt.result });
    return { ...prompt.result };
  }

  cancelPrompts(handle: AgentHandle, reason = 'Agent was closed.'): void {
    const agent = this.getAgent(handle);
    this.cancelTask(handle, reason);
    if (agent.activePromptId) {
      const prompt = this.prompts.get(agent.activePromptId);
      if (prompt)
        this.settlePrompt(prompt.handle, {
          promptId: prompt.handle.id,
          agentId: handle.id,
          status: 'cancelled',
          ok: false,
          returnCode: 130,
          error: reason,
        });
    }
    agent.state = 'closed';
  }

  close(handle: AgentHandle): void {
    const agent = this.getAgent(handle);
    if (agent.state === 'closed') return;
    this.cancelPrompts(handle);
  }

  allAgents(): AgentHandle[] {
    return [...this.agents.values()].map(r => ({ ...r.handle }));
  }
}

export const lifecycleRegistry = new LifecycleRegistry();

// ── Session owner identity ──────────────────────────────────────────────
// The created-panes registry is shared across all pi-shepherd processes (it
// lives in the user agent dir), so pane creation must be tagged with the
// owning parent session and session-facing views must filter by it. The owner
// id is the parent pi session's session id, bound once by the extension at
// session_start; a test/override env var wins when set.

let boundSessionOwner: string | undefined;

/**
 * Stable identity of this parent pi session for tagging owned panes.
 * Undefined when not yet bound (and no override is set).
 */
export function sessionOwner(): string | undefined {
  const override = process.env.PI_SHEPHERD_OWNER_SESSION?.trim();
  return override || boundSessionOwner;
}

/**
 * Bind (or clear) the parent session identity. Called from session_start /
 * session_shutdown; binding is idempotent so re-fire is safe.
 */
export function bindSessionOwner(id: string | undefined): void {
  if (id?.trim()) boundSessionOwner = id.trim();
  else boundSessionOwner = undefined;
}
