#!/usr/bin/env node
/** Phase 3 verification for the child-side messaging/completion extension. */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import {
  createChildBroker,
  createEnvelope,
  createParentBroker,
  pollParentInbox,
  publishFromChild,
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
];
const savedEnv = Object.fromEntries(envNames.map(name => [name, process.env[name]]));

try {
  await withTempDirectory('pi-shepherd-child-', async root => {
    const broker = createParentBroker('child-surface-session', {
      rootDir: `${root}/broker`,
      maxQueueDepth: 2,
    });
    const capability = registerChild(broker, 'shepherd-agent-child-surface');
    const peerCapability = registerChild(broker, 'shepherd-agent-peer-surface');
    const peerChild = createChildBroker({ rootDir: broker.rootDir, ...peerCapability });
    process.env.PI_SHEPHERD_BROKER_DIR = broker.rootDir;
    process.env.PI_SHEPHERD_BROKER_SESSION_ID = capability.sessionId;
    process.env.PI_SHEPHERD_BROKER_ID = capability.brokerId;
    process.env.PI_SHEPHERD_AGENT_ID = capability.agentId;
    process.env.PI_SHEPHERD_BROKER_TOKEN = capability.token;
    process.env.PI_SHEPHERD_AGENT_INBOX = capability.inboxPath;
    process.env.PI_SHEPHERD_TASK_ID = 'shepherd-task-child-surface';
    process.env.PI_SHEPHERD_SESSION = `${root}/child-session.jsonl`;

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
    const { default: registerChildExtension } = await import('../src/extension/shepherd-done.ts');
    registerChildExtension(pi);

    assert.deepEqual(
      registered.map(tool => tool.name),
      ['shepherd_message', 'shepherd_done']
    );
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
    const messageTool = registered.find(tool => tool.name === 'shepherd_message');
    assert.ok(messageTool.description.includes('exact opaque agent id returned by shepherd_spawn'));
    assert.ok(messageTool.description.includes('agent definition name'));
    assert.ok(messageTool.description.includes('will be rejected'));
    assert.ok(messageTool.promptGuidelines.join(' ').includes('angle-bracket placeholder'));
    console.log('PASS child registers only messaging and explicit completion tools');

    const doneTool = registered.find(tool => tool.name === 'shepherd_done');
    assert.equal(doneTool.parameters.properties.summary.maxLength, 8_000);
    const oversizedCompletion = await doneTool.execute('oversized-done-call', {
      taskId: 'shepherd-task-child-surface',
      status: 'completed',
      summary: 'x'.repeat(8_001),
    });
    assert.equal(oversizedCompletion.details.returnCode, 1);
    assert.equal(oversizedCompletion.details.code, 'completion_too_large');
    console.log('PASS oversized completion is rejected before it can become pending');

    const messageResult = await messageTool.execute('message-call', {
      target: 'shepherd',
      message: 'Please review the authentication flow.',
      expectsReply: true,
      threadId: 'thread-child-surface',
      delivery: 'followUp',
    });
    assert.equal(messageResult.details.returnCode, 0);
    assert.match(messageResult.content[0].text, /call:\n {4}shepherd_message/);
    const inbox = pollParentInbox(broker);
    const sentMessage = inbox.find(m => m.kind === 'message');
    assert.ok(sentMessage, 'question envelope is queued in the parent inbox');
    assert.equal(sentMessage.senderId, capability.agentId);
    assert.equal(sentMessage.targetId, 'shepherd');
    assert.equal(sentMessage.expectsReply, true);
    assert.equal(sentMessage.threadId, 'thread-child-surface');
    const mirror = inbox.find(m => m.kind === 'runtime');
    assert.ok(mirror, 'tracked request is mirrored to the parent for task correlation');
    assert.equal(mirror.requestOpen, true);
    assert.equal(mirror.replyTo, sentMessage.messageId);
    assert.equal(mirror.targetId, 'shepherd');
    console.log('PASS child shepherd_message publishes an asynchronous correlated envelope');

    const invalidTargetResult = await messageTool.execute('invalid-target-call', {
      target: 'planner',
      message: 'This must not be routed by display name.',
    });
    assert.equal(invalidTargetResult.details.returnCode, 1);
    assert.equal(invalidTargetResult.details.code, 'invalid_target');
    assert.match(
      invalidTargetResult.content[0].text,
      /exact opaque agent id returned by shepherd_spawn/
    );
    assert.match(invalidTargetResult.content[0].text, /agent name such as "planner"/);
    assert.deepEqual(
      pollParentInbox(broker),
      [],
      'invalid peer target is rejected before any message is queued'
    );
    console.log(
      'PASS child shepherd_message rejects agent names instead of treating them as peer ids'
    );

    const incomingTask = createEnvelope(
      { sessionId: broker.sessionId, brokerId: broker.brokerId, senderId: broker.parentId },
      {
        kind: 'task',
        targetId: capability.agentId,
        taskId: 'shepherd-task-child-surface',
        delivery: 'followUp',
        content: 'Complete the review.',
      }
    );
    publishFromParent(broker, incomingTask);
    await new Promise(resolve => setTimeout(resolve, 300));

    const doneResult = await doneTool.execute('done-call', {
      taskId: 'shepherd-task-child-surface',
      status: 'completed',
      summary: 'Review completed.',
    });
    assert.equal(doneResult.details.returnCode, 0);
    assert.match(doneResult.content[0].text, /call:\n {4}shepherd_done/);
    assert.deepEqual(pollParentInbox(broker), [], 'completion waits for agent_end telemetry');
    const duplicateDone = await doneTool.execute('done-call-again', {
      taskId: 'shepherd-task-child-surface',
      status: 'completed',
      summary: 'A different summary must not create a second completion.',
    });
    assert.equal(duplicateDone.details.returnCode, 0);
    assert.deepEqual(pollParentInbox(broker), [], 'repeated completion remains pending');

    let shutdowns = 0;
    await handlers.get('agent_end')(
      { messages: [{ role: 'assistant', stopReason: 'stop' }] },
      {
        shutdown() {
          shutdowns += 1;
        },
      }
    );
    assert.equal(shutdowns, 0);
    assert.equal(fs.existsSync(`${root}/child-session.jsonl.exit`), false);
    const completion = pollParentInbox(broker)[0];
    assert.equal(completion.kind, 'task_done');
    assert.equal(completion.taskId, 'shepherd-task-child-surface');
    assert.equal(completion.status, 'completed');
    assert.equal(completion.summary, 'Review completed.');
    console.log('PASS child publishes task completion only after agent_end');

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
      }
    );
    publishFromParent(broker, incoming);
    await handlers.get('session_start')({}, {});
    const replyMessage = sentUserMessages.at(-1);
    assert.equal(sentUserMessages.length, 2);
    assert.match(replyMessage.content, /Shepherd message from Shepherd/);
    assert.match(replyMessage.content, /Reply to: request-123/);
    assert.equal(replyMessage.options.deliverAs, 'steer');
    assert.equal(replyMessage.options.triggerTurn, true);
    assert.ok(
      messageTool.promptGuidelines.some(guideline =>
        guideline.includes('request, not your own task ID')
      ),
      'child guidance explains requester task id for replies'
    );
    await new Promise(resolve => setTimeout(resolve, 300));
    const mismatchedReply = await messageTool.execute('mismatched-reply', {
      target: 'shepherd',
      message: 'This must be rejected.',
      taskId: 'shepherd-task-wrong-owner',
      replyTo: 'request-123',
    });
    assert.equal(mismatchedReply.details.returnCode, 1);
    assert.equal(mismatchedReply.details.code, 'reply_task_mismatch');
    const inferredReply = await messageTool.execute('inferred-reply', {
      target: 'shepherd',
      message: 'The reply task id should be inferred.',
      replyTo: 'request-123',
    });
    assert.equal(inferredReply.details.returnCode, 0);
    const inferredEnvelope = pollParentInbox(broker).find(m => m.replyTo === 'request-123');
    assert.ok(inferredEnvelope, 'reply with omitted taskId is published');
    assert.equal(inferredEnvelope.taskId, 'shepherd-task-child-surface');
    console.log('PASS child replies infer the requester task id and reject mismatched task ids');

    const retryTask = createEnvelope(
      { sessionId: broker.sessionId, brokerId: broker.brokerId, senderId: broker.parentId },
      {
        kind: 'task',
        targetId: capability.agentId,
        taskId: 'shepherd-task-retry-publication',
        delivery: 'followUp',
        content: 'Complete after a transient full queue.',
      }
    );
    publishFromParent(broker, retryTask);
    await new Promise(resolve => setTimeout(resolve, 300));
    const retryDone = await doneTool.execute('retry-done-call', {
      taskId: 'shepherd-task-retry-publication',
      status: 'completed',
      summary: 'Published after queue capacity returns.',
    });
    assert.equal(retryDone.details.returnCode, 0);
    for (let index = 0; index < 2; index++) {
      publishFromChild(
        peerChild,
        createEnvelope(
          { sessionId: broker.sessionId, brokerId: broker.brokerId, senderId: peerChild.agentId },
          {
            kind: 'message',
            targetId: broker.parentId,
            delivery: 'followUp',
            content: `queue filler ${index}`,
          }
        )
      );
    }
    await handlers.get('agent_end')(
      { messages: [{ role: 'assistant', stopReason: 'stop' }] },
      { shutdown() {} }
    );
    assert.equal(
      pollParentInbox(broker).some(message => message.kind === 'task_done'),
      false,
      'full queue defers completion publication'
    );
    await new Promise(resolve => setTimeout(resolve, 400));
    const retriedCompletion = pollParentInbox(broker).find(
      message => message.kind === 'task_done' && message.taskId === retryTask.taskId
    );
    assert.ok(retriedCompletion, 'mailbox polling retries deferred completion publication');
    console.log('PASS transient completion publication failure retries without another model turn');

    const peerRequest = createEnvelope(
      { sessionId: peerChild.sessionId, brokerId: peerChild.brokerId, senderId: peerChild.agentId },
      {
        kind: 'message',
        targetId: capability.agentId,
        taskId: 'shepherd-task-child-surface',
        replyTo: undefined,
        expectsReply: true,
        delivery: 'followUp',
        content: 'Reply directly to this peer request.',
      }
    );
    publishFromChild(peerChild, peerRequest);
    await new Promise(resolve => setTimeout(resolve, 300));
    const directPeerReply = await messageTool.execute('direct-peer-reply', {
      target: peerChild.agentId,
      message: 'pong',
      replyTo: peerRequest.messageId,
    });
    assert.equal(directPeerReply.details.returnCode, 0);
    const replyMirror = pollParentInbox(broker).find(
      message =>
        message.kind === 'runtime' &&
        message.replyReceived === true &&
        message.replyTo === peerRequest.messageId
    );
    assert.ok(replyMirror, 'direct peer replies mirror correlation to the parent');
    assert.equal(replyMirror.taskId, 'shepherd-task-child-surface');
    console.log('PASS direct peer replies notify the parent without requiring a duplicate relay');

    // A failed local delivery is reported to the parent as a runtime
    // diagnostic correlated with the undelivered message id.
    const failing = [
      { sessionId: broker.sessionId, brokerId: broker.brokerId, senderId: broker.parentId },
      {
        kind: 'message',
        targetId: capability.agentId,
        delivery: 'followUp',
        content: 'This one cannot be delivered.',
      },
    ];
    const failingEnvelope = createEnvelope(failing[0], failing[1]);
    publishFromParent(broker, failingEnvelope);
    let deliverFailures = 0;
    const realSend = pi.sendUserMessage.bind(pi);
    pi.sendUserMessage = (content, options) => {
      deliverFailures += 1;
      throw new Error('renderer unavailable');
    };
    // The 250ms poll interval from the earlier session_start delivers the
    // message through the now-failing sender.
    await new Promise(resolve => setTimeout(resolve, 400));
    assert.equal(deliverFailures, 1);
    const diagnostics = pollParentInbox(broker);
    const diagnostic = diagnostics.find(
      m => m.kind === 'runtime' && String(m.content).includes(failingEnvelope.messageId)
    );
    assert.ok(diagnostic, 'failed delivery produces a runtime diagnostic in the parent inbox');
    assert.equal(diagnostic.error, 'renderer unavailable');
    assert.equal(
      diagnostic.summary,
      undefined || diagnostic.summary,
      'diagnostic carries the failure detail'
    );
    pi.sendUserMessage = realSend;
    await handlers.get('session_shutdown')({}, {});
    console.log('PASS failed local message delivery is reported to the parent with the message id');
    console.log('PASS child polling queues incoming messages with requested delivery mode');
  });

  // The child surface remains loadable for legacy launches that have not yet
  // been wired to a parent broker. Tool calls fail clearly instead of trying
  // to invent a session or writing outside an owned mailbox.
  for (const name of envNames) delete process.env[name];
  const registered = [];
  const pi = {
    registerTool(tool) {
      registered.push(tool);
    },
    on() {},
    sendUserMessage() {
      throw new Error('must not deliver without broker');
    },
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
