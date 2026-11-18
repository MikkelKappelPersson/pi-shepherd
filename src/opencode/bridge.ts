/**
 * OpenCode bridge (spec 013, Phase 3): routing, delivery, and notifications.
 *
 * Pi-owned surface for OpenCode. The engine registries are the source of
 * truth for task/message state; this module adds what the OpenCode host
 * needs around them:
 *
 * - Sheep records + task→parent routing maps (server-process scope).
 * - Parent→sheep delivery via terminal input (Herdr `agent prompt` with a
 *   `pane send-text` fallback; `hc send` on hc). The opencode TUI ignores
 *   `--session` attach, so terminal input is the exact, session-free
 *   transport. `session.prompt` is used only for parent-session notices,
 *   where the session id is exactly known.
 * - Child envelope publishing (message/done) through the shared file broker
 *   with the sheep as sender, followed by the backend drain — mirroring
 *   what the Pi child surface does, so registry semantics (reply
 *   correlation, waiting states, completion settlement) are identical.
 * - Exactly-once completion prompts via the backend `onTaskSettled`
 *   observers (delegate-submission failures excluded: already reported).
 * - Stale-wait prompts via the engine monitors.
 * - Done-nudge on child run completion via `session.execution.*` events
 *   (`session.idle` is never emitted in v2), delivered as terminal input
 *   to the sheep's pane; bounded per task, then escalated to the parent.
 *
 * Capability model: task ids are unguessable opaque ids and act as the
 * bearer credential (same as Pi's broker tokens). A session may act for a
 * task it can name; sender display resolves through the task owner or the
 * bound sheep session.
 */

import { herdrExecSync } from '../runtimes/herdr/herdr.ts';
import { hcExecSync } from '../runtimes/hc/hc.ts';
import {
  bindSessionOwner,
  lifecycleRegistry,
} from '../runtimes/herdr/orchestration.ts';
import {
  configureStaleWaitNotifications,
  ensureParentBroker,
  processParentBrokerMessages,
} from '../runtimes/herdr/lifecycle.ts';
import {
  configureHcStaleWaitNotifications,
  describeHcAgent,
  drainHcInboxForSession,
  ensureHcBroker,
  onTaskSettled as onHcTaskSettled,
  resolveHcTerminalId,
} from '../runtimes/hc/runtime.ts';
import {
  createChildBroker,
  createEnvelope,
  publishFromChild,
  registerChild,
  type ChildCapability,
} from '../runtimes/herdr/messaging.ts';
import { unseenCompletionLedger } from '../core/unseen-completions.ts';
import { statusAgent } from '../runtimes/herdr/lifecycle.ts';
import { describeHcStatusView } from '../runtimes/hc/runtime.ts';

export type SheepBackend = 'herdr' | 'hc';

export interface SheepRecord {
  agentId: string;
  backend: SheepBackend;
  paneId?: string;
  terminalId?: string;
  cwd: string;
  parentSessionId: string;
  childCapability: ChildCapability;
  brokerRootDir: string;
  brokerSessionId: string;
  brokerId: string;
  parentBrokerId: string;
  /** Wall-clock ms when the sheep was spawned (discovery-bind baseline). */
  spawnedAt: number;
  /** Best-effort bound OpenCode child session (discovery or first call). */
  boundChildSessionId?: string;
  /** Message ids relayed to this sheep, for replyTo→task inference. */
  receivedMessages: Map<string, string | undefined>;
  /** Outstanding expectsReply requests published by this sheep. */
  outstandingRequests: Set<string>;
  /** Done-nudges sent per task id (bounded, then escalated). */
  nudgeCounts: Map<string, number>;
  /** Tasks whose stall was already escalated to the parent. */
  escalatedTasks: Set<string>;
}

const sheepByAgent = new Map<string, SheepRecord>();
const childSessionToAgent = new Map<string, string>();
const taskToParent = new Map<string, Map<string, string>>();
/** Sessions that used parent tools: sheep-only tools refuse them. */
const parentSessions = new Set<string>();

