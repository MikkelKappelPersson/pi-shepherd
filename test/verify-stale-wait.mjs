#!/usr/bin/env node
/** Phase 8 verification for stale-wait monitoring and reminders. */
import assert from 'node:assert/strict';
import { LifecycleRegistry, lifecycleRegistry } from '../src/core/orchestration.ts';
import { StaleWaitMonitor } from '../src/core/lifecycle.ts';
import { withFakeDateNow } from './helpers/fake-clock.mjs';
import { registerShepherdTools, setStaleWaitSessionActive } from '../src/extension/shepherd.ts';

const ONE_MIN = 60_000;

function makeMonitor(registry) {
  const infos = [];
  const monitor = new StaleWaitMonitor(registry, info => infos.push(info), 1_000);
  return { monitor, infos };
}

/** Put an agent's task into `waiting` on an outstanding reply. */
function enterWaiting(registry, agent, target, question) {
  const task = registry.createTask(agent, 'Investigate the authentication failure.');
  registry.setTaskRunning(task.id);
  registry.openPendingRequest(task.id, {
    messageId: 'msg-question-1',
    targetAgentId: target.id,
    text: question,
  });
  return task.id;
}

await withFakeDateNow(0, async clock => {
  const registry = new LifecycleRegistry();
  const scout = registry.registerAgent({ agent: 'scout', label: 'stale-scout' });
  const planner = registry.registerAgent({ agent: 'planner', label: 'stale-planner' });
  const { monitor, infos } = makeMonitor(registry);
  registry.setAgentState(planner, 'working');
  const taskId = enterWaiting(registry, scout, planner, 'What is the retry backoff?');

  // 4.9 min in: under the default 5-min threshold -> no notification yet.
  clock.advance(4.9 * ONE_MIN);
  await monitor.poll();
  assert.equal(infos.length, 0, 'no stale notification before the threshold is crossed');
  console.log('PASS no stale notification while below the threshold');

  // Cross the threshold: exactly one notification.
  clock.advance(0.2 * ONE_MIN);
  await monitor.poll();
  assert.equal(infos.length, 1, 'one notification after crossing the threshold');
  console.log('PASS a waiting task crossing the threshold produces one stale-wait notification');

  // One notification per episode: advancing further does not repeat it.
  clock.advance(ONE_MIN);
  await monitor.poll();
  assert.equal(infos.length, 1, 'the same episode does not notify again');
  console.log('PASS no repeated notification while the episode is still open');

  // Notification content.
  const info = infos[0];
  assert.equal(info.taskId, taskId);
  assert.equal(info.agentId, scout.id);
  assert.equal(info.agent, 'scout');
  assert.equal(info.label, 'stale-scout');
  assert.match(info.description, /authentication failure/);
  assert.equal(typeof info.waitingSince, 'number');
  assert.ok(info.elapsedMs >= 5 * ONE_MIN, 'elapsed wait reflects the threshold crossing');
  assert.equal(info.requestMessageId, 'msg-question-1');
  assert.equal(info.question, 'What is the retry backoff?');
  assert.equal(info.recipientId, planner.id);
  assert.equal(info.recipientState, 'working');
  assert.equal(info.thresholdMinutes, 5, 'default threshold is 5 minutes');
  console.log('PASS the stale-wait notification carries task, owner, question, recipient, and elapsed time');

  // A reply clears the stale condition; a new episode re-notifies.
  registry.setAgentState(planner, 'idle');
  clock.advance(ONE_MIN);
  registry.resolveReplyForTask(taskId, 'msg-question-1');
  assert.equal(registry.getTask(taskId).state, 'running');
  assert.equal(registry.getTask(taskId).staleNotifiedAt, undefined, 'reply clears the stale flag');
  registry.openPendingRequest(taskId, {
    messageId: 'msg-question-2',
    targetAgentId: planner.id,
    text: 'And the max attempts?',
  });
  clock.advance(5.5 * ONE_MIN);
  await monitor.poll();
  assert.equal(infos.length, 2, 'a new waiting episode produces its own notification');
  assert.equal(infos[1].requestMessageId, 'msg-question-2');
  console.log('PASS a reply clears the stale condition and a new episode re-notifies');
  monitor.shutdown();
});

