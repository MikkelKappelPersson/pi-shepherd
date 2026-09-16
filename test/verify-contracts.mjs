#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  assertDepthAvailable,
  findOwnershipConflicts,
  interpolatePrevious,
  mapWithConcurrencyLimit,
  MAX_CONCURRENCY,
  MAX_PARALLEL_TASKS,
  ownedPaths,
  truncateResult,
} from '../src/compat/contracts.ts';
import { checkoutOf, createWorktreeLeases, releaseWorktreeLeases } from '../src/compat/worktree.ts';
import {
  lastAssistantText,
  readSessionTelemetry,
  sessionTelemetryCursor,
  sessionTelemetrySince,
  shepherdSessionFromArgs,
  writePiLaunchFiles,
} from '../src/core/herdr.ts';
import {
  agentWrites,
  compatibilityResult,
  registerSubagentCompatibility,
} from '../src/compat/subagent.ts';
import { lifecycleRegistry, LifecycleRegistry } from '../src/core/orchestration.ts';

function git(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}

assert.equal(MAX_PARALLEL_TASKS, 8);
assert.equal(MAX_CONCURRENCY, 4);
assert.equal(
  agentWrites({ tools: ['bash'] }),
  true,
  'shell-capable agents retain writer ownership'
);
assert.equal(
  agentWrites({ tools: ['read', 'grep'] }),
  false,
  'read-only agents do not claim writer ownership'
);
assert.deepEqual(ownedPaths('Do not edit src/a.ts; update src/b.ts'), ['src/b.ts']);
assert.deepEqual(ownedPaths('Edit ../../shared.ts'), ['../../shared.ts']);
assert.deepEqual(ownedPaths('Edit ~/Makefile'), [join(process.env.HOME, 'Makefile')]);
assert.equal(
  findOwnershipConflicts(
    [
      { agent: 'a', task: 'Edit src/a.ts', cwd: '/repo', writes: true },
      { agent: 'b', task: 'Update src/a.ts', writes: true },
    ],
    '/repo'
  ).length,
  1,
  'omitted cwd is normalized to the parent cwd before ownership checks'
);
assert.equal(
  findOwnershipConflicts(
    [
      { agent: 'a', task: 'Edit ../../shared.ts', cwd: '/repo/sub/deep', writes: true },
      { agent: 'b', task: 'Update /repo/shared.ts', cwd: '/repo', writes: true },
    ],
    '/repo'
  ).length,
  1,
  'repeated parent-relative paths resolve before ownership comparison'
);
assert.equal(
  findOwnershipConflicts(
    [
      { agent: 'a', task: 'Edit src/a.ts', cwd: '/repo', writes: true, isolate: true },
      { agent: 'b', task: 'Update src/a.ts', cwd: '/repo', writes: true },
    ],
    '/repo'
  ).length,
  0,
  'isolated tasks do not claim files within their relocated checkout'
);
assert.equal(
  findOwnershipConflicts(
    [
      { agent: 'a', task: 'Edit /repo/src/a.ts', cwd: '/repo', writes: true, isolate: true },
      { agent: 'b', task: 'Update /repo/src/a.ts', cwd: '/repo', writes: true, isolate: true },
    ],
    '/repo'
  ).length,
  1,
  'isolated tasks still conflict on absolute paths in the original checkout'
);
assert.equal(
  findOwnershipConflicts(
    [
      { agent: 'a', task: 'Edit ~/Makefile', cwd: '/repo', writes: true, isolate: true },
      { agent: 'b', task: 'Update ~/Makefile', cwd: '/other', writes: true, isolate: true },
    ],
    '/repo'
  ).length,
  1,
  'isolated tasks still conflict on shared paths outside their checkout'
);
assert.equal(assertDepthAvailable({ PI_SUBAGENT_DEPTH: '1', PI_SUBAGENT_MAX_DEPTH: '2' }), 2);
assert.throws(
  () => assertDepthAvailable({ PI_SUBAGENT_DEPTH: '2', PI_SUBAGENT_MAX_DEPTH: '2' }),
  /depth 2 of 2/
);
assert.match(truncateResult('x'.repeat(20), 10), /10 characters omitted/);

