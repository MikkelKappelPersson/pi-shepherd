/**
 * OpenCode action dispatcher (spec 013, Phase 2).
 *
 * Pi-owned surface for OpenCode: mirrors the `spawn` / `status` / `read` /
 * `close` / `herd` / `agents` / `prune` branches of the Pi `doAction()`
 * against the same shared engine (discovery, runtimes, broker, registries).
 * The Pi dispatcher is not reused because it is entangled with Pi UI types;
 * the lifecycle semantics are identical.
 *
 * Every function takes an explicit { cwd, sessionId } context (resolved
 * from the OpenCode session by server.ts) and returns plain text for the
 * tool result. Thrown errors carry the user-facing message.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadSettings } from '../core/config.ts';
import { discoverAgents } from '../core/discovery.ts';
import { unseenCompletionLedger } from '../core/unseen-completions.ts';
import { resolveBackend, HC_SETUP_HINT, type ResolvedBackend } from '../runtimes/backend.ts';
import { detectCaller } from '../runtimes/detect.ts';
import { createHerdrRuntime } from '../runtimes/herdr/runtime.ts';
import {
  createHcRuntime,
  describeHcAgent,
  describeHcSheepMailbox,
  describeHcStatusView,
  describeHcTask,
  drainHcInboxForSession,
  hcTaskWatcherService,
  isHcTaskId,
  resolveHcAgentId,
  resolveHcTerminalId,
} from '../runtimes/hc/runtime.ts';
import { isHcAvailable } from '../runtimes/hc/hc.ts';
import { hcExecSync } from '../runtimes/hc/hc.ts';
import { bindSessionOwner, lifecycleRegistry } from '../runtimes/herdr/orchestration.ts';
import { ensureParentBroker, sendParentMessage, statusAgent } from '../runtimes/herdr/lifecycle.ts';
import {
  HERDR_SETUP_HINT,
  agentSummaries,
  formatSummary,
  herdrExecSync,
  isHerdrAvailable,
  loadCreatedPanes,
  pruneStaleCreatedPanes,
} from '../runtimes/herdr/herdr.ts';
import { OPENCODE_LAUNCH_OVERRIDES } from './host.ts';
import { parentArtifactSession } from './fieldnotes.ts';
import {
  agentForChildSession,
  bindChildSession,
  clearUnseenForWatch,
  deliverToSheep,
  ensureSheepBroker,
  forgetSheep,
  isParentSession,
  kickoffSheepBind,
  messageTextForSheep,
  noteTaskParent,
  publishSheepDone,
  publishSheepMessage,
  recipientOfRelayedMessage,
  recordSheepSpawn,
  sheepDisplay,
  sheepRecord,
  taskTextForSheep,
} from './bridge.ts';
import { taskWatcherService } from '../runtimes/herdr/lifecycle.ts';

const execFileAsync = promisify(execFile);

export interface OpencodeActionContext {
  cwd: string;
  sessionId?: string;
}

const PLACEMENTS = ['pane_right', 'pane_down', 'tab', 'workspace'] as const;
type Placement = (typeof PLACEMENTS)[number];

/** Resolve the backend for one call; throws the setup hint when unreachable. */
function backendFor(ctx: OpencodeActionContext): ResolvedBackend {
  let backend: ResolvedBackend;
  try {
    backend = resolveBackend(loadSettings(ctx.cwd).backend, detectCaller());
  } catch (error: any) {
    throw new Error(`Herd unavailable: ${error?.message ?? error}`);
  }
  if (backend === 'hc') {
    if (!isHcAvailable()) throw new Error(`Herd unavailable: backend "hc" is unreachable. ${HC_SETUP_HINT}`);
  } else if (!isHerdrAvailable()) {
    throw new Error(`Herd requires a running Herdr session.\n${HERDR_SETUP_HINT}`);
  }
  return backend;
}

/**
 * Scope registries to this OpenCode session. Same-session calls are a
 * no-op; a different session rotates the namespace exactly like Pi's
 * session switch.
 */
function bindSession(ctx: OpencodeActionContext): void {
  lifecycleRegistry.beginSession(ctx.sessionId);
  bindSessionOwner(ctx.sessionId);
}

function displayName(agent: string, label: string): string {
  return label ? `${agent}: ${label}` : agent;
}

