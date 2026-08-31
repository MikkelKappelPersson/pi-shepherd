#!/usr/bin/env node
/** Phase 3 verification for the child-side messaging/completion extension. */
import assert from 'node:assert/strict';
import {
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
];
const savedEnv = Object.fromEntries(envNames.map(name => [name, process.env[name]]));

try {
  await withTempDirectory('pi-shepherd-child-', async root => {
    const broker = createParentBroker('child-surface-session', { rootDir: `${root}/broker` });
    const capability = registerChild(broker, 'shepherd-agent-child-surface');
    process.env.PI_SHEPHERD_BROKER_DIR = broker.rootDir;
    process.env.PI_SHEPHERD_BROKER_SESSION_ID = capability.sessionId;
    process.env.PI_SHEPHERD_BROKER_ID = capability.brokerId;
    process.env.PI_SHEPHERD_AGENT_ID = capability.agentId;
    process.env.PI_SHEPHERD_BROKER_TOKEN = capability.token;
    process.env.PI_SHEPHERD_AGENT_INBOX = capability.inboxPath;
    process.env.PI_SHEPHERD_TASK_ID = 'shepherd-task-child-surface';

    const registered = [];
    const handlers = new Map();
    const sentUserMessages = [];
    const pi = {
      registerTool(tool) { registered.push(tool); },
      on(event, handler) { handlers.set(event, handler); },
      sendUserMessage(content, options) { sentUserMessages.push({ content, options }); },
    };
    const { default: registerChildExtension } = await import('../src/extension/shepherd-done.ts');
    registerChildExtension(pi);

    assert.deepEqual(registered.map(tool => tool.name), ['shepherd_message', 'shepherd_done']);
    for (const tool of registered) {
      assert.equal(tool.parameters.type, 'object');
      assert.equal(typeof tool.name, 'string');
      assert.equal(typeof tool.label, 'string');
      assert.equal(typeof tool.description, 'string');
      assert.equal(typeof tool.promptSnippet, 'string');
      assert.equal(typeof tool.execute, 'function');
    }
    assert.ok(handlers.has('session_start'));
    assert.ok(handlers.has('session_shutdown'));
    assert.ok(handlers.has('agent_end'));
    console.log('PASS child registers only messaging and explicit completion tools');

    const messageTool = registered.find(tool => tool.name === 'shepherd_message');
    const doneTool = registered.find(tool => tool.name === 'shepherd_done');
    const messageResult = await messageTool.execute('message-call', {
      target: 'shepherd',
      message: 'Please review the authentication flow.',
      expectsReply: true,
      threadId: 'thread-child-surface',
      delivery: 'followUp',
    });
    assert.equal(messageResult.details.returnCode, 0);
    assert.match(messageResult.content[0].text, /call:\n    shepherd_message/);
    const sentMessage = pollParentInbox(broker)[0];
    assert.equal(sentMessage.senderId, capability.agentId);
    assert.equal(sentMessage.targetId, 'shepherd');
    assert.equal(sentMessage.expectsReply, true);
    assert.equal(sentMessage.threadId, 'thread-child-surface');
    console.log('PASS child shepherd_message publishes an asynchronous correlated envelope');

    const doneResult = await doneTool.execute('done-call', {
      taskId: 'shepherd-task-child-surface',
      status: 'completed',
      summary: 'Review completed.',
    });
    assert.equal(doneResult.details.returnCode, 0);
    assert.match(doneResult.content[0].text, /call:\n    shepherd_done/);
    const completion = pollParentInbox(broker)[0];
    assert.equal(completion.kind, 'task_done');
    assert.equal(completion.taskId, 'shepherd-task-child-surface');
    assert.equal(completion.status, 'completed');
    assert.equal(completion.summary, 'Review completed.');
    console.log('PASS child shepherd_done publishes an explicit task-done envelope');
    const duplicateDone = await doneTool.execute('done-call-again', {
      taskId: 'shepherd-task-child-surface',
      status: 'completed',
      summary: 'A different summary must not create a second completion.',
    });
    assert.equal(duplicateDone.details.duplicate, true);
    assert.deepEqual(pollParentInbox(broker), []);
    console.log('PASS repeated child shepherd_done calls are idempotent');

    const incoming = createEnvelope(
      { sessionId: broker.sessionId, brokerId: broker.brokerId, senderId: broker.parentId },
      {
        kind: 'reply',
        targetId: capability.agentId,
        taskId: 'shepherd-task-child-surface',
        threadId: 'thread-child-surface',
        replyTo: 'request-123',
        delivery: 'steer',
        content: 'The middleware is in src/auth/session.ts.',
      },
    );
    publishFromParent(broker, incoming);
    await handlers.get('session_start')({}, {});
    assert.equal(sentUserMessages.length, 1);
    assert.match(sentUserMessages[0].content, /Shepherd message from Shepherd/);
    assert.match(sentUserMessages[0].content, /Reply to: request-123/);
    assert.equal(sentUserMessages[0].options.deliverAs, 'steer');
    await handlers.get('session_shutdown')({}, {});
    console.log('PASS child polling queues incoming messages with requested delivery mode');
  });

  // The child surface remains loadable for legacy launches that have not yet
  // been wired to a parent broker. Tool calls fail clearly instead of trying
  // to invent a session or writing outside an owned mailbox.
  for (const name of envNames) delete process.env[name];
  const registered = [];
  const pi = {
    registerTool(tool) { registered.push(tool); },
    on() {},
    sendUserMessage() { throw new Error('must not deliver without broker'); },
  };
  const { default: registerChildExtension } = await import('../src/extension/shepherd-done.ts');
  registerChildExtension(pi);
  const result = await registered[0].execute('missing-broker', {
    target: 'shepherd',
    message: 'This should be rejected.',
  });
  assert.equal(result.details.returnCode, 1);
  assert.equal(result.details.code, 'broker_unavailable');
  console.log('PASS child tools fail safely when no broker capability is configured');
} finally {
  for (const name of envNames) {
    if (savedEnv[name] === undefined) delete process.env[name];
    else process.env[name] = savedEnv[name];
  }
}

console.log('All child-surface assertions passed.');