{
  // A completed task never raises a stale notification.
  const registry = new LifecycleRegistry();
  const scout = registry.registerAgent({ agent: 'scout', label: 'done-scout' });
  const { monitor, infos } = makeMonitor(registry);
  const task = registry.createTask(scout, 'Will finish quickly.');
  registry.setTaskRunning(task.id);
  registry.settleTask(task.id, { status: 'completed', ok: true, text: 'done' });
  await withFakeDateNow(0, async clock => {
    clock.advance(60 * ONE_MIN);
    await monitor.poll();
  });
  assert.equal(infos.length, 0, 'a completed task never raises a stale notification');
  monitor.shutdown();
  console.log('PASS a completed task has no stale notification');
}

{
  // An idle agent with no waiting task raises nothing.
  const registry = new LifecycleRegistry();
  const idle = registry.registerAgent({ agent: 'planner', label: 'just-idle' });
  registry.setAgentState(idle, 'idle');
  const { monitor, infos } = makeMonitor(registry);
  await withFakeDateNow(0, async clock => {
    clock.advance(60 * ONE_MIN);
    await monitor.poll();
  });
  assert.equal(infos.length, 0, 'an idle agent with no waiting task raises nothing');
  monitor.shutdown();
  console.log('PASS an idle agent without a waiting task produces no stale notification');
}

{
  // Stale-wait is information only; it never settles the task.
  const registry = new LifecycleRegistry();
  const scout = registry.registerAgent({ agent: 'scout', label: 'keep-waiting' });
  const planner = registry.registerAgent({ agent: 'planner', label: 'keep-waiting-2' });
  const { monitor, infos } = makeMonitor(registry);
  const task = registry.createTask(scout, 'Still waiting.');
  registry.setTaskRunning(task.id);
  await withFakeDateNow(0, async clock => {
    registry.openPendingRequest(task.id, { messageId: 'msg-1', targetAgentId: planner.id, text: 'q?' });
    clock.advance(60 * ONE_MIN);
    await monitor.poll();
  });
  assert.equal(infos.length, 1, 'one stale notification was emitted');
  assert.equal(registry.getTask(task).state, 'waiting', 'stale-wait does not settle the task');
  registry.settleTask(task, { status: 'blocked', ok: false, error: 'Tracked reply deadline reached.' });
  assert.equal(registry.getTask(task).state, 'blocked');
  monitor.shutdown();
  console.log('PASS stale-wait is information only; the reply deadline settles the task separately');
}

{
  // Monitor starts only while a task is waiting and stops when none remain.
  const registry = new LifecycleRegistry();
  const scout = registry.registerAgent({ agent: 'scout', label: 'timer' });
  const planner = registry.registerAgent({ agent: 'planner', label: 'timer-2' });
  const { monitor } = makeMonitor(registry);
  assert.ok(!monitor['timer'], 'no timer while there are no waiting tasks');
  await withFakeDateNow(0, async clock => {
    const task = registry.createTask(scout, 'Waiting for the timer.');
    registry.setTaskRunning(task.id);
    registry.openPendingRequest(task.id, { messageId: 'm1', targetAgentId: planner.id, text: 'q?' });
    monitor.kick();
    assert.ok(monitor['timer'], 'timer starts once a task is waiting');
    // Let the episode elapse so a poll finds a waiting task, then settle it.
    clock.advance(ONE_MIN);
    registry.settleTask(task.id, { status: 'completed', ok: true, text: 'done' });
    await monitor.poll();
  });
  assert.ok(!monitor['timer'], 'monitor stops when no waiting tasks remain');
  monitor.shutdown();
  console.log('PASS monitor starts only while waiting tasks exist and stops when none remain');
}

