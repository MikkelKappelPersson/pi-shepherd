import { randomUUID } from 'node:crypto';
import { discoverAgents, resolveDelegatedModel } from './discovery.ts';
import {
  createEnvelope,
  createParentBroker,
  publishFromParent,
  pollParentInbox,
  registerChild,
  unregisterChild,
  closeBrokerWhenChildrenGone,
  type ParentBroker,
  type ShepherdDelivery,
  type ShepherdMessageEnvelope,
  type PublishResult,
} from './messaging.ts';
import { loadSettings } from '../extension/config.ts';
import {
  ensureHerdrRuntime,
  getHerdrWorkspaceId,
  createHerdrInstance,
  waitForHerdrShellReady,
  waitForHerdrAgentDetected,
  launchPiInPane,
  setCreatedPaneDir,
  herdrExec,
  herdrExecSync,
  loadCreatedPanes,
  paneExists,
  removeCreatedPaneDir,
  readPaneTail,
  readLastAssistantText,
  readCompletionSignal,
  readLaunchExitCode,
} from './herdr.ts';
import {
  lifecycleRegistry,
  type AgentHandle,
  type AgentHandleInput,
  type PromptHandle,
  type PromptHandleInput,
  type PromptResult,
  type WatcherCompletion,
  type WatcherNotification,
  type WatcherRegistration,
  type AgentStatus,
  formatAgentName,
  validateAgentLabel,
  sessionOwner,
  LifecycleError,
  type CreateTaskOptions,
  type TaskHandle,
  type TaskResult,
} from './orchestration.ts';
import {
  reserveArtifacts,
  markArtifactStarted,
  finalizeArtifact,
  type ShepherdSession,
  type ArtifactReservation,
} from './artifact-sessions.ts';

let parentBroker: ParentBroker | undefined;
let parentBrokerSessionId: string | undefined;
let parentBrokerTimer: ReturnType<typeof setInterval> | undefined;
let parentBrokerTicking = false;
let lastTrackedTaskRuntimeCheck = 0;

function startParentBrokerMonitor(): void {
  if (parentBrokerTimer) return;
  parentBrokerTimer = setInterval(() => void processParentBrokerMessages(), 250);
  (parentBrokerTimer as any).unref?.();
}

function stopParentBrokerMonitor(): void {
  if (parentBrokerTimer) clearInterval(parentBrokerTimer);
  parentBrokerTimer = undefined;
  parentBrokerTicking = false;
  lastTrackedTaskRuntimeCheck = 0;
}

/** Ensure one parent-owned mailbox exists for the current Shepherd session. */
export function ensureParentBroker(sessionId?: string): ParentBroker {
  const id = sessionId?.trim() || sessionOwner();
  if (!id) throw new Error('Unable to resolve the parent Shepherd session identity.');
  if (parentBroker && !parentBroker.closed && parentBrokerSessionId === id) return parentBroker;
  parentBroker = createParentBroker(id);
  parentBrokerSessionId = id;
  startParentBrokerMonitor();
  return parentBroker;
}

export function currentParentBroker(): ParentBroker | undefined {
  return parentBroker && !parentBroker.closed ? parentBroker : undefined;
}

/**
 * Close the broker only after the Herdr integration confirms all child panes
 * are gone. Returning false preserves the mailbox for live children.
 */
export function shutdownParentBroker(childrenGone: () => boolean): boolean {
  if (!parentBroker) return true;
  const closed = closeBrokerWhenChildrenGone(parentBroker, childrenGone);
  if (closed) {
    stopParentBrokerMonitor();
    parentBroker = undefined;
    parentBrokerSessionId = undefined;
  }
  return closed;
}

export interface StartOptions {
  cwd?: string;
  model?: string;
  placement?: 'pane_right' | 'pane_down' | 'tab' | 'workspace';
  label?: string;
  /** Internal parent-bound artifact session, resolved by the parent tool. */
  artifactSession?: ShepherdSession;
}

