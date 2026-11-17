/**
 * hc implementation of the Shepherd runtime contract.
 *
 * Thin delegation layer over the hc terminal primitives in `./hc.ts`: it
 * introduces no new behavior beyond mapping the backend-neutral contract onto
 * `hc run / send / read / wait / kill` plus the shared parent-owned mailbox.
 * Every id accepted or returned here is an opaque lifecycle id; terminal
 * addresses stay internal to registry lookups (`read` resolves a handle to
 * its terminal only for the diagnostic tail).
 *
 * Channel split (documented, not magic):
 * - `spawn` boots pi via `hc run --bg` from the shared launch files.
 * - `delegate` publishes a tracked task envelope into the mailbox — the
 *   child extension polls its inbox, exactly like on the pane-based backend.
 *   Task text is never pasted into the terminal: typing into a live agent
 *   would corrupt its input.
 * - `message` without a task id pastes text with `hc send` (an untracked
 *   poke, the send/Enter analogue of a native prompt). Correlated traffic
 *   (taskId / expectsReply / replyTo) goes through the mailbox so reply
 *   correlation and waiting state stay identical on both backends.
 * - `watch` drains the mailbox for `task_done` envelopes, observes the
 *   completion sidecar, and idles efficiently on `hc wait --timeout`.
 * - `status`/`read` map onto `hc get`/`hc read`; `close` maps onto
 *   `hc kill` + `hc rm` for owned terminals only.
 * - `message` with `expectsReply` opens a tracked reply with the same
 *   `staleWaitThreshold` reminder and `timeout->blocked` settlement as the
 *   pane backend; `status` reports `waitingOn` + `stale` identically.
 *
 * Phase 2 parity: resolver wiring, expectsReply/stale/blocked parity,
 * fieldnotes bridge, docs. This module intentionally imports nothing
 * from the pane-based backend; shared transport-independent helpers arrive
 * re-exported through `./hc.ts`.
 */

import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ShepherdSession } from '../../core/artifact-sessions.ts';
import {
  finalizeArtifact,
  markArtifactStarted,
  reserveArtifacts,
  type ArtifactReservation,
} from '../../core/artifact-sessions.ts';
import type { AgentThinkingLevel } from '../../core/discovery.ts';
import {
  discoverAgents,
  resolveDelegatedModel,
  resolveDelegatedThinking,
} from '../../core/discovery.ts';
import { DEFAULT_SETTINGS, loadSettings } from '../../core/config.ts';
import { mintId, mintMessageId, normalizeHandleId } from '../../core/ids.ts';
import {
  createEnvelope,
  createParentBroker,
  hcExec,
  launchPiInHcTerminal,
  loadCreatedTerminals,
  pollParentInbox,
  publishFromParent,
  readCompletionSignal,
  readHcTerminalTail,
  readLastAssistantText,
  registerChild,
  removeCreatedTerminalDir,
  forgetCreatedTerminal,
  killHcTerminal,
  unregisterChild,
  waitForHcAgentDetected,
  HcError,
  type ChildCapability,
  type ParentBroker,
  type ShepherdMessageEnvelope,
} from './hc.ts';
import type {
  AgentHandle,
  Completion,
  MessageId,
  RuntimeProcState,
  RuntimeStatus,
  RuntimeTaskState,
  ShepherdRuntime,
  SpawnPlacement,
  TaskId,
} from '../runtime.ts';

/** Execution context captured by the adapter for the parent session it serves. */
export interface HcRuntimeContext {
  cwd?: string;
  model?: { provider: string; id: string };
  thinkingLevel?: AgentThinkingLevel;
  hasUI?: boolean;
  ui?: any;
  sessionId?: string;
  /** Parent fieldnotes session, resolved by the calling surface. */
  artifactSession?: ShepherdSession;
  /**
   * Child launch overrides (binary/command/env prefix). The Pi path omits
   * this; other hosts pass their own CLI shape here.
   */
  launch?: {
    binary?: string;
    extensionEntry?: string;
    envPrefix?: string;
    command?: string;
  };
}

export class HcRuntimeError extends Error {
  readonly code:
    | 'unknown_handle'
    | 'closed_handle'
    | 'active_task'
    | 'unknown_task'
    | 'task_agent_mismatch'
    | 'invalid_handle'
    | 'invalid_target'
    | 'invalid_task'
    | 'invalid_transition'
    | 'timeout';
  constructor(code: HcRuntimeError['code'], message: string) {
    super(message);
    this.name = 'HcRuntimeError';
    this.code = code;
  }
}

type AgentState = 'idle' | 'working' | 'blocked' | 'done' | 'failed' | 'closed';

interface AgentRecord {
  handle: {
    id: string;
    agent: string;
    label: string;
    model?: string;
    terminalId?: string;
    cwd?: string;
  };
  state: AgentState;
  activeTaskId?: string;
  completionSignalPath?: string;
  completionResultPath?: string;
  artifactSession?: ShepherdSession;
  childCapability?: ChildCapability;
  baselineCompletionSignalId?: string;
}

type InternalTaskState = 'created' | 'running' | 'waiting' | 'completed' | 'blocked' | 'failed' | 'cancelled' | 'timed_out';

interface TaskRecord {
  taskId: string;
  agentId: string;
  description: string;
  state: InternalTaskState;
  createdAt: number;
  deadlineAt?: number;
  timeoutId?: ReturnType<typeof setTimeout>;
  waitingSince?: number;
  pendingReplyMessageId?: string;
  pendingReplyTargetAgentId?: string;
  pendingReplyDeadlineAt?: number;
  pendingReplyText?: string;
  pendingRequestIds: Set<string>;
  /** Set when the stale-wait monitor has reminded for this wait episode. */
  staleNotifiedAt?: number;
  result?: TaskResultInternal;
  onSettled?: (result: TaskResultInternal) => void;
  artifactSession?: ShepherdSession;
  artifact?: ArtifactReservation;
}

interface TaskResultInternal {
  taskId: string;
  agentId: string;
  status: 'completed' | 'blocked' | 'failed' | 'cancelled' | 'timed_out';
  ok: boolean;
  returnCode: number;
  text?: string;
  error?: string;
  completedAt: number;
}

function validateAgentLabel(value: unknown): string {
  if (value == null) return '';
  if (typeof value !== 'string') throw new Error('Agent label must be a string.');
  const label = value.trim();
  if (!label) return '';
  if (label.length > 64) throw new Error('Agent label must be at most 64 characters.');
  if (!/^[\p{L}\p{N} _.-]+$/u.test(label) || label.includes(':'))
    throw new Error(
      'Agent label may contain only letters, numbers, spaces, _, -, and .; colons and control characters are not allowed.'
    );
  return label;
}

function formatAgentName(agent: string, label?: string): string {
  const trimmed = label?.trim() ?? '';
  return trimmed ? `${agent}: ${trimmed}` : agent;
}

function handleId(input: unknown, kind: 'AgentHandle' | 'TaskHandle'): string {
  const normalized = normalizeHandleId(input, kind);
  if (!normalized.ok) throw new HcRuntimeError('invalid_handle', normalized.message);
  return normalized.id;
}

function toProcState(state: string | undefined): RuntimeProcState {
  if (state === 'working') return 'working';
  if (state === 'idle') return 'idle';
  return 'unknown';
}