/**
 * Mark a session as a parent (orchestrator) session.
 * A sheep that touched a parent-only tool before its session was bound must
 * not keep a stale parent mark: sheep binding wins (see isParentSession).
 */
export function markParentSession(sessionId: string): void {
  if (!sessionId) return;
  if (isSheepSession(sessionId)) {
    parentSessions.delete(sessionId);
    return;
  }
  parentSessions.add(sessionId);
}

/**
 * True when the session was seen driving the parent surface.
 * Known sheep sessions are never parents, even if an early parent-tool call
 * marked them before binding — otherwise `sheepMessage` rejects the reply.
 */
export function isParentSession(sessionId: string): boolean {
  return parentSessions.has(sessionId) && !isSheepSession(sessionId);
}

function parentMapFor(taskId: string): Map<string, string> {
  let map = taskToParent.get(taskId);
  if (!map) taskToParent.set(taskId, (map = new Map()));
  return map;
}

/**
 * Remember which parent session owns a task (delegate/watch time).
 * Sheep sessions are never notice recipients: a child that learns a task id
 * (e.g. from a relayed question) must not become a "parent" and receive the
 * completion notice. This also keeps a stray peer-process observation from
 * prompting a sheep pane.
 */
export function noteTaskParent(taskId: string, parentSessionId: string): void {
  if (!parentSessionId || isSheepSession(parentSessionId)) return;
  parentMapFor(taskId).set('parent', parentSessionId);
}

/** All parent sessions waiting on a task (delegate + watchers). */
function parentsFor(taskId: string): string[] {
  const map = taskToParent.get(taskId);
  if (!map) return [];
  return [...map.values()];
}

export function recordSheepSpawn(record: Omit<SheepRecord, 'receivedMessages' | 'outstandingRequests' | 'nudgeCounts' | 'escalatedTasks' | 'spawnedAt'>): void {
  sheepByAgent.set(record.agentId, {
    ...record,
    spawnedAt: Date.now(),
    receivedMessages: new Map(),
    outstandingRequests: new Set(),
    nudgeCounts: new Map(),
    escalatedTasks: new Set(),
  });
}

export function forgetSheep(agentId: string): void {
  const record = sheepByAgent.get(agentId);
  if (!record) return;
  sheepByAgent.delete(agentId);
  if (record.boundChildSessionId) childSessionToAgent.delete(record.boundChildSessionId);
}

/**
 * Re-resolve a sheep into the CURRENT parent broker, re-registering it
 * when a broker rotation (reload, multi-session server) dropped its entry.
 * Without this, sends fail with "unknown child target" and child
 * envelopes land in a directory no drain reads. Idempotent: a registered
 * sheep is returned untouched.
 */
export function ensureSheepBroker(record: SheepRecord): void {
  const key = record.parentSessionId || undefined;
  if (record.backend === 'hc') {
    const active = ensureHcBroker(key);
    if (!active.children.has(record.agentId)) {
      const cap = registerChild(active, record.agentId);
      record.childCapability = cap;
      record.brokerRootDir = active.rootDir;
      record.brokerSessionId = active.sessionId;
      record.brokerId = active.brokerId;
      record.parentBrokerId = active.parentId;
    }
    return;
  }
  const active = ensureParentBroker(key);
  if (!active.children.has(record.agentId)) {
    const cap = registerChild(active, record.agentId);
    record.childCapability = cap;
    record.brokerRootDir = active.rootDir;
    record.brokerSessionId = active.sessionId;
    record.brokerId = active.brokerId;
    record.parentBrokerId = active.parentId;
  }
}

/** Clear routing state once a task settles (prevents unbounded growth). */
export function forgetTaskParent(taskId: string): void {
  taskToParent.delete(taskId);
}

type SessionLister = (directory: string) => Promise<unknown>;
let listSessions: SessionLister | undefined;

/** Session lister for best-effort sheep-session discovery (set at setup). */
export function setSessionLister(lister: SessionLister): void {
  listSessions = lister;
}

interface ListedSession {
  id: string;
  created: number;
  directory: string;
}

