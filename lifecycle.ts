import { discoverAgents, type AgentScope } from "./discovery.ts";
import {
 ensureHerdrRuntime, getHerdrWorkspaceId, createHerdrTab, waitForHerdrShellReady,
 waitForHerdrAgentDetected, launchPiInPane, herdrExec, herdrExecSync,
 loadCreatedPanes, paneExists, removeCreatedPaneDir, readPaneTail,
} from "./herdr.ts";
import { lifecycleRegistry, type AgentHandle, type PromptHandle, type PromptResult, type AgentStatus } from "./orchestration.ts";

export interface StartOptions { cwd?: string; model?: string; agentScope?: AgentScope; confirmProjectAgents?: boolean; omitSystemPrompt?: boolean; timeout?: number; }

export async function startAgent(name: string, options: StartOptions = {}, ctx: { cwd: string; hasUI?: boolean; ui?: any }): Promise<AgentHandle> {
 const cwd = options.cwd ?? ctx.cwd;
 const found = discoverAgents(cwd, options.agentScope ?? "user").agents.find(a => a.name === name);
 if (!found) throw new Error(`Unknown agent "${name}".`);
 if (found.source === "project" && options.confirmProjectAgents !== false && ctx.hasUI) {
  const ok = await ctx.ui.confirm("Run project-local agent?", `Agent: ${name}\nSource: ${found.filePath}`);
  if (!ok) throw new Error("Project-local agent was not approved.");
 }
 await ensureHerdrRuntime();
 const { paneId, tabId } = createHerdrTab(name, cwd, getHerdrWorkspaceId());
 try {
  await waitForHerdrShellReady(paneId, { timeoutMs: options.timeout ?? 15000 });
  launchPiInPane(paneId, { name, persistent: true, systemPrompt: found.systemPrompt, omitSystemPrompt: options.omitSystemPrompt ?? found.omitSystemPrompt, model: options.model ?? found.model, tools: found.tools });
  const ready = await waitForHerdrAgentDetected(paneId, { timeoutMs: options.timeout ?? 20000 });
  if (!ready.detected) throw new Error(`Agent "${name}" did not become ready.`);
  return lifecycleRegistry.registerAgent({ agent: name, paneId, tabId, workspaceId: getHerdrWorkspaceId() });
 } catch (error) {
  try { herdrExecSync(["pane", "close", paneId]); } catch {}
  if (!paneExists(paneId)) removeCreatedPaneDir(paneId);
  throw error;
 }
}

export async function promptAgent(handle: AgentHandle, message: string, options: { timeout?: number } = {}): Promise<PromptHandle> {
 if (!message.trim()) throw new Error("Prompt message must not be empty.");
 const record = lifecycleRegistry.getAgent(handle);
 if (!record.handle.paneId) throw new Error("Agent handle has no pane.");
 const detected = await waitForHerdrAgentDetected(record.handle.paneId, { timeoutMs: Math.min(options.timeout ?? 120000, 15000) });
 if (!detected.detected) throw new Error(`Agent "${handle.id}" is not detected.`);
 // Reserve the single active slot before submission, so concurrent callers
 // cannot both pass validation. Failed submission is settled immediately and
 // never returned as a usable handle.
 let baselineStateChangeSeq: number | undefined;
 try {
  const before: any = herdrExecSync(["agent", "get", record.handle.paneId]);
  const seq = before?.result?.agent?.state_change_seq;
  if (typeof seq === "number") baselineStateChangeSeq = seq;
 } catch {}
 const prompt = lifecycleRegistry.createPrompt(handle, options.timeout, baselineStateChangeSeq);
 try {
  // No --wait: submission returns as soon as Herdr accepts the message.
  await herdrExec(["agent", "prompt", record.handle.paneId, message]);
  return prompt;
 } catch (error) {
  lifecycleRegistry.settlePrompt(prompt, { promptId: prompt.id, agentId: prompt.agentId, status: "failed", ok: false, error: String((error as any)?.message ?? error) });
  throw new Error(`Prompt submission failed: ${String((error as any)?.message ?? error)}`);
 }
}