export async function startAgent(
  name: string,
  options: StartOptions = {},
  ctx: {
    cwd: string;
    model?: { provider: string; id: string };
    hasUI?: boolean;
    ui?: any;
    sessionId?: string;
  }
): Promise<AgentHandle> {
  const cwd = options.cwd ?? ctx.cwd;
  const label = validateAgentLabel(options.label);
  const settings = loadSettings(cwd);
  // Agent scope and project approval are settings-owned; callers cannot
  // override them per spawn.
  const agentScope = settings.agentScope;
  const confirmProjectAgents = settings.confirmProjectAgents;
  const discovered = discoverAgents(cwd, agentScope, {
    includeBundled: settings.includeBundledAgents,
  }).agents;
  const found = discovered.find(a => a.name === name);
  if (!found) {
    const available = discovered.map(a => a.name).join(', ');
    const suggestion = discovered.find(a => a.name.toLowerCase() === name.trim().toLowerCase());
    throw new Error(
      `Unknown agent "${name}" in ${agentScope} scope.` +
        (suggestion ? ` Did you mean "${suggestion.name}"?` : '') +
        (available ? ` Available agents: ${available}.` : ' No agents are available.') +
        ' Call shepherd with action "agents" to list exact names.'
    );
  }
  if (found.source === 'project' && confirmProjectAgents && ctx.hasUI) {
    const ok = await ctx.ui.confirm(
      'Run project-local agent?',
      `Agent: ${name}\nSource: ${found.filePath}`
    );
    if (!ok) throw new Error('Project-local agent was not approved.');
  }
  await ensureHerdrRuntime();
  const broker = ensureParentBroker(ctx.sessionId);
  const reservedAgentId = lifecycleRegistry.allocateAgentId();
  const childCapability = registerChild(broker, reservedAgentId);
  const placement = options.placement ?? 'tab';
  const herdrPlacement = placement === 'pane_right' || placement === 'pane_down' ? 'pane' : placement;
  const direction = placement === 'pane_down' ? 'down' : 'right';
  let paneId = '';
  let tabId = '';
  let workspaceId = '';
  try {
    const delegatedModel = resolveDelegatedModel(options.model ?? found.model, ctx.model);
    const created = createHerdrInstance(
      formatAgentName(name, label),
      cwd,
      herdrPlacement,
      herdrPlacement === 'workspace' ? undefined : getHerdrWorkspaceId(),
      direction
    );
    paneId = created.paneId;
    tabId = created.tabId;
    workspaceId = created.workspaceId;
    await waitForHerdrShellReady(paneId, { timeoutMs: 15_000 });
    const files = launchPiInPane(paneId, {
      name,
      persistent: true,
      childBroker: { rootDir: broker.rootDir, ...childCapability },
      systemPrompt: found.systemPrompt,
      // Prompt-shaping options belong to the discovered agent definition.
      omitSystemPrompt: found.omitSystemPrompt,
      omitPiDocumentation: found.omitPiDocumentation === true,
      omitContextFiles: found.omitContextFiles === true,
      // An explicit start option wins, then the agent definition, then the
      // parent Shepherd's current provider/model. This keeps slash-command
      // starts and model-facing starts on the same resolution path.
      model: delegatedModel,
      tools: found.tools,
    });
    setCreatedPaneDir(paneId, files.dir);
    // Keep the launch directory registered while the persistent child is alive;
    // its completion sidecar is also the reliable fast-completion signal.
    const ready = await waitForHerdrAgentDetected(paneId, { timeoutMs: 20_000 });
    if (!ready.detected) {
      const returnCode = ready.exitCode ?? (await readLaunchExitCode(paneId));
      const output = (await readPaneTail(paneId)).trim();
      const suffix = returnCode === null ? '' : ` (return code ${returnCode})`;
      const wording = returnCode !== null && returnCode !== 0 ? 'failed to start' : 'did not become ready';
      throw Object.assign(
        new Error(`Agent "${name}" ${wording}${suffix}.${output ? `\n${output}` : ''}`),
        { returnCode: returnCode ?? 1, code: 'agent_not_ready' }
      );
    }
    return lifecycleRegistry.registerAgent(
      { id: reservedAgentId, agent: name, label, model: delegatedModel, paneId, tabId, workspaceId },
      {
        completionSignalPath: `${files.sessionFile}.exit`,
        completionResultPath: files.sessionFile,
        artifactSession: options.artifactSession,
        childCapability,
      }
    );
  } catch (error) {
    try { unregisterChild(broker, reservedAgentId); } catch {}
    if (paneId) {
      try {
        herdrExecSync(['pane', 'close', paneId]);
      } catch {}
      if (!paneExists(paneId)) removeCreatedPaneDir(paneId);
    }
    throw error;
  }
}

function artifactContext(session: ShepherdSession, artifact: ArtifactReservation): string {
  return [
    '\n\n--- Shepherd fieldnotes context ---',
    `Shared session: ${session.sessionPath}`,
    `Shared fieldnotes: ${session.mocPath}`,
    `Assigned note: ${artifact.filePath}`,
    `Project-relative note: ${artifact.relativePath}`,
    'Read the shared fieldnotes before working. Write your findings only to the assigned note; do not create another Shepherd session.',
    '--- End Shepherd fieldnotes context ---',
  ].join('\n');
}

function finalizePromptArtifact(handle: PromptHandle, result: PromptResult): void {
  const { session, artifact } = lifecycleRegistry.promptArtifact(handle);
  if (!session || !artifact) return;
  const status =
    result.status === 'timeout'
      ? 'timed-out'
      : result.status === 'cancelled'
        ? 'cancelled'
        : result.ok
          ? 'completed'
          : 'failed';
  finalizeArtifact(session, artifact, { status, output: result.text, error: result.error });
}

function finalizeTaskArtifact(handle: TaskHandle, result: TaskResult): void {
  const { session, artifact } = lifecycleRegistry.taskArtifact(handle);
  if (!session || !artifact) return;
  const status =
    result.status === 'timed_out'
      ? 'timed-out'
      : result.status === 'cancelled'
        ? 'cancelled'
        : result.status === 'completed'
          ? 'completed'
          : result.status === 'blocked'
            ? 'failed'
            : 'failed';
  finalizeArtifact(session, artifact, { status, output: result.text, error: result.error });
}

export interface DelegateOptions extends CreateTaskOptions {
  /** Parent pi session identity used for broker creation in tests/startup. */
  sessionId?: string;
  /** Internal parent-bound artifact session, resolved by the parent tool. */
  artifactSession?: ShepherdSession;
}

/**
 * Submit a tracked task through the parent broker. This returns after the task
 * envelope is queued; completion is intentionally handled by shepherd_done in
 * a later phase rather than by this call or by a child turn ending.
 */
