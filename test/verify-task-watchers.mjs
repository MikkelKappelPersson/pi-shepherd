#!/usr/bin/env node
/** Phase 7 verification for task-aware, non-blocking one-shot watchers. */
import assert from 'node:assert/strict';
import { LifecycleRegistry, LifecycleError } from '../src/core/orchestration.ts';
import {
  TaskWatcherService,
  taskWatcherService,
} from '../src/core/lifecycle.ts';
import { lifecycleRegistry } from '../src/core/orchestration.ts';
import { registerShepherdTools, setTaskWatcherSessionActive } from '../src/extension/shepherd.ts';

// ── Core registry + TaskWatcherService ─────────────────────────────────
const registry = new LifecycleRegistry();
const worker = registry.registerAgent({ agent: 'worker', label: 'watcher-worker' });
const planner = registry.registerAgent({ agent: 'planner', label: 'watcher-planner' });
const scout = registry.registerAgent({ agent: 'scout', label: 'watcher-scout' });

const events = [];
const service = new TaskWatcherService(registry, event => events.push(event), 5);

const taskA = registry.createTask(worker, 'A');
const taskB = registry.createTask(planner, 'B');
const taskC = registry.createTask(scout, 'C');

// Pending task registration returns synchronously; nothing is delivered yet.
const regA = service.watch(taskA.id);
assert.equal(regA.pending.length, 1);
assert.deepEqual(regA.completed, []);
assert.equal(regA.taskIds[0], taskA.id);
console.log('PASS a pending task registers non-blocking and returns immediately');

// Entering `waiting` must NOT fire the watcher (only settlement does).
registry.setTaskRunning(taskA.id);
registry.addPendingRequest(taskA.id, 'request-x');
registry.setTaskWaiting(taskA.id);
await new Promise(resolve => setTimeout(resolve, 15));
assert.ok(!events.some(e => e.completions.some(c => c.taskId === taskA.id)),
  'waiting state is not a watcher completion');
console.log('PASS a task entering waiting does not complete its watcher');

// No watcher delivery until an explicit settlement.
assert.equal(events.length, 0);
console.log('PASS no completion is delivered while the task is still running/waiting');

// Settling fires exactly one notification enriched with agent identity.
registry.settleTask(taskA.id, { status: 'completed', text: 'done A', ok: true });
await new Promise(resolve => setTimeout(resolve, 20));
const aEvents = events.filter(e => e.completions.some(c => c.taskId === taskA.id));
assert.equal(aEvents.length, 1, 'exactly one notification for a settled task');
const aCompletion = aEvents[0].completions.find(c => c.taskId === taskA.id);
assert.equal(aCompletion.status, 'completed');
assert.equal(aCompletion.ok, true);
assert.equal(aCompletion.returnCode, 0);
assert.equal(aCompletion.text, 'done A');
assert.equal(aCompletion.agentId, worker.id);
assert.equal(aCompletion.agent, 'worker');
assert.equal(aCompletion.label, 'watcher-worker');
console.log('PASS a completed task produces one terminal notification with agent + text');

// Already-settled task returns immediately and is not delivered again.
const regA2 = service.watch(taskA.id);
assert.equal(regA2.pending.length, 0);
assert.equal(regA2.completed.length, 1);
await new Promise(resolve => setTimeout(resolve, 10));
assert.equal(
  events.filter(e => e.completions.some(c => c.taskId === taskA.id)).length,
  1,
  'already-settled task is not re-delivered'
);
console.log('PASS an already-completed task returns immediately and is not duplicated');

// Multiple task ids in one watcher; coalesced completions preserve input order.
const regAB = service.watch([taskB.id, taskC.id]);
assert.deepEqual(regAB.pending.map(id => id), [taskB.id, taskC.id]);
registry.setTaskRunning(taskB.id);
registry.setTaskRunning(taskC.id);
registry.settleTask(taskC.id, { status: 'failed', error: 'boom', ok: false });
registry.settleTask(taskB.id, { status: 'blocked', error: 'stuck', ok: false });
await new Promise(resolve => setTimeout(resolve, 25));
const abEvent = events.find(e => e.watcherId === regAB.watcherId);
assert.ok(abEvent, 'array watcher is notified');
assert.deepEqual(
  abEvent.completions.map(c => c.taskId),
  [taskB.id, taskC.id],
  'coalesced completions preserve the watch input order'
);
const bCompletion = abEvent.completions.find(c => c.taskId === taskB.id);
const cCompletion = abEvent.completions.find(c => c.taskId === taskC.id);
assert.equal(bCompletion.status, 'blocked');
assert.equal(bCompletion.returnCode, 2);
assert.equal(cCompletion.status, 'failed');
assert.equal(cCompletion.returnCode, 1);
assert.equal(cCompletion.error, 'boom');
console.log('PASS multiple task ids settle independently, in watch input order, with correct codes');

