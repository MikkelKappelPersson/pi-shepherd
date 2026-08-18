#!/usr/bin/env node
const { LifecycleRegistry } = await import("../orchestration.ts");
let failures = 0;
function assert(ok, label) { if (ok) console.log(`PASS  ${label}`); else { failures++; console.log(`FAIL  ${label}`); } }
const { prepareShepherdArguments } = await import("../shepherd.ts");
const preparedHandle = prepareShepherdArguments({
 action: "prompt",
 handle: JSON.stringify({ id: "agent-1", agent: "worker" }),
 message: "say hi",
});
assert(JSON.stringify(preparedHandle.handle) === JSON.stringify({ id: "agent-1", agent: "worker" }), "stringified handle is normalized before validation");
const preparedArray = prepareShepherdArguments({
 action: "wait",
 handle: JSON.stringify([{ id: "prompt-1", agentId: "agent-1", createdAt: 1 }]),
});
assert(JSON.stringify(preparedArray.handle) === JSON.stringify([{ id: "prompt-1", agentId: "agent-1", createdAt: 1 }]), "stringified handle array is normalized before validation");
assert(prepareShepherdArguments({ action: "prompt", handle: { id: "agent-1" }, message: "say hi" }).handle.id === "agent-1", "native handle is preserved");

const registry = new LifecycleRegistry();
const agent = registry.registerAgent({ agent: "scout", paneId: "owned-pane" });
assert(JSON.parse(JSON.stringify(agent)).id === agent.id, "stable agent handle serialization");
for (const invalid of [JSON.stringify(agent), agent.id]) {
 try { registry.getAgent(invalid); assert(false, "non-object agent handle rejected"); }
 catch (e) {
  assert(e.code === "invalid_handle", "non-object agent handle rejected");
  assert(e.message.includes("Correct syntax:"), "agent handle error prints correct syntax");
 }
}
const prompt = registry.createPrompt(agent);
assert(JSON.parse(JSON.stringify(prompt)).agentId === agent.id, "stable prompt handle serialization");
for (const invalid of [JSON.stringify(prompt), prompt.id]) {
 try { registry.getPrompt(invalid); assert(false, "non-object prompt handle rejected"); }
 catch (e) {
  assert(e.code === "invalid_handle", "non-object prompt handle rejected");
  assert(e.message.includes('Correct syntax: { action: "wait"'), "prompt handle error prints correct syntax");
 }
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