export async function delegateAgent(
  handle: AgentHandleInput,
  description: string,
  options: DelegateOptions = {}
): Promise<TaskHandle> {
  if (typeof description !== 'string' || !description.trim()) throw new Error('Delegated task description must not be empty.');
  const canonical = lifecycleRegistry.canonicalAgentHandle(handle);
  const record = lifecycleRegistry.getAgent(canonical);
  if (!record.handle.paneId) throw new Error('Agent handle has no pane.');
  const detected = await waitForHerdrAgentDetected(record.handle.paneId, { timeoutMs: 15_000 });
  if (!detected.detected) throw new Error(`Agent "${canonical.id}" is not detected.`);

  const broker = ensureParentBroker(options.sessionId);
  let childCapability = lifecycleRegistry.agentChildCapability(canonical);
  if (!childCapability) {
    childCapability = registerChild(broker, canonical.id);
    lifecycleRegistry.attachAgentChildCapability(canonical, childCapability);
  }

  const task = lifecycleRegistry.createTask(canonical, description, {
    timeoutMs: options.timeoutMs,
    deadlineAt: options.deadlineAt,
    artifactSession: options.artifactSession ?? lifecycleRegistry.artifactSession(canonical),
  });
  const session = options.artifactSession ?? lifecycleRegistry.artifactSession(canonical);
  try {
    if (session) {
      const artifact = reserveArtifacts(session, [
        { agent: record.handle.agent, mode: 'single', task: description },
      ])[0];
      markArtifactStarted(session, artifact, { taskId: task.id, agentId: task.agentId });
      lifecycleRegistry.attachTaskArtifact(task, session, artifact, result =>
        finalizeTaskArtifact(task, result)
      );
    }
    const envelope = createEnvelope(
      { sessionId: broker.sessionId, brokerId: broker.brokerId, senderId: broker.parentId },
      {
        kind: 'task',
        targetId: canonical.id,
        taskId: task.id,
        delivery: 'followUp',
        content: description,
      }
    );
    publishFromParent(broker, envelope);
    lifecycleRegistry.setTaskRunning(task);
    return task;
  } catch (error) {
    lifecycleRegistry.settleTask(task, {
      status: 'failed',
      ok: false,
      returnCode: 1,
      error: String((error as any)?.message ?? error),
    });
    throw new Error(`Task submission failed: ${String((error as any)?.message ?? error)}`);
  }
}

/** Apply one explicit child completion to the parent task registry. */
function applyTaskDoneEnvelope(envelope: ShepherdMessageEnvelope): TaskResult | undefined {
  if (envelope.kind !== 'task_done' || !envelope.taskId || !envelope.status) return undefined;
  let task;
  try {
    task = lifecycleRegistry.getTask(envelope.taskId);
  } catch {
    // The broker may contain a late completion after a parent restart/close;
    // unknown session-local task ids are ignored rather than creating records.
    return undefined;
  }
  if (['completed', 'blocked', 'failed', 'cancelled', 'timed_out'].includes(task.state)) {
    return lifecycleRegistry.taskResult(task.taskId);
  }
  if (envelope.status === 'completed' && task.pendingRequestIds.length > 0) {
    // A child cannot declare success while required replies remain pending.
    // Leave the task waiting so the reply or an explicit blocked/failed result
    // can resolve it later.
    return undefined;
  }
  try {
    return lifecycleRegistry.settleTaskForAgent(envelope.taskId, { id: envelope.senderId }, {
      status: envelope.status,
      text: envelope.summary ?? envelope.content,
      error: envelope.error,
    });
  } catch {
    // Ownership and lifecycle failures are rejected at the registry boundary;
    // malformed/late control messages must not stop broker polling.
    return undefined;
  }
}

/**
 * Drain parent control messages and observe external terminal failures. This
 * is deliberately separate from prompt watchers: idle and turn-settled states
 * are never considered successful task completion.
 */
function extractAgentError(output: string): string | undefined {
  const match = output.match(/(?:^|\n)\s*Error:\s*(.+)/i);
  if (!match) return undefined;
  const message = match[1].trim();
  return /api key|authentication|authenticat|provider|model|failed to load/i.test(message)
    ? message
    : undefined;
}

async function readImmediateAgentError(paneId: string): Promise<string | undefined> {
  return extractAgentError((await readPaneTail(paneId)).trim());
}

// ── Phase 6: asynchronous message routing ──────────────────────────────────
// The parent Shepherd is the message hub: it owns request (expectsReply)
// correlation and task waiting state. Children publish into the parent-owned
// broker; parent→child publishes go straight to the target inbox, child→parent
// events are consumed by processParentBrokerMessages() below.

export interface ParentMessageInput {
  target: string;
  message: string;
  taskId?: string;
  threadId?: string;
  replyTo?: string;
  delivery?: 'followUp' | 'steer';
  expectsReply?: boolean;
}

export interface ParentMessageResult {
  messageId: string;
  accepted: true;
  delivery: 'queued' | 'duplicate';
  requestId?: string;
  targetId: string;
  targetTaskState?: string;
}

/**
 * Send a parent-originated message to an owned child. With `expectsReply` and
 * a task id the task enters `waiting` until a matching reply arrives.
 */