function normalizeSessionList(raw: unknown): ListedSession[] {
  const arr = Array.isArray(raw)
    ? raw
    : ((raw as any)?.data ?? (raw as any)?.sessions ?? (raw as any)?.items ?? []);
  if (!Array.isArray(arr)) return [];
  return arr.flatMap((s: any) => {
    const id = s?.id ?? s?.sessionID;
    if (typeof id !== 'string' || !id) return [];
    const created =
      Number(s?.time?.created ?? s?.created ?? s?.time?.updated ?? 0) || 0;
    const directory = s?.location?.directory ?? s?.directory ?? '';
    return [{ id, created, directory }];
  });
}

/**
 * Best-effort bind of a sheep to its OpenCode child session. The TUI
 * creates its server session lazily on first input, so right after spawn
 * there is nothing to bind. The first terminal-input delivery creates it;
 * this background poll then binds the newest session in the sheep's cwd.
 * The delegating parent session is always excluded, so it can never be
 * mistaken for its own sheep. Never used for auth or delivery (those are
 * task-id and pane-exact); it only powers the done-nudge trigger.
 */
export function kickoffSheepBind(record: SheepRecord, excludeSessionId?: string): void {
  if (record.boundChildSessionId || !listSessions) return;
  const lister = listSessions;
  const baseline = Date.now();
  void (async () => {
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 2000));
      try {
        if (sheepByAgent.get(record.agentId)?.boundChildSessionId) return;
        const sessions = normalizeSessionList(await lister(record.cwd));
        const candidate = sessions
          .filter(
            s =>
              s.id !== excludeSessionId &&
              s.created >= baseline - 5000 &&
              (!s.directory || s.directory === record.cwd)
          )
          .sort((a, b) => b.created - a.created)[0];
        if (candidate) {
          bindChildSession(record.agentId, candidate.id);
          return;
        }
      } catch {
        /* keep polling; discovery is best effort */
      }
    }
  })();
}

export function sheepRecord(agentId: string): SheepRecord | undefined {
  return sheepByAgent.get(agentId);
}

export function isSheepSession(sessionId: string): boolean {
  return childSessionToAgent.has(sessionId);
}

export function agentForChildSession(sessionId: string): string | undefined {
  return childSessionToAgent.get(sessionId);
}

/**
 * Find the sheep a relayed message was delivered to (by relayed message
 * id). Exact attribution for peer replies from not-yet-bound sessions:
 * only the terminal that received the message can know its id.
 */
export function recipientOfRelayedMessage(messageId: string): SheepRecord | undefined {
  for (const record of sheepByAgent.values()) {
    if (record.receivedMessages.has(messageId)) return record;
  }
  return undefined;
}

export function bindChildSession(agentId: string, childSessionId: string): void {
  const record = sheepByAgent.get(agentId);
  if (!record) return;
  if (record.boundChildSessionId) childSessionToAgent.delete(record.boundChildSessionId);
  record.boundChildSessionId = childSessionId;
  childSessionToAgent.set(childSessionId, agentId);
  // A pre-binding parent-tool call may have marked this session as a parent;
  // binding as a sheep must win so `sheepMessage` accepts its replies.
  parentSessions.delete(childSessionId);
}

/** True when a pane/terminal transport belongs to a currently managed sheep. */
export function isManagedTransport(id: string): boolean {
  for (const record of sheepByAgent.values()) {
    if (record.paneId === id || record.terminalId === id) return true;
  }
  return false;
}

/** Resolve a sheep's agent from its bound session, if any. */
function agentForSession(sessionId: string): SheepRecord | undefined {
  const agentId = childSessionToAgent.get(sessionId);
  return agentId ? sheepByAgent.get(agentId) : undefined;
}

function displayName(agent: string, label: string): string {
  return label ? `${agent}: ${label}` : agent;
}

/** Best-effort display identity for prompts (never throws). */
export function sheepDisplay(agentId: string): string {
  const record = sheepByAgent.get(agentId);
  if (record) {
    try {
      const handle =
        record.backend === 'hc'
          ? describeHcAgent(agentId)
          : lifecycleRegistry.getAgent(agentId).handle;
      return displayName(handle.agent, handle.label);
    } catch {
      /* fall through */
    }
  }
  return agentId;
}

