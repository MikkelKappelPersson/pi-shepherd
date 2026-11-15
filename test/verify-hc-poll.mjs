#!/usr/bin/env node
/**
 * Spec 011 verification: hc background inbox poll (+ drain-first reads).
 *
 * No live spawn, no wall-clock waits: the poller is driven through its
 * exported seam (register/start/stop/synchronous tick), and the pump path
 * is proven with real broker stores on disk (like the messaging suite) —
 * a queued `task_done` for an unknown task is consumed from the inbox and
 * observably dropped, which exercises the full tick → poll → apply
 * pipeline. Settlement itself stays covered by 010's suites.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import {
  describeHcStatusView,
  drainHcInboxForSession,
  hcInjectTestAgent,
  hcInjectTestTask,
  hcInboxPollerStateForTests,
  hcRemoveTestAgent,
  hcRemoveTestTask,
  isHcInboxPollerRunning,
  onTaskSettled as onHcTaskSettled,
  pollHcInboxOnce,
  registerHcPollSession,
  stopHcInboxPoller,
} from '../src/runtimes/hc/runtime.ts';

const SESS_A = `hc-poll-test-a-${Date.now()}`;
const SESS_B = `hc-poll-test-b-${Date.now()}`;

function brokerDirs() {
  return readdirSync(tmpdir()).filter(name => name.startsWith('pi-shepherd-broker-'));
}

function brokerDirForSession(sessionId) {
  for (const name of brokerDirs()) {
    try {
      const manifest = JSON.parse(
        readFileSync(path.join(tmpdir(), name, 'broker.json'), 'utf8')
      );
      if (manifest.sessionId === sessionId) return path.join(tmpdir(), name);
    } catch {
      /* not ours / unreadable */
    }
  }
  return undefined;
}

function cleanupSession(sessionId) {
  const dir = brokerDirForSession(sessionId);
  if (dir) rmSync(dir, { recursive: true, force: true });
}

// Clean slate: no timer running in this process yet.
stopHcInboxPoller();
{
  const state = hcInboxPollerStateForTests();
  assert.equal(state.running, false, 'poller starts stopped');
  assert.equal(isHcInboxPollerRunning(), false, 'running flag agrees');
  console.log('PASS poller starts stopped');
}

// drainHcInboxForSession with no session resolves nothing and mints nothing.
{
  const before = brokerDirs();
  assert.equal(drainHcInboxForSession(undefined), false, 'undefined session skips');
  assert.equal(drainHcInboxForSession('   '), false, 'blank session skips');
  assert.deepEqual(brokerDirs(), before, 'a skipped drain mints no broker store');
  console.log('PASS drain-first with no session is a no-op that mints nothing');
}

// Lifecycle: register starts (idempotent), unref'd, stop halts.
{
  registerHcPollSession(SESS_A);
  registerHcPollSession(SESS_A);
  let state = hcInboxPollerStateForTests();
  assert.equal(state.running, true, 'register starts the poller');
  assert.equal(isHcInboxPollerRunning(), true, 'running flag agrees');
  assert.equal(state.unrefed, true, 'the timer is unrefed and cannot hold the process open');
  stopHcInboxPoller();
  assert.equal(isHcInboxPollerRunning(), false, 'stop halts the poller');
  console.log('PASS poller lifecycle: idempotent start, unrefed, stop halts');
}

// Quiescence: a tick with no unsettled tasks stops the timer.
{
  registerHcPollSession(SESS_A);
  assert.equal(isHcInboxPollerRunning(), true, 'poller running before the tick');
  pollHcInboxOnce();
  assert.equal(
    isHcInboxPollerRunning(),
    false,
    'tick with an empty task registry stops at quiescence'
  );
  console.log('PASS tick stops the poller at quiescence');
}

// Pump: a queued task_done is consumed and observably dropped (unknown task),
// proving the tick runs the full poll → apply pipeline.
{
  registerHcPollSession(SESS_B);
  assert.equal(drainHcInboxForSession(SESS_B), true, 'first drain materializes the broker');
  const dir = brokerDirForSession(SESS_B);
  assert.ok(dir, 'registration resolves a real session broker');
  const manifest = JSON.parse(readFileSync(path.join(dir, 'broker.json'), 'utf8'));
  const inbox = path.join(dir, 'parent', 'inbox');
  writeFileSync(
    path.join(inbox, `0000000000000001-hc-poll-ghost.json`),
    JSON.stringify({
      kind: 'task_done',
      messageId: 'shepherd-message-hc-poll-ghost',
      taskId: 'shepherd-task-hc-poll-ghost',
      senderId: 'shepherd-agent-hc-poll-ghost',
      targetId: manifest.parentId,
      sessionId: manifest.sessionId,
      brokerId: manifest.brokerId,
      status: 'completed',
      summary: 'ghost done',
      schemaVersion: 1,
      delivery: 'followUp',
      createdAt: Date.now(),
    }),
    'utf8'
  );
  pollHcInboxOnce();
  assert.deepEqual(readdirSync(inbox), [], 'the tick consumed the inbox');
  assert.equal(
    readdirSync(path.join(dir, 'processed')).length,
    1,
    'the envelope was acknowledged to processed/'
  );
  assert.ok(
    readdirSync(path.join(dir, 'rejected')).some(name =>
      name.startsWith('task-done-dropped-')
    ),
    'an unresolvable completion is observably dropped, not silently lost'
  );
  console.log('PASS tick pumps the drain: queued done consumed and observably applied');
}