export async function spawnSheep(
  ctx: OpencodeActionContext,
  opts: {
    agent: string;
    label: string;
    placement?: string;
    no_parent?: boolean;
    cwd?: string;
  }
): Promise<string> {
  if (opts.placement !== undefined && !(PLACEMENTS as readonly string[]).includes(opts.placement)) {
    throw new Error(
      `Unknown placement "${opts.placement}". Use one of: ${PLACEMENTS.join(', ')}.`
    );
  }
  const backend = backendFor(ctx);
  bindSession(ctx);
  const spawnCwd = opts.cwd ?? ctx.cwd;
  const placement = (opts.placement ?? undefined) as Placement | undefined;
  // Resolve the parent fieldnotes session once for this spawn, on the same
  // layout Pi uses. Both runtimes store it on the agent so later delegates
  // reserve their notes in the shared collection.
  const artifactSession = parentArtifactSession(ctx);
  const fieldnoteLine = artifactSession ? `\nfieldnote: ${artifactSession.sessionRelativePath}` : '';
  if (backend === 'hc') {
    const runtime = createHcRuntime({
      cwd: spawnCwd,
      sessionId: ctx.sessionId,
      artifactSession,
      launch: { ...OPENCODE_LAUNCH_OVERRIDES },
    });
    const id = await runtime.spawn({ name: opts.agent } as any, {
      cwd: spawnCwd,
      label: opts.label,
      placement,
      no_parent: opts.no_parent === true,
    });
    const handle = describeHcAgent(id);
    const mailbox = describeHcSheepMailbox(id);
    if (!mailbox) throw new Error(`Sheep "${id}" registered without a mailbox capability.`);
    recordSheepSpawn({
      agentId: handle.id,
      backend: 'hc',
      terminalId: resolveHcTerminalId(id),
      cwd: spawnCwd,
      parentSessionId: ctx.sessionId ?? '',
      childCapability: mailbox.childCapability,
      brokerRootDir: mailbox.rootDir,
      brokerSessionId: mailbox.sessionId,
      brokerId: mailbox.brokerId,
      parentBrokerId: mailbox.parentId,
    });
    return `shepherd_spawn spawned ${displayName(handle.agent, handle.label)}\nagent id: ${handle.id}${fieldnoteLine}`;
  }
  const runtime = createHerdrRuntime({
    cwd: spawnCwd,
    sessionId: ctx.sessionId,
    artifactSession,
    launch: { ...OPENCODE_LAUNCH_OVERRIDES },
  });
  const id = await runtime.spawn({ name: opts.agent } as any, {
    cwd: spawnCwd,
    label: opts.label,
    placement,
  });
  const handle = lifecycleRegistry.getAgent(id).handle;
  const broker = ensureParentBroker(ctx.sessionId);
  const capability = lifecycleRegistry.agentChildCapability(id);
  if (!capability) throw new Error(`Sheep "${id}" registered without a mailbox capability.`);
  recordSheepSpawn({
    agentId: handle.id,
    backend: 'herdr',
    paneId: handle.paneId,
    cwd: spawnCwd,
    parentSessionId: ctx.sessionId ?? '',
    childCapability: capability,
    brokerRootDir: broker.rootDir,
    brokerSessionId: broker.sessionId,
    brokerId: broker.brokerId,
    parentBrokerId: broker.parentId,
  });
  return `shepherd_spawn spawned ${displayName(handle.agent, handle.label)}\nagent id: ${handle.id}${fieldnoteLine}`;
}

export async function statusSheep(
  ctx: OpencodeActionContext,
  opts: { id: string }
): Promise<string> {
  const backend = backendFor(ctx);
  bindSession(ctx);
  if (backend === 'hc') {
    try {
      drainHcInboxForSession(ctx.sessionId);
    } catch {
      /* reads stay best-effort */
    }
    const view = describeHcStatusView(opts.id);
    const taskNote = view.task ? `; task ${view.task.id} ${view.task.state}` : '';
    return `agent ${view.state}${taskNote}.\nagent id: ${view.handle.id}`;
  }
  const result = statusAgent(opts.id);
  const taskNote = result.task ? `; task ${result.task.id} ${result.task.state}` : '';
  return `agent ${result.state}${taskNote}.\nagent id: ${result.handle.id}`;
}