export function sendParentMessage(input: ParentMessageInput): ParentMessageResult {
  if (typeof input.message !== 'string' || !input.message.trim()) {
    throw new LifecycleError('invalid_task', 'Message content must not be empty.');
  }
  const broker = currentParentBroker() ?? ensureParentBroker();
  const agent = lifecycleRegistry.getAgent({ id: input.target });
  if (agent.state === 'closed') {
    throw new LifecycleError('closed_handle', `Agent "${input.target}" is closed.`);
  }
  const replyDeadline = input.expectsReply ? Date.now() + loadSettings(process.cwd()).timeout * 60_000 : undefined;
  if (input.expectsReply && input.taskId) {
    // Open the request before publishing so the task never waits on a
    // question the broker refused to queue. The question envelope id becomes
    // the correlation key for the reply.
    if (lifecycleRegistry.getTask(input.taskId).agentId !== agent.handle.id) {
      throw new LifecycleError(
        'task_agent_mismatch',
        `Task "${input.taskId}" is owned by another agent than the message target.`
      );
    }
    const provisional = createEnvelope(
      { sessionId: broker.sessionId, brokerId: broker.brokerId, senderId: broker.parentId },
      {
        kind: 'message',
        targetId: agent.handle.id,
        messageId: `shepherd-message-${randomUUID()}`,
        taskId: input.taskId,
        threadId: input.threadId,
        replyTo: input.replyTo,
        expectsReply: true,
        delivery: input.delivery === 'steer' ? 'steer' : 'followUp',
        content: input.message,
        createdAt: Date.now(),
      },
    );
    lifecycleRegistry.openPendingRequest(input.taskId, {
      messageId: provisional.messageId,
      targetAgentId: agent.handle.id,
      deadlineAt: replyDeadline,
      text: input.message,
    });
    try {
      const envelope = provisional;
      const accepted = publishFromParent(broker, envelope);
      return {
        messageId: envelope.messageId,
        accepted: true,
        delivery: accepted.delivery,
        requestId: envelope.messageId,
        targetId: agent.handle.id,
        targetTaskState: 'waiting',
      };
    } catch (error) {
      lifecycleRegistry.clearPendingReply(input.taskId);
      throw error;
    }
  }
  const envelope = createEnvelope(
    { sessionId: broker.sessionId, brokerId: broker.brokerId, senderId: broker.parentId },
    {
      kind: input.replyTo ? 'reply' : 'message',
      targetId: agent.handle.id,
      messageId: `shepherd-message-${randomUUID()}`,
      taskId: input.taskId,
      threadId: input.threadId,
      replyTo: input.replyTo,
      ...(replyDeadline !== undefined ? { deadlineAt: replyDeadline } : {}),
      delivery: input.delivery === 'steer' ? 'steer' : 'followUp',
      content: input.message,
    },
  );
  const accepted = publishFromParent(broker, envelope);
  let targetTaskState: string | undefined;
  if (input.taskId) {
    targetTaskState = lifecycleRegistry.getTask(input.taskId).state;
  }
  return {
    messageId: envelope.messageId,
    accepted: true,
    delivery: accepted.delivery,
    targetId: agent.handle.id,
    ...(targetTaskState ? { targetTaskState } : {}),
  };
}

export type ParentMessageKind = 'message' | 'reply' | 'runtime';
export type ParentMessageNotifier = (notification: { kind: ParentMessageKind; envelope: ShepherdMessageEnvelope }) => void;

let parentMessageNotifier: ParentMessageNotifier | undefined;

/** Bridge child-originated messages and runtime events into the parent session. */
export function configureParentMessageNotifications(notifier: ParentMessageNotifier | undefined): void {
  parentMessageNotifier = notifier;
}

function notifyParentMessage(kind: ParentMessageKind, envelope: ShepherdMessageEnvelope): void {
  try {
    parentMessageNotifier?.({ kind, envelope });
  } catch {
    // Delivery diagnostics must never break broker polling.
  }
}

/**
 * Drain the parent mailbox and observe external terminal failures. Task
 * completions and failures settle into the registry; child messages and
 * request/reply correlation are applied for task state and surfaced to the
 * parent delivery bridge. This deliberately does NOT treat idle turns, agent
 * end, or agent_settled states as successful task completion.
 */
export async function processParentBrokerMessages(): Promise<TaskResult[]> {
  const broker = currentParentBroker();
  if (!broker || parentBrokerTicking) return [];
  parentBrokerTicking = true;
  const settled: TaskResult[] = [];
  try {
    for (const envelope of pollParentInbox(broker)) {
      const result = envelope.kind === 'task_done'
        ? applyTaskDoneEnvelope(envelope)
        : applyMessageEnvelope(broker, envelope);
      if (result) settled.push(result);
    }
    const now = Date.now();
    if (now - lastTrackedTaskRuntimeCheck >= 1_000) {
      lastTrackedTaskRuntimeCheck = now;
      for (const task of lifecycleRegistry.allTasks()) {
        if (!['created', 'running', 'waiting'].includes(task.state)) continue;
        let agent: AgentHandle;
        try {
          agent = lifecycleRegistry.getAgent({ id: task.agentId }).handle;
        } catch {
          continue;
        }
        if (!agent.paneId) continue;
        if (!paneExists(agent.paneId)) {
          const result = lifecycleRegistry.settleTask(task.taskId, {
            status: 'failed',
            error: 'Agent pane disappeared before the task completed.',
          });
          settled.push(result);
          continue;
        }
        if (task.state === 'waiting' &&
            task.pendingReplyDeadlineAt !== undefined &&
            now >= task.pendingReplyDeadlineAt) {
          const result = lifecycleRegistry.settleTask(task.taskId, {
            status: 'blocked',
            ok: false,
            text: `Timed out waiting for a reply from ${task.pendingReplyTargetAgentId ?? 'the target agent'} (message ${task.pendingReplyMessageId ?? 'unknown'} never answered).`,
            error: 'Tracked reply deadline reached.',
          });
          settled.push(result);
          continue;
        }
        const providerError = await readImmediateAgentError(agent.paneId);
        if (providerError) {
          const result = lifecycleRegistry.settleTask(task.taskId, {
            status: 'failed',
            returnCode: 1,
            error: providerError,
          });
          settled.push(result);
        }
      }
    }
  } finally {
    parentBrokerTicking = false;
  }
  return settled;
}

