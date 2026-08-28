import { discoverAgents, resolveDelegatedModel } from './discovery.ts';
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
  type AgentStatus,
  formatAgentName,
  validateAgentLabel,
} from './orchestration.ts';
import {
  reserveArtifacts,
  markArtifactStarted,
  finalizeArtifact,
  type ShepherdSession,
  type ArtifactReservation,
} from './artifact-sessions.ts';

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
      { agent: name, label, model: delegatedModel, paneId, tabId, workspaceId },
      {
        completionSignalPath: `${files.sessionFile}.exit`,
        completionResultPath: files.sessionFile,
        artifactSession: options.artifactSession,
      }
    );
  } catch (error) {
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