// ── Terminal-input delivery ─────────────────────────────────────────────

function deliverToHerdrPane(paneId: string, text: string): void {
  // Prefer the agent-aware prompt (rejects when the agent is blocked);
  // fall back to raw pane input when the agent is not yet detected.
  try {
    herdrExecSync(['agent', 'prompt', paneId, text]);
    return;
  } catch {
    /* fall through to raw input */
  }
  herdrExecSync(['pane', 'send-text', paneId, text]);
  herdrExecSync(['pane', 'send-keys', paneId, 'Enter']);
}

function deliverToHcTerminal(terminalId: string, text: string): void {
  hcExecSync(['send', terminalId, text]);
}

/** Deliver text to a sheep's terminal (throws with the backend error). */
export async function deliverToSheep(record: SheepRecord, text: string): Promise<void> {
  // The child TUI may still be booting when the first delivery lands.
  // Retry briefly: terminal input buffers until the agent reads it.
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      deliverToSheepOnce(record, text);
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 2) await new Promise(r => setTimeout(r, 4000));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function deliverToSheepOnce(record: SheepRecord, text: string): void {
  if (record.backend === 'hc') {
    const terminalId = record.terminalId ?? resolveHcTerminalId(record.agentId);
    if (!terminalId) throw new Error(`Sheep "${record.agentId}" has no terminal to deliver to.`);
    record.terminalId = terminalId;
    deliverToHcTerminal(terminalId, text);
    return;
  }
  const paneId = record.paneId;
  if (!paneId) throw new Error(`Sheep "${record.agentId}" has no pane to deliver to.`);
  deliverToHerdrPane(paneId, text);
}

// ── Injected text formats ───────────────────────────────────────────────

export function taskTextForSheep(task: string, taskId: string): string {
  return (
    `${task}\n\nTask ID: ${taskId}\n\n` +
    '[Autonomous agent]\n' +
    'Complete this task autonomously. A delegated task may span multiple runs: ending the current run or becoming idle does not complete the task. ' +
    'Use shepherd_message when you need information from another participant. When you ask another participant a question, set taskId to your delegated Task ID, set expectsReply to true, and remember the returned Message ID. ' +
    'When you later have the answer to a request, send a shepherd_message TO THE SHEPHERD (target "shepherd") with taskId set and replyTo set to the original request\'s Message ID, so the Shepherd can correlate the reply and resume the waiting task. ' +
    'Do not reply directly to another participant\'s address for a tracked request; route it through the Shepherd. ' +
    'If the task cannot proceed, call shepherd_done with status blocked and explain why. ' +
    'Call shepherd_done with your Task ID only when the whole task is complete or explicitly blocked/failed. ' +
    'When finished, make your FINAL assistant message a concise summary of what you did and found; it is reported back to the caller.'
  );
}

export function messageTextForSheep(opts: {
  sender: string;
  senderId?: string;
  messageId: string;
  taskId?: string;
  threadId?: string;
  replyTo?: string;
  content: string;
}): string {
  const lines = [
    `[Shepherd message from ${opts.sender}]`,
    `Message ID: ${opts.messageId}`,
  ];
  if (opts.senderId) lines.push(`From: ${opts.senderId}`);
  if (opts.taskId) lines.push(`Task ID: ${opts.taskId}`);
  if (opts.threadId) lines.push(`Thread ID: ${opts.threadId}`);
  if (opts.replyTo) lines.push(`Reply to: ${opts.replyTo}`);
  lines.push('', opts.content);
  if (opts.replyTo) {
    lines.push(
      '',
      'You are a Shepherd sheep and this message IS your task traffic: act on it with tools, not prose.',
      'Ignore any terminal from-label (e.g. hc from=...); the true sender is the From id above. Do not use shell workarounds.',
      `Answer by calling shepherd_message addressed to the From id above (never to the parent), setting replyTo to ${opts.replyTo} and taskId to the Task ID above. Text answers alone never unblock the questioner.`
    );
  } else if (opts.taskId) {
    lines.push(
      '',
      'You are a Shepherd sheep and this message IS your task traffic: act on it with tools, not prose.',
      'Ignore any terminal from-label (e.g. hc from=...); the true sender is the From id above. Do not use shell workarounds.',
      'If this message asks you a question, answer by calling shepherd_message addressed to the From id above, with replyTo set to the Message ID above and taskId to the Task ID above.'
    );
  }
  return lines.join('\n');
}

