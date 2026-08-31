#!/usr/bin/env node
/** Phase 1 verification for tracked task records and state transitions. */
import assert from 'node:assert/strict';
import {
  LifecycleError,
  LifecycleRegistry,
} from '../src/core/orchestration.ts';
import { createManualClock, withFakeDateNow } from './helpers/fake-clock.mjs';

const registry = new LifecycleRegistry();
const scout = registry.registerAgent({ agent: 'scout', label: 'task registry' });
const planner = registry.registerAgent({ agent: 'planner', label: 'task registry' });
const worker = registry.registerAgent({ agent: 'worker', label: 'task registry' });

function expectLifecycleError(fn, code, label) {
  assert.throws(fn, error => {
    assert.ok(error instanceof LifecycleError, `${label}: expected LifecycleError`);
    assert.equal(error.code, code, `${label}: error code`);
    return true;
  });
  console.log(`PASS ${label}`);
}

const task = registry.createTask(scout, 'Investigate the authentication flow.');
assert.match(task.id, /^shepherd-task-/);
assert.equal(task.agentId, scout.id);
assert.equal(registry.getTask(task.id).state, 'created');
assert.equal(registry.canonicalTaskHandle(task.id).id, task.id);
assert.equal(registry.taskResult(task.id), undefined);
console.log('PASS task creation returns a session-scoped opaque task id');

expectLifecycleError(
  () => registry.getTask(JSON.stringify(task)),
  'unknown_task',
  'quoted task object is rejected'
);
expectLifecycleError(
  () => registry.getTask('not-a-task'),
  'unknown_task',
  'unknown task id is rejected'
);
expectLifecycleError(
  () => registry.createTask(scout, 'A second task'),
  'active_task',
  'one active task per agent is enforced'
);
expectLifecycleError(
  () => registry.createTask(planner, '   '),
  'invalid_task',
  'empty task descriptions are rejected'
);

const taskWithDeadline = registry.createTask(planner, 'Deadline task', { timeoutMs: 30_000 });
assert.equal(taskWithDeadline.agentId, planner.id);
assert.equal(
  registry.getTask(taskWithDeadline.id).deadlineAt,
  taskWithDeadline.createdAt + 30_000
);
console.log('PASS task deadlines are recorded at creation');
const artifactSession = { sessionPath: '/tmp/session', mocPath: '/tmp/shepherd.md' };
const artifact = { id: 'artifact-1', filePath: '/tmp/session/worker.md', relativePath: '.shepherd/worker.md' };
registry.attachTaskArtifact(taskWithDeadline.id, artifactSession, artifact);
assert.equal(registry.taskArtifact(taskWithDeadline.id).artifact.id, 'artifact-1');
assert.equal(registry.getTask(taskWithDeadline.id).artifactSession.sessionPath, '/tmp/session');
console.log('PASS task records retain artifact associations independently of settlement');

registry.setTaskRunning(task.id);
assert.equal(registry.getTask(task.id).state, 'running');
assert.ok(registry.getTask(task.id).startedAt);
console.log('PASS created task transitions to running');

expectLifecycleError(
  () => registry.setTaskWaiting(task.id),
  'invalid_transition',
  'task cannot wait without a pending request'
);
registry.addPendingRequest(task.id, 'request-one');
registry.addPendingRequest(task.id, 'request-two');
assert.deepEqual(registry.getTask(task.id).pendingRequestIds, ['request-one', 'request-two']);
registry.setTaskWaiting(task.id);
const waiting = registry.getTask(task.id);
assert.equal(waiting.state, 'waiting');
assert.ok(waiting.waitingSince);
assert.equal(waiting.pendingRequestIds.length, 2);
console.log('PASS running task enters waiting with pending requests and wait timestamp');

// The process/agent can become idle while the task remains waiting. This is
// the boundary that prevents future task watchers from copying prompt idle
// inference into the tracked-task protocol.
registry.setAgentState(scout, 'idle');
assert.equal(registry.status(scout).state, 'idle');
assert.equal(registry.getTask(task.id).state, 'waiting');
assert.equal(registry.taskResult(task.id), undefined);
console.log('PASS idle agent state does not settle a waiting task');
expectLifecycleError(
  () => registry.setTaskRunning(task.id),
  'invalid_transition',
  'waiting task cannot resume while requests remain pending'
);