/**
 * Apply one child-originated message to request/task state. Returns a settled
 * task result when the envelope is an explicit completion; everything else
 * updates correlation state and surfaces to the parent delivery bridge.
 */
function applyMessageEnvelope(broker: ParentBroker, envelope: ShepherdMessageEnvelope): TaskResult | undefined {
  switch (envelope.kind) {
    case 'runtime': {
      if (envelope.requestOpen === true && envelope.taskId && envelope.replyTo) {
        try {
          const task = lifecycleRegistry.getTask(envelope.taskId);
          if (['running', 'waiting'].includes(task.state) && task.pendingReplyMessageId !== envelope.replyTo) {
            try {
              lifecycleRegistry.openPendingRequest(envelope.taskId, {
                messageId: envelope.replyTo,
                targetAgentId: envelope.requestTargetId,
                text: envelope.summary ?? envelope.content,
              });
            } catch {
              // The task already has an outstanding tracked reply; keep the
              // first one per the one-request policy.
            }
          }
        } catch {
          // Unknown task ids (e.g. session-local tasks from another process)
          // are ignored; the mailbox ack already consumed the mirrored event.
        }
      }
      return undefined;
    }
    case 'reply': {
      if (envelope.replyTo && envelope.taskId) {
        try {
          const resolution = lifecycleRegistry.resolveReplyForTask(envelope.taskId, envelope.replyTo);
          // Relay the answer to the task owner, but only when the answer came
          // from a different participant: the parent already holds answers to
          // its own questions, and echoing them back to the owner's inbox
          // would create a self-addressed user message.
          if (resolution.resolved && resolution.agentId !== envelope.senderId) {
            const asker = lifecycleRegistry.getAgent({ id: resolution.agentId });
            const relayed = createEnvelope(
              { sessionId: broker.sessionId, brokerId: broker.brokerId, senderId: broker.parentId },
              {
                kind: 'reply',
                targetId: asker.handle.id,
                messageId: `shepherd-message-${randomUUID()}`,
                taskId: envelope.taskId,
                threadId: envelope.threadId,
                replyTo: envelope.replyTo,
                originSenderId: envelope.senderId,
                delivery: envelope.delivery,
                content: envelope.content,
              },
            );
            publishFromParent(broker, relayed);
          }
        } catch {
          // Invalid replies (unknown task or mismatched replyTo) leave the
          // request pending so the owner can still block/cancel it explicitly.
        }
      }
      notifyParentMessage('reply', envelope);
      return undefined;
    }
    default:
      notifyParentMessage('message', envelope);
      return undefined;
  }
}

export async function promptAgent(
  handle: AgentHandleInput,
  message: string,
  options: { timeout?: number } = {}
): Promise<PromptHandle> {
  if (!message.trim()) throw new Error('Prompt message must not be empty.');
  const canonical = lifecycleRegistry.canonicalAgentHandle(handle);
  const record = lifecycleRegistry.getAgent(canonical);
  if (!record.handle.paneId) throw new Error('Agent handle has no pane.');
  const detected = await waitForHerdrAgentDetected(record.handle.paneId, {
    timeoutMs: Math.min(options.timeout ?? 120000, 15000),
  });
  if (!detected.detected) throw new Error(`Agent "${canonical.id}" is not detected.`);
  // Reserve the single active slot before submission, so concurrent callers
  // cannot both pass validation. Failed submission is settled immediately and
  // never returned as a usable handle.
  let baselineStateChangeSeq: number | undefined;
  try {
    const before: any = herdrExecSync(['agent', 'get', record.handle.paneId]);
    const seq = before?.result?.agent?.state_change_seq;
    if (typeof seq === 'number') baselineStateChangeSeq = seq;
  } catch {}
  const signalPath = lifecycleRegistry.completionSignalPath(canonical);
  const baselineCompletionSignalId = signalPath
    ? readCompletionSignal(signalPath)?.signalId
    : undefined;
  const prompt = lifecycleRegistry.createPrompt(
    canonical,
    undefined, // waitPrompts owns the timeout; promptAgent must not arm one
    baselineStateChangeSeq,
    baselineCompletionSignalId
  );
  const session = lifecycleRegistry.artifactSession(canonical);
  let artifact: ArtifactReservation | undefined;
  try {
    if (session) {
      artifact = reserveArtifacts(session, [
        { agent: record.handle.agent, mode: 'single', task: message },
      ])[0];
      markArtifactStarted(session, artifact, { promptId: prompt.id, agentId: prompt.agentId });
      lifecycleRegistry.attachPromptArtifact(prompt, session, artifact, result =>
        finalizePromptArtifact(prompt, result)
      );
    }
    // No --wait: submission returns as soon as Herdr accepts the message.
    await herdrExec([
      'agent',
      'prompt',
      record.handle.paneId,
      message + (session && artifact ? artifactContext(session, artifact) : ''),
    ]);
    // Provider validation can fail immediately after Herdr accepts the
    // prompt. Give the child a short bounded window to print that error so
    // shepherd_prompt reports it directly instead of returning a prompt that
    // can only fail later as a wait timeout.
    for (let attempt = 0; attempt < 5; attempt++) {
      const error = await readImmediateAgentError(record.handle.paneId);
      if (error) throw new Error(`Agent prompt failed: ${error}`);
      if (attempt < 4) await new Promise(resolve => setTimeout(resolve, 100));
    }
    return prompt;
  } catch (error) {
    lifecycleRegistry.settlePrompt(prompt, {
      promptId: prompt.id,
      agentId: prompt.agentId,
      status: 'failed',
      ok: false,
      returnCode: 1,
      error: String((error as any)?.message ?? error),
    });
    throw new Error(`Prompt submission failed: ${String((error as any)?.message ?? error)}`);
  }
}

