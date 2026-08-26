#!/usr/bin/env node
const { LifecycleRegistry } = await import("../src/core/orchestration.ts");
let failures = 0;
function assert(ok, label) { if (ok) console.log(`PASS  ${label}`); else { failures++; console.log(`FAIL  ${label}`); } }
const { prepareShepherdArguments, formatIdForModel } = await import("../src/extension/shepherd.ts");
const preparedHandle = prepareShepherdArguments({
 action: "prompt",
 handle: JSON.stringify({ id: "agent-1", agent: "worker" }),
 message: "say hi",
});
const preparedId = prepareShepherdArguments({ action: "prompt", id: "agent-1", message: "say hi" });
assert(preparedId.id === "agent-1", "native lifecycle id is preserved");
const preparedLegacy = prepareShepherdArguments({
 action: "prompt",
 handle: JSON.stringify({ id: "agent-1", agent: "worker" }),
 message: "say hi",
});
assert(preparedLegacy.id === "agent-1" && !('handle' in preparedLegacy), "legacy handle is migrated to id");
const preparedArray = prepareShepherdArguments({
 action: "wait",
 id: JSON.stringify(["prompt-1", "prompt-2"]),
});
assert(JSON.stringify(preparedArray.id) === JSON.stringify(["prompt-1", "prompt-2"]), "stringified id array is normalized before validation");
assert(formatIdForModel("shepherd-agent-1") === "shepherd-agent-1", "model-facing id text remains copyable");
const normalizedOptions = prepareShepherdArguments({
 action: "spawn", agent: "worker", confirmProjectAgents: "False", omitSystemPrompt: "True", timeout: "120000",
});
assert(normalizedOptions.confirmProjectAgents === false && normalizedOptions.omitSystemPrompt === true, "stringified booleans are normalized");
assert(normalizedOptions.timeout === 120000, "stringified integer is normalized");

const registry = new LifecycleRegistry();
const agent = registry.registerAgent({ agent: "scout", paneId: "owned-pane" });
assert(JSON.parse(JSON.stringify(agent)).id === agent.id, "stable internal agent handle serialization");
assert(registry.getAgent(agent.id).handle.id === agent.id, "agent id resolves in registry");
try { registry.getAgent(JSON.stringify(agent)); assert(false, "quoted agent object rejected"); }
catch (e) {
 assert(e.code === "unknown_handle", "quoted agent object rejected");
 assert(e.message.includes("pane id"), "agent id error explains pane distinction");
}
const prompt = registry.createPrompt(agent);
assert(JSON.parse(JSON.stringify(prompt)).agentId === agent.id, "stable internal prompt handle serialization");
assert(registry.getPrompt(prompt.id).handle.id === prompt.id, "prompt id resolves in registry");
try { registry.getPrompt(JSON.stringify(prompt)); assert(false, "quoted prompt object rejected"); }
catch (e) {
 assert(e.code === "unknown_handle", "quoted prompt object rejected");
 assert(e.message.includes("agent id"), "prompt id error explains id distinction");
}
try { registry.createPrompt(agent); assert(false, "duplicate active prompt rejected"); } catch (e) { assert(e.code === "active_prompt", "duplicate active prompt rejected"); }
registry.settlePrompt(prompt, { promptId: prompt.id, agentId: agent.id, status: "done", ok: true, text: "ok" });
assert(registry.status(agent).state === "done", "settlement updates agent state");
assert(registry.settlePrompt(prompt, { promptId: prompt.id, agentId: agent.id, status: "failed", ok: false }).status === "done", "settlement is idempotent");
const second = registry.createPrompt(agent);
registry.close(agent);
assert((await registry.wait(second)).status === "cancelled", "close cancels unresolved prompt");
assert(registry.status(agent).state === "closed", "close marks agent closed");
try { registry.getAgent({ id: "foreign" }); assert(false, "unknown handle rejected"); } catch (e) { assert(e.code === "unknown_handle", "unknown handle rejected"); }
if (failures) process.exit(1);
console.log("All registry assertions passed.");