function toTaskState(state: InternalTaskState): RuntimeTaskState {
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

const TERMINAL_TASK_STATES: ReadonlySet<InternalTaskState> = new Set([
  'completed',
  'blocked',
  'failed',
  'cancelled',
  'timed_out',
]);

// ── Module-singleton registries ─────────────────────────────────────────
// The adapter is stateless (one per action is enough): agents, tasks, and
// the parent mailbox live here, exactly like the pane backend's lifecycle
// registry. The owned-terminals file stays the cross-process source of
// truth for ownership (close/prune). `generationId` namespaces minted
// opaque ids for this process; there is no session rotation (unlike the
// pane backend's beginSession) because one extension process serves one
// parent session at a time here.
const generationId = randomUUID().slice(0, 8);
const agents = new Map<string, AgentRecord>();
const tasks = new Map<string, TaskRecord>();
let broker: ParentBroker | undefined;
let brokerOwnerKey: string | undefined;

function ownerSessionKey(sessionId?: string): string {
  return (
    sessionId?.trim() ||
    process.env.PI_SHEPHERD_OWNER_SESSION?.trim() ||
    `hc-parent-${generationId}`
  );
}

function ensureBroker(sessionId?: string): ParentBroker {
  const key = ownerSessionKey(sessionId);
  if (broker && !broker.closed && brokerOwnerKey === key) return broker;
  broker = createParentBroker(key);
  brokerOwnerKey = key;
  return broker;
}

function settleTask(record: TaskRecord, settlement: Omit<TaskResultInternal, 'taskId' | 'agentId' | 'completedAt'> & { completedAt?: number }, options: HcSettleTaskOptions = {}): TaskResultInternal {
  if (record.result) return { ...record.result };
  const completedAt = settlement.completedAt ?? Date.now();
  const ok = settlement.status === 'completed' && settlement.ok !== false;
  const defaultReturnCode =
    settlement.status === 'cancelled'
      ? 130
      : settlement.status === 'timed_out'
        ? 124
        : settlement.status === 'blocked'
          ? 2
          : ok
            ? 0
            : 1;
  const result: TaskResultInternal = {
    taskId: record.taskId,
    agentId: record.agentId,
    status: settlement.status,
    ok,
    returnCode: settlement.returnCode ?? defaultReturnCode,
    ...(settlement.text !== undefined ? { text: settlement.text } : {}),
    ...(settlement.error !== undefined ? { error: settlement.error } : {}),
    completedAt,
  };
  record.result = result;
  record.state = settlement.status;
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
  const agent = agents.get(record.agentId);
  if (agent?.activeTaskId === record.taskId) {
    agent.activeTaskId = undefined;
    if (agent.state !== 'closed') {
      agent.state =
        settlement.status === 'completed'
          ? 'done'
          : settlement.status === 'blocked'
            ? 'blocked'
            : 'failed';
    }
  }
  try {
    finalizeTaskArtifact(record, result);
  } catch {
    /* artifact persistence must not break task settlement */
  }
  // Non-blocking watcher delivery + observer feed (pane parity): the
  // bridge owns the only ledger `record` call sites, so this path only
  // notifies watchers and then observers. The bridge records the
  // observation and schedules the idle wake, exactly like Herdr.
  const hadWatchers = notifyHcTaskWatchers(result);
  const agentHandle = agents.get(record.agentId)?.handle;
  const settlementContext: HcTaskSettlementContext = {
    hadWatchers,
    ...(agentHandle ? { agent: agentHandle.agent, label: agentHandle.label } : {}),
    ...(options.source !== undefined ? { source: options.source } : {}),
  };
  notifyHcTaskSettledObservers(result, settlementContext);
  return { ...result };
}

function resolveReplyForTask(record: TaskRecord, replyTo: string): boolean {
  if (record.result || replyTo !== record.pendingReplyMessageId) return false;
  record.pendingRequestIds.delete(record.pendingReplyMessageId!);
  record.pendingReplyMessageId = undefined;
  record.pendingReplyTargetAgentId = undefined;
  record.pendingReplyDeadlineAt = undefined;
  record.pendingReplyText = undefined;
  if (record.state === 'waiting') {
    record.state = 'running';
    record.waitingSince = undefined;
    record.staleNotifiedAt = undefined;
  }
  return true;
}

function openPendingRequest(
  record: TaskRecord,
  request: { messageId: string; targetAgentId?: string; deadlineAt?: number; text?: string }
): void {
  if (record.result) {
    throw new HcRuntimeError(
      'invalid_transition',
      `Task "${record.taskId}" is already ${record.state}.`
    );
  }
  if (record.pendingReplyMessageId !== undefined) {
    throw new HcRuntimeError(
      'invalid_task',
      `Task "${record.taskId}" already has an outstanding tracked reply (${record.pendingReplyMessageId}).`
    );
  }
  if (record.state === 'created') record.state = 'running';
  record.pendingReplyMessageId = request.messageId;
  record.pendingReplyTargetAgentId = request.targetAgentId;
  record.pendingReplyText = request.text;
  if (request.deadlineAt !== undefined && Number.isFinite(request.deadlineAt)) {
    record.pendingReplyDeadlineAt = request.deadlineAt;
  }
  record.pendingRequestIds.add(request.messageId);
  record.state = 'waiting';
  record.waitingSince ??= Date.now();
  // One stale reminder per wait episode (information only); the reply
  // deadline below stays the authoritative settlement.
  try {
    hcStaleWaitMonitor.kick();
  } catch {
    /* monitor is best effort */
  }
}

/** Best-effort rejected-completion diagnostic beside the drain's own store. */
function writeTaskDoneDiagnostic(active: ParentBroker, kind: string, envelope: ShepherdMessageEnvelope, reason: string): void {
  try {
    const dir = path.join(active.rootDir, 'rejected');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, `task-done-${kind}-${Date.now()}.json`),
      JSON.stringify({ at: Date.now(), reason, envelope }, null, 2),
      'utf8'
    );
  } catch {
    /* diagnostics must never break broker polling */
  }
}

/**
 * Apply one explicit child completion to the task registry. The envelope
 * sender is broker-authenticated; a task id that does not resolve to the
 * sender's own task is re-anchored on the sender's active task, and a
 * completion with no resolvable task is dropped observably.
 */
function applyTaskDoneEnvelope(active: ParentBroker, envelope: ShepherdMessageEnvelope): TaskResultInternal | undefined {
  if (envelope.kind !== 'task_done' || !envelope.status) return undefined;
  let record: TaskRecord | undefined;
  if (envelope.taskId) record = tasks.get(envelope.taskId);
  let senderAgentId: string | undefined;
  for (const agent of agents.values()) {
    if (agent.handle.id === envelope.senderId) {
      senderAgentId = agent.handle.id;
      break;
    }
  }
  let senderActiveTask: TaskRecord | undefined;
  if (senderAgentId !== undefined) {
    const sender = agents.get(senderAgentId);
    const candidate = sender?.activeTaskId ? tasks.get(sender.activeTaskId) : undefined;
    if (candidate && !candidate.result) senderActiveTask = candidate;
  }
  if (record && record.result) return { ...record.result };
  let effective = record;
  if (record && senderAgentId !== undefined && record.agentId !== senderAgentId) {
    effective = senderActiveTask;
  }
  if (!effective) effective = senderActiveTask;
  if (!effective || senderAgentId === undefined) {
    writeTaskDoneDiagnostic(active, 'dropped', envelope, 'no active task matches the sender');
    return undefined;
  }
  if (envelope.status === 'completed' && effective.pendingRequestIds.size > 0) return undefined;
  try {
    if (effective.agentId !== senderAgentId) {
      throw new HcRuntimeError(
        'task_agent_mismatch',
        `Agent "${senderAgentId}" does not own task "${effective.taskId}".`
      );
    }
    return settleTask(effective, {
      status: envelope.status,
      text: envelope.summary ?? envelope.content,
      error: envelope.error,
    });
  } catch {
    writeTaskDoneDiagnostic(active, 'dropped', envelope, `settlement of "${effective.taskId}" was rejected`);
    return undefined;
  }
}

