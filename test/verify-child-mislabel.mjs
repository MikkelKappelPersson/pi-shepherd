#!/usr/bin/env node
/**
 * Phase 3 verification for the child side of the task-mislabel fix (issue
 * #13). Spawn-then-delegate children are launched without a task id, so
 * shepherd_done must validate the LLM's echoed id against the most recently
 * delegated task and correct a fabricated one instead of publishing it.
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
];
const savedEnv = Object.fromEntries(envNames.map(name => [name, process.env[name]]));

try {
  await withTempDirectory('pi-shepherd-child-mislabel-', async root => {
    const broker = createParentBroker('child-mislabel-session', { rootDir: `${root}/broker` });
    const capability = registerChild(broker, 'shepherd-agent-mislabel-child');
    const child = createChildBroker({ rootDir: broker.rootDir, ...capability });
    // Spawn-then-delegate: the launch carries no task id of its own.
    process.env.PI_SHEPHERD_BROKER_DIR = broker.rootDir;
    process.env.PI_SHEPHERD_BROKER_SESSION_ID = capability.sessionId;
    process.env.PI_SHEPHERD_BROKER_ID = capability.brokerId;
    process.env.PI_SHEPHERD_AGENT_ID = capability.agentId;
    process.env.PI_SHEPHERD_BROKER_TOKEN = capability.token;
    process.env.PI_SHEPHERD_AGENT_INBOX = capability.inboxPath;
    delete process.env.PI_SHEPHERD_TASK_ID;

    const registered = [];
    const handlers = new Map();
    const pi = {
      registerTool(tool) {
        registered.push(tool);
      },
      on(event, handler) {
        handlers.set(event, handler);
      },
      sendUserMessage() {},
    };
    const { default: registerChildExtension } = await import(
      '../src/extension/shepherd-done.ts'
    );
    registerChildExtension(pi);
    const doneTool = registered.find(tool => tool.name === 'shepherd_done');
    assert.ok(doneTool, 'shepherd_done is registered');

    // 1. shepherd_done before any task arrives is rejected, not fabricated.
    const rejected = await doneTool.execute('pre-task', {
      taskId: 'T1234-1',
      status: 'completed',
      summary: 'Too early.',
    });
    assert.equal(rejected.details.returnCode, 1);
    assert.equal(rejected.details.code, 'no_delegated_task');
    assert.deepEqual(pollParentInbox(broker), []);
    console.log('PASS child shepherd_done before any delegated task is rejected');

    // 2. The delegated task id arrives with the kind: 'task' envelope.
    const delegated = createEnvelope(
      { sessionId: broker.sessionId, brokerId: broker.brokerId, senderId: broker.parentId },
      {
        kind: 'task',
        targetId: capability.agentId,
        taskId: 'shepherd-task-mislabel-7ff36112',
        delivery: 'followUp',
        content: 'Implement the M2 engine wiring.',
      }
    );
    publishFromParent(broker, delegated);
    handlers.get('session_start')();

    // 3. A fabricated echoed id is corrected to the delegated task id.
    const corrected = await doneTool.execute('mislabel', {
      taskId: 'T2854-9715',
      status: 'completed',
      summary: 'M2 engine wiring complete.',
    });
    assert.equal(corrected.details.returnCode, 0);
    assert.equal(corrected.details.taskId, 'shepherd-task-mislabel-7ff36112');
    assert.match(corrected.details.idMismatch, /T2854-9715/);
    const published = pollParentInbox(broker).find(envelope => envelope.kind === 'task_done');
    assert.ok(published, 'the completion is published');
    assert.equal(published.taskId, 'shepherd-task-mislabel-7ff36112');
    assert.equal(published.status, 'completed');
    assert.equal(published.summary, 'M2 engine wiring complete.');
    console.log('PASS child shepherd_done corrects a fabricated task id to the delegated task');

    // 4. A matching id is published unchanged, with no correction note.
    const clean = await doneTool.execute('clean', {
      taskId: 'shepherd-task-mislabel-7ff36112',
      status: 'completed',
      summary: 'Again.',
    });
    assert.equal(clean.details.returnCode, 0);
    assert.equal(clean.details.idMismatch, undefined);
    const second = pollParentInbox(broker).find(envelope => envelope.kind === 'task_done');
    assert.equal(second.taskId, 'shepherd-task-mislabel-7ff36112');
    console.log('PASS child shepherd_done with the delegated task id is published unchanged');

    // 5. Omitting the id completes the current delegated task (the default
    //    flow: the id is inferred from the child context, not pasted).
    const omitted = await doneTool.execute('omit', {
      status: 'completed',
      summary: 'Omitted the id entirely.',
    });
    assert.equal(omitted.details.returnCode, 0);
    assert.equal(omitted.details.taskId, 'shepherd-task-mislabel-7ff36112');
    assert.equal(omitted.details.idMismatch, undefined);
    const third = pollParentInbox(broker).find(envelope => envelope.kind === 'task_done');
    assert.equal(third.taskId, 'shepherd-task-mislabel-7ff36112');
    console.log('PASS child shepherd_done without a task id completes the current delegated task');
  });
} finally {
  for (const name of envNames) {
    if (savedEnv[name] === undefined) delete process.env[name];
    else process.env[name] = savedEnv[name];
  }
}

console.log('All child mislabel assertions passed.');
