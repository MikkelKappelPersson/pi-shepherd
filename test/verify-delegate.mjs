#!/usr/bin/env node
/** Phase 4 verification for the tracked delegation adapter contract. */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { registerShepherdTools } from '../src/extension/shepherd.ts';
import {
  currentParentBroker,
  delegateAgent,
  ensureParentBroker,
  shutdownParentBroker,
} from '../src/core/lifecycle.ts';
import { createChildBroker, pollChildInbox } from '../src/core/messaging.ts';
import { createOrResumeSession } from '../src/core/artifact-sessions.ts';
import { LifecycleError, lifecycleRegistry } from '../src/core/orchestration.ts';
import { withTempDirectory } from './helpers/test-utils.mjs';

const registered = [];
registerShepherdTools({
  registerTool(tool) { registered.push(tool); },
  registerMessageRenderer() {},
});
const delegateTool = registered.find(tool => tool.name === 'shepherd_delegate');
assert.ok(delegateTool, 'parent registers shepherd_delegate');
assert.equal(delegateTool.parameters.type, 'object');
assert.deepEqual(delegateTool.parameters.required, ['target', 'task']);
assert.deepEqual(Object.keys(delegateTool.parameters.properties).sort(), ['target', 'task', 'timeout']);
assert.match(delegateTool.description, /task id/i);
assert.match(delegateTool.description, /idle child/i);
console.log('PASS parent delegation tool exposes the tracked task contract');

await withTempDirectory('pi-shepherd-delegate-', async root => {
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  const fakeHerdr = path.join(bin, 'herdr');
  fs.writeFileSync(fakeHerdr, `#!/bin/sh
if [ "$1" = "agent" ] && [ "$2" = "get" ]; then
  printf '%s\\n' '{"result":{"agent":{"pane_id":"pane-delegate-test","agent_status":"idle"}}}'
  exit 0
fi
if [ "$1" = "--version" ]; then printf '%s\\n' 'herdr test'; exit 0; fi
exit 1
`);
  fs.chmodSync(fakeHerdr, 0o700);
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${oldPath ?? ''}`;
  let task;
  let agent;
  try {
    agent = lifecycleRegistry.registerAgent({ agent: 'scout', label: 'delegate test', paneId: 'pane-delegate-test' });
    const artifactSession = createOrResumeSession({
      projectRoot: root,
      sessionName: 'delegated-task',
      mode: 'single',
    });
    const started = Date.now();
    task = await delegateAgent(agent, 'Investigate the authentication flow.', {
      sessionId: 'delegate-test-session',
      artifactSession,
    });
    assert.ok(Date.now() - started < 1_000, 'delegation returns without waiting for task completion');
    assert.match(task.id, /^shepherd-task-/);
    assert.equal(lifecycleRegistry.getTask(task.id).state, 'running');
    const broker = currentParentBroker();
    assert.ok(broker);
    const capability = lifecycleRegistry.agentChildCapability(agent);
    assert.ok(capability);
    const child = createChildBroker({ rootDir: broker.rootDir, ...capability });
    const taskEnvelope = pollChildInbox(child)[0];
    assert.equal(taskEnvelope.kind, 'task');
    assert.equal(taskEnvelope.taskId, task.id);
    assert.equal(taskEnvelope.targetId, agent.id);
    assert.equal(taskEnvelope.content, 'Investigate the authentication flow.');
    const taskArtifact = lifecycleRegistry.taskArtifact(task).artifact;
    assert.ok(taskArtifact);
    assert.equal(taskArtifact.task, 'Investigate the authentication flow.');
    assert.equal(taskArtifact.status, 'running');
    console.log('PASS delegation creates a running task and queues a task envelope without waiting');
    console.log('PASS delegation associates and starts one task artifact');
    await assert.rejects(
      () => delegateAgent(agent, 'A second active task.', { sessionId: 'delegate-test-session' }),
      error => error?.code === 'active_task' || /active tracked task/.test(error?.message ?? ''),
    );
    console.log('PASS delegation rejects a second active task for the same agent');

    lifecycleRegistry.settleTask(task.id, { status: 'cancelled', error: 'test cleanup' });
    assert.equal(lifecycleRegistry.getTask(task.id).state, 'cancelled');
    assert.equal(lifecycleRegistry.taskArtifact(task).artifact.status, 'cancelled');

    const failedAgent = lifecycleRegistry.registerAgent({ agent: 'worker', label: 'publish failure', paneId: 'pane-delegate-test' });
    await assert.rejects(
      () => delegateAgent(failedAgent, 'x'.repeat(70_000), { sessionId: 'delegate-test-session' }),
      /Task submission failed/,
    );
    const failedTask = lifecycleRegistry.allTasks().find(record => record.agentId === failedAgent.id);
    assert.equal(failedTask.state, 'failed');
    assert.equal(lifecycleRegistry.activeTaskForAgent(failedAgent), undefined);
    console.log('PASS failed task publication rolls back the active task slot');

    const closedAgent = lifecycleRegistry.registerAgent({ agent: 'planner', label: 'closed target', paneId: 'pane-delegate-test' });
    lifecycleRegistry.close(closedAgent);
    await assert.rejects(
      () => delegateAgent(closedAgent, 'This must not be submitted.', { sessionId: 'delegate-test-session' }),
      error => error instanceof LifecycleError && error.code === 'closed_handle',
    );
    console.log('PASS delegation rejects a closed target agent');

    assert.equal(shutdownParentBroker(() => true), true);
  } finally {
    process.env.PATH = oldPath;
    if (task && lifecycleRegistry.taskResult(task.id) === undefined) {
      lifecycleRegistry.settleTask(task.id, { status: 'cancelled', error: 'test cleanup' });
    }
    if (currentParentBroker()) shutdownParentBroker(() => true);
  }
});

await assert.rejects(
  () => delegateAgent('not-an-agent', 'Investigate this.'),
  error => error instanceof LifecycleError && error.code === 'unknown_handle',
);
console.log('PASS delegation rejects unknown opaque agent ids before submission');

await assert.rejects(
  () => delegateAgent('not-an-agent', ''),
  /must not be empty/,
);
console.log('PASS delegation rejects empty task descriptions before submission');

console.log('All delegation assertions passed.');
