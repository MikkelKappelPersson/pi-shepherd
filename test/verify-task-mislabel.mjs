#!/usr/bin/env node
/**
 * Phase 6 verification for the task-mislabel fix (issue #13): the child LLM
 * can echo a fabricated or foreign task id in shepherd_done. The parent must
 * correlate the completion on the authenticated sender's active task, keep a
 * diagnostic for unresolvable completions, and never silently ack one.
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  createChildBroker,
  createEnvelope,
  publishFromChild,
  registerChild,
} from '../src/core/messaging.ts';
import {
  configureParentMessageNotifications,
  ensureParentBroker,
  processParentBrokerMessages,
  shutdownParentBroker,
} from '../src/core/lifecycle.ts';
import { lifecycleRegistry } from '../src/core/orchestration.ts';

const broker = ensureParentBroker('mislabel-test-session');
const worker = lifecycleRegistry.registerAgent({
  agent: 'worker',
  label: 'mislabel',
  paneId: undefined,
});
const planner = lifecycleRegistry.registerAgent({
  agent: 'planner',
  label: 'mislabel',
  paneId: undefined,
});
const workerCap = registerChild(broker, worker.id);
const plannerCap = registerChild(broker, planner.id);
const workerChild = createChildBroker({ rootDir: broker.rootDir, ...workerCap });
const plannerChild = createChildBroker({ rootDir: broker.rootDir, ...plannerCap });

const dropped = [];
configureParentMessageNotifications(notification => {
  if (notification.kind === 'task_done_dropped') {
    dropped.push({ envelope: notification.envelope, reason: notification.reason });
  }
});

const taskDone = (child, taskId, status, summary) =>
  createEnvelope(
    { sessionId: child.sessionId, brokerId: child.brokerId, senderId: child.agentId },
    {
      kind: 'task_done',
      targetId: 'shepherd',
      taskId,
      status,
      summary,
      delivery: 'followUp',
    }
  );

const rejectedFiles = (prefix) =>
  fs.readdirSync(path.join(broker.rootDir, 'rejected')).filter(name => name.startsWith(prefix));

try {
  // 1. A sender with an active task publishes a completion whose id is
  //    fabricated: the completion settles the sender's own task and the
  //    watcher is woken, with a diagnostic recording the mismatch.
  const task = lifecycleRegistry.createTask(worker, 'Implement the engine wiring.');
  lifecycleRegistry.setTaskRunning(task.id);
  const watch = lifecycleRegistry.waitForTasks(task.id);
  publishFromChild(workerChild, taskDone(workerChild, 'T2854-9715', 'completed', 'M2 engine wiring complete.'));
  const results = await processParentBrokerMessages();
  assert.equal(results.length, 1);
  assert.equal(results[0].taskId, task.id);
  assert.equal(results[0].status, 'completed');
  assert.equal(results[0].text, 'M2 engine wiring complete.');
  assert.equal(lifecycleRegistry.getTask(task.id).state, 'completed');
  const [settled] = await watch;
  assert.equal(settled.status, 'completed');
  const mismatches = rejectedFiles('task-done-mismatch-');
  assert.equal(mismatches.length, 1);
  const mismatch = JSON.parse(
    fs.readFileSync(path.join(broker.rootDir, 'rejected', mismatches[0]), 'utf8')
  );
  assert.match(mismatch.reason, /T2854-9715/);
  console.log(
    'PASS a completion with a fabricated task id settles the sender active task and wakes its watcher'
  );

  // 2. A sender without an active task publishes an unknown id: nothing
  //    settles, the drop is surfaced to the parent, and a diagnostic remains.
  const otherTask = lifecycleRegistry.createTask(planner, 'Unrelated running work.');
  lifecycleRegistry.setTaskRunning(otherTask.id);
  publishFromChild(workerChild, taskDone(workerChild, 'T9999-4242', 'failed', 'No such task.'));
  assert.deepEqual(await processParentBrokerMessages(), []);
  assert.equal(lifecycleRegistry.getTask(otherTask.id).state, 'running');
  assert.equal(dropped.length, 1);
  assert.equal(dropped[0].envelope.taskId, 'T9999-4242');
  assert.match(dropped[0].reason ?? '', /no active task/);
  const droppedFiles = rejectedFiles('task-done-dropped-');
  assert.equal(droppedFiles.length, 1);
  const droppedRecord = JSON.parse(
    fs.readFileSync(path.join(broker.rootDir, 'rejected', droppedFiles[0]), 'utf8')
  );
  assert.match(droppedRecord.reason, /no active task/);
  console.log(
    'PASS a completion with no matching task is dropped observably without settling anything'
  );
  lifecycleRegistry.settleTask(otherTask.id, { status: 'cancelled', error: 'scenario cleanup' });

  // 3. A sender with its own active task echoes a known task id owned by
  //    another agent: the foreign task is left untouched and the sender's
  //    own task settles.
  const own = lifecycleRegistry.createTask(worker, 'Own work to finish.');
  lifecycleRegistry.setTaskRunning(own.id);
  const foreign = lifecycleRegistry.createTask(planner, 'Foreign task to ignore.');
  lifecycleRegistry.setTaskRunning(foreign.id);
  publishFromChild(workerChild, taskDone(workerChild, foreign.id, 'completed', 'Done with the other one.'));
  const foreignResults = await processParentBrokerMessages();
  assert.equal(foreignResults.length, 1);
  assert.equal(foreignResults[0].taskId, own.id);
  assert.equal(lifecycleRegistry.getTask(own.id).state, 'completed');
  assert.equal(lifecycleRegistry.getTask(foreign.id).state, 'running');
  console.log('PASS a completion mislabeled with a foreign task id settles the sender own task');

  // 4. A duplicate completion of an already-settled task stays idempotent.
  publishFromChild(workerChild, taskDone(workerChild, own.id, 'completed', 'Again.'));
  const duplicate = await processParentBrokerMessages();
  assert.equal(duplicate.length, 1);
  assert.equal(duplicate[0].taskId, own.id);
  assert.equal(duplicate[0].status, 'completed');
  console.log('PASS a duplicate completion of a settled task returns the stored result');
} finally {
  for (const agent of [worker, planner]) {
    const active = lifecycleRegistry.activeTaskForAgent(agent);
    if (active) {
      lifecycleRegistry.settleTask(active.taskId, { status: 'cancelled', error: 'test cleanup' });
    }
  }
  shutdownParentBroker(() => true);
}

console.log('All task mislabel assertions passed.');
