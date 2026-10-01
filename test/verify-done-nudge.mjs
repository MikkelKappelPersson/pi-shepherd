#!/usr/bin/env node
/**
 * Verification for the forgotten-shepherd_done recovery: a tracked task that a
 * child leaves open at turn end gets one reminder turn, and a task that stays
 * open past the budget is escalated to the parent instead of looping.
 */
import assert from 'node:assert/strict';
import {
  createChildBroker,
  createEnvelope,
  createParentBroker,
  pollParentInbox,
  publishFromParent,
  registerChild,
} from '../src/core/messaging.ts';
import { withTempDirectory } from './helpers/test-utils.mjs';

const envNames = [
  'PI_SHEPHERD_BROKER_DIR',
  'PI_SHEPHERD_BROKER_SESSION_ID',
  'PI_SHEPHERD_BROKER_ID',
  'PI_SHEPHERD_AGENT_ID',
  'PI_SHEPHERD_BROKER_TOKEN',
  'PI_SHEPHERD_AGENT_INBOX',
  'PI_SHEPHERD_TASK_ID',
  'PI_SHEPHERD_SESSION',
  'PI_SHEPHERD_AUTO_EXIT',
  'PI_SHEPHERD_STAY_OPEN',
  'PI_SHEPHERD_DONE_NUDGES',
];
const savedEnv = Object.fromEntries(envNames.map(name => [name, process.env[name]]));
const { default: registerChildExtension } = await import('../src/extension/shepherd-done.ts');

/** Load the child extension with a fresh fake pi harness. */
function loadChild({ taskId, nudges, autoExit = '0', stayOpen = '1' } = {}) {
  if (taskId === undefined) delete process.env.PI_SHEPHERD_TASK_ID;
  else process.env.PI_SHEPHERD_TASK_ID = taskId;
  if (nudges === undefined) delete process.env.PI_SHEPHERD_DONE_NUDGES;
  else process.env.PI_SHEPHERD_DONE_NUDGES = String(nudges);
  process.env.PI_SHEPHERD_AUTO_EXIT = autoExit;
  process.env.PI_SHEPHERD_STAY_OPEN = stayOpen;
  delete process.env.PI_SHEPHERD_SESSION;
  const registered = [];
  const handlers = new Map();
  const sentUserMessages = [];
  const pi = {
    registerTool(tool) {
      registered.push(tool);
    },
    on(event, handler) {
      handlers.set(event, handler);
    },
    sendUserMessage(content, options) {
      sentUserMessages.push({ content, options });
    },
  };
  registerChildExtension(pi);
  return {
    pi,
    handlers,
    sentUserMessages,
    tools: Object.fromEntries(registered.map(tool => [tool.name, tool])),
    async endTurn(messages = [{ role: 'assistant', stopReason: 'stop' }]) {
      let shutdowns = 0;
      await handlers.get('agent_end')({ messages }, {
        shutdown() {
          shutdowns += 1;
        },
      });
      return shutdowns;
    },
  };
}

const normalEnd = [{ role: 'assistant', stopReason: 'stop' }];

