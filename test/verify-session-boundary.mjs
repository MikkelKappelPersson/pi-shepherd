#!/usr/bin/env node
/** Regression coverage for lifecycle state leaking across pi sessions. */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { LifecycleError, LifecycleRegistry, lifecycleRegistry } from '../src/core/orchestration.ts';

function expectUnknown(fn, label, code = 'unknown_handle') {
  assert.throws(fn, error => {
    assert.ok(error instanceof LifecycleError, `${label}: expected LifecycleError`);
    assert.equal(error.code, code, `${label}: expected ${code}`);
    return true;
  });
  console.log(`PASS ${label}`);
}

// Core registry behavior: a repeated session_start for the same parent must be
// idempotent, while a different parent session gets a fresh lifecycle namespace.
const registry = new LifecycleRegistry();
registry.beginSession('parent-session-a');
const oldTester = registry.registerAgent({ agent: 'tester', label: 'task 1 color adjustment' });
const oldWorker = registry.registerAgent({ agent: 'worker', label: 'task 1 color adjustment' });
const oldTask = registry.createTask(oldTester, 'Old session task');
const oldPrompt = registry.createPrompt(oldTester);
// Settle before switching so this focused test does not leave the prompt's
// long safety timer alive; the handle should still be rejected after rollover.
registry.settlePrompt(oldPrompt, { promptId: oldPrompt.id, agentId: oldTester.id, status: 'done', ok: true });

assert.throws(
  () => registry.registerAgent({ agent: 'tester', label: 'task 1 color adjustment' }),
  /Duplicate agent label/,
  'same-session duplicate remains rejected',
);
console.log('PASS same-session duplicate remains rejected');

registry.beginSession('parent-session-a');
assert.throws(
  () => registry.registerAgent({ agent: 'tester', label: 'task 1 color adjustment' }),
  /Duplicate agent label/,
  'repeated session_start for the same session does not reset the registry',
);
console.log('PASS repeated session_start for the same session does not reset the registry');

registry.beginSession('parent-session-b');
const freshTester = registry.registerAgent({ agent: 'tester', label: 'task 1 color adjustment' });
assert.notEqual(freshTester.id, oldTester.id, 'new session receives a new opaque agent id');
assert.equal(registry.allAgents().length, 1, 'allAgents exposes only current-session agents');
assert.equal(registry.allAgents()[0].id, freshTester.id);
console.log('PASS identical label is reusable in a new session');
console.log('PASS old-session agents are excluded from current-session projections');

expectUnknown(() => registry.getAgent(oldTester.id), 'old agent id is rejected after a session switch');
expectUnknown(() => registry.getAgent(oldWorker.id), 'old peer agent id is rejected after a session switch');
expectUnknown(() => registry.getTask(oldTask.id), 'old task id is rejected after a session switch', 'unknown_task');
expectUnknown(() => registry.getPrompt(oldPrompt.id), 'old prompt id is rejected after a session switch');
assert.deepEqual(registry.allTasks(), [], 'old-session tasks are excluded from current-session projections');
console.log('PASS old-session tasks are excluded from current-session projections');

// A spawn can cross a session boundary while Herdr is starting the child. Its
// reserved id must not be registered into the new session accidentally.
const inFlightId = registry.allocateAgentId();
registry.beginSession('parent-session-c');
assert.throws(
  () => registry.registerAgent({ id: inFlightId, agent: 'tester', label: 'in-flight spawn' }),
  error => error instanceof LifecycleError && error.code === 'invalid_handle',
  'in-flight spawn ids cannot be registered after a session switch',
);
console.log('PASS in-flight spawn ids cannot be registered after a session switch');

// Integration boundary: exercise the actual index.ts session_start hook so the
// regression cannot be hidden by testing beginSession() without wiring it up.
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = mkdtempSync(path.join(tmpdir(), 'pi-shepherd-session-boundary-'));
try {
  const calls = { events: [] };
  const pi = {
    registerTool() {},
    registerCommand() {},
    registerMessageRenderer() {},
    on(event, handler) { calls.events.push({ event, handler }); },
  };
  const { default: registerExtension } = await import('../index.ts');
  registerExtension(pi);
  const sessionStartHandlers = calls.events
    .filter(entry => entry.event === 'session_start')
    .map(entry => entry.handler);
  assert.ok(sessionStartHandlers.length >= 2, 'parent extension registers session_start handlers');

  const start = id => {
    const context = {
      hasUI: false,
      cwd: process.cwd(),
      sessionManager: { getSessionId: () => id },
    };
    for (const handler of sessionStartHandlers) handler({}, context);
  };

  start('hook-session-a');
  const hookOld = lifecycleRegistry.registerAgent({ agent: 'tester', label: 'hook boundary' });
  start('hook-session-a');
  assert.throws(
    () => lifecycleRegistry.registerAgent({ agent: 'tester', label: 'hook boundary' }),
    /Duplicate agent label/,
    'the real hook keeps repeated starts in one session idempotent',
  );
  console.log('PASS the real hook keeps repeated starts in one session idempotent');

  start('hook-session-b');
  const hookFresh = lifecycleRegistry.registerAgent({ agent: 'tester', label: 'hook boundary' });
  assert.notEqual(hookFresh.id, hookOld.id);
  expectUnknown(() => lifecycleRegistry.getAgent(hookOld.id), 'the real hook retires old agent ids');
  console.log('PASS the real hook allows a label to be reused by the new session');
} finally {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
}

console.log('All session-boundary assertions passed.');