export async function readSheep(
  ctx: OpencodeActionContext,
  opts: { target: string; lines?: number; source?: string }
): Promise<string> {
  const target = opts.target?.trim();
  if (!target) throw new Error('Provide an agent id, name, or pane target to read.');
  const lines = opts.lines ?? 40;
  const source = opts.source ?? 'recent-unwrapped';
  const backend = backendFor(ctx);
  bindSession(ctx);
  if (backend === 'hc') {
    const agentId = resolveHcAgentId(target);
    if (!agentId) return `Could not read "${target}": unknown hc agent, terminal, or name.`;
    try {
      const runtime = createHcRuntime({ cwd: ctx.cwd, sessionId: ctx.sessionId });
      const tail = await runtime.read(agentId, { lines });
      return (tail as string).trim() || '(no terminal output)';
    } catch (error: any) {
      return `Could not read "${target}": ${error?.message ?? String(error)}`;
    }
  }
  const created = loadCreatedPanes();
  const match = created.find(p => p.paneId === target || p.name === target);
  let resolved = match?.paneId ?? target;
  if (!match) {
    try {
      resolved = lifecycleRegistry.getAgent({ id: target }).handle.paneId ?? target;
    } catch {
      // Keep the original target so Herdr returns the useful not-found error.
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
    return (stdout as string).trim() || '(no terminal output)';
  } catch {
    // Agent detection is dropped once the pane's child exited — fall back
    // to a plain terminal read so finished runs stay inspectable.
    try {
      const { stdout } = await execFileAsync(
        'herdr',
        ['pane', 'read', resolved, '--lines', String(lines), '--format', 'text'],
        { encoding: 'utf8' }
      );
      return (stdout as string).trim() || '(no terminal output)';
    } catch {
      return `Could not read "${target}": Herdr has no such agent or pane.`;
    }
  }
}

export async function closeSheep(
  ctx: OpencodeActionContext,
  opts: { id: string }
): Promise<string> {
  const backend = backendFor(ctx);
  bindSession(ctx);
  const runtime =
    backend === 'hc'
      ? createHcRuntime({ cwd: ctx.cwd, sessionId: ctx.sessionId })
      : createHerdrRuntime({ cwd: ctx.cwd, sessionId: ctx.sessionId });
  await runtime.close(opts.id);
  forgetSheep(opts.id);
  const identity =
    backend === 'hc'
      ? describeHcAgent(opts.id)
      : (() => {
          const handle = lifecycleRegistry.getAgent(opts.id).handle;
          return { id: handle.id, agent: handle.agent, label: handle.label };
        })();
  const cleared = unseenCompletionLedger.clearForAgent(identity.id);
  const clearedNote =
    cleared.length > 0
      ? `; cleared ${cleared.length} unseen completion(s): ${cleared.join(', ')}`
      : '';
  return `closed ${displayName(identity.agent, identity.label)}${clearedNote}\nagent id: ${identity.id}`;
}

export async function listAgents(
  ctx: OpencodeActionContext,
  opts: { agentScope?: string }
): Promise<string> {
  bindSession(ctx);
  const settings = loadSettings(ctx.cwd);
  const scope = (opts.agentScope ?? settings.agentScope) as 'user' | 'project' | 'both';
  if (!['user', 'project', 'both'].includes(scope)) {
    throw new Error(`Unknown agent scope "${opts.agentScope}". Use one of: user, project, both.`);
  }
  const { agents } = discoverAgents(ctx.cwd, scope, {
    includeBundled: settings.includeBundledAgents,
  });
  if (agents.length === 0) {
    return `No agent definitions found in ${scope} scope. Do not guess an agent name; add a definition or choose another scope.`;
  }
  const lines = agents.map(a => `${a.name} (${a.source}): ${a.description}`);
  return `Available agent names (copy the name exactly; names are case-sensitive):\n${lines.join('\n')}`;
}

export async function listHerd(ctx: OpencodeActionContext): Promise<string> {
  backendFor(ctx);
  bindSession(ctx);
  pruneStaleCreatedPanes();
  const out = herdrExecSync(['agent', 'list']);
  const agents = agentSummaries(out);
  if (agents.length === 0) return 'No agents detected in Herdr.';
  return agents.map(formatSummary).join('\n');
}

export async function pruneRegistrations(ctx: OpencodeActionContext): Promise<string> {
  bindSession(ctx);
  const pruned = pruneStaleCreatedPanes();
  const remaining = loadCreatedPanes().length;
  return pruned === 0
    ? `No stale pi-shepherd panes found (${remaining} registered).`
    : `Removed ${pruned} stale pane registration(s); ${remaining} remain.`;
}

function runtimeFor(
  ctx: OpencodeActionContext,
  backend: 'herdr' | 'hc',
  artifactSession?: import('../core/artifact-sessions.ts').ArtifactSession
) {
  return backend === 'hc'
    ? createHcRuntime({ cwd: ctx.cwd, sessionId: ctx.sessionId, artifactSession })
    : createHerdrRuntime({ cwd: ctx.cwd, sessionId: ctx.sessionId, artifactSession });
}

function requireSheep(agentId: string): import('./bridge.ts').SheepRecord {
  const record = sheepRecord(agentId);
  if (!record) {
    throw new Error(
      `Unknown agent id "${agentId}". Lifecycle ids are scoped to this Shepherd; use the id from the latest shepherd_spawn result, not an agent name, label, or pane id.`
    );
  }
  return record;
}

/** Owning agent of a task; throws the unknown-task error for foreign ids. */
function taskOwnerAgent(taskId: string, backend: 'herdr' | 'hc'): string {
  if (backend === 'hc') {
    const task = describeHcTask(taskId);
    if (!task) {
      throw new Error(
        `Unknown task id "${taskId}". Use the id returned by shepherd_delegate, not an agent id or terminal address.`
      );
    }
    return task.agentId;
  }
  try {
    return lifecycleRegistry.getTask(taskId).agentId;
  } catch {
    throw new Error(
      `Unknown task id "${taskId}". Use the id returned by shepherd_delegate, not an agent id or pane id.`
    );
  }
}

/** Open (unsettled) task currently owned by a sheep, if any. */
function activeTaskForSheep(agentId: string, backend: 'herdr' | 'hc'): string | undefined {
  try {
    if (backend === 'hc') {
      const task = describeHcStatusView(agentId).task;
      return task ? task.id : undefined;
    }
    const task = lifecycleRegistry.activeTaskForAgent({ id: agentId });
    return task && !['completed', 'blocked', 'failed', 'cancelled', 'timed_out'].includes(task.state)
      ? task.id
      : undefined;
  } catch {
    return undefined;
  }
}

export async function delegateSheep(
  ctx: OpencodeActionContext,
  opts: { target: string; task: string; timeout?: number }
): Promise<string> {
  if (!opts.task?.trim()) throw new Error('Delegated task description must not be empty.');
  const backend = backendFor(ctx);
  bindSession(ctx);
  const record = requireSheep(opts.target);
  if (record.backend !== backend) {
    throw new Error(
      `Agent "${opts.target}" lives on the "${record.backend}" backend; the resolved backend is "${backend}". Opaque ids never cross backends.`
    );
  }
  const timeoutMinutes = opts.timeout ?? loadSettings(ctx.cwd).timeout;
  if (!Number.isFinite(timeoutMinutes) || timeoutMinutes <= 0) {
    throw new Error('Delegated task timeout must be a positive number of minutes.');
  }
  ensureSheepBroker(record);
  // Re-resolve on delegate so a task always reserves its note in the shared
  // collection, even if the agent record predates fieldnotes resolution.
  const runtime = runtimeFor(ctx, backend, parentArtifactSession(ctx));
  const taskId = await runtime.delegate(opts.target, opts.task, { timeoutMin: timeoutMinutes });
  noteTaskParent(taskId, ctx.sessionId ?? '');
  const display = sheepDisplay(opts.target);
  // deliver task text via terminal input
  let deliveryNote = '';
  try {
    await deliverToSheep(record, taskTextForSheep(opts.task, taskId));
    // The first terminal input creates the child's server session lazily;
    // bind it in the background for the done-nudge trigger (the delegating
    // parent session itself is excluded from candidates).
    kickoffSheepBind(record, ctx.sessionId);
  } catch (error: any) {
    deliveryNote = ` Task text delivery failed (${error?.message ?? error}); the task is open — retry the text via shepherd_message or wait for the deadline.`;
  }
  return `Delegated task to ${display}\ntask id: ${taskId}${deliveryNote}`;
}

function formatInlineCompletion(completion: {
  taskId: string;
  agentId: string;
  status: string;
  text?: string;
  error?: string;
}): string {
  const lines = [`- ${completion.taskId}: ${completion.status}`];
  if (completion.text) lines.push(`  ${completion.text.split('\n')[0]}`);
  if (completion.error) lines.push(`  error: ${completion.error}`);
  return lines.join('\n');
}

export async function watchSheep(
  ctx: OpencodeActionContext,
  opts: { id: string | string[] }
): Promise<string> {
  const ids: string[] = Array.isArray(opts.id) ? opts.id : [opts.id];
  if (ids.length === 0) throw new Error('Expected one or more task ids to watch.');
  const backend = backendFor(ctx);
  bindSession(ctx);
  for (const id of ids) {
    const known = backend === 'hc' ? isHcTaskId(id) : lifecycleRegistry.isTaskId(id);
    if (!known) {
      throw new Error(
        `Unknown watcher target "${id}". Pass a task id from shepherd_delegate; agent ids and pane/terminal addresses are not valid watcher targets.`
      );
    }
  }
  if (new Set(ids).size !== ids.length) {
    throw new Error('A watcher cannot contain duplicate task ids.');
  }
  if (backend === 'hc') {
    try {
      drainHcInboxForSession(ctx.sessionId);
    } catch {
      /* reads stay best-effort */
    }
  }
  const registration =
    backend === 'hc' ? hcTaskWatcherService.watch(ids) : taskWatcherService.watch(ids);
  for (const id of ids) noteTaskParent(id, ctx.sessionId ?? '');
  // Retrieval clear: an explicit watch pulls already-settled results, so no
  // later notice may fire for them (onTaskSettled prompts exactly once per
  // settlement; already-settled tasks are reported inline here instead).
  clearUnseenForWatch(ids);
  const summary =
    registration.pending.length > 0
      ? `watching ${registration.pending.length} task${registration.pending.length === 1 ? '' : 's'} asynchronously; completion arrives automatically`
      : 'watch registered; all tasks were already settled';
  const lines = [summary, `watcher id: ${registration.watcherId}`];
  if (registration.pending.length > 0) lines.push(`pending: ${registration.pending.join(', ')}`);
  for (const done of registration.completed as any[]) {
    lines.push(formatInlineCompletion(done));
  }
  return lines.join('\n');
}

export async function messageSheep(
  ctx: OpencodeActionContext,
  opts: {
    target: string;
    message: string;
    taskId?: string;
    threadId?: string;
    replyTo?: string;
    expectsReply?: boolean;
    delivery?: 'followUp' | 'steer';
  }
): Promise<string> {
  if (!opts.message?.trim()) throw new Error('Message content must not be empty.');
  if (opts.target === 'parent' || opts.target === 'shepherd') {
    throw new Error('Cannot message the parent session from here; target must be a sheep agent id.');
  }
  const backend = backendFor(ctx);
  bindSession(ctx);
  const record = requireSheep(opts.target);
  if (record.backend !== backend) {
    throw new Error(
      `Agent "${opts.target}" lives on the "${record.backend}" backend; the resolved backend is "${backend}". Opaque ids never cross backends.`
    );
  }
  let messageId: string;
  let targetTaskState: string | undefined;
  ensureSheepBroker(record);
  if (backend === 'hc') {
    const runtime = runtimeFor(ctx, backend);
    messageId = await runtime.message(opts.target, opts.message, {
      taskId: opts.taskId,
      threadId: opts.threadId,
      replyTo: opts.replyTo,
      expectsReply: opts.expectsReply,
      delivery: opts.delivery,
    });
    try {
      const view = describeHcStatusView(opts.target);
      if (view.task && (opts.taskId === undefined || view.task.id === opts.taskId)) {
        targetTaskState = view.task.state;
      }
    } catch {
      /* display hint is best effort */
    }
    if (!targetTaskState && opts.expectsReply && opts.taskId) targetTaskState = 'waiting';
  } else {
    const result = sendParentMessage({
      target: opts.target,
      message: opts.message,
      taskId: opts.taskId,
      threadId: opts.threadId,
      replyTo: opts.replyTo,
      expectsReply: opts.expectsReply,
      delivery: opts.delivery,
    });
    messageId = result.messageId;
    targetTaskState = result.targetTaskState;
  }
  const display = sheepDisplay(opts.target);
  const relayText = messageTextForSheep({
    sender: 'Shepherd',
    messageId,
    taskId: opts.taskId,
    threadId: opts.threadId,
    replyTo: opts.replyTo,
    content: opts.message,
  });
  record.receivedMessages.set(messageId, opts.taskId);
  let deliveryNote = '';
  try {
    await deliverToSheep(record, relayText);
  } catch (error: any) {
    if (opts.expectsReply && opts.taskId) {
      // The question never reached the sheep: release the wait it opened so
      // the task does not park on an undelivered request.
      try {
        lifecycleRegistry.clearPendingReply(opts.taskId);
      } catch {
        /* best effort */
      }
      throw new Error(
        `Message delivery to ${display} failed (${error?.message ?? error}); the tracked request was released.`
      );
    }
    deliveryNote = ` Message delivery failed (${error?.message ?? error}); the message was not received.`;
  }
  return (
    `Message queued to ${display}` +
    (targetTaskState ? ` (task ${targetTaskState})` : '') +
    `\nmessage id: ${messageId}${deliveryNote}`
  );
}

/**
 * Child-side message: the caller is a sheep session. The sender resolves
 * through the bound session, falling back to the task owner when the
 * session is not (yet) bound.
 */
export async function sheepMessage(
  ctx: OpencodeActionContext,
  opts: {
    target: string;
    message: string;
    taskId?: string;
    threadId?: string;
    replyTo?: string;
    expectsReply?: boolean;
    delivery?: 'followUp' | 'steer';
  },
  childSessionId: string
): Promise<{ text: string; parentPrompt?: string; parentSessionId?: string }> {
  if (!opts.message?.trim()) throw new Error('Message content must not be empty.');
  if (isParentSession(childSessionId)) {
    throw new Error(
      'shepherd_message from a parent session uses the parent form (target a sheep agent id); ' +
        'the sheep form is for delegated sheep sessions only.'
    );
  }
  const backend = backendFor(ctx);
  bindSession(ctx);
  const bound = sheepRecord(agentForChildSessionSafe(childSessionId) ?? '');
  let sender = bound;
  let effectiveTaskId = opts.taskId;
  if (!sender && opts.replyTo) {
    // Peer reply from a not-yet-bound session: only the terminal that
    // received the request can know its message id.
    sender = recipientOfRelayedMessage(opts.replyTo);
  }
  if (!sender && opts.taskId) {
    const owner = taskOwnerAgent(opts.taskId, backend);
    sender = sheepRecord(owner);
  }
  if (!sender) {
    throw new Error(
      'No delegated task found for this session. shepherd_message applies to a task delivered through the Shepherd; include its Task ID.'
    );
  }
  if (!effectiveTaskId) {
    effectiveTaskId = activeTaskForSheep(sender.agentId, backend);
  }
  // replyTo must belong to the effective task (mirrors the child-surface
  // task-mismatch guard).
  if (opts.replyTo) {
    const knownTask = sender.receivedMessages.get(opts.replyTo);
    if (knownTask !== undefined && effectiveTaskId !== undefined && knownTask !== effectiveTaskId) {
      throw new Error(
        `Reply ${opts.replyTo} belongs to task ${knownTask ?? 'none'}; use that task id, not ${effectiveTaskId}.`
      );
    }
    if (knownTask === undefined && sender.receivedMessages.has(opts.replyTo)) {
      // Reply to a message with no task: adopt the effective task.
    }
    if (effectiveTaskId === undefined) effectiveTaskId = knownTask ?? undefined;
  }
  bindChildSessionSafe(sender.agentId, childSessionId);
  ensureSheepBroker(sender);
  const isParentTarget = opts.target === 'parent' || opts.target === 'shepherd';
  const targetAgentId = isParentTarget ? sender.parentBrokerId : opts.target;
  if (!isParentTarget) requireSheep(opts.target);
  const published = publishSheepMessage(sender, {
    target: targetAgentId,
    message: opts.message,
    taskId: effectiveTaskId,
    threadId: opts.threadId,
    replyTo: opts.replyTo,
    expectsReply: opts.expectsReply,
    delivery: opts.delivery,
  });
  if (!published.mirrorDelivered && opts.expectsReply) {
    return {
      text: 'Shepherd message accepted; reply tracking degraded (request mirror failed).',
      parentPrompt: undefined,
    };
  }
  // Resolve the requester's wait when this answers it.
  if (opts.replyTo && effectiveTaskId) {
    try {
      const owner = sheepRecord(taskOwnerAgent(effectiveTaskId, backend));
      owner?.outstandingRequests.delete(opts.replyTo);
    } catch {
      /* best effort */
    }
  }
  if (isParentTarget) {
    const senderDisplay = sheepDisplay(sender.agentId);
    return {
      text: `Shepherd message accepted for asynchronous delivery.\nmessage id: ${published.messageId}`,
      parentPrompt:
        `Shepherd message from ${senderDisplay}\n` +
        `message id: ${published.messageId}` +
        (effectiveTaskId ? `\ntask id: ${effectiveTaskId}` : '') +
        (opts.replyTo ? `\nreply to: ${opts.replyTo}` : '') +
        `\n\n${opts.message}`,
      parentSessionId: sender.parentSessionId || undefined,
    };
  }
  const recipient = requireSheep(opts.target);
  const relayText = messageTextForSheep({
    sender: sheepDisplay(sender.agentId),
    senderId: sender.agentId,
    messageId: published.messageId,
    taskId: effectiveTaskId,
    threadId: opts.threadId,
    replyTo: opts.replyTo,
    content: opts.message,
  });
  recipient.receivedMessages.set(published.messageId, effectiveTaskId);
  let deliveryNote = '';
  try {
    await deliverToSheep(recipient, relayText);
  } catch (error: any) {
    deliveryNote = ` (delivery to the peer failed: ${error?.message ?? error})`;
  }
  return {
    text:
      `Shepherd message accepted for asynchronous delivery.\nmessage id: ${published.messageId}` +
      deliveryNote,
    parentPrompt: undefined,
  };
}

/**
 * Child-side completion: only the sheep session bound to the task's owner
 * may complete it. Mirrors the one-shot correction rule: a misremembered id
 * is corrected to the sheep's own open task, never to another agent's.
 */
export async function sheepDone(
  ctx: OpencodeActionContext,
  opts: { taskId?: string; status: string; summary?: string },
  childSessionId: string
): Promise<{ text: string }> {
  if (isParentSession(childSessionId)) {
    throw new Error(
      'shepherd_done is a sheep-only tool: only the delegated sheep session may complete its task.'
    );
  }
  if (!['completed', 'blocked', 'failed'].includes(opts.status)) {
    throw new Error(
      `Invalid status "${opts.status}"; use completed, blocked, or failed.`
    );
  }
  const backend = backendFor(ctx);
  bindSession(ctx);
  const boundAgentId = agentForChildSessionSafe(childSessionId);
  const bound = boundAgentId ? sheepRecord(boundAgentId) : undefined;
  const ownOpenTask = bound ? activeTaskForSheep(bound.agentId, backend) : undefined;
  let effectiveTaskId = opts.taskId;
  if (effectiveTaskId === undefined) effectiveTaskId = ownOpenTask;
  if (effectiveTaskId === undefined) {
    throw new Error(
      'No delegated task found for this session. shepherd_done only applies to a task delivered through the Shepherd; include its Task ID.'
    );
  }
  const ownerAgentId = taskOwnerAgent(effectiveTaskId, backend);
  const owner = requireSheep(ownerAgentId);
  if (bound && bound.agentId !== ownerAgentId) {
    throw new Error(
      `Task "${effectiveTaskId}" is not owned by this sheep session. Complete only your own delegated task.`
    );
  }
  if (!bound && opts.taskId === undefined) {
    throw new Error(
      'This session is not recognized as a sheep session; include the Task ID from the delegated task text.'
    );
  }
  bindChildSessionSafe(ownerAgentId, childSessionId);
  ensureSheepBroker(owner);
  publishSheepDone(owner, {
    taskId: effectiveTaskId,
    status: opts.status as 'completed' | 'blocked' | 'failed',
    summary: opts.summary,
  });
  // A completed status with outstanding required replies is not applied by
  // the registry (the reply or an explicit blocked/failed result must land
  // first). Surface that instead of claiming success.
  const stillOpen = activeTaskForSheep(ownerAgentId, backend) === effectiveTaskId;
  if (opts.status === 'completed' && stillOpen) {
    return {
      text:
        `Shepherd task completion NOT recorded: task ${effectiveTaskId} still has an outstanding required reply. ` +
        'Answer it first, or report blocked/failed with the reason.',
    };
  }
  const display = sheepDisplay(ownerAgentId);
  return {
    text: `Shepherd task completion accepted for ${display}.\ntask id: ${effectiveTaskId}\nstatus: ${opts.status}`,
  };
}

function agentForChildSessionSafe(childSessionId: string): string | undefined {
  try {
    return agentForChildSession(childSessionId);
  } catch {
    return undefined;
  }
}

function bindChildSessionSafe(agentId: string, childSessionId: string): void {
  try {
    bindChildSession(agentId, childSessionId);
  } catch {
    /* binding is best effort */
  }
}