const waitingRegistry = new LifecycleRegistry();
waitingRegistry.beginSession('wait-test');
const waitingAgent = waitingRegistry.registerAgent({
  agent: 'worker',
  paneId: 'pane-wait',
  tabId: 'tab-wait',
  workspaceId: 'workspace-wait',
  cwd: '/repo',
});
const settledEvents = [];
waitingRegistry.onTaskSettlement(result => settledEvents.push(result));
const waitingTask = waitingRegistry.createTask(waitingAgent, 'wait for explicit completion');
let resolved = false;
const waitingResult = waitingRegistry.waitForTask(waitingTask).then(result => {
  resolved = true;
  return result;
});
await Promise.resolve();
assert.equal(resolved, false, 'idle state does not settle compatibility waits');
waitingRegistry.setAgentState(waitingAgent, 'idle');
await Promise.resolve();
assert.equal(resolved, false, 'an idle child still owns its tracked task');
waitingRegistry.settleTask(waitingTask, { status: 'completed', text: 'done' });
assert.equal((await waitingResult).text, 'done');
assert.equal(settledEvents.length, 1);
assert.equal(settledEvents[0].agent, 'worker');
assert.equal(settledEvents[0].description, 'wait for explicit completion');
waitingRegistry.settleTask(waitingTask, { status: 'failed', error: 'duplicate' });
assert.equal(settledEvents.length, 1, 'duplicate settlement emits no second completion');

const registered = [];
const compatibilityHooks = new Map();
registerSubagentCompatibility({
  registerTool(tool) {
    registered.push(tool);
  },
  on(event, handler) {
    compatibilityHooks.set(event, handler);
  },
});
assert.equal(registered.length, 1);
assert.equal(registered[0].name, 'subagent');
assert.equal(registered[0].parameters.type, 'object');
const structuredFailure = compatibilityResult('single', [
  {
    agent: 'worker',
    task: 'Fail with evidence.',
    cwd: '/repo',
    status: 'failed',
    ok: false,
    returnCode: 1,
    text: 'failure details',
    taskId: 'shepherd-task-failed',
    toolCalls: [{ name: 'read', args: { path: 'src/a.ts' } }],
  },
]);
assert.equal(structuredFailure.details.failed, true);
assert.equal(structuredFailure.details.results[0].taskId, 'shepherd-task-failed');
assert.deepEqual(
  await compatibilityHooks.get('tool_result')({
    type: 'tool_result',
    toolName: 'subagent',
    toolCallId: 'compatibility-failure',
    input: {},
    content: structuredFailure.content,
    details: structuredFailure.details,
    isError: false,
  }),
  { isError: true },
  'failed compatibility results retain details while the runtime marks them as errors'
);
let launched = false;
const originalAllocateAgentId = lifecycleRegistry.allocateAgentId;
lifecycleRegistry.allocateAgentId = () => {
  launched = true;
  return originalAllocateAgentId.call(lifecycleRegistry);
};
try {
  await assert.rejects(
    registered[0].execute(
      'too-many',
      {
        tasks: Array.from({ length: 9 }, (_, index) => ({
          agent: 'worker',
          task: `Edit src/file-${index}.ts`,
        })),
      },
      undefined,
      undefined,
      { cwd: process.cwd(), sessionManager: { getSessionId: () => 'contract-test' } }
    ),
    /Too many parallel tasks \(9\)/
  );
  assert.equal(launched, false, '9-task fanout is refused before launch');
  const abortedRun = new AbortController();
  abortedRun.abort();
  const abortedResult = await registered[0].execute(
    'aborted',
    { agent: 'worker', task: 'Do nothing.' },
    abortedRun.signal,
    undefined,
    { cwd: process.cwd(), sessionManager: { getSessionId: () => 'contract-test' } }
  );
  assert.equal(abortedResult.details.failed, true);
  assert.equal(abortedResult.details.results[0].status, 'cancelled');
  assert.match(abortedResult.content[0].text, /aborted/);
  assert.deepEqual(
    await compatibilityHooks.get('tool_result')({
      type: 'tool_result',
      toolName: 'subagent',
      toolCallId: 'aborted',
      input: {},
      content: abortedResult.content,
      details: abortedResult.details,
      isError: false,
    }),
    { isError: true },
    'runtime marks a structured single-task failure as an error'
  );
  assert.equal(launched, false, 'pre-aborted call launches no agent');
} finally {
  lifecycleRegistry.allocateAgentId = originalAllocateAgentId;
}
assert.equal(
  shepherdSessionFromArgs(['pi', '--session', '/tmp/unrelated/session.jsonl']),
  undefined,
  'ordinary sessions do not inherit Shepherd child mode'
);

