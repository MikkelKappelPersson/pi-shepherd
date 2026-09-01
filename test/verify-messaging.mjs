#!/usr/bin/env node
/** Phase 2 verification for the parent-owned filesystem mailbox. */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  MessagingError,
  closeBrokerWhenChildrenGone,
  createChildBroker,
  createEnvelope,
  createParentBroker,
  pollChildInbox,
  pollParentInbox,
  publishFromChild,
  publishFromParent,
  registerChild,
  unregisterChild,
} from '../src/core/messaging.ts';
import { createFakeChildIdentity, createFakeParentIdentity, withTempDirectory } from './helpers/test-utils.mjs';

function expectMessagingError(fn, code, label) {
  assert.throws(fn, error => {
    assert.ok(error instanceof MessagingError, `${label}: expected MessagingError`);
    assert.equal(error.code, code, `${label}: error code`);
    return true;
  });
  console.log(`PASS ${label}`);
}

await withTempDirectory('pi-shepherd-messaging-', async root => {
  const parentIdentity = createFakeParentIdentity();
  const broker = createParentBroker(parentIdentity.sessionId, {
    rootDir: path.join(root, 'broker'),
  });
  assert.equal(fs.statSync(broker.rootDir).mode & 0o777, 0o700);
  assert.equal(fs.existsSync(broker.parentInboxPath), true);
  assert.equal(fs.existsSync(path.join(broker.rootDir, 'broker.json')), true);
  console.log('PASS broker creates protected session mailbox structure');

  const scoutIdentity = createFakeChildIdentity({ agentId: 'shepherd-agent-scout' });
  const plannerIdentity = createFakeChildIdentity({ agentId: 'shepherd-agent-planner' });
  const scoutCapability = registerChild(broker, scoutIdentity.agentId);
  const plannerCapability = registerChild(broker, plannerIdentity.agentId);
  const scout = createChildBroker({ rootDir: broker.rootDir, ...scoutCapability });
  const planner = createChildBroker({ rootDir: broker.rootDir, ...plannerCapability });
  assert.equal(scout.agentId, scoutIdentity.agentId);
  assert.equal(planner.agentId, plannerIdentity.agentId);
  console.log('PASS child capabilities rehydrate registered child connections');

  const childToParent = createEnvelope(
    { sessionId: scout.sessionId, brokerId: scout.brokerId, senderId: scout.agentId },
    {
      kind: 'message',
      targetId: 'shepherd',
      delivery: 'followUp',
      content: 'Scout needs planner input.',
      expectsReply: true,
      taskId: 'shepherd-task-example',
      threadId: 'thread-example',
    },
  );
  const acceptedToParent = publishFromChild(scout, childToParent);
  assert.equal(acceptedToParent.accepted, true);
  assert.equal(acceptedToParent.delivery, 'queued');
  const parentMessages = pollParentInbox(broker);
  assert.deepEqual(parentMessages, [childToParent]);
  assert.deepEqual(pollParentInbox(broker), []);
  console.log('PASS child-to-parent envelopes are queued and consumed once');

  const parentToChild = createEnvelope(
    { sessionId: broker.sessionId, brokerId: broker.brokerId, senderId: broker.parentId },
    {
      kind: 'task',
      targetId: planner.agentId,
      taskId: 'shepherd-task-planner',
      deadlineAt: 123_456,
      delivery: 'followUp',
      content: 'Investigate the planner side of the question.',
    },
  );
  assert.equal(parentToChild.deadlineAt, 123_456);
  assert.equal(publishFromParent(broker, parentToChild).delivery, 'queued');
  assert.deepEqual(pollChildInbox(planner), [parentToChild]);
  assert.deepEqual(pollChildInbox(planner), []);
  console.log('PASS parent-to-child envelopes are routed to the target inbox');

  const peerMessage = createEnvelope(
    { sessionId: scout.sessionId, brokerId: scout.brokerId, senderId: scout.agentId },
    {
      kind: 'reply',
      targetId: planner.agentId,
      replyTo: childToParent.messageId,
      threadId: childToParent.threadId,
      delivery: 'followUp',
      content: 'Please check the session middleware.',
    },
  );
  assert.equal(publishFromChild(scout, peerMessage).delivery, 'queued');
  assert.deepEqual(pollChildInbox(planner), [peerMessage]);
  console.log('PASS child-to-child messages route through the parent broker');

  // The acknowledgement marker makes a repeated envelope safe even after the
  // original file has been moved out of the inbox.
  const duplicate = publishFromChild(scout, childToParent);
  assert.equal(duplicate.delivery, 'duplicate');
  assert.deepEqual(pollParentInbox(broker), []);
  console.log('PASS duplicate envelopes are acknowledged idempotently');

  const foreignSender = { ...childToParent, senderId: planner.agentId, messageId: 'foreign-sender' };
  expectMessagingError(
    () => publishFromChild(scout, foreignSender),
    'invalid_sender',
    'child cannot publish as another child'
  );
  expectMessagingError(
    () => publishFromParent(broker, { ...parentToChild, senderId: planner.agentId, messageId: 'foreign-parent' }),
    'invalid_sender',
    'parent broker rejects non-parent sender'
  );
  assert.throws(
    () => publishFromChild(scout, { ...childToParent, targetId: 'planner', messageId: 'display-name-target' }),
    error => {
      assert.ok(error instanceof MessagingError);
      assert.equal(error.code, 'invalid_target');
      assert.match(error.message, /exact opaque agent id returned by shepherd_spawn/);
      assert.match(error.message, /agent name such as "planner"/);
      return true;
    },
    'agent definition names are rejected with actionable target guidance',
  );
  expectMessagingError(
    () => publishFromChild(scout, { ...childToParent, targetId: 'unknown-agent', messageId: 'unknown-target' }),
    'invalid_target',
    'unknown child target is rejected'
  );
  expectMessagingError(
    () => publishFromParent(broker, { ...parentToChild, targetId: 'shepherd', messageId: 'parent-target' }),
    'invalid_target',
    'parent cannot publish into its own inbox'
  );
  expectMessagingError(
    () => publishFromChild(scout, { ...childToParent, sessionId: 'foreign-session', messageId: 'foreign-session-message' }),
    'foreign_session',
    'foreign session envelope is rejected'
  );
  expectMessagingError(
    () => createChildBroker({ ...scoutCapability, rootDir: broker.rootDir, token: 'wrong-token' }),
    'invalid_capability',
    'invalid child capability is rejected'
  );

  // A partial write uses the temporary suffix and must not be visible to the
  // poller as a deliverable envelope.
  const partialPath = path.join(broker.parentInboxPath, '.partial.json.tmp');
  fs.writeFileSync(partialPath, '{"schemaVersion":1');
  assert.deepEqual(pollParentInbox(broker), []);
  assert.equal(fs.existsSync(partialPath), true);
  fs.rmSync(partialPath);
  console.log('PASS partial temporary writes are ignored by polling');

  const malformedPath = path.join(broker.parentInboxPath, 'malformed.json');
  fs.writeFileSync(malformedPath, '{not-json');
  assert.deepEqual(pollParentInbox(broker), []);
  assert.equal(fs.existsSync(malformedPath), false);
  assert.ok(fs.readdirSync(path.join(broker.rootDir, 'rejected')).length > 0);
  console.log('PASS malformed envelopes are quarantined without crashing the poller');

  const boundedBroker = createParentBroker('bounded-session', {
    rootDir: path.join(root, 'bounded'),
    maxQueueDepth: 1,
  });
  const boundedChildCap = registerChild(boundedBroker, 'bounded-child');
  const boundedChild = createChildBroker({ rootDir: boundedBroker.rootDir, ...boundedChildCap });
  const boundedEnvelope = createEnvelope(
    { sessionId: boundedChild.sessionId, brokerId: boundedChild.brokerId, senderId: boundedChild.agentId },
    { kind: 'message', targetId: 'shepherd', delivery: 'followUp', content: 'one' },
  );
  publishFromChild(boundedChild, boundedEnvelope);
  expectMessagingError(
    () => publishFromChild(boundedChild, createEnvelope(
      { sessionId: boundedChild.sessionId, brokerId: boundedChild.brokerId, senderId: boundedChild.agentId },
      { kind: 'message', targetId: 'shepherd', delivery: 'followUp', content: 'two' },
    )),
    'queue_full',
    'queue depth limit rejects excess messages'
  );
  const largeBroker = createParentBroker('size-session', {
    rootDir: path.join(root, 'size'),
    maxMessageBytes: 100,
  });
  const largeCap = registerChild(largeBroker, 'size-child');
  const largeChild = createChildBroker({ rootDir: largeBroker.rootDir, ...largeCap });
  expectMessagingError(
    () => publishFromChild(largeChild, createEnvelope(
      { sessionId: largeChild.sessionId, brokerId: largeChild.brokerId, senderId: largeChild.agentId },
      { kind: 'message', targetId: 'shepherd', delivery: 'followUp', content: 'x'.repeat(500) },
    )),
    'message_too_large',
    'message size limit rejects oversized messages'
  );
  const contentBroker = createParentBroker('content-session', {
    rootDir: path.join(root, 'content'),
    maxMessageBytes: 10_000,
    maxContentLength: 10,
  });
  const contentCap = registerChild(contentBroker, 'content-child');
  const contentChild = createChildBroker({ rootDir: contentBroker.rootDir, ...contentCap });
  expectMessagingError(
    () => publishFromChild(contentChild, createEnvelope(
      { sessionId: contentChild.sessionId, brokerId: contentChild.brokerId, senderId: contentChild.agentId },
      { kind: 'message', targetId: 'shepherd', delivery: 'followUp', content: 'x'.repeat(11) },
    )),
    'message_too_large',
    'content length limit rejects oversized content'
  );

  assert.equal(closeBrokerWhenChildrenGone(broker, () => false), false);
  assert.equal(fs.existsSync(broker.rootDir), true);
  unregisterChild(broker, scout.agentId);
  unregisterChild(broker, planner.agentId);
  assert.equal(closeBrokerWhenChildrenGone(broker), true);
  assert.equal(fs.existsSync(broker.rootDir), false);
  console.log('PASS broker cleanup waits for confirmed child disappearance');

  assert.equal(closeBrokerWhenChildrenGone(boundedBroker, () => true), true);
  assert.equal(closeBrokerWhenChildrenGone(largeBroker, () => true), true);
  assert.equal(closeBrokerWhenChildrenGone(contentBroker, () => true), true);
});

console.log('All messaging assertions passed.');