registry.markTaskStaleNotified(task.id, 12_345);
assert.equal(registry.getTask(task.id).staleNotifiedAt, 12_345);
registry.clearTaskStaleNotification(task.id);
assert.equal(registry.getTask(task.id).staleNotifiedAt, undefined);
console.log('PASS stale-notification tracking is separate from task settlement');

registry.resolvePendingRequest(task.id, 'request-one');
assert.equal(registry.getTask(task.id).state, 'waiting');
assert.deepEqual(registry.getTask(task.id).pendingRequestIds, ['request-two']);
registry.resolvePendingRequest(task.id, 'request-two');
assert.equal(registry.getTask(task.id).state, 'running');
assert.equal(registry.getTask(task.id).waitingSince, undefined);
console.log('PASS task resumes only after all pending requests resolve');

const clock = createManualClock(100_000);
await withFakeDateNow(clock.now(), async controlled => {
  const clocked = registry.createTask(worker, 'Task with controlled timestamps');
  registry.setTaskRunning(clocked.id);
  registry.addPendingRequest(clocked.id, 'clock-request');
  controlled.advance(1_500);
  registry.setTaskWaiting(clocked.id);
  assert.equal(registry.getTask(clocked.id).waitingSince, 101_500);
  registry.settleTask(clocked.id, { status: 'cancelled', error: 'test cleanup' });
});
console.log('PASS task timestamps use the injected test clock boundary');

expectLifecycleError(
  () => registry.settleTaskForAgent(task.id, planner, { status: 'completed' }),
  'task_agent_mismatch',
  'foreign agent cannot complete another agent task'
);
assert.equal(registry.assertTaskOwner(task.id, scout).taskId, task.id);
console.log('PASS task ownership is checked before lifecycle completion');

const completed = registry.settleTask(task.id, {
  status: 'completed',
  text: 'Authentication flow documented.',
  completedAt: 200_000,
});
assert.equal(completed.ok, true);
assert.equal(completed.returnCode, 0);
assert.equal(completed.status, 'completed');
assert.equal(registry.getTask(task.id).state, 'completed');
assert.deepEqual(registry.getTask(task.id).pendingRequestIds, []);
assert.equal(registry.activeTaskForAgent(scout), undefined);
console.log('PASS task settlement clears requests and releases the active slot');

const duplicate = registry.settleTask(task.id, {
  status: 'failed',
  error: 'must not replace the first result',
});
assert.deepEqual(duplicate, completed);
console.log('PASS terminal task settlement is idempotent');

expectLifecycleError(
  () => registry.setTaskRunning(task.id),
  'invalid_transition',
  'terminal task cannot become running'
);
expectLifecycleError(
  () => registry.markTaskStaleNotified(task.id),
  'invalid_transition',
  'terminal task cannot be marked waiting/stale'
);

registry.setTaskRunning(taskWithDeadline.id);
const cancelled = registry.cancelTask(planner, 'Planner closed before completing the task.');
assert.equal(cancelled.status, 'cancelled');
assert.equal(cancelled.returnCode, 130);
assert.equal(registry.getTask(taskWithDeadline.id).state, 'cancelled');
console.log('PASS cancelling an agent task produces a cancelled terminal result');

const timeoutTask = registry.createTask(worker, 'Task that times out');
registry.setTaskRunning(timeoutTask.id);
const timedOut = registry.settleTask(timeoutTask.id, {
  status: 'timed_out',
  error: 'deadline reached',
});
assert.equal(timedOut.ok, false);
assert.equal(timedOut.returnCode, 124);
console.log('PASS timed-out task receives the standard timeout return code');

const blockedTask = registry.createTask(planner, 'Blocked task');
registry.setTaskRunning(blockedTask.id);
const blocked = registry.settleTask(blockedTask.id, { status: 'blocked', text: 'Needs input.' });
assert.equal(blocked.ok, false);
assert.equal(blocked.returnCode, 2);
assert.equal(registry.status(planner).state, 'blocked');
console.log('PASS blocked task receives the standard blocked result');

const snapshots = registry.allTasks();
assert.ok(snapshots.some(record => record.taskId === task.id && record.state === 'completed'));
assert.ok(snapshots.every(record => Array.isArray(record.pendingRequestIds)));
console.log('PASS task listing returns JSON-safe task snapshots');

console.log('All task registry assertions passed.');