let active = 0;
let maximum = 0;
const values = await mapWithConcurrencyLimit(
  Array.from({ length: 8 }, (_, index) => index),
  4,
  async value => {
    active++;
    maximum = Math.max(maximum, active);
    await new Promise(resolve => setTimeout(resolve, 5));
    active--;
    return value * 2;
  }
);
assert.deepEqual(values, [0, 2, 4, 6, 8, 10, 12, 14]);
assert.ok(maximum <= 4);
const aborted = new AbortController();
aborted.abort();
await assert.rejects(
  mapWithConcurrencyLimit([1, 2], 1, async value => value, aborted.signal),
  /aborted/
);

const literalPrevious = 'literal $& $$ $` sequence';
assert.equal(
  interpolatePrevious('value: {previous}', literalPrevious),
  `value: ${literalPrevious}`,
  'production chain interpolation preserves literal dollar sequences'
);

const launch = writePiLaunchFiles({
  name: 'depth-test',
  subagentDepth: 2,
  herdrContext: {
    paneId: 'workspace:pane',
    tabId: 'workspace:tab',
    workspaceId: 'workspace',
    socketPath: '/tmp/herdr.sock',
  },
});
try {
  const script = readFileSync(launch.scriptFile, 'utf8');
  const context = JSON.parse(readFileSync(join(launch.dir, 'child-context.json'), 'utf8'));
  assert.equal(context.PI_SUBAGENT_DEPTH, '2');
  assert.ok(
    !('PI_REVIEW_REACH_WRITER' in context),
    'child cannot claim parent review-writer status'
  );
  assert.match(script, /shepherd-child\.ts/);
  assert.equal(context.HERDR_ENV, '1');
  assert.equal(context.HERDR_PANE_ID, 'workspace:pane');
  assert.equal(context.HERDR_TAB_ID, 'workspace:tab');
  assert.equal(context.HERDR_WORKSPACE_ID, 'workspace');
  assert.equal(context.HERDR_SOCKET_PATH, '/tmp/herdr.sock');
  const bootstrap = readFileSync(join(launch.dir, 'shepherd-child.ts'), 'utf8');
  assert.match(bootstrap, /Object\.entries\(values\)/);
  assert.equal(
    shepherdSessionFromArgs(['pi', '--session', launch.sessionFile]),
    launch.sessionFile,
    'declawd-safe session marker identifies a Shepherd child without PI_* environment'
  );
  assert.equal(
    shepherdSessionFromArgs(['pi', `--session=${launch.sessionFile}`]),
    launch.sessionFile,
    'inline session argument also identifies a Shepherd child'
  );
} finally {
  rmSync(launch.dir, { recursive: true, force: true });
}

const telemetryFile = join(tmpdir(), `pi-shepherd-telemetry-${process.pid}.jsonl`);
writeFileSync(
  telemetryFile,
  [
    JSON.stringify({
      type: 'message',
      message: {
        role: 'assistant',
        model: 'test-model',
        stopReason: 'stop',
        usage: {
          input: 3,
          output: 5,
          cacheRead: 7,
          cacheWrite: 11,
          totalTokens: 26,
          cost: { total: 0.25 },
        },
        content: [
          { type: 'toolCall', name: 'read', arguments: { path: 'src/a.ts' } },
          { type: 'text', text: 'done' },
          { type: 'text', text: 'second block' },
        ],
      },
    }),
  ].join('\n')
);
try {
  const telemetry = readSessionTelemetry(telemetryFile);
  assert.equal(telemetry.model, 'test-model');
  assert.deepEqual(telemetry.usage, {
    input: 3,
    output: 5,
    cacheRead: 7,
    cacheWrite: 11,
    cost: 0.25,
    contextTokens: 26,
    turns: 1,
  });
  assert.deepEqual(telemetry.toolCalls, [{ name: 'read', args: { path: 'src/a.ts' } }]);
  assert.equal(lastAssistantText(telemetry.messages), 'done\nsecond block');
  const cursor = sessionTelemetryCursor(telemetry);
  writeFileSync(
    telemetryFile,
    `\n${JSON.stringify({
      type: 'message',
      message: {
        role: 'assistant',
        usage: { input: 2, output: 4, totalTokens: 6, cost: { total: 0.1 } },
        content: [{ type: 'toolCall', name: 'grep', arguments: { path: 'src/b.ts' } }],
      },
    })}\n`,
    { flag: 'a' }
  );
  const delta = sessionTelemetrySince(readSessionTelemetry(telemetryFile), cursor);
  assert.deepEqual(delta.toolCalls, [{ name: 'grep', args: { path: 'src/b.ts' } }]);
  assert.equal(delta.usage.input, 2);
  assert.equal(delta.usage.output, 4);
  assert.equal(delta.usage.turns, 1);
} finally {
  rmSync(telemetryFile, { force: true });
}