// Latest registration wins: single session per process.
{
  registerHcPollSession(SESS_A);
  registerHcPollSession(SESS_B);
  assert.equal(
    hcInboxPollerStateForTests().session,
    SESS_B,
    'latest registration wins'
  );
  stopHcInboxPoller();
  console.log('PASS latest registration wins (single session per process)');
}

// Real settlement: a queued done for a KNOWN task settles it through the
// 010 observer path (not just a dropped diagnostic).
{
  const SESS_C = `hc-poll-test-c-${Date.now()}`;
  const agentId = 'shepherd-agent-hc-poll-real';
  const taskId = 'shepherd-task-hc-poll-real';
  hcInjectTestAgent({
    handle: { id: agentId, agent: 'worker', label: 'poll-real' },
    state: 'working',
    activeTaskId: taskId,
  });
  hcInjectTestTask({
    taskId,
    agentId,
    description: 'real settle via tick',
    state: 'running',
    createdAt: Date.now(),
    pendingRequestIds: new Set(),
  });
  const seen = [];
  const off = onHcTaskSettled((result, context) => seen.push({ result, context }));
  registerHcPollSession(SESS_C);
  assert.equal(drainHcInboxForSession(SESS_C), true, 'broker materialized for real-settle');
  const dir = brokerDirForSession(SESS_C);
  const manifest = JSON.parse(readFileSync(path.join(dir, 'broker.json'), 'utf8'));
  writeFileSync(
    path.join(dir, 'parent', 'inbox', `0000000000000003-hc-poll-real.json`),
    JSON.stringify({
      kind: 'task_done',
      messageId: 'shepherd-message-hc-poll-real',
      taskId,
      senderId: agentId,
      targetId: manifest.parentId,
      sessionId: manifest.sessionId,
      brokerId: manifest.brokerId,
      status: 'completed',
      summary: 'real-ok',
      schemaVersion: 1,
      delivery: 'followUp',
      createdAt: Date.now(),
    }),
    'utf8'
  );
  pollHcInboxOnce();
  off();
  assert.deepEqual(readdirSync(path.join(dir, 'parent', 'inbox')), [], 'real done consumed');
  assert.equal(seen.length, 1, 'the 010 observer fired exactly once');
  assert.equal(seen[0].result.status, 'completed', 'settled completed');
  assert.equal(seen[0].result.text, 'real-ok', 'settlement text carried through');
  assert.equal(
    describeHcStatusView(agentId).task,
    undefined,
    'settled task leaves the status view (agent still known)'
  );
  assert.equal(isHcInboxPollerRunning(), false, 'settlement restores quiescence');
  hcRemoveTestTask(taskId);
  hcRemoveTestAgent(agentId);
  cleanupSession(SESS_C);
  console.log('PASS tick settles a queued done for a known task through the observer');
}

// Keep-alive converse: an open task keeps the poller running across ticks.
{
  const SESS_D = `hc-poll-test-d-${Date.now()}`;
  const agentId = 'shepherd-agent-hc-poll-open';
  const taskId = 'shepherd-task-hc-poll-open';
  hcInjectTestAgent({
    handle: { id: agentId, agent: 'worker', label: 'poll-open' },
    state: 'working',
    activeTaskId: taskId,
  });
  hcInjectTestTask({
    taskId,
    agentId,
    description: 'open keeps poller alive',
    state: 'running',
    createdAt: Date.now(),
    pendingRequestIds: new Set(),
  });
  registerHcPollSession(SESS_D);
  pollHcInboxOnce();
  assert.equal(
    isHcInboxPollerRunning(),
    true,
    'an unsettled task keeps the poller alive'
  );
  hcRemoveTestTask(taskId);
  hcRemoveTestAgent(agentId);
  pollHcInboxOnce();
  assert.equal(isHcInboxPollerRunning(), false, 'removing the task restores quiescence');
  cleanupSession(SESS_D);
  console.log('PASS open task keeps the poller alive; removal restores quiescence');
}

// Cleanup: no timer left running, no test broker stores left behind.
stopHcInboxPoller();
cleanupSession(SESS_A);
cleanupSession(SESS_B);
assert.equal(isHcInboxPollerRunning(), false, 'no timer survives the suite');
assert.equal(brokerDirForSession(SESS_A), undefined, 'test broker A removed');
assert.equal(brokerDirForSession(SESS_B), undefined, 'test broker B removed');
console.log('PASS cleanup leaves no timer and no broker stores');

console.log('All hc-poll assertions passed.');