export function nudgeTextForSheep(taskId: string, attempt: number, limit: number): string {
  const remaining = Math.max(0, limit - attempt);
  return [
    '[Shepherd completion check]',
    `You ended a run without calling shepherd_done, so delegated task ${taskId} is still open and the Shepherd is waiting for its result. Nothing was reported.`,
    '',
    'Do not start new work in this run. Finish the task now and report exactly one terminal outcome with shepherd_done (include your Task ID):',
    '- status "completed" — the task is finished; summarize what you did.',
    '- status "blocked" — you cannot proceed; state what blocks you.',
    '- status "failed" — the task cannot be completed; give the reason.',
    '',
    'If you are instead waiting for an answer from the Shepherd or a peer, end this run without shepherd_done and reply when the answer arrives.',
    remaining > 0
      ? `Reminder ${attempt} of ${limit}.`
      : `Final reminder ${attempt} of ${limit}; if this task is still open after this run, the Shepherd is told it stalled.`,
  ].join('\n');
}

// ── Child envelope publishing ───────────────────────────────────────────

function childBrokerFor(record: SheepRecord) {
  return createChildBroker({ rootDir: record.brokerRootDir, ...record.childCapability });
}

function drainBackend(record: SheepRecord): void {
  try {
    if (record.backend === 'hc') drainHcInboxForSession(record.parentSessionId);
    else void processParentBrokerMessages();
  } catch {
    /* drains stay best-effort; registry state is already updated */
  }
}

export interface SheepPublishResult {
  messageId: string;
  delivery: string;
}

/** Publish a task_done envelope as the sheep, then drain. */
export function publishSheepDone(
  record: SheepRecord,
  opts: { taskId: string; status: 'completed' | 'blocked' | 'failed'; summary?: string }
): SheepPublishResult {
  const broker = childBrokerFor(record);
  const completion = createEnvelope(
    { sessionId: broker.sessionId, brokerId: broker.brokerId, senderId: record.agentId },
    {
      kind: 'task_done',
      targetId: broker.parentId,
      taskId: opts.taskId,
      status: opts.status,
      summary: opts.summary,
      content: opts.summary,
      delivery: 'followUp',
    }
  );
  const accepted = publishFromChild(broker, completion);
  drainBackend(record);
  return { messageId: completion.messageId, delivery: accepted.delivery };
}

export interface SheepMessageInput {
  target: string;
  message: string;
  taskId?: string;
  threadId?: string;
  replyTo?: string;
  expectsReply?: boolean;
  delivery?: 'followUp' | 'steer';
}

/**
 * Publish a sheep message/reply as the sheep, mirroring the Pi child
 * surface: peer replies go direct with a correlation mirror to the parent;
 * expectsReply opens a tracked request with its own mirror. Then drain.
 */
