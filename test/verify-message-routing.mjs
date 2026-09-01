#!/usr/bin/env node
/**
 * Phase 6 verification: asynchronous message routing.
 *
 * Covers the canonical waiting scenario end-to-end at the service level:
 *   - parent-to-child messages (plain and expectsReply),
 *   - child questions that put the sender's task into `waiting`,
 *   - replies that resolve the request (task -> running) and are relayed
 *     back to the asker's inbox with preserved provenance,
 *   - mismatched and duplicate replies,
 *   - reply deadline expiry (task -> blocked),
 *   - delivery rejections and task-state invariants for plain messages.
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'path';
import {
  currentParentBroker,
  ensureParentBroker,
  processParentBrokerMessages,
  sendParentMessage,
  shutdownParentBroker,
} from '../src/core/lifecycle.ts';
import { createChildBroker, pollChildInbox, publishFromChild, registerChild, createEnvelope } from '../src/core/messaging.ts';
import { lifecycleRegistry, LifecycleError } from '../src/core/orchestration.ts';
import { withTempDirectory } from './helpers/test-utils.mjs';

function writeFakeHerdr(fakePath, stateFile) {
  const body = [
    '#!/usr/bin/env node',
    'const fs = require("node:fs");',
    `const state = JSON.parse(fs.readFileSync('${stateFile}', "utf8"));`,
    'const [cmd, sub, target] = process.argv.slice(2);',
    'if (cmd === "pane" && sub === "list") {',
    '  process.stdout.write(JSON.stringify({ result: { panes: (state.panes ?? []).map(id => ({ pane_id: id })) } }));',
    '} else if (cmd === "agent" && sub === "read") {',
    '  if ((state.errorPanes ?? []).includes(target)) {',
    '    process.stdout.write("Error: provider authentication failed\\n");',
    '  }',
    '}',
    'process.exit(0);',
    '',
  ].join('\n');
  fs.writeFileSync(fakePath, body);
  fs.chmodSync(fakePath, 0o755);
}

await withTempDirectory('pi-shepherd-message-routing-', async root => {
  const bin = path.join(root, 'bin');
  const stateFile = path.join(root, 'herdr-state.json');
  fs.mkdirSync(bin);
  writeFakeHerdr(path.join(bin, 'herdr'), stateFile);
  fs.writeFileSync(stateFile, JSON.stringify({ panes: ['pane-timeout'], errorPanes: [] }));

  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${oldPath ?? ''}`;

  const SESSION = 'message-routing-test-session';
  ensureParentBroker(SESSION);
  const broker = currentParentBroker();
  assert.ok(broker);

  // Participants: scout sends, planner is the (busy) recipient.
  const scout = lifecycleRegistry.registerAgent({ agent: 'scout', label: 'routing scout' });
  const planner = lifecycleRegistry.registerAgent({ agent: 'planner', label: 'routing planner' });
  for (const agent of [scout, planner]) {
    const capability = registerChild(broker, agent.id);
    lifecycleRegistry.attachAgentChildCapability(agent, capability);
  }
  const scoutChild = createChildBroker({ rootDir: broker.rootDir, ...lifecycleRegistry.agentChildCapability(scout) });
  const plannerChild = createChildBroker({ rootDir: broker.rootDir, ...lifecycleRegistry.agentChildCapability(planner) });

  const scoutTask = lifecycleRegistry.createTask(scout, 'Investigate the authentication flow.');
  lifecycleRegistry.setTaskRunning(scoutTask.id);

  // A separate busy-task on planner so the question targets a busy recipient.
  const plannerTask = lifecycleRegistry.createTask(planner, 'Design the session middleware.');
  lifecycleRegistry.setTaskRunning(plannerTask.id);

  try {
    // ── Message to an idle recipient (no active task) ────────────────────
    const idleAgent = lifecycleRegistry.registerAgent({ agent: 'reviewer', label: 'idle recipient' });
    const idleCapability = registerChild(broker, idleAgent.id);
    lifecycleRegistry.attachAgentChildCapability(idleAgent, idleCapability);
    const idleChild = createChildBroker({ rootDir: broker.rootDir, ...idleCapability });
    const idleMessage = sendParentMessage({ target: idleAgent.id, message: 'Are you free to review?' });
    assert.equal(idleMessage.accepted, true);
    assert.equal('requestId' in idleMessage, false, 'no reply tracking without expectsReply');
    const idleInbox = pollChildInbox(idleChild);
    assert.equal(idleInbox.length, 1);
    assert.equal(idleInbox[0].content, 'Are you free to review?');
    assert.equal(lifecycleRegistry.activeTaskForAgent(idleAgent), undefined, 'a message never creates a task');
    console.log('PASS a message to an idle recipient is queued without creating task state');

    assert.throws(
      () => sendParentMessage({ target: 'planner', message: 'This must not resolve by agent name.' }),
      error => {
        assert.ok(error instanceof LifecycleError);
        assert.equal(error.code, 'invalid_target');
        assert.match(error.message, /exact opaque agent id returned by shepherd_spawn/);
        assert.match(error.message, /agent name such as "planner"/);
        return true;
      },
      'parent shepherd_message rejects agent definition names with actionable target guidance',
    );
    console.log('PASS parent shepherd_message rejects agent names instead of resolving them');

    // ── Parent reply settles a child-originated request locally ────────────
    const parentReplyTask = lifecycleRegistry.createTask(idleAgent, 'Complete the parent reply handshake.');
    lifecycleRegistry.setTaskRunning(parentReplyTask.id);
    const childQuestion = createEnvelope(
      { sessionId: idleChild.sessionId, brokerId: idleChild.brokerId, senderId: idleChild.agentId },
      {
        kind: 'message',
        targetId: 'shepherd',
        taskId: parentReplyTask.id,
        expectsReply: true,
        delivery: 'followUp',
        content: 'CHILD_REQUEST: please answer directly.',
      },
    );
    assert.equal(publishFromChild(idleChild, childQuestion).accepted, true);
    const childRequestMirror = createEnvelope(
      { sessionId: idleChild.sessionId, brokerId: idleChild.brokerId, senderId: idleChild.agentId },
      {
        kind: 'runtime',
        targetId: 'shepherd',
        taskId: parentReplyTask.id,
        replyTo: childQuestion.messageId,
        requestOpen: true,
        requestTargetId: broker.parentId,
        summary: childQuestion.content,
        delivery: 'followUp',
      },
    );
    assert.equal(publishFromChild(idleChild, childRequestMirror).accepted, true);
    await processParentBrokerMessages();
    assert.equal(lifecycleRegistry.getTask(parentReplyTask.id).state, 'waiting');
    const directAnswer = sendParentMessage({
      target: idleAgent.id,
      taskId: parentReplyTask.id,
      replyTo: childQuestion.messageId,
      message: 'PARENT_DIRECT_REPLY: request answered.',
    });
    assert.equal(directAnswer.accepted, true);
    assert.equal(directAnswer.targetTaskState, 'running');
    assert.equal(lifecycleRegistry.getTask(parentReplyTask.id).state, 'running');
    const directAnswerEnvelope = pollChildInbox(idleChild).find(
      message => message.replyTo === childQuestion.messageId,
    );
    assert.ok(directAnswerEnvelope, 'the direct parent reply reaches the child');
    const directCompletion = lifecycleRegistry.settleTask(parentReplyTask.id, {
      status: 'completed',
      text: 'Completed after the direct parent reply.',
    });
    assert.equal(directCompletion.status, 'completed');
    console.log('PASS parent reply resolves a child-originated request without a redundant child acknowledgment');

    // ── Parent -> child: plain message leaves task state unchanged ────────
    const plain = sendParentMessage({ target: scout.id, message: 'Any progress so far?', taskId: scoutTask.id });
    assert.match(plain.messageId, /^shepherd-message-/);
    assert.equal(plain.accepted, true);
    assert.equal(lifecycleRegistry.getTask(scoutTask.id).state, 'running');
    const scoutInbox = pollChildInbox(scoutChild);
    assert.equal(scoutInbox.length, 1);
    assert.equal(scoutInbox[0].content, 'Any progress so far?');
    assert.equal(scoutInbox[0].senderId, broker.parentId);
    assert.equal(scoutInbox[0].delivery, 'followUp');
    console.log('PASS parent-to-child message is queued without altering task state');

    // ── Parent -> child: expectsReply puts the task into waiting ──────────
    const question = sendParentMessage({
      target: scout.id,
      message: 'Confirm the middleware location.',
      taskId: scoutTask.id,
      expectsReply: true,
    });
    assert.equal(question.targetTaskState, 'waiting');
    assert.equal(question.requestId, question.messageId);
    const waitingTask = lifecycleRegistry.getTask(scoutTask.id);
    assert.equal(waitingTask.state, 'waiting');
    assert.equal(waitingTask.pendingReplyMessageId, question.messageId);
    assert.ok(waitingTask.pendingReplyDeadlineAt > Date.now());
    console.log('PASS parent expectsReply message creates a tracked request and sets the task waiting');

    // The child answers the parent question through the parent mailbox.
    const parentReply = createEnvelope(
      { sessionId: scoutChild.sessionId, brokerId: scoutChild.brokerId, senderId: scoutChild.agentId },
      {
        kind: 'reply',
        targetId: 'shepherd',
        taskId: scoutTask.id,
        replyTo: question.messageId,
        delivery: 'followUp',
        content: 'The middleware is in src/auth/session.ts.',
      },
    );
    assert.equal(publishFromChild(scoutChild, parentReply).accepted, true);
    await processParentBrokerMessages();
    assert.equal(lifecycleRegistry.getTask(scoutTask.id).state, 'running');
    const selfRelays = pollChildInbox(scoutChild).filter(m => m.kind === 'reply' && m.replyTo === question.messageId);
    assert.equal(selfRelays.length, 0, 'the owner answering its own tracked request is not echoed back to its own inbox');
    console.log('PASS a matching reply clears the request and returns the task to running');

    // ── Canonical scenario: worker asks a busy planner ────────────────────
    const busyQuestion = createEnvelope(
      { sessionId: scoutChild.sessionId, brokerId: scoutChild.brokerId, senderId: scoutChild.agentId },
      {
        kind: 'message',
        targetId: planner.id,
        taskId: scoutTask.id,
        threadId: 'thread-auth-flow',
        expectsReply: true,
        delivery: 'followUp',
        content: 'What have you found about the authentication flow?',
      },
    );
    // The question goes directly to the busy planner inbox...
    assert.equal(publishFromChild(scoutChild, busyQuestion).delivery, 'queued');
    // ...and the child mirrors the tracked request to the parent mailbox.
    const mirror = createEnvelope(
      { sessionId: scoutChild.sessionId, brokerId: scoutChild.brokerId, senderId: scoutChild.agentId },
      {
        kind: 'runtime',
        targetId: 'shepherd',
        taskId: scoutTask.id,
        threadId: 'thread-auth-flow',
        replyTo: busyQuestion.messageId,
        requestOpen: true,
        requestTargetId: planner.id,
        summary: 'What have you found about the authentication flow?',
        delivery: 'followUp',
      },
    );
    assert.equal(publishFromChild(scoutChild, mirror).accepted, true);
    await processParentBrokerMessages();

    assert.equal(lifecycleRegistry.getTask(scoutTask.id).state, 'waiting');
    assert.equal(lifecycleRegistry.getTask(scoutTask.id).pendingReplyMessageId, busyQuestion.messageId);
    const queuedForPlanner = pollChildInbox(plannerChild).find(m => m.messageId === busyQuestion.messageId);
    assert.ok(queuedForPlanner, 'the question is delivered to the busy planner inbox as a follow-up');
    assert.equal(queuedForPlanner.expectsReply, true);
    assert.equal(lifecycleRegistry.getTask(plannerTask.id).state, 'running', 'planner busy-task is untouched by the incoming question');
    console.log('PASS worker asking a busy planner queues a follow-up and keeps the worker task waiting');

    // ── Invalid reply: mismatched replyTo leaves the request pending ──────
    const mismatchedReply = createEnvelope(
      { sessionId: plannerChild.sessionId, brokerId: plannerChild.brokerId, senderId: plannerChild.agentId },
      {
        kind: 'reply',
        targetId: 'shepherd',
        taskId: scoutTask.id,
        replyTo: 'shepherd-message-not-the-question',
        delivery: 'followUp',
        content: 'Stray answer.',
      },
    );
    assert.equal(publishFromChild(plannerChild, mismatchedReply).accepted, true);
    await processParentBrokerMessages();
    assert.equal(lifecycleRegistry.getTask(scoutTask.id).state, 'waiting');
    assert.equal(lifecycleRegistry.getTask(scoutTask.id).pendingReplyMessageId, busyQuestion.messageId);
    console.log('PASS a mismatched reply is rejected and the task stays waiting');

    // ── Valid reply: planner answers; scout resumes; relay preserves provenance ──
    const peerReply = createEnvelope(
      { sessionId: plannerChild.sessionId, brokerId: plannerChild.brokerId, senderId: plannerChild.agentId },
      {
        kind: 'reply',
        targetId: 'shepherd',
        taskId: scoutTask.id,
        threadId: 'thread-auth-flow',
        replyTo: busyQuestion.messageId,
        delivery: 'followUp',
        content: 'Sessions are validated by middleware in src/auth/session.ts.',
      },
    );
    assert.equal(publishFromChild(plannerChild, peerReply).accepted, true);
    await processParentBrokerMessages();
    assert.equal(lifecycleRegistry.getTask(scoutTask.id).state, 'running');
    const peerRelay = pollChildInbox(scoutChild).find(m => m.kind === 'reply' && m.replyTo === busyQuestion.messageId);
    assert.ok(peerRelay, 'the answer is relayed to the worker inbox');
    assert.equal(peerRelay.originSenderId, plannerChild.agentId, 'provenance: origin sender stays the planner');
    assert.equal(peerRelay.content, 'Sessions are validated by middleware in src/auth/session.ts.');
    assert.notEqual(peerRelay.messageId, peerReply.messageId, 'relay uses a fresh message id');
    console.log('PASS planner reply resolves the request, the worker resumes, and the relay preserves sender provenance');

    // A peer may answer directly to the requester's inbox. The child-side
    // reply mirror still lets the parent clear the tracked waiting task, while
    // avoiding a second parent-generated relay.
    const directQuestion = createEnvelope(
      { sessionId: scoutChild.sessionId, brokerId: scoutChild.brokerId, senderId: scoutChild.agentId },
      {
        kind: 'message',
        targetId: planner.id,
        taskId: scoutTask.id,
        expectsReply: true,
        delivery: 'followUp',
        content: 'Can you answer directly?',
      },
    );
    assert.equal(publishFromChild(scoutChild, directQuestion).delivery, 'queued');
    const directRequestMirror = createEnvelope(
      { sessionId: scoutChild.sessionId, brokerId: scoutChild.brokerId, senderId: scoutChild.agentId },
      {
        kind: 'runtime',
        targetId: 'shepherd',
        taskId: scoutTask.id,
        replyTo: directQuestion.messageId,
        requestOpen: true,
        requestTargetId: planner.id,
        summary: directQuestion.content,
        delivery: 'followUp',
      },
    );
    assert.equal(publishFromChild(scoutChild, directRequestMirror).accepted, true);
    await processParentBrokerMessages();
    assert.equal(lifecycleRegistry.getTask(scoutTask.id).state, 'waiting');
    const directPeerReply = createEnvelope(
      { sessionId: plannerChild.sessionId, brokerId: plannerChild.brokerId, senderId: plannerChild.agentId },
      {
        kind: 'reply',
        targetId: scout.id,
        taskId: scoutTask.id,
        replyTo: directQuestion.messageId,
        delivery: 'followUp',
        content: 'Direct pong.',
      },
    );
    assert.equal(publishFromChild(plannerChild, directPeerReply).delivery, 'queued');
    const directReplyMirror = createEnvelope(
      { sessionId: plannerChild.sessionId, brokerId: plannerChild.brokerId, senderId: plannerChild.agentId },
      {
        kind: 'runtime',
        targetId: 'shepherd',
        taskId: scoutTask.id,
        replyTo: directQuestion.messageId,
        replyReceived: true,
        summary: directPeerReply.content,
        delivery: 'followUp',
      },
    );
    assert.equal(publishFromChild(plannerChild, directReplyMirror).accepted, true);
    await processParentBrokerMessages();
    assert.equal(lifecycleRegistry.getTask(scoutTask.id).state, 'running');
    assert.deepEqual(pollChildInbox(scoutChild), [directPeerReply]);
    console.log('PASS direct peer reply mirrors resolve the waiting task without duplicate delivery');

    // ── Duplicate reply: idempotent, no second relay, no state change ─────
    const duplicateReply = createEnvelope(
      { sessionId: plannerChild.sessionId, brokerId: plannerChild.brokerId, senderId: plannerChild.agentId },
      {
        kind: 'reply',
        targetId: 'shepherd',
        taskId: scoutTask.id,
        threadId: 'thread-auth-flow',
        replyTo: busyQuestion.messageId,
        delivery: 'followUp',
        content: 'Sessions are validated by middleware in src/auth/session.ts.',
      },
    );
    assert.equal(publishFromChild(plannerChild, duplicateReply).accepted, true);
    await processParentBrokerMessages();
    assert.equal(lifecycleRegistry.getTask(scoutTask.id).state, 'running');
    const relaysForQuestion = pollChildInbox(scoutChild).filter(m => m.kind === 'reply' && m.replyTo === busyQuestion.messageId);
    assert.equal(relaysForQuestion.length, 0, 'a reply for an already-resolved request is not relayed again');
    console.log('PASS a duplicate reply is idempotent and does not re-deliver');

    // ── Reply deadline expiry settles the task as blocked ─────────────────
    const timeoutAgent = lifecycleRegistry.registerAgent({ agent: 'worker', label: 'timeout target', paneId: 'pane-timeout' });
    const timeoutTask = lifecycleRegistry.createTask(timeoutAgent, 'Task that waits for a dead reply.');
    lifecycleRegistry.setTaskRunning(timeoutTask.id);
    lifecycleRegistry.openPendingRequest(timeoutTask.id, {
      messageId: 'shepherd-message-timeout-question',
      targetAgentId: planner.id,
      deadlineAt: Date.now() - 1_000,
      text: 'Question that will never be answered.',
    });
    assert.equal(lifecycleRegistry.getTask(timeoutTask.id).state, 'waiting');
    let blocked = false;
    for (let i = 0; i < 8 && !blocked; i++) {
      await processParentBrokerMessages();
      blocked = lifecycleRegistry.getTask(timeoutTask.id).state === 'blocked';
      if (!blocked) await new Promise(resolve => setTimeout(resolve, 300));
    }
    const timeoutResult = lifecycleRegistry.taskResult(timeoutTask.id);
    assert.equal(timeoutResult?.status, 'blocked');
    assert.equal(timeoutResult?.returnCode, 2);
    assert.match(timeoutResult?.error ?? '', /reply deadline/i);
    console.log('PASS a reply deadline expiry settles the waiting task as blocked');

    // ── Rejections: closed target, unknown target, mismatched task owner ──
    const closedAgent = lifecycleRegistry.registerAgent({ agent: 'planner', label: 'closed message target' });
    lifecycleRegistry.close(closedAgent);
    assert.throws(
      () => sendParentMessage({ target: closedAgent.id, message: 'Hello.' }),
      error => error instanceof LifecycleError && error.code === 'closed_handle',
    );
    console.log('PASS messaging a closed agent is rejected');

    assert.throws(
      () => sendParentMessage({ target: 'not-an-agent', message: 'Hello.' }),
      error => error instanceof LifecycleError && error.code === 'invalid_target',
    );
    console.log('PASS messaging an unknown target id is rejected as an invalid message target');

    const foreignTask = lifecycleRegistry.createTask(timeoutAgent, 'Task for the other worker.');
    lifecycleRegistry.setTaskRunning(foreignTask.id);
    assert.throws(
      () => sendParentMessage({ target: scout.id, message: 'Wrong owner.', taskId: foreignTask.id, expectsReply: true }),
      error => error instanceof LifecycleError && error.code === 'task_agent_mismatch',
    );
    assert.equal(lifecycleRegistry.getTask(foreignTask.id).state, 'running');
    console.log('PASS expectsReply against a task owned by another agent is rejected');
  } finally {
    process.env.PATH = oldPath;
    for (const agent of lifecycleRegistry.allAgents()) {
      const active = lifecycleRegistry.activeTaskForAgent(agent);
      if (active) {
        try { lifecycleRegistry.settleTask(active.taskId, { status: 'cancelled', error: 'test cleanup' }); } catch {}
      }
    }
    shutdownParentBroker(() => true);
  }
});

console.log('All message routing assertions passed.');
