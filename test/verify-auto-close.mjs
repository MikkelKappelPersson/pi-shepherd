#!/usr/bin/env node
import assert from 'node:assert/strict';
import { scheduleAgentAutoClose } from '../src/extension/auto-close.ts';

const agent = { id: 'shepherd-agent-test', agent: 'worker', paneId: 'pane-test' };

function harness({
  keepOpen = false,
  stayOpen = false,
  activeTask,
  activePromptId,
  state = 'done',
} = {}) {
  const scheduled = [];
  const closed = [];
  const failures = [];
  const registry = {
    getAgent() {
      return { handle: agent, state, activePromptId };
    },
    activeTaskForAgent() {
      return activeTask;
    },
  };
  const options = {
    registry,
    settingsFor: () => ({ keepOpen, stayOpen }),
    schedule(callback, delayMs) {
      scheduled.push({ callback, delayMs });
    },
    async close(handle) {
      closed.push(handle);
      return { ...handle, confirmedGone: true };
    },
    onFailure(error) {
      failures.push(error);
    },
  };
  return { options, scheduled, closed, failures };
}

async function flushScheduled(h) {
  for (const entry of h.scheduled) {
    entry.callback();
  }
  await new Promise(resolve => setImmediate(resolve));
}

{
  const h = harness({ keepOpen: true });
  assert.equal(scheduleAgentAutoClose(agent, '/tmp', h.options), false);
  assert.equal(h.scheduled.length, 0);
  console.log('PASS keepOpen retains a completed agent');
}

{
  const h = harness({ stayOpen: true });
  assert.equal(scheduleAgentAutoClose(agent, '/tmp', h.options), false);
  assert.equal(h.scheduled.length, 0);
  console.log('PASS stayOpen retains a completed agent even when keepOpen is off');
}

{
  const h = harness();
  assert.equal(scheduleAgentAutoClose(agent, '/tmp', h.options), true);
  assert.equal(h.scheduled.length, 1);
  assert.equal(h.scheduled[0].delayMs, 10_000);
  await flushScheduled(h);
  assert.deepEqual(h.closed, [agent]);
  assert.deepEqual(h.failures, []);
  console.log('PASS terminal agents auto-close after the grace period');
}

{
  const h = harness({ activeTask: { taskId: 'shepherd-task-next' }, state: 'working' });
  assert.equal(scheduleAgentAutoClose(agent, '/tmp', h.options), true);
  await flushScheduled(h);
  assert.deepEqual(h.closed, []);
  console.log('PASS a reused agent with a new active task is not auto-closed');
}

{
  const h = harness({ activePromptId: 'shepherd-prompt-next', state: 'working' });
  assert.equal(scheduleAgentAutoClose(agent, '/tmp', h.options), true);
  await flushScheduled(h);
  assert.deepEqual(h.closed, []);
  console.log('PASS a reused agent with an active legacy prompt is not auto-closed');
}

{
  const h = harness({ state: 'idle' });
  assert.equal(scheduleAgentAutoClose(agent, '/tmp', h.options), true);
  await flushScheduled(h);
  assert.deepEqual(h.closed, []);
  console.log('PASS a nonterminal agent state is not auto-closed');
}

{
  const h = harness();
  h.options.close = async () => ({ ...agent, confirmedGone: false });
  assert.equal(scheduleAgentAutoClose(agent, '/tmp', h.options), true);
  await flushScheduled(h);
  assert.equal(h.failures.length, 1);
  assert.match(String(h.failures[0]), /could not be confirmed/i);
  console.log('PASS an unconfirmed auto-close is surfaced to the parent');
}

console.log('All auto-close assertions passed.');