export type PromptWatcherNotifier = (notification: WatcherNotification) => void | Promise<void>;

/**
 * Non-blocking prompt completion observer. The registry owns settlement and
 * watcher deduplication; this service only polls Herdr for prompts that have
 * no completion result yet and bridges completions to the parent extension.
 *
 * This is the legacy prompt path. Tracked delegated tasks must not reuse its
 * idle/done inference: a child may be idle while its task is waiting for a
 * peer reply. The task path will settle only from shepherd_done or an explicit
 * failure, cancellation, or timeout event.
 */
export class PromptWatcherService {
  private timer?: ReturnType<typeof setInterval>;
  private ticking = false;
  private notifier?: PromptWatcherNotifier;
  private readonly registry: typeof lifecycleRegistry;
  private readonly intervalMs: number;
  private readonly coalesceMs: number;
  private readonly queued = new Map<string, WatcherCompletion[]>();
  private readonly promptOrder = new Map<string, Map<string, number>>();
  private readonly remaining = new Map<string, number>();
  private readonly flushTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    registry = lifecycleRegistry,
    notifier?: PromptWatcherNotifier,
    intervalMs = 500,
    coalesceMs = 25
  ) {
    this.registry = registry;
    this.notifier = notifier;
    this.intervalMs = intervalMs;
    this.coalesceMs = coalesceMs;
  }

  setNotifier(notifier?: PromptWatcherNotifier): void {
    this.notifier = notifier;
  }

  watch(handles: PromptHandleInput | PromptHandleInput[]): WatcherRegistration {
    // Registration is synchronous, so the id is assigned before any later
    // settlement can invoke this callback. Keeping it in this closure avoids
    // putting watcher identity into durable prompt results.
    let watcherId = '';
    const registration = this.registry.watchPrompts(handles, completion => {
      this.queue(watcherId, completion);
    });
    watcherId = registration.watcherId;
    if (registration.pending.length > 0) {
      this.promptOrder.set(
        watcherId,
        new Map(registration.promptIds.map((promptId, index) => [promptId, index]))
      );
      this.remaining.set(watcherId, registration.pending.length);
      this.start();
    }
    return registration;
  }

  /** Stop polling and discard delivery state for the parent session. */
  shutdown(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.ticking = false;
    for (const timer of this.flushTimers.values()) clearTimeout(timer);
    this.flushTimers.clear();
    this.queued.clear();
    this.promptOrder.clear();
    this.remaining.clear();
    this.registry.clearWatchers();
  }

  private start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    // A watcher is lifecycle state, not a reason for a test/host process to
    // remain alive after its parent has gone away.
    (this.timer as any).unref?.();
    void this.tick();
  }

  private stopIfIdle(): void {
    if (this.registry.watchedPromptIds().length > 0) return;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private queue(watcherId: string, completion: WatcherCompletion): void {
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
    this.stopIfIdle();
  }

  private flush(watcherId: string): void {
    this.flushTimers.delete(watcherId);
    const completions = this.queued.get(watcherId);
    this.queued.delete(watcherId);
    if (!completions || completions.length === 0) return;
    // A watcher still reports prompts as they settle, but when several
    // completions are coalesced into one notification, keep the array in the
    // caller's input order. This makes the result deterministic without
    // delaying an individual completion until earlier prompts finish.
    const order = this.promptOrder.get(watcherId);
    if (order) {
      completions.sort((left, right) =>
        (order.get(left.promptId) ?? Number.MAX_SAFE_INTEGER) -
        (order.get(right.promptId) ?? Number.MAX_SAFE_INTEGER)
      );
    }
    const notification = { watcherId, completions };
    if (this.remaining.get(watcherId) === 0) {
      this.promptOrder.delete(watcherId);
      this.remaining.delete(watcherId);
    }
    try {
      const result = this.notifier?.(notification);
      if (result && typeof (result as Promise<void>).catch === 'function') {
        (result as Promise<void>).catch(() => undefined);
      }
    } catch {
      // The prompt result is already durable; an unavailable parent message
      // bridge must not corrupt settlement or fieldnote finalization.
    }
  }

  private async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const promptIds = this.registry.watchedPromptIds();
      if (promptIds.length === 0) {
        this.stopIfIdle();
        return;
      }
      await Promise.all(promptIds.map(promptId => this.observe(promptId)));
    } finally {
      this.ticking = false;
      this.stopIfIdle();
    }
  }

  private async observe(promptId: string): Promise<void> {
    let record: any;
    try {
      record = this.registry.getPrompt(promptId);
    } catch {
      return;
    }
    if (record.settled) return;
    let agent: any;
    try {
      agent = this.registry.getAgent({ id: record.handle.agentId } as AgentHandle);
    } catch {
      return;
    }
    const paneId = agent.handle.paneId;
    if (!paneId) return;
    const signalPath = this.registry.completionSignalPath(agent.handle);
    const resultPath = this.registry.completionResultPath(agent.handle);
    const readText = async (): Promise<string> => {
      if (resultPath) {
        const text = readLastAssistantText(resultPath).trim();
        if (text) return text;
      }
      return (await readPaneTail(paneId)).trim();
    };
    const readError = async (): Promise<string | undefined> => {
      return extractAgentError(await readPaneTail(paneId));
    };
    try {
      // Use the async Herdr bridge here: watcher registration must return
      // without synchronously waiting on a child or the Herdr CLI.
      const out: any = await herdrExec(['agent', 'get', paneId]);
      const state = String(out?.result?.agent?.agent_status ?? 'unknown').toLowerCase();
      const seq = out?.result?.agent?.state_change_seq;
      if (state === 'working') this.registry.observeWorking(record.handle);
      const signal: any = signalPath ? readCompletionSignal(signalPath) : undefined;
      const tracking = this.registry.promptTracking(record.handle);
      if (signal?.signalId && signal.signalId !== tracking.baselineCompletionSignalId) {
        const failed = signal.type === 'error';
        this.registry.settlePrompt(record.handle, {
          promptId,
          agentId: record.handle.agentId,
          status: failed ? 'failed' : 'done',
          ok: !failed,
          text: await readText(),
          ...(failed && signal.errorMessage ? { error: signal.errorMessage } : {}),
          ...(typeof signal.returnCode === 'number' ? { returnCode: signal.returnCode } : {}),
        });
        return;
      }
      const error = await readError();
      if (error) {
        this.registry.settlePrompt(record.handle, {
          promptId,
          agentId: record.handle.agentId,
          status: 'failed',
          ok: false,
          returnCode: 1,
          error,
        });
        return;
      }
      const sequenceAdvanced =
        tracking.baselineStateChangeSeq === undefined ||
        (typeof seq === 'number' && seq !== tracking.baselineStateChangeSeq);
      if (['idle', 'done', 'blocked'].includes(state) && (tracking.observedWorking || sequenceAdvanced)) {
        this.registry.settlePrompt(record.handle, {
          promptId,
          agentId: record.handle.agentId,
          status: state === 'blocked' ? 'blocked' : state === 'done' ? 'done' : 'idle',
          ok: state !== 'blocked',
          text: await readText(),
        });
      }
    } catch {
      const error = await readError();
      if (error) {
        this.registry.settlePrompt(record.handle, {
          promptId,
          agentId: record.handle.agentId,
          status: 'failed',
          ok: false,
          returnCode: 1,
          error,
        });
      }
    }
  }
}