const root = mkdtempSync(join(tmpdir(), 'pi-shepherd-contracts-'));
try {
  git(root, 'init');
  git(root, 'config', 'user.email', 'test@localhost');
  git(root, 'config', 'user.name', 'Test');
  writeFileSync(join(root, 'base.txt'), 'base\n');
  git(root, 'add', 'base.txt');
  git(root, 'commit', '-m', 'base');
  const nested = join(root, 'nested');
  execFileSync('mkdir', ['-p', nested]);
  assert.equal(realpathSync(checkoutOf(nested)?.checkout), realpathSync(root));
  const alias = join(tmpdir(), `pi-shepherd-alias-${process.pid}`);
  try {
    execFileSync('ln', ['-s', root, alias]);
    assert.equal(
      findOwnershipConflicts(
        [
          { agent: 'a', task: `Edit ${join(root, 'a.ts')}`, cwd: root, writes: true },
          { agent: 'b', task: `Update ${join(alias, 'a.ts')}`, cwd: root, writes: true },
        ],
        root
      ).length,
      1,
      'filesystem aliases are canonicalized before ownership comparison'
    );
  } finally {
    rmSync(alias, { force: true });
  }

  const [dirty] = createWorktreeLeases(
    [{ agent: 'worker', task: 'Edit src/a.ts', cwd: nested, isolate: true }],
    root,
    'dirty'
  );
  writeFileSync(join(dirty.path, 'dirty.txt'), 'keep\n');
  const [dirtyOutcome] = releaseWorktreeLeases([dirty]);
  assert.equal(dirtyOutcome.removed, false, 'dirty worktrees are preserved');

  const [retained] = createWorktreeLeases(
    [{ agent: 'worker', task: 'Edit src/c.ts', cwd: root, isolate: true }],
    root,
    'retained'
  );
  retained.retain = true;
  const [retainedOutcome] = releaseWorktreeLeases([retained]);
  assert.equal(retainedOutcome.removed, false, 'unconfirmed child shutdown retains worktree');

  const [absoluteTarget] = createWorktreeLeases(
    [{ agent: 'worker', task: `Edit ${join(root, 'base.txt')}`, cwd: root, isolate: true }],
    root,
    'absolute'
  );
  const absoluteConflict = findOwnershipConflicts(
    [
      {
        agent: 'a',
        task: `Edit ${join(root, 'base.txt')}`,
        cwd: absoluteTarget.cwd,
        writes: true,
        isolate: true,
      },
      {
        agent: 'b',
        task: `Update ${join(root, 'base.txt')}`,
        cwd: root,
        writes: true,
        isolate: true,
      },
    ],
    root
  );
  assert.equal(absoluteConflict.length, 1, 'absolute original-checkout paths remain shared');
  absoluteTarget.retain = true;
  releaseWorktreeLeases([absoluteTarget]);

  const [ahead] = createWorktreeLeases(
    [{ agent: 'worker', task: 'Edit src/d.ts', cwd: root, isolate: true }],
    root,
    'ahead'
  );
  writeFileSync(join(ahead.path, 'ahead.txt'), 'commit\n');
  git(ahead.path, 'add', 'ahead.txt');
  git(ahead.path, 'commit', '-m', 'ahead');
  const [aheadOutcome] = releaseWorktreeLeases([ahead]);
  assert.equal(aheadOutcome.removed, false, 'ahead worktrees are preserved');

  const [detached] = createWorktreeLeases(
    [{ agent: 'worker', task: 'Edit src/e.ts', cwd: root, isolate: true }],
    root,
    'detached'
  );
  writeFileSync(join(detached.path, 'detached.txt'), 'commit\n');
  git(detached.path, 'add', 'detached.txt');
  git(detached.path, 'commit', '-m', 'saved-on-branch');
  git(detached.path, 'checkout', '--detach', detached.baseRev);
  const [detachedOutcome] = releaseWorktreeLeases([detached]);
  assert.equal(detachedOutcome.removed, false, 'branch commits survive a detached worktree head');

  const [empty] = createWorktreeLeases(
    [{ agent: 'worker', task: 'Edit src/b.ts', cwd: root, isolate: true }],
    root,
    'empty'
  );
  const [emptyOutcome] = releaseWorktreeLeases([empty]);
  assert.equal(emptyOutcome.removed, true, 'empty worktrees are removed');
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(
  'PASS compatibility contracts preserve depth, concurrency, ownership, truncation, and worktree safety'
);