// The drain's broker is threaded through: resolving a *separate* broker
// here (bare `ensureBroker()`) would mint a fallback-keyed store, orphan
// the session mailbox, and address reply relays to a store the child
// never polls.
function applyMessageEnvelope(active: ParentBroker, envelope: ShepherdMessageEnvelope): void {
  switch (envelope.kind) {
    case 'runtime': {
      if (envelope.replyReceived === true && envelope.taskId && envelope.replyTo) {
        const record = tasks.get(envelope.taskId);
        if (record) resolveReplyForTask(record, envelope.replyTo);
        return;
      }
      if (envelope.requestOpen === true && envelope.taskId && envelope.replyTo) {
        const record = tasks.get(envelope.taskId);
        if (record && !record.result && record.pendingReplyMessageId !== envelope.replyTo) {
          try {
            openPendingRequest(record, {
              messageId: envelope.replyTo,
              targetAgentId: envelope.requestTargetId,
              text: envelope.summary ?? envelope.content,
            });
          } catch {
            /* one outstanding request per task; keep the first */
          }
        }
      }
      return;
    }
    case 'reply': {
      if (envelope.replyTo && envelope.taskId) {
        const record = tasks.get(envelope.taskId);
        if (record && resolveReplyForTask(record, envelope.replyTo)) {
          if (record.agentId !== envelope.senderId) {
            const owner = agents.get(record.agentId);
            if (owner?.handle.terminalId) {
              try {
                const relayed = createEnvelope(
                  { sessionId: active.sessionId, brokerId: active.brokerId, senderId: active.parentId },
                  {
                    kind: 'reply',
                    targetId: owner.handle.id,
                    messageId: mintMessageId(),
                    taskId: envelope.taskId,
                    threadId: envelope.threadId,
                    replyTo: envelope.replyTo,
                    originSenderId: envelope.senderId,
                    delivery: envelope.delivery,
                    content: envelope.content,
                  }
                );
                publishFromParent(active, relayed);
              } catch {
                /* relay is best effort; the requester task already resolved */
              }
            }
          }
        }
      }
      return;
    }
    default:
      return;
  }
}

/** Drain the parent mailbox; task completions settle the registry. */
function drainHcSessionInbox(sessionId?: string): void {
  const active = ensureBroker(sessionId);
  let envelopes: ShepherdMessageEnvelope[];
  try {
    envelopes = pollParentInbox(active);
  } catch {
    return;
  }
  for (const envelope of envelopes) {
    try {
      if (envelope.kind === 'task_done') applyTaskDoneEnvelope(active, envelope);
      else applyMessageEnvelope(active, envelope);
    } catch {
      /* one bad envelope must not stop the drain */
    }
  }
  settleDueReplyTimeouts();
}

/** Settle waiting tasks whose tracked-reply deadline has passed. */
function settleDueReplyTimeouts(now = Date.now()): void {
  for (const record of tasks.values()) {
    if (record.result) continue;
    if (
      record.state === 'waiting' &&
      record.pendingReplyDeadlineAt !== undefined &&
      now >= record.pendingReplyDeadlineAt
    ) {
      settleTask(record, {
        status: 'blocked',
        ok: false,
        text: `Timed out waiting for a reply from ${record.pendingReplyTargetAgentId ?? 'the target agent'} (message ${record.pendingReplyMessageId ?? 'unknown'} never answered).`,
        error: 'Tracked reply deadline reached.',
      });
    }
  }
}

// ── 011: background inbox poll ──────────────────────────────────────────
// Herdr parity: the pane backend polls the parent inbox every 250 ms, so
// completions settle while the Shepherd is idle. hc drains only inside
// tool calls; this timer pumps the same session-keyed drain in the
// background. The tick never settles directly and never mints a broker:
// unresolvable sessions are skipped, never fallback-keyed.
const HC_DRAIN_POLL_MS = 250;
// Single session: the hc runtime is single-session-per-process (the module
// `generationId` is baked into every agent/task id), so the poller tracks
// one session key. A set would alternate `ensureBroker` keys and mint a
// fresh store on every drain instead of polling the live mailbox.
let hcPollSession: string | undefined;
let hcDrainTimer: ReturnType<typeof setInterval> | undefined;

function startHcInboxPoller(): void {
  if (hcDrainTimer) return;
  hcDrainTimer = setInterval(() => {
    try {
      pollHcInboxOnce();
    } catch {
      /* a tick must never break the host turn */
    }
  }, HC_DRAIN_POLL_MS);
  (hcDrainTimer as any).unref?.();
}

export function stopHcInboxPoller(): void {
  if (hcDrainTimer) clearInterval(hcDrainTimer);
  hcDrainTimer = undefined;
}

export function isHcInboxPollerRunning(): boolean {
  return hcDrainTimer !== undefined;
}

/**
 * Register a session with possibly-open work; starts the poller. Resolves
 * through `ownerSessionKey` exactly like the drains, so the tick always
 * polls the same store the tool calls use (explicit id, env session, or
 * the process fallback — never skipped, never a different key).
 */
export function registerHcPollSession(sessionId?: string): void {
  hcPollSession = ownerSessionKey(sessionId);
  startHcInboxPoller();
}

/** One synchronous poll pass over the registered session, then stop at quiescence. */
export function pollHcInboxOnce(): void {
  if (hcPollSession !== undefined) {
    try {
      drainHcSessionInbox(hcPollSession);
    } catch {
      /* a bad session drain must not stop the pass */
    }
  }
  for (const record of tasks.values()) {
    if (!record.result) return;
  }
  stopHcInboxPoller();
}

/**
 * Drain-first entry for read paths (`watch` registration, `status` view):
 * returns false without touching anything when no session resolves, so a
 * read can never mint a fallback-keyed broker.
 */
export function drainHcInboxForSession(sessionId?: string): boolean {
  const id = sessionId?.trim();
  if (!id) return false;
  drainHcSessionInbox(id);
  return true;
}

/** Test seam (011 suite): isolated agent/task fixtures for real-settlement ticks. */
export function hcInjectTestAgent(agent: AgentRecord): void {
  agents.set(agent.handle.id, agent);
}
export function hcInjectTestTask(task: TaskRecord): void {
  tasks.set(task.taskId, task);
}
export function hcRemoveTestAgent(agentId: string): void {
  agents.delete(agentId);
}
export function hcRemoveTestTask(taskId: string): void {
  tasks.delete(taskId);
}

/** Test seam: lifecycle + unref visibility without wall-clock waits. */
export function hcInboxPollerStateForTests(): {
  running: boolean;
  session: string | undefined;
  unrefed: boolean | undefined;
} {
  let unrefed: boolean | undefined;
  try {
    unrefed =
      hcDrainTimer === undefined
        ? undefined
        : typeof (hcDrainTimer as any).hasRef === 'function'
          ? !(hcDrainTimer as any).hasRef()
          : undefined;
  } catch {
    unrefed = undefined;
  }
  return { running: hcDrainTimer !== undefined, session: hcPollSession, unrefed };
}

// ── Phase 2 parity: stale-wait monitor + non-blocking task watchers ──────
// Mirrors the pane-based backend's stale-wait monitor and task-watcher
// service over the module hc registries. The
// monitor is information only (never a settlement); reply deadlines remain
// the authoritative `blocked` settlement. Watchers are non-blocking: `watch`
// registers synchronously and later completions arrive via the notifier,
// exactly like the pane backend's task-watcher bridge.

export interface HcStaleWaitInfo {
  taskId: string;
  agentId: string;
  agent?: string;
  label?: string;
  description: string;
  waitingSince: number;
  elapsedMs: number;
  requestMessageId: string;
  question: string;
  recipientId?: string;
  recipientName?: string;
  recipientState?: string;
  thresholdMinutes: number;
}

export type HcStaleWaitNotifier = (info: HcStaleWaitInfo) => void | Promise<void>;

class HcStaleWaitMonitor {
  private timer?: ReturnType<typeof setInterval>;
  private notifier?: HcStaleWaitNotifier;
  private readonly intervalMs: number;

  constructor(notifier?: HcStaleWaitNotifier, intervalMs = 1_000) {
    this.notifier = notifier;
    this.intervalMs = intervalMs;
  }

  kick(): void {
    this.ensureStarted();
    void this.poll();
  }

  shutdown(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  setNotifier(notifier?: HcStaleWaitNotifier): void {
    this.notifier = notifier;
  }

  private ensureStarted(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.poll(), this.intervalMs);
    (this.timer as any).unref?.();
  }