export const promptWatcherService = new PromptWatcherService();

export function configurePromptWatcherNotifications(notifier?: PromptWatcherNotifier): void {
  promptWatcherService.setNotifier(notifier);
}

export function shutdownPromptWatchers(): void {
  promptWatcherService.shutdown();
}

async function waitOne(handle: PromptHandleInput, timeoutMs = 120000): Promise<PromptResult> {
  const failed = (error: unknown): PromptResult => ({
    promptId:
      typeof handle === 'object' && handle && typeof handle.id === 'string' ? handle.id : 'unknown',
    agentId:
      typeof handle === 'object' && handle && typeof handle.agentId === 'string'
        ? handle.agentId
        : 'unknown',
    status: 'failed',
    ok: false,
    returnCode: 1,
    error: String((error as any)?.message ?? error),
  });
  try {
    const canonical = lifecycleRegistry.canonicalPromptHandle(handle);
    const record = lifecycleRegistry.getPrompt(canonical);
    if (record.settled) return lifecycleRegistry.wait(canonical);
    const agent = lifecycleRegistry.getAgent({ id: canonical.agentId } as AgentHandle);
    const signalPath = lifecycleRegistry.completionSignalPath(agent.handle);
    const resultPath = lifecycleRegistry.completionResultPath(agent.handle);
    // Prefer the full final answer from the child's session file; the pane
    // tail only reflects the TUI rendering and is a fallback for short answers.
    const readResultText = async (): Promise<string> => {
      if (resultPath) {
        const text = readLastAssistantText(resultPath).trim();
        if (text) return text;
      }
      return agent.handle.paneId ? (await readPaneTail(agent.handle.paneId)).trim() : '';
    };
    const readAgentError = async (): Promise<string | undefined> => {
      if (!agent.handle.paneId) return undefined;
      const output = await readPaneTail(agent.handle.paneId);
      // Some provider failures happen before shepherd-done receives an
      // agent_end event, so there is no completion sidecar to observe. Catch
      // the terminal error here and turn it into a failed prompt result rather
      // than allowing the wait to time out.
      const match = output.match(/(?:^|\n)\s*Error:\s*(.+)/i);
      if (!match) return undefined;
      const message = match[1].trim();
      return /api key|authentication|authenticat|provider|model|failed to load/i.test(message)
        ? message
        : undefined;
    };

    // Arm/replace the timeout on the prompt record (clears safety net from createPrompt).
    if (record.timeoutId) clearTimeout(record.timeoutId);
    record.timeoutId = setTimeout(
      () =>
        lifecycleRegistry.settlePrompt(canonical, {
          promptId: canonical.id,
          agentId: canonical.agentId,
          status: 'timeout',
          ok: false,
          error: `Timed out waiting for agent after ${timeoutMs >= 60000 ? Math.round(timeoutMs / 60000) + ' minutes' : Math.round(timeoutMs / 1000) + ' seconds'}`,
        }),
      timeoutMs
    );

    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      try {
        const out: any = herdrExecSync(['agent', 'get', agent.handle.paneId!]);
        const state = String(out?.result?.agent?.agent_status ?? 'unknown').toLowerCase();
        const seq = out?.result?.agent?.state_change_seq;
        const tracking = lifecycleRegistry.promptTracking(canonical);
        if (state === 'working') lifecycleRegistry.observeWorking(canonical);
        const signal = signalPath ? readCompletionSignal(signalPath) : undefined;
        const signalAdvanced = Boolean(
          signal?.signalId && signal.signalId !== tracking.baselineCompletionSignalId
        );
        if (signalAdvanced) {
          const text = await readResultText();
          const failedSignal = signal?.type === 'error';
          return lifecycleRegistry.settlePrompt(canonical, {
            promptId: canonical.id,
            agentId: canonical.agentId,
            status: failedSignal ? 'failed' : 'done',
            ok: !failedSignal,
            text,
            ...(failedSignal && signal?.errorMessage ? { error: signal.errorMessage } : {}),
          });
        }
        const agentError = await readAgentError();
        if (agentError) {
          return lifecycleRegistry.settlePrompt(canonical, {
            promptId: canonical.id,
            agentId: canonical.agentId,
            status: 'failed',
            ok: false,
            returnCode: 1,
            error: agentError,
          });
        }
        const sequenceAdvanced =
          tracking.baselineStateChangeSeq === undefined ||
          (typeof seq === 'number' && seq !== tracking.baselineStateChangeSeq);
        // An idle/done state observed before this submission is not completion.
        // Require a post-submit state transition or a working observation first.
        if (
          ['idle', 'done', 'blocked'].includes(state) &&
          (tracking.observedWorking || sequenceAdvanced)
        ) {
          const text = await readResultText();
          return lifecycleRegistry.settlePrompt(canonical, {
            promptId: canonical.id,
            agentId: canonical.agentId,
            status: state === 'blocked' ? 'blocked' : state === 'done' ? 'done' : 'idle',
            ok: state !== 'blocked',
            text,
          });
        }
      } catch {
        // Herdr may stop recognizing the child as soon as Pi enters its
        // provider-error state. Still inspect the pane in that case; the
        // terminal error is the useful result, not a wait timeout.
        const agentError = await readAgentError();
        if (agentError) {
          return lifecycleRegistry.settlePrompt(canonical, {
            promptId: canonical.id,
            agentId: canonical.agentId,
            status: 'failed',
            ok: false,
            returnCode: 1,
            error: agentError,
          });
        }
      }
      await new Promise(r => setTimeout(r, 500));
    }
    // Loop exited without settling; the timeout callback will fire.
    // wait() will return the timeout result set by settlePrompt.
    return lifecycleRegistry.wait(canonical);
  } catch (error) {
    return failed(error);
  }
}

