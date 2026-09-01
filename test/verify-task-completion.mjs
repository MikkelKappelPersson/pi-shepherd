#!/usr/bin/env node
/** Phase 5 verification for explicit task completion handling. */
import assert from 'node:assert/strict';
import {
  createChildBroker,
  createEnvelope,
  publishFromChild,
  registerChild,
} from '../src/core/messaging.ts';
import {
  currentParentBroker,
  ensureParentBroker,
  processParentBrokerMessages,
  shutdownParentBroker,
} from '../src/core/lifecycle.ts';
import { LifecycleRegistry, lifecycleRegistry } from '../src/core/orchestration.ts';

// Use the exported process-global registry because the lifecycle broker
// monitor consumes the same registry as the parent extension.
const broker = ensureParentBroker('completion-test-session');
const scout = lifecycleRegistry.registerAgent({ agent: 'scout', label: 'completion', paneId: undefined });
const planner = lifecycleRegistry.registerAgent({ agent: 'planner', label: 'completion', paneId: undefined });
const foreign = lifecycleRegistry.registerAgent({ agent: 'worker', label: 'completion', paneId: undefined });
const scoutCap = registerChild(broker, scout.id);
const plannerCap = registerChild(broker, planner.id);
const foreignCap = registerChild(broker, foreign.id);
const scoutChild = createChildBroker({ rootDir: broker.rootDir, ...scoutCap });
const plannerChild = createChildBroker({ rootDir: broker.rootDir, ...plannerCap });
const foreignChild = createChildBroker({ rootDir: broker.rootDir, ...foreignCap });

try {
  const task = lifecycleRegistry.createTask(scout, 'Complete the explicit completion test.');
  lifecycleRegistry.setTaskRunning(task.id);
  lifecycleRegistry.setAgentState(scout, 'idle');
  assert.equal(lifecycleRegistry.getTask(task.id).state, 'running');
  const completion = createEnvelope(
    { sessionId: scoutChild.sessionId, brokerId: scoutChild.brokerId, senderId: scoutChild.agentId },
    {
      kind: 'task_done',
      targetId: 'shepherd',
      taskId: task.id,
      status: 'completed',
      summary: 'The explicit task is complete.',
      delivery: 'followUp',
    },
  );
  publishFromChild(scoutChild, completion);
  const results = await processParentBrokerMessages();
  assert.equal(results.length, 1);
  assert.equal(results[0].status, 'completed');
  assert.equal(results[0].text, 'The explicit task is complete.');
  assert.equal(lifecycleRegistry.getTask(task.id).state, 'completed');
  console.log('PASS explicit task-done envelope settles a task even after an idle child turn');

  const duplicateResults = await processParentBrokerMessages();
  assert.deepEqual(duplicateResults, []);
  console.log('PASS consumed task-done envelopes do not produce duplicate settlement');

  const waitingTask = lifecycleRegistry.createTask(planner, 'Wait for a required reply.');
  lifecycleRegistry.setTaskRunning(waitingTask.id);
  lifecycleRegistry.addPendingRequest(waitingTask.id, 'request-required');
  lifecycleRegistry.setTaskWaiting(waitingTask.id);
  const premature = createEnvelope(
    { sessionId: plannerChild.sessionId, brokerId: plannerChild.brokerId, senderId: plannerChild.agentId },
    {
      kind: 'task_done',
      targetId: 'shepherd',
      taskId: waitingTask.id,
      status: 'completed',
      summary: 'This is premature.',
      delivery: 'followUp',
    },
  );
  publishFromChild(plannerChild, premature);
  assert.deepEqual(await processParentBrokerMessages(), []);
  assert.equal(lifecycleRegistry.getTask(waitingTask.id).state, 'waiting');
  console.log('PASS successful completion is rejected while required requests remain pending');

  const blocked = createEnvelope(
    { sessionId: plannerChild.sessionId, brokerId: plannerChild.brokerId, senderId: plannerChild.agentId },
    {
      kind: 'task_done',
      targetId: 'shepherd',
      taskId: waitingTask.id,
      status: 'blocked',
      summary: 'The required reply never arrived.',
      delivery: 'followUp',
    },
  );
  publishFromChild(plannerChild, blocked);
  const blockedResult = await processParentBrokerMessages();
  assert.equal(blockedResult[0].status, 'blocked');
  assert.equal(lifecycleRegistry.getTask(waitingTask.id).state, 'blocked');
  console.log('PASS blocked completion explicitly settles a waiting task');

  const foreignTask = lifecycleRegistry.createTask(scout, 'Reject foreign completion.');
  lifecycleRegistry.setTaskRunning(foreignTask.id);
  const foreignCompletion = createEnvelope(
    { sessionId: foreignChild.sessionId, brokerId: foreignChild.brokerId, senderId: foreignChild.agentId },
    {
      kind: 'task_done',
      targetId: 'shepherd',
      taskId: foreignTask.id,
      status: 'completed',
      summary: 'Wrong owner.',
      delivery: 'followUp',
    },
  );
  publishFromChild(foreignChild, foreignCompletion);
  assert.deepEqual(await processParentBrokerMessages(), []);
  assert.equal(lifecycleRegistry.getTask(foreignTask.id).state, 'running');
  console.log('PASS foreign child completion is rejected without settling the task');

  lifecycleRegistry.settleTask(foreignTask.id, { status: 'cancelled', error: 'test cleanup' });
  assert.deepEqual(await processParentBrokerMessages(), []);
} finally {
  for (const agent of [scout, planner, foreign]) {
    const active = lifecycleRegistry.activeTaskForAgent(agent);
    if (active) lifecycleRegistry.settleTask(active.taskId, { status: 'cancelled', error: 'test cleanup' });
  }
  shutdownParentBroker(() => true);
}

// Keep the import above as a deliberate guard against accidentally replacing
// the process-global lifecycle registry with an unrelated local registry.
assert.ok(new LifecycleRegistry());
console.log('All task completion assertions passed.');
