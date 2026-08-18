#!/usr/bin/env node
const { LifecycleRegistry } = await import("../orchestration.ts");
let failures = 0;
function assert(ok, label) { if (ok) console.log(`PASS  ${label}`); else { failures++; console.log(`FAIL  ${label}`); } }
const registry = new LifecycleRegistry();
const agent = registry.registerAgent({ agent: "scout", paneId: "owned-pane" });
assert(JSON.parse(JSON.stringify(agent)).id === agent.id, "stable agent handle serialization");
assert(registry.getAgent(JSON.stringify(agent)).handle.id === agent.id, "JSON agent handle normalization");
assert(registry.getAgent(agent.id).handle.id === agent.id, "opaque agent id normalization");
const prompt = registry.createPrompt(agent);
assert(JSON.parse(JSON.stringify(prompt)).agentId === agent.id, "stable prompt handle serialization");
assert(registry.getPrompt(JSON.stringify(prompt)).handle.id === prompt.id, "JSON prompt handle normalization");
assert(registry.getPrompt(prompt.id).handle.id === prompt.id, "opaque prompt id normalization");
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