export function publishSheepMessage(
  record: SheepRecord,
  input: SheepMessageInput
): SheepPublishResult & { mirrorDelivered?: boolean } {
  const broker = childBrokerFor(record);
  const message = createEnvelope(
    { sessionId: broker.sessionId, brokerId: broker.brokerId, senderId: record.agentId },
    {
      kind: input.replyTo ? 'reply' : 'message',
      targetId: input.target,
      taskId: input.taskId,
      threadId: input.threadId,
      replyTo: input.replyTo,
      expectsReply: input.expectsReply,
      delivery: input.delivery === 'followUp' ? 'followUp' : 'steer',
      content: input.message,
    }
  );
  const accepted = publishFromChild(broker, message);
  let mirrorDelivered = true;
  const isPeerReply =
    accepted.delivery === 'queued' &&
    input.replyTo &&
    !['shepherd', 'parent', broker.parentId].includes(input.target);
  const isTrackedRequest = accepted.delivery === 'queued' && input.expectsReply === true;
  try {
    if (isPeerReply) {
      const mirror = createEnvelope(
        { sessionId: broker.sessionId, brokerId: broker.brokerId, senderId: record.agentId },
        {
          kind: 'runtime',
          targetId: broker.parentId,
          taskId: input.taskId,
          replyTo: input.replyTo,
          replyReceived: true,
          summary: input.message,
          delivery: 'followUp',
        }
      );
      publishFromChild(broker, mirror);
    }
    if (isTrackedRequest) {
      const mirrored = createEnvelope(
        { sessionId: broker.sessionId, brokerId: broker.brokerId, senderId: record.agentId },
        {
          kind: 'runtime',
          targetId: broker.parentId,
          taskId: input.taskId,
          threadId: input.threadId,
          replyTo: message.messageId,
          requestOpen: true,
          requestTargetId: ['shepherd', 'parent'].includes(input.target)
            ? broker.parentId
            : input.target,
          summary: input.message,
          delivery: 'followUp',
        }
      );
      publishFromChild(broker, mirrored);
    }
  } catch {
    mirrorDelivered = false;
  }
  if (input.expectsReply === true) record.outstandingRequests.add(message.messageId);
  drainBackend(record);
  return { messageId: message.messageId, delivery: accepted.delivery, mirrorDelivered };
}

// ── Parent-session prompting ────────────────────────────────────────────

const PARENT_NOTICE_RETRIES = 3;
const parentNoticeDelay = (attempt: number) => 250 * (attempt + 1);

/**
 * Deliver a notice to a human parent session. Sheep sessions are never
 * notified, and a transient failure (the parent is generating a reply, so
 * `session.prompt` rejects) is retried instead of silently dropped. Results
 * stay retrievable via status/watch even if every attempt fails.
 */
async function promptParent(
  ctx: any,
  parentSessionId: string | undefined,
  content: string
): Promise<void> {
  if (!parentSessionId || isSheepSession(parentSessionId)) return;
  for (let attempt = 0; attempt < PARENT_NOTICE_RETRIES; attempt++) {
    try {
      await ctx.session.prompt({ sessionID: parentSessionId, text: content });
      return;
    } catch (error) {
      if (attempt === PARENT_NOTICE_RETRIES - 1) {
        console.error(`shepherd: parent notice delivery failed after ${PARENT_NOTICE_RETRIES} attempts: ${String(error)}`);
        return;
      }
      await new Promise(resolve => setTimeout(resolve, parentNoticeDelay(attempt)));
    }
  }
}

function completionText(result: {
  taskId: string;
  agentId: string;
  status: string;
  ok: boolean;
  returnCode: number;
  text?: string;
  error?: string;
  agent?: string;
  label?: string;
}): string {
  const identity = result.label ? `${result.agent ?? result.agentId}: ${result.label}` : (result.agent ?? result.agentId);
  const lines = [`shepherd_watcher completion: ${identity} ${result.status}`, `task id: ${result.taskId}`];
  if (result.text) lines.push('', result.text);
  if (result.error) lines.push('', `error: ${result.error}`);
  return lines.join('\n');
}

// ── Bridge installation ─────────────────────────────────────────────────

function doneNudgeLimit(): number {
  const raw = process.env.SHEPHERD_DONE_NUDGES ?? process.env.PI_SHEPHERD_DONE_NUDGES;
  if (raw === undefined) return 1;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 1;
}