// Terminal outcomes carry the right status + return code.
const cancelledAgent = registry.registerAgent({ agent: 'worker', label: 'watcher-cancelled' });
const cancelled = registry.createTask(cancelledAgent, 'will be cancelled');
const regCancelled = service.watch(cancelled.id);
registry.setTaskRunning(cancelled.id);
registry.settleTask(cancelled.id, { status: 'cancelled', error: 'Agent was closed.' });
const timedOutAgent = registry.registerAgent({ agent: 'worker', label: 'watcher-timeout' });
const timedOut = registry.createTask(timedOutAgent, 'will time out');
const regTimedOut = service.watch(timedOut.id);
registry.setTaskRunning(timedOut.id);
registry.settleTask(timedOut.id, { status: 'timed_out', error: 'Tracked task deadline reached.' });
await new Promise(resolve => setTimeout(resolve, 20));
const cancelledCompletion = events
  .find(e => e.completions.some(c => c.taskId === cancelled.id))
  .completions.find(c => c.taskId === cancelled.id);
const timedOutCompletion = events
  .find(e => e.completions.some(c => c.taskId === timedOut.id))
  .completions.find(c => c.taskId === timedOut.id);
assert.equal(cancelledCompletion.status, 'cancelled');
assert.equal(cancelledCompletion.returnCode, 130);
assert.match(cancelledCompletion.error, /closed/i);
assert.equal(timedOutCompletion.status, 'timed_out');
assert.equal(timedOutCompletion.returnCode, 124);
console.log('PASS cancelled and timed-out tasks report their terminal status and return code');

// Independent watchers each get exactly one notification for the same task.
const idle = registry.registerAgent({ agent: 'planner', label: 'watcher-shared' });
const shared = registry.createTask(idle, 'shared');
const regShared1 = service.watch(shared.id);
const regShared2 = service.watch(shared.id);
registry.setTaskRunning(shared.id);
registry.settleTask(shared.id, { status: 'completed', text: 'shared done', ok: true });
await new Promise(resolve => setTimeout(resolve, 20));
const perWatcher = [regShared1.watcherId, regShared2.watcherId].map(watcherId =>
  events.filter(e => e.watcherId === watcherId && e.completions.some(c => c.taskId === shared.id)).length
);
assert.deepEqual(perWatcher, [1, 1], 'each independent watcher observes exactly one completion');
service.shutdown();
console.log('PASS independent watchers each observe the same task exactly once');

// Reject agent ids / pane ids / unknown ids as watcher targets; no duplicates.
expectRejectTaskWatcher(() => service.watch('shepherd-agent-unknown'), 'unknown task is rejected');
expectRejectTaskWatcher(() => service.watch([taskA.id, taskA.id]), 'duplicate task ids are rejected');
function expectRejectTaskWatcher(fn, label) {
  assert.throws(fn, e => e instanceof LifecycleError, label);
  console.log(`PASS ${label}`);
}

// ── Extension bridge ─────────────────────────────────────────────────────
// The parent extension's task watcher sends a custom follow-up that triggers a
// turn, uses the task id as the correlation key, and stays silent on shutdown.
const sentTask = [];
let taskMessageRenderer;
registerShepherdTools({
  registerTool() {},
  registerMessageRenderer(customType, renderer) {
    if (customType === 'shepherd.task.completion') taskMessageRenderer = renderer;
  },
  sendMessage(message, options) {
    sentTask.push({ message, options });
  },
});

const bridgeAgent = lifecycleRegistry.registerAgent({ agent: 'worker', label: 'task-bridge' });
const bridgeTask = lifecycleRegistry.createTask(bridgeAgent, 'Bridge task.');
lifecycleRegistry.setTaskRunning(bridgeTask.id);
setTaskWatcherSessionActive(true);
taskWatcherService.watch(bridgeTask.id);
lifecycleRegistry.settleTask(bridgeTask.id, { status: 'completed', text: 'bridge task done', ok: true });
await new Promise(resolve => setTimeout(resolve, 40));
assert.equal(sentTask.length, 1, 'task bridge sends one custom completion message');
assert.equal(typeof taskMessageRenderer, 'function');
assert.equal(sentTask[0].message.customType, 'shepherd.task.completion');
assert.equal(sentTask[0].message.details.completions[0].taskId, bridgeTask.id);
assert.equal(sentTask[0].message.details.completions[0].agentId, bridgeAgent.id);
assert.match(sentTask[0].message.content, /\nreturn:\n/);
assert.match(sentTask[0].message.content, /"taskId":/);
assert.doesNotMatch(sentTask[0].message.content, /"promptId":/);
assert.deepEqual(sentTask[0].options, { deliverAs: 'followUp', triggerTurn: true });
console.log('PASS the parent bridge delivers task completions as a turn-triggering follow-up with the task id');

// A completion is not re-sent after the shutdown path releases state.
const bridgeAgent2 = lifecycleRegistry.registerAgent({ agent: 'worker', label: 'task-bridge-2' });
const bridgeTask2 = lifecycleRegistry.createTask(bridgeAgent2, 'Bridge task 2.');
lifecycleRegistry.setTaskRunning(bridgeTask2.id);
taskWatcherService.watch(bridgeTask2.id);
setTaskWatcherSessionActive(false);
lifecycleRegistry.settleTask(bridgeTask2.id, { status: 'completed', text: 'should not be sent', ok: true });
await new Promise(resolve => setTimeout(resolve, 40));
assert.equal(
  sentTask.length,
  1,
  'no task completion is delivered after the session bridge is deactivated'
);
setTaskWatcherSessionActive(true);
console.log('PASS task-watcher delivery is suppressed after the parent session goes inactive');

// Clean up the global task watcher timers so the process can exit.
taskWatcherService.shutdown();
console.log('All task-watcher assertions passed.');