  private maybeStop(): void {
    const waiting = [...tasks.values()].some(t => t.state === 'waiting' && !t.result);
    if (!waiting && this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  async poll(): Promise<void> {
    const now = Date.now();
    const waiting = [...tasks.values()].filter(t => t.state === 'waiting' && !t.result);
    if (waiting.length === 0) {
      this.maybeStop();
      return;
    }
    for (const task of waiting) {
      const thresholdMinutes = (() => {
        try {
          const agent = agents.get(task.agentId);
          return loadSettings(agent?.handle.cwd ?? process.cwd()).staleWaitThreshold;
        } catch {
          return DEFAULT_SETTINGS.staleWaitThreshold;
        }
      })();
      if (thresholdMinutes < 1) continue;
      if (now - (task.waitingSince ?? now) < thresholdMinutes * 60_000) continue;
      if (task.staleNotifiedAt !== undefined) continue;
      const elapsedMs = now - (task.waitingSince ?? now);
      const owner = agents.get(task.agentId);
      let recipientName: string | undefined;
      let recipientState: string | undefined;
      if (task.pendingReplyTargetAgentId) {
        const recipient = agents.get(task.pendingReplyTargetAgentId);
        if (recipient) {
          recipientName = recipient.handle.label
            ? `${recipient.handle.agent}: ${recipient.handle.label}`
            : recipient.handle.agent;
          recipientState = recipient.state;
        }
      }
      const info: HcStaleWaitInfo = {
        taskId: task.taskId,
        agentId: task.agentId,
        ...(owner ? { agent: owner.handle.agent, label: owner.handle.label } : {}),
        description: task.description,
        waitingSince: task.waitingSince ?? now,
        elapsedMs,
        requestMessageId: task.pendingReplyMessageId ?? '',
        question: task.pendingReplyText ?? '',
        ...(task.pendingReplyTargetAgentId ? { recipientId: task.pendingReplyTargetAgentId } : {}),
        ...(recipientName ? { recipientName } : {}),
        ...(recipientState ? { recipientState } : {}),
        thresholdMinutes,
      };
      try {
        task.staleNotifiedAt = Date.now();
        const result = this.notifier?.(info);
        if (result && typeof (result as Promise<void>).catch === 'function') {
          (result as Promise<void>).catch(() => undefined);
        }
      } catch {
        // Best effort; reply deadline stays authoritative.
      }
    }
    this.maybeStop();
  }
}

export const hcStaleWaitMonitor = new HcStaleWaitMonitor();

export function configureHcStaleWaitNotifications(notifier?: HcStaleWaitNotifier): void {
  hcStaleWaitMonitor.setNotifier(notifier);
}

export function shutdownHcStaleWaitMonitor(): void {
  hcStaleWaitMonitor.shutdown();
  stopHcInboxPoller();
}

// ── Non-blocking hc task watchers (shepherd_watch parity) ─────────────────
// `HcRuntime.watch` blocks; the `shepherd_watch` tool must return at once
// and deliver later completions via notification. This registry mirrors
// `LifecycleRegistry.watchTasks` + `TaskWatcherService`: synchronous
// registration with already-settled sync delivery, exactly-once later
// delivery per task, and unseen-ledger feed for watcher-less settlements.

export interface HcTaskWatcherRegistration {
  watcherId: string;
  taskIds: string[];
  pending: string[];
  completed: TaskResultInternal[];
}

export type HcTaskWatcherCompletion = TaskResultInternal & { agent?: string; label?: string };
export type HcTaskWatcherCallback = (completion: HcTaskWatcherCompletion) => void;

const hcWatchers = new Map<
  string,
  {
    kind: 'task';
    taskIds: string[];
    pending: Set<string>;
    callback?: HcTaskWatcherCallback | HcTaskWatcherCallback[];
    delivered: Set<string>;
  }
>();
const hcTaskWatchers = new Map<string, Set<string>>();

function hcCompletionFor(taskId: string): HcTaskWatcherCompletion | undefined {
  const record = tasks.get(taskId);
  if (!record?.result) return undefined;
  const agent = agents.get(record.agentId);
  return {
    ...record.result,
    ...(agent ? { agent: agent.handle.agent, label: agent.handle.label } : {}),
  };
}

/** Synchronous registration; already-settled tasks deliver immediately. */
export function watchHcTasks(
  handles: string | string[],
  callback?: HcTaskWatcherCallback | HcTaskWatcherCallback[]
): HcTaskWatcherRegistration {
  const values = Array.isArray(handles) ? handles : [handles];
  if (values.length === 0) {
    throw new HcRuntimeError('invalid_handle', 'Expected one or more opaque task ids to watch.');
  }
  const taskIds = values.map(value => {
    const id = handleId(value, 'TaskHandle');
    const record = tasks.get(id);
    if (!record) {
      throw new HcRuntimeError(
        'unknown_task',
        `Unknown task id "${id}". Task ids are scoped to this parent session; use the id returned by shepherd_delegate, not an agent id or terminal address.`
      );
    }
    return record.taskId;
  });
  if (new Set(taskIds).size !== taskIds.length) {
    throw new HcRuntimeError('invalid_handle', 'A watcher cannot contain duplicate task ids.');
  }
  const watcherId = mintId('watch', generationId);
  const pending = new Set<string>();
  const completed: TaskResultInternal[] = [];
  const deliver = (completion: HcTaskWatcherCompletion): void => {
    if (Array.isArray(callback)) {
      for (const one of callback) one(completion);
    } else callback?.(completion);
  };
  for (const taskId of taskIds) {
    const done = hcCompletionFor(taskId);
    if (done) completed.push({ ...done });
    else pending.add(taskId);
  }
  if (pending.size > 0) {
    hcWatchers.set(watcherId, {
      kind: 'task',
      taskIds: [...taskIds],
      pending,
      callback,
      delivered: new Set(),
    });
    for (const taskId of pending) {
      let watchers = hcTaskWatchers.get(taskId);
      if (!watchers) hcTaskWatchers.set(taskId, (watchers = new Set()));
      watchers.add(watcherId);
    }
    // Synchronous already-settled delivery must still flow through the
    // notifier path so `shepherd_watch` sees uniform completions.
    for (const done of completed) {
      try {
        deliver({ ...done });
      } catch {
        /* delivery must not break registration */
      }
    }
  }
  return { watcherId, taskIds: [...taskIds], pending: [...pending], completed };
}

/** Deliver one settlement to watchers; returns whether anyone observed it. */
function notifyHcTaskWatchers(result: TaskResultInternal): boolean {
  const watcherIds = [...(hcTaskWatchers.get(result.taskId) ?? [])];
  hcTaskWatchers.delete(result.taskId);
  const agent = agents.get(result.agentId);
  let hadWatchers = false;
  for (const watcherId of watcherIds) {
    const watcher = hcWatchers.get(watcherId);
    if (!watcher || watcher.delivered.has(result.taskId)) continue;
    watcher.delivered.add(result.taskId);
    watcher.pending.delete(result.taskId);
    try {
      const delivery: HcTaskWatcherCompletion = {
        ...result,
        ...(agent ? { agent: agent.handle.agent, label: agent.handle.label } : {}),
      };
      const cb = watcher.callback;
      if (Array.isArray(cb)) {
        for (const one of cb) one(delivery);
      } else cb?.(delivery);
    } catch {
      /* notification delivery must not break settlement */
    }
    if (watcher.callback !== undefined) hadWatchers = true;
    if (watcher.pending.size === 0) hcWatchers.delete(watcherId);
  }
  return hadWatchers;
}

/** Internal source tags for settlements that are not unseen-at-source. */
export type HcTaskSettlementSource = 'delegate-submission-failure';

/**
 * Context attached to each hc settlement observation.
 *
 * `hadWatchers` is true only when at least one hc task-watcher callback was
 * actually invoked for this settlement. `agent`/`label` come from the settled
 * agent's handle. `source` marks settlements callers must not treat as unseen
 * completions (a delegate submission failure is already reported in the
 * `shepherd_delegate` tool result).
 */
export interface HcTaskSettlementContext {
  hadWatchers: boolean;
  agent?: string;
  label?: string;
  source?: HcTaskSettlementSource;
}

/** One hc settlement observation; see {@link onTaskSettled}. */
export type HcTaskSettledListener = (result: TaskResultInternal, context: HcTaskSettlementContext) => void;

/** Internal settle options; only the delegate failure path passes `source`. */
export interface HcSettleTaskOptions {
  source?: HcTaskSettlementSource;
}

const hcSettlementListeners = new Set<HcTaskSettledListener>();

/**
 * Registry contract: observe hc settlements that reach a terminal task state.
 *
 * Mirrors the pane-backend registry `onTaskSettled` contract: the listener fires once per actual
 * transition into a terminal task state, after the hc watcher fan-out, with
 * a shallow copy of the result and a fresh context. Listener failures are
 * swallowed and can never affect settlement; with no listener subscribed,
 * `settleTask` behaves exactly as before. Prompt (legacy) settlements are not
 * observed (the hc runtime has no prompt path).
 */
export function onTaskSettled(listener: HcTaskSettledListener): () => void {
  hcSettlementListeners.add(listener);
  return () => {
    hcSettlementListeners.delete(listener);
  };
}

/**
 * Deliver one terminal settlement to `onTaskSettled` subscribers, each with
 * its own shallow copy of the result and context. Listener failures are
 * swallowed and can never affect settlement. Called by the settle path after
 * the hc watcher fan-out; exported so observer parity is unit-testable
 * without a live terminal (mirrors the pane-backend settle listener loop).
 */
export function notifyHcTaskSettledObservers(
  result: TaskResultInternal,
  context: HcTaskSettlementContext
): void {
  for (const listener of [...hcSettlementListeners]) {
    try {
      listener({ ...result }, { ...context });
    } catch {
      /* settlement observation must not break settlement */
    }
  }
}

export type HcTaskWatcherNotifier = (notification: {
  watcherId: string;
  completions: HcTaskWatcherCompletion[];
}) => void | Promise<void>;

/** Coalescing non-blocking delivery bridge (mirrors TaskWatcherService). */
class HcTaskWatcherService {
  private notifier?: HcTaskWatcherNotifier;
  private readonly coalesceMs: number;
  private readonly queued = new Map<string, HcTaskWatcherCompletion[]>();
  private readonly order = new Map<string, Map<string, number>>();
  private readonly remaining = new Map<string, number>();
  private readonly flushTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(notifier?: HcTaskWatcherNotifier, coalesceMs = 25) {
    this.notifier = notifier;
    this.coalesceMs = coalesceMs;
  }

  setNotifier(notifier?: HcTaskWatcherNotifier): void {
    this.notifier = notifier;
  }

  watch(handles: string | string[]): HcTaskWatcherRegistration {
    let watcherId = '';
    const registration = watchHcTasks(handles, completion => {
      this.queue(watcherId, completion);
    });
    watcherId = registration.watcherId;
    if (registration.pending.length > 0) {
      this.order.set(
        watcherId,
        new Map(registration.taskIds.map((taskId, index) => [taskId, index]))
      );
      this.remaining.set(watcherId, registration.pending.length);
    }
    return registration;
  }

  shutdown(): void {
    for (const timer of this.flushTimers.values()) clearTimeout(timer);
    this.flushTimers.clear();
    this.queued.clear();
    this.order.clear();
    this.remaining.clear();
    hcWatchers.clear();
    hcTaskWatchers.clear();
  }

  private queue(watcherId: string, completion: HcTaskWatcherCompletion): void {
    if (!watcherId) return;
    const list = this.queued.get(watcherId) ?? [];
    list.push({ ...completion });
    this.queued.set(watcherId, list);
    const remaining = this.remaining.get(watcherId);
    if (remaining !== undefined) this.remaining.set(watcherId, Math.max(0, remaining - 1));
    if (!this.flushTimers.has(watcherId)) {
      const timer = setTimeout(() => this.flush(watcherId), this.coalesceMs);
      (timer as any).unref?.();
      this.flushTimers.set(watcherId, timer);
    }
  }

  private flush(watcherId: string): void {
    this.flushTimers.delete(watcherId);
    const completions = this.queued.get(watcherId);
    this.queued.delete(watcherId);
    if (!completions || completions.length === 0) return;
    const order = this.order.get(watcherId);
    if (order) {
      completions.sort(
        (left, right) =>
          (order.get(left.taskId) ?? Number.MAX_SAFE_INTEGER) -
          (order.get(right.taskId) ?? Number.MAX_SAFE_INTEGER)
      );
    }
    if (this.remaining.get(watcherId) === 0) {
      this.order.delete(watcherId);
      this.remaining.delete(watcherId);
    }
    try {
      const result = this.notifier?.({ watcherId, completions });
      if (result && typeof (result as Promise<void>).catch === 'function') {
        (result as Promise<void>).catch(() => undefined);
      }
    } catch {
      // Durable result; missing bridge must not corrupt settlement.
    }
  }
}

export const hcTaskWatcherService = new HcTaskWatcherService();

export function configureHcTaskWatcherNotifications(notifier?: HcTaskWatcherNotifier): void {
  hcTaskWatcherService.setNotifier(notifier);
}

export function shutdownHcTaskWatchers(): void {
  hcTaskWatcherService.shutdown();
  stopHcInboxPoller();
}

/** True when the id names a known hc task (tool routing, not a contract). */
export function isHcTaskId(id: unknown): boolean {
  if (typeof id !== 'string' || !id) return false;
  return tasks.has(id);
}

/**
 * Tool-facing status view for an hc sheep: lifecycle state plus the active
 * tracked task with the same fields the pane-backend tool reports (waiting
 * age, pending request, waiting recipient, stale flag). Returns undefined
 * task when no open task exists.
 */
export function describeHcStatusView(agentId: string): {
  handle: { id: string; agent: string; label: string };
  state: AgentState;
  task?: {
    id: string;
    state: InternalTaskState;
    description: string;
    waitingSince?: number;
    waitingMs?: number;
    pendingRequestMessageId?: string;
    waitingRecipient?: string;
    stale?: boolean;
  };
} {
  const id = handleId(agentId, 'AgentHandle');
  const record = agents.get(id);
  if (!record) {
    throw new HcRuntimeError(
      'unknown_handle',
      `Unknown agent id "${id}". Lifecycle ids are scoped to this parent session; use the id from the latest spawn result.`
    );
  }
  let taskView: ReturnType<typeof describeHcStatusView>['task'];
  const open = record.activeTaskId ? tasks.get(record.activeTaskId) : undefined;
  if (open && !open.result) {
    let waitingRecipient: string | undefined;
    if (open.pendingReplyTargetAgentId) {
      const recipient = agents.get(open.pendingReplyTargetAgentId);
      waitingRecipient = recipient
        ? recipient.handle.label
          ? `${recipient.handle.agent}: ${recipient.handle.label}`
          : recipient.handle.agent
        : open.pendingReplyTargetAgentId;
    }
    taskView = {
      id: open.taskId,
      state: open.state,
      description: open.description,
      ...(open.waitingSince !== undefined
        ? { waitingSince: open.waitingSince, waitingMs: Math.max(0, Date.now() - open.waitingSince) }
        : {}),
      ...(open.pendingReplyMessageId ? { pendingRequestMessageId: open.pendingReplyMessageId } : {}),
      ...(waitingRecipient ? { waitingRecipient } : {}),
      ...(open.staleNotifiedAt !== undefined ? { stale: true as const } : {}),
    };
  }
  return {
    handle: { id: record.handle.id, agent: record.handle.agent, label: record.handle.label },
    state: record.state,
    ...(taskView ? { task: taskView } : {}),
  };
}

/**
 * Non-contract introspection for the resolver seam: display identity for a
 * known hc agent. Unknown ids throw, exactly like the registry lookups
 * behind every other method. Records are retained after close so a closed
 * sheep still describes itself (mirrors the pane-backend registry).
 */
export function describeHcAgent(agentId: string): {
  id: string;
  agent: string;
  label: string;
  model?: string;
} {
  const id = handleId(agentId, 'AgentHandle');
  const record = agents.get(id);
  if (!record) {
    throw new HcRuntimeError(
      'unknown_handle',
      `Unknown agent id "${id}". Lifecycle ids are scoped to this parent session; use the id from the latest spawn result. A terminal address is not an agent id.`
    );
  }
  return {
    id: record.handle.id,
    agent: record.handle.agent,
    label: record.handle.label,
    ...(record.handle.model ? { model: record.handle.model } : {}),
  };
}

/**
 * Resolve a diagnostic read target to an opaque hc agent id: exact id first,
 * then display identity (`agent`, `agent: label`, label), then owned
 * terminal name/address. Returns undefined when nothing matches (the caller
 * surfaces the backend's useful not-found error).
 */
export function resolveHcAgentId(target: string): string | undefined {
  if (agents.has(target)) return target;
  for (const record of agents.values()) {
    const display = record.handle.label
      ? `${record.handle.agent}: ${record.handle.label}`
      : record.handle.agent;
    if (
      record.handle.agent === target ||
      record.handle.label === target ||
      display === target
    ) {
      return record.handle.id;
    }
  }
  try {
    const match = loadCreatedTerminals().find(t => t.terminalId === target || t.name === target);
    if (match) {
      for (const record of agents.values()) {
        if (record.handle.terminalId === match.terminalId) return record.handle.id;
      }
    }
  } catch {
    /* registry read is best effort */
  }
  return undefined;
}

/**
 * Build the hc runtime adapter for one parent session context. Stateless:
 * registries live at module scope so per-action instances share sheep.
 */
export function createHcRuntime(context: HcRuntimeContext = {}): ShepherdRuntime {
  const cwd = context.cwd ?? process.cwd();
  const sessionId = context.sessionId;

  function canonicalAgent(input: unknown): AgentRecord {
    const id = handleId(input, 'AgentHandle');
    const record = agents.get(id);
    if (!record)
      throw new HcRuntimeError(
        'unknown_handle',
        `Unknown agent id "${id}". Lifecycle ids are scoped to this parent session; use the id from the latest spawn result. A terminal address is not an agent id.`
      );
    return record;
  }

  function taskRecord(input: unknown): TaskRecord {
    const id = handleId(input, 'TaskHandle');
    const record = tasks.get(id);
    if (!record) {
      throw new HcRuntimeError(
        'unknown_task',
        `Unknown task id "${id}". Task ids are scoped to this parent session; use the id returned by shepherd_delegate, not an agent id or terminal address.`
      );
    }
    return record;
  }

  function toCompletion(result: TaskResultInternal): Completion {
    const agent = agents.get(result.agentId);
    return {
      taskId: result.taskId,
      agentId: result.agentId,
      status: result.status,
      ok: result.ok,
      returnCode: result.returnCode,
      ...(result.text !== undefined ? { text: result.text } : {}),
      ...(result.error !== undefined ? { error: result.error } : {}),
      completedAt: result.completedAt,
      ...(agent ? { agent: agent.handle.agent } : {}),
      ...(agent && agent.handle.label ? { label: agent.handle.label } : {}),
    };
  }

  function finalizeTaskArtifact(record: TaskRecord, result: TaskResultInternal): void {
    const { artifactSession, artifact } = record;
    if (!artifactSession || !artifact) return;
    const status =
      result.status === 'timed_out'
        ? 'timed-out'
        : result.status === 'cancelled'
          ? 'cancelled'
          : result.status === 'completed'
            ? 'completed'
            : 'failed';
    finalizeArtifact(artifactSession, artifact, { status, output: result.text, error: result.error });
  }

  /** Closure thin wrapper: tool-call drains keep their exact behavior. */
  function drainBrokerInbox(): void {
    drainHcSessionInbox(sessionId);
  }

  async function terminalState(terminalId: string): Promise<{ live: boolean; agentState?: string }> {
    try {
      const rec = (await hcExec(['get', terminalId, '--json'])) as any;
      const agentState =
        typeof rec?.status?.state === 'string' ? (rec.status.state as string) : undefined;
      return { live: rec?.state === 'live', agentState };
    } catch (error) {
      if (error instanceof HcError && error.kind === 'not_found') return { live: false };
      return { live: true };
    }
  }

  async function settleFromSignal(record: TaskRecord): Promise<TaskResultInternal | undefined> {
    const agent = agents.get(record.agentId);
    const signalPath = agent?.completionSignalPath;
    if (!signalPath) return undefined;
    const signal: any = readCompletionSignal(signalPath);
    if (!signal?.signalId) return undefined;
    if (signal.taskId !== undefined && signal.taskId !== record.taskId) return undefined;
    if (signal.taskId === undefined && signal.signalId === agent?.baselineCompletionSignalId) {
      return undefined;
    }
    const status = signal.type === 'error' ? 'failed' : 'completed';
    let text: string | undefined =
      typeof signal.summary === 'string' && signal.summary ? signal.summary : undefined;
    if (!text && agent?.completionResultPath) {
      const last = readLastAssistantText(agent.completionResultPath).trim();
      if (last) text = last;
    }
    if (!text && agent?.handle.terminalId) {
      const tail = (await readHcTerminalTail(agent.handle.terminalId)).trim();
      if (tail) text = tail;
    }
    return settleTask(record, {
      status: status as 'completed' | 'failed',
      ...(text !== undefined ? { text } : {}),
      ...(signal.errorMessage !== undefined ? { error: String(signal.errorMessage) } : {}),
    });
  }

  return {
    async spawn(def, opts) {
      const label = validateAgentLabel(opts.label);
      const spawnCwd = opts.cwd ?? cwd;
      const settings = loadSettings(spawnCwd);
      // Placement is accepted and ignored: hc terminals have no panes/tabs;
      // the sheep always starts as a background terminal in the cwd.
      const _placement: SpawnPlacement | undefined = opts.placement;
      void _placement;
      const discovered = discoverAgents(spawnCwd, settings.agentScope, {
        includeBundled: settings.includeBundledAgents,
      }).agents;
      const found = discovered.find(a => a.name === def.name);
      if (!found) {
        const available = discovered.map(a => a.name).join(', ');
        const suggestion = discovered.find(
          a => a.name.toLowerCase() === def.name.trim().toLowerCase()
        );
        throw new Error(
          `Unknown agent "${def.name}" in ${settings.agentScope} scope.` +
            (suggestion ? ` Did you mean "${suggestion.name}"?` : '') +
            (available ? ` Available agents: ${available}.` : ' No agents are available.') +
            ' Call shepherd with action "agents" to list exact names.'
        );
      }
      if (found.source === 'project' && settings.confirmProjectAgents && context.hasUI) {
        const ok = await context.ui.confirm(
          'Run project-local agent?',
          `Agent: ${def.name}\nSource: ${found.filePath}`
        );
        if (!ok) throw new Error('Project-local agent was not approved.');
      }
      const display = formatAgentName(found.name, label);
      if (
        label &&
        [...agents.values()].some(
          a => formatAgentName(a.handle.agent, a.handle.label) === display
        )
      ) {
        throw new Error(`Duplicate agent label "${display}".`);
      }
      const active = ensureBroker(sessionId);
      const reservedAgentId = mintId('agent', generationId);
      const childCapability = registerChild(active, reservedAgentId);
      const delegatedModel = resolveDelegatedModel(found.model, context.model);
      const delegatedThinking = resolveDelegatedThinking(found.thinking, context.thinkingLevel);
      let launched: { terminalId: string; dir: string; sessionFile: string; scriptFile: string } | undefined;
      try {
        launched = launchPiInHcTerminal(found.name, {
          name: found.name,
          label,
          cwd: spawnCwd,
          persistent: true,
          childBroker: { rootDir: active.rootDir, ...childCapability },
          systemPrompt: found.systemPrompt,
          omitSystemPrompt: found.omitSystemPrompt,
          omitPiDocumentation: found.omitPiDocumentation === true,
          omitContextFiles: found.omitContextFiles === true,
          model: delegatedModel,
          thinking: delegatedThinking,
          tools: found.tools,
          // Host launch overrides (other hosts boot their own CLI); Pi omits.
          ...(context.launch?.binary !== undefined ? { binary: context.launch.binary } : {}),
          ...(context.launch?.extensionEntry !== undefined
            ? { extensionEntry: context.launch.extensionEntry }
            : {}),
          ...(context.launch?.envPrefix !== undefined
            ? { envPrefix: context.launch.envPrefix }
            : {}),
          ...(context.launch?.command !== undefined ? { command: context.launch.command } : {}),
        });
        const ready = await waitForHcAgentDetected(launched.terminalId, { timeoutMs: 20_000 });
        if (!ready.detected) {
          const output = (await readHcTerminalTail(launched.terminalId)).trim();
          const suffix = ready.exitCode === undefined ? '' : ` (return code ${ready.exitCode})`;
          throw Object.assign(
            new Error(`Agent "${found.name}" did not become ready${suffix}.${output ? `\n${output}` : ''}`),
            { returnCode: ready.exitCode ?? 1, code: 'agent_not_ready' }
          );
        }
      } catch (error) {
        if (launched) {
          try {
            killHcTerminal(launched.terminalId);
          } catch {}
          removeCreatedTerminalDir(launched.terminalId);
          forgetCreatedTerminal(launched.terminalId);
        }
        try {
          unregisterChild(active, reservedAgentId);
        } catch {}
        throw error;
      }
      const id = reservedAgentId;
      const signalPath = `${launched!.sessionFile}.exit`;
      const baseline = readCompletionSignal(signalPath)?.signalId;
      agents.set(id, {
        handle: {
          id,
          agent: found.name,
          label,
          ...(delegatedModel ? { model: delegatedModel } : {}),
          terminalId: launched.terminalId,
          cwd: spawnCwd,
        },
        state: 'idle',
        completionSignalPath: signalPath,
        completionResultPath: launched.sessionFile,
        artifactSession: context.artifactSession,
        childCapability,
        baselineCompletionSignalId: baseline,
      });
      return id;
    },

    async delegate(agentId, task, opts) {
      if (typeof task !== 'string' || !task.trim())
        throw new HcRuntimeError('invalid_task', 'Delegated task description must not be empty.');
      const agent = canonicalAgent(agentId);
      if (agent.state === 'closed') {
        throw new HcRuntimeError('closed_handle', `Agent "${agent.handle.id}" is closed.`);
      }
      if (!agent.handle.terminalId) throw new Error('Agent handle has no terminal.');
      const detected = await waitForHcAgentDetected(agent.handle.terminalId, { timeoutMs: 15_000 });
      if (!detected.detected) throw new Error(`Agent "${agent.handle.id}" is not detected.`);
      if (agent.activeTaskId) {
        throw new HcRuntimeError(
          'active_task',
          `Agent "${agent.handle.id}" already has an active tracked task (${agent.activeTaskId}).`
        );
      }
      const active = ensureBroker(sessionId);
      if (!agent.childCapability) {
        agent.childCapability = registerChild(active, agent.handle.id);
      }
      const createdAt = Date.now();
      const id = mintId('task', generationId);
      const deadlineAt =
        opts.timeoutMin !== undefined ? createdAt + opts.timeoutMin * 60_000 : undefined;
      if (deadlineAt !== undefined && !Number.isFinite(deadlineAt)) {
        throw new HcRuntimeError('invalid_task', 'Task timeout must be a finite number.');
      }
      // `requestId` has no mailbox dedup equivalent: a retried submit is a
      // second call by design here.
      void opts.requestId;
      const record: TaskRecord = {
        taskId: id,
        agentId: agent.handle.id,
        description: task.trim(),
        state: 'created',
        createdAt,
        ...(deadlineAt !== undefined ? { deadlineAt } : {}),
        pendingRequestIds: new Set(),
        artifactSession: context.artifactSession ?? agent.artifactSession,
      };
      tasks.set(id, record);
      // 011: the background poll covers this session while work is open.
      registerHcPollSession(sessionId);
      agent.activeTaskId = id;
      agent.baselineCompletionSignalId = agent.completionSignalPath
        ? (readCompletionSignal(agent.completionSignalPath)?.signalId ??
          agent.baselineCompletionSignalId)
        : undefined;
      if (deadlineAt !== undefined) {
        const delay = Math.max(0, deadlineAt - Date.now());
        record.timeoutId = setTimeout(() => {
          // Drain-first: a `task_done` already queued in the parent inbox
          // wins over the bare deadline (mirrors the `watch`-loop
          // drain-then-check order; 010 §3). A genuinely late done still
          // loses: `settleTask` on an already-terminal record is a no-op.
          drainBrokerInbox();
          if (!record.result) {
            settleTask(record, { status: 'timed_out', error: 'Tracked task deadline reached.' });
          }
        }, delay);
        (record.timeoutId as any).unref?.();
      }
      const session = record.artifactSession;
      try {
        if (session) {
          const artifact = reserveArtifacts(session, [
            { agent: agent.handle.agent, mode: 'single', task },
          ])[0];
          markArtifactStarted(session, artifact, { taskId: id, agentId: agent.handle.id });
          record.artifactSession = session;
          record.artifact = artifact;
          record.onSettled = result => finalizeTaskArtifact(record, result);
        }
        const envelope = createEnvelope(
          { sessionId: active.sessionId, brokerId: active.brokerId, senderId: active.parentId },
          {
            kind: 'task',
            targetId: agent.handle.id,
            taskId: id,
            delivery: 'followUp',
            content: task,
          }
        );
        publishFromParent(active, envelope);
        record.state = 'running';
        return id;
      } catch (error) {
        settleTask(
          record,
          {
            status: 'failed',
            error: String((error as any)?.message ?? error),
          },
          { source: 'delegate-submission-failure' }
        );
        throw new Error(`Task submission failed: ${String((error as any)?.message ?? error)}`);
      }
    },

    async message(target, msg, opts): Promise<MessageId> {
      if (typeof msg !== 'string' || !msg.trim()) {
        throw new HcRuntimeError('invalid_task', 'Message content must not be empty.');
      }
      if (target === 'parent') {
        throw new HcRuntimeError(
          'invalid_handle',
          'hc runtime adapter cannot address "parent": child-to-parent messages use the child broker surface.'
        );
      }
      const active = ensureBroker(sessionId);
      let agent: AgentRecord;
      try {
        agent = canonicalAgent(target);
      } catch (error) {
        if (error instanceof HcRuntimeError && error.code === 'unknown_handle') {
          throw new HcRuntimeError(
            'invalid_target',
            `Unknown message target "${target}". shepherd_message requires the exact opaque agent id returned by shepherd_spawn (for example "shepherd-agent-..."); do not use an agent name such as "planner", a display label, a terminal address, or a placeholder such as "<planner agent ID>".`
          );
        }
        throw error;
      }
      if (agent.state === 'closed') {
        throw new HcRuntimeError('closed_handle', `Agent "${agent.handle.id}" is closed.`);
      }
      // Fresh correlation before routing: a reply that already landed
      // resolves the wait here instead of leaving `status` stale.
      drainBrokerInbox();
      settleDueReplyTimeouts();
      // Correlated traffic goes through the mailbox so request/task state
      // matches the pane-based backend exactly.
      if (opts.taskId) {
        const record = taskRecord(opts.taskId);
        if (record.agentId !== agent.handle.id) {
          throw new HcRuntimeError(
            'task_agent_mismatch',
            `Task "${opts.taskId}" is owned by another agent than the message target.`
          );
        }
        if (opts.expectsReply) {
          const replyDeadline =
            Date.now() + loadSettings(agent.handle.cwd ?? cwd).timeout * 60_000;
          const provisional = createEnvelope(
            { sessionId: active.sessionId, brokerId: active.brokerId, senderId: active.parentId },
            {
              kind: 'message',
              targetId: agent.handle.id,
              messageId: mintMessageId(),
              taskId: opts.taskId,
              threadId: opts.threadId,
              replyTo: opts.replyTo,
              expectsReply: true,
              delivery: opts.delivery === 'followUp' ? 'followUp' : 'steer',
              content: msg,
              createdAt: Date.now(),
            }
          );
          openPendingRequest(record, {
            messageId: provisional.messageId,
            targetAgentId: agent.handle.id,
            deadlineAt: replyDeadline,
            text: msg,
          });
          try {
            const accepted = publishFromParent(active, provisional);
            return accepted.messageId;
          } catch (error) {
            try {
              resolveReplyForTask(record, provisional.messageId);
            } catch {}
            throw error;
          }
        }
        const envelope = createEnvelope(
          { sessionId: active.sessionId, brokerId: active.brokerId, senderId: active.parentId },
          {
            kind: opts.replyTo ? 'reply' : 'message',
            targetId: agent.handle.id,
            messageId: mintMessageId(),
            taskId: opts.taskId,
            threadId: opts.threadId,
            replyTo: opts.replyTo,
            delivery: opts.delivery === 'followUp' ? 'followUp' : 'steer',
            content: msg,
          }
        );
        const accepted = publishFromParent(active, envelope);
        if (opts.replyTo) {
          try {
            resolveReplyForTask(record, opts.replyTo);
          } catch {
            /* non-tracked replies stay deliverable as ordinary correlation */
          }
        }
        return accepted.messageId;
      }
      if (opts.replyTo) {
        const envelope = createEnvelope(
          { sessionId: active.sessionId, brokerId: active.brokerId, senderId: active.parentId },
          {
            kind: 'reply',
            targetId: agent.handle.id,
            messageId: mintMessageId(),
            threadId: opts.threadId,
            replyTo: opts.replyTo,
            delivery: opts.delivery === 'followUp' ? 'followUp' : 'steer',
            content: msg,
          }
        );
        const accepted = publishFromParent(active, envelope);
        return accepted.messageId;
      }
      // Untracked text goes straight to the terminal (paste + Enter), the
      // analogue of a native prompt poke. A fresh id is minted for the
      // receipt; there is no mailbox correlation to resolve later.
      if (!agent.handle.terminalId) throw new Error('Agent handle has no terminal.');
      const messageId = mintMessageId();
      try {
        await hcExec(
          opts.delivery === 'followUp'
            ? ['send', agent.handle.terminalId, msg, '--json']
            : ['send', agent.handle.terminalId, msg, '--force', '--json']
        );
      } catch (error) {
        throw new Error(
          `Message send failed: ${error instanceof HcError ? `${error.kind}: ${error.message}` : String((error as any)?.message ?? error)}`
        );
      }
      return messageId;
    },

    async watch(taskIds) {
      const values = Array.isArray(taskIds) ? taskIds : [taskIds];
      if (values.length === 0)
        throw new HcRuntimeError('invalid_handle', 'Expected one or more opaque task ids to watch.');
      const ids = values.map(value => taskRecord(value).taskId);
      if (new Set(ids).size !== ids.length) {
        throw new HcRuntimeError('invalid_handle', 'A wait cannot contain duplicate task ids.');
      }
      const overallTimeoutMs = 1_200_000;
      const deadline = Date.now() + overallTimeoutMs;
      for (;;) {
        drainBrokerInbox();
        const now = Date.now();
        for (const id of ids) {
          const record = tasks.get(id)!;
          if (record.result) continue;
          if (record.deadlineAt !== undefined && now >= record.deadlineAt) {
            settleTask(record, { status: 'timed_out', error: 'Tracked task deadline reached.' });
            continue;
          }
          if (
            record.state === 'waiting' &&
            record.pendingReplyDeadlineAt !== undefined &&
            now >= record.pendingReplyDeadlineAt
          ) {
            settleTask(record, {
              status: 'blocked',
              ok: false,
              text: `Timed out waiting for a reply from ${record.pendingReplyTargetAgentId ?? 'the target agent'} (message ${record.pendingReplyMessageId ?? 'unknown'} never answered).`,
              error: 'Tracked reply deadline reached.',
            });
            continue;
          }
          const settled = await settleFromSignal(record);
          if (settled) continue;
          const agent = agents.get(record.agentId);
          if (agent?.handle.terminalId) {
            const { live } = await terminalState(agent.handle.terminalId);
            if (!live) {
              const retry = await settleFromSignal(record);
              if (!retry) {
                settleTask(record, {
                  status: 'failed',
                  error: 'Agent terminal ended before the task completed.',
                });
              }
            }
          }
        }
        if (ids.every(id => tasks.get(id)?.result)) break;
        if (Date.now() >= deadline) {
          const pending = ids.filter(id => !tasks.get(id)?.result);
          throw new HcRuntimeError(
            'timeout',
            `Timed out after 20 minutes waiting for ${pending.length} unsettled task${pending.length === 1 ? '' : 's'}. The tasks keep running; watch them later with shepherd_watch.`
          );
        }
        // Idle efficiently on the first unsettled terminal; a check-in (or a
        // finished terminal, which returns at once) simply re-runs the drain.
        const firstOpen = ids.map(id => tasks.get(id)!).find(r => !r.result);
        const terminalId = firstOpen ? agents.get(firstOpen.agentId)?.handle.terminalId : undefined;
        if (terminalId) {
          try {
            await hcExec(['wait', terminalId, '--timeout', '3', '--json']);
          } catch {
            await new Promise(r => setTimeout(r, 1000));
          }
        } else {
          await new Promise(r => setTimeout(r, 500));
        }
      }
      return ids.map(id => toCompletion(tasks.get(id)!.result!));
    },

    async status(agentId) {
      const agent = canonicalAgent(agentId);
      drainBrokerInbox();
      settleDueReplyTimeouts();
      let proc: RuntimeProcState = 'unknown';
      if (agent.state === 'closed') {
        proc = 'unknown';
      } else if (agent.handle.terminalId) {
        proc = toProcState((await terminalState(agent.handle.terminalId)).agentState);
      }
      const record = agent.activeTaskId ? tasks.get(agent.activeTaskId) : undefined;
      const open = record && !record.result ? record : undefined;
      return {
        proc,
        task: open ? toTaskState(open.state) : 'done',
        ...(open?.pendingReplyMessageId ? { waitingOn: open.pendingReplyMessageId } : {}),
        ...(open?.staleNotifiedAt !== undefined ? { stale: true } : {}),
      } as RuntimeStatus;
    },

    async close(agentId) {
      const agent = canonicalAgent(agentId);
      const record = agents.get(agent.handle.id)!;
      if (
        !record.handle.terminalId ||
        !loadCreatedTerminals().some(t => t.terminalId === record.handle.terminalId)
      )
        throw new Error('Refusing to close an unowned terminal.');
      const terminalId = record.handle.terminalId;
      if (record.activeTaskId) {
        const task = tasks.get(record.activeTaskId);
        if (task && !task.result) {
          settleTask(task, { status: 'cancelled', error: 'Agent was closed.' });
        }
        record.activeTaskId = undefined;
      }
      record.state = 'closed';
      const active = ensureBroker(sessionId);
      try {
        unregisterChild(active, record.handle.id);
      } catch {
        /* best effort */
      }
      try {
        killHcTerminal(terminalId);
      } catch {
        throw new Error('Could not close agent terminal.');
      }
      removeCreatedTerminalDir(terminalId);
      forgetCreatedTerminal(terminalId);
    },

    async read(agentId, opts) {
      const agent = canonicalAgent(agentId);
      if (!agent.handle.terminalId) {
        throw new HcRuntimeError(
          'unknown_handle',
          `Agent "${agent.handle.id}" has no terminal to read.`
        );
      }
      const tail = await readHcTerminalTail(agent.handle.terminalId);
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

// Re-export the context type for resolver wiring (Phase 1.2) without
// reaching into this module's closure.
export type { AgentHandle, TaskId };