{
  // Disabled timeout handling: a 0-minute threshold disables reminders.
  const { withTempDirectory } = await import('./helpers/test-utils.mjs');
  await withTempDirectory(undefined, async dir => {
    const prev = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = dir;
    try {
      const fs = await import('node:fs');
      const path = await import('node:path');
      const dir2 = path.join(dir, 'pi-shepherd');
      fs.mkdirSync(dir2, { recursive: true });
      fs.writeFileSync(path.join(dir2, 'config.json'), JSON.stringify({ staleWaitThreshold: 0 }));

      const registry = new LifecycleRegistry();
      const scout = registry.registerAgent({ agent: 'scout', label: 'disabled' });
      const planner = registry.registerAgent({ agent: 'planner', label: 'disabled-2' });
      const { monitor, infos } = makeMonitor(registry);
      const task = registry.createTask(scout, 'Should not remind.');
      registry.setTaskRunning(task.id);
      await withFakeDateNow(0, async clock => {
        registry.openPendingRequest(task.id, { messageId: 'msg-1', targetAgentId: planner.id, text: 'q?' });
        clock.advance(60 * ONE_MIN);
        await monitor.poll();
      });
      assert.equal(infos.length, 0, 'a disabled (0-minute) threshold raises no notification');
      monitor.shutdown();
    } finally {
      if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = prev;
    }
  });
  console.log('PASS a disabled stale-wait threshold raises no notification');
}

{
  // Bridge delivery + suppression once the parent session is inactive.
  const { staleWaitMonitor } = await import('../src/core/lifecycle.ts');
  const sent = [];
  let renderRegistered = false;
  registerShepherdTools({
    registerTool() {},
    registerMessageRenderer(customType) {
      if (customType === 'shepherd.stale.wait') renderRegistered = true;
    },
    sendMessage(_message, options) {
      sent.push(options);
    },
  });
  assert.ok(renderRegistered, 'the shepherd.stale.wait renderer was registered');

  const scout = lifecycleRegistry.registerAgent({ agent: 'scout', label: 'bridge-scout' });
  const planner = lifecycleRegistry.registerAgent({ agent: 'planner', label: 'bridge-planner' });
  setStaleWaitSessionActive(true);
  const sentCountAfterActive = await withFakeDateNow(0, async clock => {
    const task = lifecycleRegistry.createTask(scout, 'Bridge stale wait.');
    lifecycleRegistry.setTaskRunning(task.id);
    lifecycleRegistry.openPendingRequest(task.id, { messageId: 'bridge-msg-1', targetAgentId: planner.id, text: 'q?' });
    clock.advance(60 * ONE_MIN);
    await staleWaitMonitor.poll();
    return sent.length;
  });
  assert.ok(sentCountAfterActive >= 1, 'one stale notification delivered as a custom follow-up');
  assert.deepEqual(sent[sent.length - 1], { deliverAs: 'followUp', triggerTurn: false });

  // With the parent session inactive, a new waiting episode is not delivered.
  const secondAgent = lifecycleRegistry.registerAgent({ agent: 'scout', label: 'bridge-scout-2' });
  setStaleWaitSessionActive(false);
  const sentCountBefore = sent.length;
  await withFakeDateNow(0, async clock => {
    const secondTask = lifecycleRegistry.createTask(secondAgent, 'Second.');
    lifecycleRegistry.setTaskRunning(secondTask.id);
    lifecycleRegistry.openPendingRequest(secondTask.id, { messageId: 'bridge-msg-2', targetAgentId: planner.id, text: 'q?' });
    clock.advance(60 * ONE_MIN);
    await staleWaitMonitor.poll();
  });
  assert.equal(sent.length, sentCountBefore, 'no delivery once the parent session is inactive');
  setStaleWaitSessionActive(true);
  staleWaitMonitor.shutdown();
  console.log('PASS stale-wait is delivered as a follow-up and suppressed after the parent session goes inactive');
}

console.log('All stale-wait assertions passed.');