export async function waitPrompts(
  handles: PromptHandleInput | PromptHandleInput[],
  options: { timeout?: number } = {}
): Promise<PromptResult | PromptResult[]> {
  const timeout = options.timeout ?? 120000;
  if (Array.isArray(handles)) {
    // Promise.all is intentionally concurrent and preserves input order. Each
    // waitOne converts operational failures into a result, so partial success is
    // never hidden by another prompt's failure.
    return Promise.all(handles.map(handle => waitOne(handle, timeout)));
  }
  return waitOne(handles, timeout);
}

export function statusAgent(handle: AgentHandleInput): AgentStatus {
  const canonical = lifecycleRegistry.canonicalAgentHandle(handle);
  const status = lifecycleRegistry.status(canonical);
  if (status.state === 'closed' || !canonical.paneId) return status;
  try {
    const rec: any = (herdrExecSync(['agent', 'get', canonical.paneId]) as any)?.result?.agent;
    const state = String(rec?.agent_status ?? 'unknown').toLowerCase();
    const mapped = ['idle', 'working', 'blocked', 'done'].includes(state)
      ? (state as any)
      : 'unknown';
    return {
      ...status,
      state: mapped,
      paneId: rec?.pane_id ?? canonical.paneId,
      tabId: rec?.tab_id ?? canonical.tabId,
      workspaceId: rec?.workspace_id ?? canonical.workspaceId,
    };
  } catch {
    return { ...status, state: paneExists(canonical.paneId) ? 'unknown' : 'failed' };
  }
}

export function closeAgent(handle: AgentHandleInput): AgentHandle {
  const canonical = lifecycleRegistry.canonicalAgentHandle(handle);
  const record = lifecycleRegistry.getAgent(canonical);
  if (!record.handle.paneId || !loadCreatedPanes().some(p => p.paneId === record.handle.paneId))
    throw new Error('Refusing to close an unowned pane.');
  lifecycleRegistry.close(canonical);
  try {
    herdrExecSync(['pane', 'close', record.handle.paneId]);
  } catch {
    if (paneExists(record.handle.paneId)) throw new Error('Could not close agent pane.');
  }
  if (!paneExists(record.handle.paneId)) removeCreatedPaneDir(record.handle.paneId);
  return canonical;
}
