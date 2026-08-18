#!/usr/bin/env node
const { LifecycleRegistry } = await import("../orchestration.ts");
let failures = 0;
function assert(ok, label) { if (ok) console.log(`PASS  ${label}`); else { failures++; console.log(`FAIL  ${label}`); } }
const registry = new LifecycleRegistry();
const a = registry.registerAgent({ agent: "a" });
const b = registry.registerAgent({ agent: "b" });
const slow = registry.createPrompt(a);
const fast = registry.createPrompt(b);
setTimeout(() => registry.settlePrompt(slow, { promptId: slow.id, agentId: slow.agentId, status: "done", ok: true, text: "slow" }), 40);
registry.settlePrompt(fast, { promptId: fast.id, agentId: fast.agentId, status: "done", ok: true, text: "fast" });
const started = Date.now();
const results = await Promise.all([registry.wait(slow), registry.wait(fast)]);
assert(results[0].text === "slow" && results[1].text === "fast", "multi-wait preserves input order");
assert(Date.now() - started >= 35, "multi-wait waits concurrently for slow result");
if (failures) process.exit(1);
console.log("All multi-wait assertions passed.");
