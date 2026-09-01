#!/usr/bin/env node
/**
 * Phase 5 failure-path verification: provider errors, unexpected pane exit,
 * close-to-cancellation, and deadline timeout.
 *
 * The parent runtime monitor (processParentBrokerMessages) observes external
 * terminal failures through the Herdr CLI: `pane list` for pane survival and
 * `agent read` for provider-error text. A fake `herdr` executable on PATH
 * (a small Node script backed by a JSON state file) keeps those observations
 * deterministic.
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'path';
import {
  closeAgent,
  ensureParentBroker,
  processParentBrokerMessages,
  shutdownParentBroker,
} from '../src/core/lifecycle.ts';
import { recordCreatedPane } from '../src/core/herdr.ts';
import { lifecycleRegistry } from '../src/core/orchestration.ts';
import { withTempDirectory } from './helpers/test-utils.mjs';

function writeState(stateFile, { panes, errorPanes = [] }) {
  fs.writeFileSync(stateFile, JSON.stringify({ panes, errorPanes }));
}

await withTempDirectory('pi-shepherd-task-failures-', async root => {
  const bin = path.join(root, 'bin');
  const agentDir = path.join(root, 'agent-dir');
  const stateFile = path.join(root, 'herdr-state.json');
  fs.mkdirSync(bin);
  const fakePath = path.join(bin, 'herdr');
  // Inline the state file path into the generated script.
  const stateBody = [
    '#!/usr/bin/env node',
    'const fs = require("node:fs");',
    `const state = JSON.parse(fs.readFileSync('${stateFile}', "utf8"));`,
    'const [cmd, sub, target] = process.argv.slice(2);',
    'if (cmd === "pane" && sub === "list") {',
    '  process.stdout.write(JSON.stringify({ result: { panes: (state.panes ?? []).map(id => ({ pane_id: id })) } }));',
    '} else if (cmd === "pane" && sub === "close") {',
    '  state.panes = (state.panes ?? []).filter(id => id !== target);',
    `  fs.writeFileSync(${JSON.stringify(stateFile)}, JSON.stringify(state));`,
    '} else if (cmd === "agent" && sub === "read") {',
    '  if ((state.errorPanes ?? []).includes(target)) {',
    '    process.stdout.write("Error: provider authentication failed\\n");',
    '  }',
    '}',
    'process.exit(0);',
    '',
  ].join('\n');
  fs.writeFileSync(fakePath, stateBody);
  fs.chmodSync(fakePath, 0o755);
  writeState(stateFile, { panes: ['pane-provider', 'pane-exited', 'pane-healthy'], errorPanes: [] });

  const oldPath = process.env.PATH;
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PATH = `${bin}${path.delimiter}${oldPath ?? ''}`;
  process.env.PI_CODING_AGENT_DIR = agentDir;

  try {
    const broker = ensureParentBroker('task-failure-test-session');
    assert.ok(broker);

    // ── Provider failure + unexpected pane exit ────────────────────────────
    const providerAgent = lifecycleRegistry.registerAgent({ agent: 'worker', label: 'provider failure', paneId: 'pane-provider' });
    const exitedAgent = lifecycleRegistry.registerAgent({ agent: 'scout', label: 'exited pane', paneId: 'pane-exited' });
    const healthyAgent = lifecycleRegistry.registerAgent({ agent: 'planner', label: 'healthy pane', paneId: 'pane-healthy' });
    const providerTask = lifecycleRegistry.createTask(providerAgent, 'Task that meets a provider error.');
    const exitedTask = lifecycleRegistry.createTask(exitedAgent, 'Task whose pane exits.');
    const healthyTask = lifecycleRegistry.createTask(healthyAgent, 'Task on a healthy pane.');
    for (const id of [providerTask.id, exitedTask.id, healthyTask.id]) {
      lifecycleRegistry.setTaskRunning(id);
    }

    assert.deepEqual(await processParentBrokerMessages(), []);
    assert.equal(lifecycleRegistry.getTask(providerTask.id).state, 'running');
    assert.equal(lifecycleRegistry.getTask(exitedTask.id).state, 'running');
    assert.equal(lifecycleRegistry.getTask(healthyTask.id).state, 'running');
    console.log('PASS live panes with clean output do not fail tracked tasks');

    // Simulate the provider dying and a second pane exiting mid-task.
    // The 250ms monitor (or the explicit drain below, whichever wins)
    // performs the runtime observation; task registry state is the
    // authoritative assertion either way.
    writeState(stateFile, { panes: ['pane-provider', 'pane-healthy'], errorPanes: ['pane-provider'] });
    let sawFailure = false;
    for (let i = 0; i < 8 && !sawFailure; i++) {
      await processParentBrokerMessages();
      sawFailure = [
        lifecycleRegistry.taskResult(providerTask.id),
        lifecycleRegistry.taskResult(exitedTask.id),
      ].every(r => r?.status === 'failed');
      if (!sawFailure) await new Promise(resolve => setTimeout(resolve, 250));
    }
    assert.ok(sawFailure, 'provider failure and pane exit settled both tasks');

    const providerResult = lifecycleRegistry.taskResult(providerTask.id);
    assert.equal(providerResult?.status, 'failed');
    assert.equal(providerResult?.returnCode, 1);
    assert.match(providerResult?.error ?? '', /provider authentication failed/);
    console.log('PASS provider error in pane output settles the task as failed');

    const exitedResult = lifecycleRegistry.taskResult(exitedTask.id);
    assert.equal(exitedResult?.status, 'failed');
    assert.match(exitedResult?.error ?? '', /pane disappeared/);
    console.log('PASS unexpected agent pane exit settles the task as failed');

    assert.equal(lifecycleRegistry.getTask(healthyTask.id).state, 'running');
    assert.deepEqual(await processParentBrokerMessages(), []);
    console.log('PASS a healthy pane task stays running and failure observation stays idempotent');
    lifecycleRegistry.settleTask(healthyTask.id, { status: 'cancelled', error: 'test cleanup' });

    // ── Close maps to task cancellation ────────────────────────────────────
    writeState(stateFile, { panes: ['pane-provider', 'pane-healthy', 'pane-closed'], errorPanes: [] });

    const closedAgent = lifecycleRegistry.registerAgent({ agent: 'planner', label: 'close target', paneId: 'pane-closed' });
    recordCreatedPane({
      paneId: 'pane-closed', tabId: 'tab-closed', name: 'close-target', cwd: root,
      createdAt: Date.now(), ownerSession: 'task-failure-test-session',
    });
    const closedTask = lifecycleRegistry.createTask(closedAgent, 'Task that gets closed mid-flight.');

    closeAgent(closedAgent);

    const cancelledResult = lifecycleRegistry.taskResult(closedTask.id);
    assert.equal(cancelledResult?.status, 'cancelled');
    assert.equal(cancelledResult?.returnCode, 130);
    assert.match(cancelledResult?.error ?? '', /closed/i);
    assert.equal(lifecycleRegistry.getAgent(closedAgent).state, 'closed');
    assert.equal(lifecycleRegistry.activeTaskForAgent(closedAgent), undefined);
    console.log('PASS closing an agent cancels its active tracked task');

    // ── Deadline expiry maps to task timeout ───────────────────────────────
    const timeoutAgent = lifecycleRegistry.registerAgent({ agent: 'worker', label: 'deadline target', paneId: 'pane-healthy' });
    const deadlineTask = lifecycleRegistry.createTask(timeoutAgent, 'Task that must time out.', { timeoutMs: 300 });
    assert.equal(lifecycleRegistry.getTask(deadlineTask.id).state, 'created');
    assert.ok(lifecycleRegistry.getTask(deadlineTask.id).deadlineAt !== undefined);

    await new Promise(resolve => setTimeout(resolve, 600));
    const timedOutResult = lifecycleRegistry.taskResult(deadlineTask.id);
    assert.equal(timedOutResult?.status, 'timed_out');
    assert.equal(timedOutResult?.returnCode, 124);
    assert.match(timedOutResult?.error ?? '', /deadline/i);
    console.log('PASS deadline expiry settles the task as timed_out through the real timer');

    assert.strictEqual(shutdownParentBroker(() => true), true);
  } finally {
    process.env.PATH = oldPath;
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
  }
});

console.log('All task failure assertions passed.');