async function waitOne(handle: PromptHandle, timeoutMs = 120000): Promise<PromptResult> {
 const failed = (error: unknown): PromptResult => ({
  promptId: typeof handle?.id === "string" ? handle.id : "unknown",
  agentId: typeof handle?.agentId === "string" ? handle.agentId : "unknown",
  status: "failed", ok: false, error: String((error as any)?.message ?? error),
 });
 try {
  const record = lifecycleRegistry.getPrompt(handle);
  if (record.settled) return lifecycleRegistry.wait(handle);
  const agent = lifecycleRegistry.getAgent({ id: handle.agentId } as AgentHandle);
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
   try {
    const out: any = herdrExecSync(["agent", "get", agent.handle.paneId!]);
    const state = String(out?.result?.agent?.agent_status ?? "unknown").toLowerCase();
    const seq = out?.result?.agent?.state_change_seq;
    const tracking = lifecycleRegistry.promptTracking(handle);
    if (state === "working") lifecycleRegistry.observeWorking(handle);
    const sequenceAdvanced = tracking.baselineStateChangeSeq === undefined || (typeof seq === "number" && seq !== tracking.baselineStateChangeSeq);
    // An idle/done state observed before this submission is not completion.
    // Require a post-submit state transition or a working observation first.
    if (["idle", "done", "blocked"].includes(state) && (tracking.observedWorking || sequenceAdvanced)) {
     const text = agent.handle.paneId ? (await readPaneTail(agent.handle.paneId)).trim() : "";
     return lifecycleRegistry.settlePrompt(handle, { promptId: handle.id, agentId: handle.agentId, status: state === "blocked" ? "blocked" : state === "done" ? "done" : "idle", ok: state !== "blocked", text });
    }
   } catch {}
   await new Promise(r => setTimeout(r, 500));
  }
  return lifecycleRegistry.settlePrompt(handle, { promptId: handle.id, agentId: handle.agentId, status: "timeout", ok: false, error: "Timed out waiting for agent." });
 } catch (error) {
  return failed(error);
 }
}

export async function waitPrompts(handles: PromptHandle | PromptHandle[], options: { timeout?: number } = {}): Promise<PromptResult | PromptResult[]> {
 const timeout = options.timeout ?? 120000;
 if (Array.isArray(handles)) {
  // Promise.all is intentionally concurrent and preserves input order. Each
  // waitOne converts operational failures into a result, so partial success is
  // never hidden by another prompt's failure.
  return Promise.all(handles.map((handle) => waitOne(handle, timeout)));
 }
 return waitOne(handles, timeout);
}

export function statusAgent(handle: AgentHandle): AgentStatus {
 const status = lifecycleRegistry.status(handle);
 if (status.state === "closed" || !handle.paneId) return status;
 try {
  const rec: any = (herdrExecSync(["agent", "get", handle.paneId]) as any)?.result?.agent;
  const state = String(rec?.agent_status ?? "unknown").toLowerCase();
  const mapped = ["idle", "working", "blocked", "done"].includes(state) ? state as any : "unknown";
  return { ...status, state: mapped, paneId: rec?.pane_id ?? handle.paneId, tabId: rec?.tab_id ?? handle.tabId, workspaceId: rec?.workspace_id ?? handle.workspaceId };
 } catch { return { ...status, state: paneExists(handle.paneId) ? "unknown" : "failed" }; }
}

export function closeAgent(handle: AgentHandle): void {
 const record = lifecycleRegistry.getAgent(handle);
 if (!record.handle.paneId || !loadCreatedPanes().some(p => p.paneId === record.handle.paneId)) throw new Error("Refusing to close an unowned pane.");
 lifecycleRegistry.close(handle);
 try { herdrExecSync(["pane", "close", record.handle.paneId]); } catch { if (paneExists(record.handle.paneId)) throw new Error("Could not close agent pane."); }
 if (!paneExists(record.handle.paneId)) removeCreatedPaneDir(record.handle.paneId);
}