try {
  await withTempDirectory('pi-shepherd-done-nudge-', async root => {
    const broker = createParentBroker('done-nudge-session', { rootDir: `${root}/broker` });

    // --- 1. A tracked task left open at turn end gets exactly one reminder.
    let capability = registerChild(broker, 'shepherd-agent-nudge');
    Object.assign(process.env, {
      PI_SHEPHERD_BROKER_DIR: broker.rootDir,
      PI_SHEPHERD_BROKER_SESSION_ID: capability.sessionId,
      PI_SHEPHERD_BROKER_ID: capability.brokerId,
      PI_SHEPHERD_AGENT_ID: capability.agentId,
      PI_SHEPHERD_BROKER_TOKEN: capability.token,
      PI_SHEPHERD_AGENT_INBOX: capability.inboxPath,
    });
    let child = loadChild({ taskId: 'shepherd-task-nudge' });
    let shutdowns = await child.endTurn(normalEnd);
    assert.equal(shutdowns, 0);
    assert.equal(child.sentUserMessages.length, 1, 'a forgotten done produces one reminder turn');
    const nudge = child.sentUserMessages[0];
    assert.match(nudge.content, /shepherd_done/);
    assert.match(nudge.content, /shepherd-task-nudge/);
    assert.equal(nudge.options.deliverAs, 'followUp');
    assert.equal(nudge.options.triggerTurn, true);
    console.log('PASS a tracked task left open at turn end is nudged with shepherd_done');

    // The reminder is a queued follow-up, not a fabricated completion.
    assert.deepEqual(pollParentInbox(broker), [], 'nudging alone publishes no task completion');

    // --- 2. The nudge is not repeated once the child complies.
    const done = await child.tools.shepherd_done.execute('done-1', {
      status: 'completed',
      summary: 'Wrote the migration.',
    });
    assert.equal(done.details.returnCode, 0);
    assert.equal(pollParentInbox(broker).filter(e => e.kind === 'task_done').length, 1);
    await child.endTurn(normalEnd);
    assert.equal(child.sentUserMessages.length, 1, 'a completed task is never nudged again');
    console.log('PASS calling shepherd_done clears the open task and stops further nudges');

    // --- 3. A forgotten done escalates to the parent once the budget is spent.
    capability = registerChild(broker, 'shepherd-agent-nudge-escalate');
    Object.assign(process.env, {
      PI_SHEPHERD_BROKER_SESSION_ID: capability.sessionId,
      PI_SHEPHERD_BROKER_ID: capability.brokerId,
      PI_SHEPHERD_AGENT_ID: capability.agentId,
      PI_SHEPHERD_BROKER_TOKEN: capability.token,
      PI_SHEPHERD_AGENT_INBOX: capability.inboxPath,
    });
    child = loadChild({ taskId: 'shepherd-task-escalate', nudges: 1 });
    await child.endTurn(normalEnd);
    assert.equal(child.sentUserMessages.length, 1, 'first forgotten done nudges');
    await child.endTurn(normalEnd); // the reminder turn also forgets shepherd_done
    assert.equal(child.sentUserMessages.length, 1, 'the reminder budget is bounded');
    const escalation = pollParentInbox(broker).find(
      e => e.kind === 'message' && String(e.content).includes('completion stalled')
    );
    assert.ok(escalation, 'an exhausted reminder budget is reported to the parent');
    assert.equal(escalation.taskId, 'shepherd-task-escalate');
    assert.equal(escalation.targetId, broker.parentId);
    assert.equal(escalation.expectsReply, undefined, 'the escalation is passive, not a question');
    await child.endTurn(normalEnd);
    assert.equal(
      pollParentInbox(broker).filter(e => String(e.content).includes('completion stalled')).length,
      0,
      'the stall is not re-reported on every later turn'
    );
    console.log('PASS an exhausted reminder budget escalates to the parent exactly once');

    // --- 4. Legitimate turn ends are never nudged.
    capability = registerChild(broker, 'shepherd-agent-nudge-guard');
    Object.assign(process.env, {
      PI_SHEPHERD_BROKER_SESSION_ID: capability.sessionId,
      PI_SHEPHERD_BROKER_ID: capability.brokerId,
      PI_SHEPHERD_AGENT_ID: capability.agentId,
      PI_SHEPHERD_BROKER_TOKEN: capability.token,
      PI_SHEPHERD_AGENT_INBOX: capability.inboxPath,
    });
    // (a) aborted turn — the user took over in the tab.
    child = loadChild({ taskId: 'shepherd-task-aborted' });
    await child.endTurn([{ role: 'assistant', stopReason: 'aborted' }]);
    // (b) provider error — another path reports the failure.
    await child.endTurn([{ role: 'assistant', stopReason: 'error', errorMessage: 'rate limited' }]);
    assert.equal(child.sentUserMessages.length, 0, 'aborted and errored turns are left alone');
    // (c) no tracked task — plain prompts settle through the sidecar.
    child = loadChild({ taskId: undefined });
    await child.endTurn(normalEnd);
    assert.equal(child.sentUserMessages.length, 0, 'an agent without a tracked task is not nudged');
    console.log('PASS aborted, errored, and untracked turn ends are never nudged');

    // --- 5. A child waiting for a tracked reply may end its turn in peace.
    capability = registerChild(broker, 'shepherd-agent-nudge-waiting');
    Object.assign(process.env, {
      PI_SHEPHERD_BROKER_SESSION_ID: capability.sessionId,
      PI_SHEPHERD_BROKER_ID: capability.brokerId,
      PI_SHEPHERD_AGENT_ID: capability.agentId,
      PI_SHEPHERD_BROKER_TOKEN: capability.token,
      PI_SHEPHERD_AGENT_INBOX: capability.inboxPath,
    });
    child = loadChild({ taskId: 'shepherd-task-waiting' });
    const request = await child.tools.shepherd_message.execute('ask-parent', {
      target: 'shepherd',
      message: 'Which migration do you want applied?',
      expectsReply: true,
    });
    assert.equal(request.details.returnCode, 0);
    pollParentInbox(broker);
    await child.endTurn(normalEnd);
    assert.equal(
      child.sentUserMessages.length,
      0,
      'ending the turn while a tracked request is outstanding is not a forgotten done'
    );
    // The reply arrives and closes the request; the next forgotten done nudges.
    publishFromParent(
      broker,
      createEnvelope(
        { sessionId: broker.sessionId, brokerId: broker.brokerId, senderId: broker.parentId },
        {
          kind: 'reply',
          targetId: capability.agentId,
          taskId: 'shepherd-task-waiting',
          replyTo: request.details.messageId,
          delivery: 'followUp',
          content: 'Apply migration 0042.',
        }
      )
    );
    const delivered = child.sentUserMessages.length;
    await child.handlers.get('session_start')({}, {});
    await new Promise(resolve => setTimeout(resolve, 300));
    await child.handlers.get('session_shutdown')({}, {});
    assert.equal(child.sentUserMessages.length - delivered, 1, 'the reply is delivered as its own turn');
    assert.match(child.sentUserMessages.at(-1).content, /Apply migration 0042/);
    await child.endTurn(normalEnd);
    assert.equal(child.sentUserMessages.length, 2, 'after the reply, a forgotten done is nudged');
    assert.match(child.sentUserMessages[1].content, /\[Shepherd completion check\]/);
    console.log('PASS waiting for a tracked reply suppresses the nudge until the answer lands');

    // --- 6. Nudging can be disabled without changing any other behavior.
    capability = registerChild(broker, 'shepherd-agent-nudge-disabled');
    Object.assign(process.env, {
      PI_SHEPHERD_BROKER_SESSION_ID: capability.sessionId,
      PI_SHEPHERD_BROKER_ID: capability.brokerId,
      PI_SHEPHERD_AGENT_ID: capability.agentId,
      PI_SHEPHERD_BROKER_TOKEN: capability.token,
      PI_SHEPHERD_AGENT_INBOX: capability.inboxPath,
    });
    child = loadChild({ taskId: 'shepherd-task-disabled', nudges: 0 });
    await child.endTurn(normalEnd);
    await child.endTurn(normalEnd);
    assert.equal(child.sentUserMessages.length, 0, 'PI_SHEPHERD_DONE_NUDGES=0 disables nudging');
    assert.equal(pollParentInbox(broker).length, 0, 'a disabled nudge reports nothing');
    console.log('PASS nudging is opt-out via PI_SHEPHERD_DONE_NUDGES=0');
  });
} finally {
  for (const name of envNames) {
    if (savedEnv[name] === undefined) delete process.env[name];
    else process.env[name] = savedEnv[name];
  }
}

console.log('All completion-nudge assertions passed.');