export function installOpencodeBridges(ctx: any): void {
  try {
    setSessionLister(async (directory: string) => ctx.session.list({ directory, limit: 20 }));
  } catch {
    /* discovery bind stays disabled without a lister */
  }
  const onSettled = (result: any, context: { hadWatchers?: boolean; source?: string }) => {
    try {
      // A delegate submission failure is already reported in the delegate
      // tool result; never prompt it again here.
      if (context?.source === 'delegate-submission-failure') return;
      const parents = parentsFor(result.taskId);
      if (parents.length === 0) return;
      const content = completionText(result);
      for (const parent of parents) void promptParent(ctx, parent, content);
      // Exactly-once: routing served, drop it so re-settles (retries) cannot
      // prompt twice and the map cannot grow without bound.
      forgetTaskParent(result.taskId);
    } catch {
      /* observation must not break settlement */
    }
  };
  try {
    lifecycleRegistry.onTaskSettled(onSettled);
  } catch {
    /* bridge is best effort */
  }
  try {
    onHcTaskSettled(onSettled);
  } catch {
    /* bridge is best effort */
  }

  const onStale = (info: any) => {
    try {
      const parents = parentsFor(info.taskId);
      if (parents.length === 0) return;
      const owner = info.label
        ? `${info.agent ?? info.agentId}: ${info.label}`
        : (info.agent ?? info.agentId);
      const lines = [
        'Shepherd stale wait',
        `Waiting on a reply for task ${info.taskId} (owner: ${owner}).`,
        `Question: ${info.question ?? ''}`,
        `Pending request: ${info.requestMessageId ?? 'unknown'}`,
      ];
      for (const parent of parents) void promptParent(ctx, parent, lines.join('\n'));
    } catch {
      /* information only */
    }
  };
  try {
    configureStaleWaitNotifications(onStale);
  } catch {
    /* bridge is best effort */
  }
  try {
    configureHcStaleWaitNotifications(onStale);
  } catch {
    /* bridge is best effort */
  }

  // Done-nudge on child run completion. `session.idle` is never emitted in
  // v2; the execution outcomes are the documented replacement. Only bound
  // sheep sessions with an open, non-waiting task are nudged, bounded per
  // task, then escalated to the parent instead of looping.
  try {
    const stream = ctx.event.subscribe({
      types: ['session.execution.succeeded', 'session.execution.failed'],
    });
    void (async () => {
      for await (const event of stream) {
        try {
          const sessionId: string | undefined =
            event?.properties?.sessionID ??
            event?.properties?.sessionId ??
            event?.sessionID ??
            event?.sessionId;
          if (!sessionId) continue;
          const agent = agentForSession(sessionId);
          if (!agent) continue;
          // Find the sheep's open running task (waiting tasks expect a
          // reply; ending the run is how the sheep waits for it).
          let openTaskId: string | undefined;
          try {
            if (agent.backend === 'hc') {
              const task = describeHcStatusView(agent.agentId).task;
              if (task && task.state !== 'waiting') openTaskId = task.id;
            } else {
              const task = statusAgent(agent.agentId).task;
              if (task && (task.state === 'running' || task.state === 'created')) {
                openTaskId = task.id;
              }
            }
          } catch {
            /* status is best effort */
          }
          if (!openTaskId || agent.outstandingRequests.size > 0) continue;
          const limit = doneNudgeLimit();
          if (limit <= 0) continue;
          const sent = agent.nudgeCounts.get(openTaskId) ?? 0;
          if (sent >= limit) {
            if (!agent.escalatedTasks.has(openTaskId)) {
              agent.escalatedTasks.add(openTaskId);
              await promptParent(
                ctx,
                agent.parentSessionId,
                `Shepherd completion stalled: task ${openTaskId} is still open after ${limit} reminder(s).`
              );
            }
            continue;
          }
          agent.nudgeCounts.set(openTaskId, sent + 1);
          try {
            await deliverToSheep(agent, nudgeTextForSheep(openTaskId, sent + 1, limit));
          } catch {
            await promptParent(
              ctx,
              agent.parentSessionId,
              `Shepherd completion stalled: task ${openTaskId} is still open (nudge delivery failed).`
            );
          }
        } catch {
          /* one bad event must not stop the stream */
        }
      }
    })();
  } catch {
    /* nudge is best effort; deadlines stay authoritative */
  }
}

/** Clear unseen notices for watched tasks (an explicit watch pulls them). */
export function clearUnseenForWatch(taskIds: string[]): void {
  try {
    unseenCompletionLedger.clear(taskIds);
  } catch {
    /* ledger is best effort */
  }
}
