#!/usr/bin/env node
/**
 * Phase 0 guardrails and test-fixture verification.
 *
 * This test deliberately exercises the existing prompt registry without
 * introducing task runtime behavior. It documents the boundary that the task
 * implementation must preserve: process/agent state can change independently
 * of explicit lifecycle settlement.
 */
import assert from 'node:assert/strict';
import { LifecycleRegistry } from '../src/core/orchestration.ts';
import { createManualClock, withFakeDateNow } from './helpers/fake-clock.mjs';
import {
  createFakeChildIdentity,
  createFakeParentIdentity,
  flushMicrotasks,
  withTempDirectory,
} from './helpers/test-utils.mjs';
import {
  plannedChildOnlyTools,
  plannedParentOnlyTools,
  plannedTaskStates,
  plannedToolContracts,
} from './helpers/feature-contracts.mjs';
import * as fs from 'node:fs';
import * as path from 'node:path';

const parent = createFakeParentIdentity();
const child = createFakeChildIdentity();
assert.equal(parent.role, 'parent');
assert.equal(child.role, 'child');
assert.equal(parent.sessionId, child.sessionId);
console.log('PASS reusable parent/child test identities share a session');

await withTempDirectory('pi-shepherd-phase0-', async directory => {
  const marker = path.join(directory, 'fixture-marker.txt');
  fs.writeFileSync(marker, 'isolated');
  assert.equal(fs.readFileSync(marker, 'utf8'), 'isolated');
  assert.ok(directory.includes('pi-shepherd-phase0-'));
});
console.log('PASS temporary test directories are isolated and cleaned up');

const clock = createManualClock(1_000);
assert.equal(clock.now(), 1_000);
assert.equal(clock.advance(500), 1_500);
assert.equal(clock.set(9_000), 9_000);
await withFakeDateNow(42_000, async controlled => {
  assert.equal(Date.now(), 42_000);
  controlled.advance(1_000);
  assert.equal(Date.now(), 43_000);
  await flushMicrotasks();
});
console.log('PASS deterministic clock helpers control synchronous and async test time');

assert.deepEqual(Object.keys(plannedToolContracts), [
  'shepherd_delegate',
  'shepherd_message',
  'shepherd_done',
  'shepherd_watch',
]);
assert.deepEqual(plannedParentOnlyTools, ['shepherd_delegate', 'shepherd_watch']);
assert.deepEqual(plannedChildOnlyTools, ['shepherd_done']);
assert.ok(plannedTaskStates.includes('waiting'));
assert.ok(plannedTaskStates.includes('completed'));
assert.ok(plannedTaskStates.includes('timed_out'));
for (const contract of Object.values(plannedToolContracts)) {
  assert.equal(contract.rootType, 'object');
  assert.ok(contract.required.length > 0);
}
console.log('PASS future tool, surface, and task-state contract placeholders are centralized');

const registry = new LifecycleRegistry();
const agent = registry.registerAgent({ agent: 'scout', label: 'phase 0 guardrail' });
const prompt = registry.createPrompt(agent);

// This is the explicit-settlement guard for the future task registry. A child
// may become idle between turns, but an open delegated task must remain open
// until shepherd_done (or an explicit failure/cancellation/timeout) settles it.
registry.setAgentState(agent, 'idle');
assert.equal(registry.status(agent).state, 'idle');
assert.equal(registry.promptResult(prompt.id), undefined);
assert.equal(registry.getPrompt(prompt.id).settled, false);
console.log('PASS agent idle state does not itself settle an open lifecycle record');

registry.settlePrompt(prompt, {
  promptId: prompt.id,
  agentId: prompt.agentId,
  status: 'done',
  ok: true,
  text: 'explicit settlement',
});
assert.equal(registry.promptResult(prompt.id)?.text, 'explicit settlement');
console.log('PASS lifecycle record settles only after an explicit settlement call');

console.log('All Phase 0 guardrail assertions passed.');
