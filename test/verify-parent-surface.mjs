#!/usr/bin/env node
/**
 * Parent/worker registration boundary.
 *
 * Launched workers inherit the user extension set, but herdr.ts explicitly
 * injects shepherd-done.ts as their worker-side Shepherd surface. The parent
 * control plane must not also be registered in those sessions.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { parentMessageDeliveryOptions } from '../src/extension/shepherd.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const indexUrl = pathToFileURL(path.join(root, 'index.ts')).href;
const probe = `
  const calls = { tools: [], toolDetails: {}, commands: [], events: [] };
  const pi = {
    registerTool(tool) {
      calls.tools.push(tool.name);
      calls.toolDetails[tool.name] = {
        description: tool.description,
        promptGuidelines: tool.promptGuidelines,
      };
    },
    registerCommand(name) { calls.commands.push(name); },
    registerMessageRenderer() {},
    on(event) { calls.events.push(event); },
  };
  const mod = await import(${JSON.stringify(indexUrl)});
  mod.default(pi);
  console.log(JSON.stringify(calls));
`;

function run(worker) {
  const isolatedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-shepherd-default-agent-'));
  const env = { ...process.env, PI_CODING_AGENT_DIR: isolatedRoot };
  if (worker) env.PI_SHEPHERD_SESSION = '/tmp/pi-shepherd-worker-session.jsonl';
  else delete env.PI_SHEPHERD_SESSION;
  const result = spawnSync(
    process.execPath,
    [
      '--experimental-strip-types',
      '--disable-warning=ExperimentalWarning',
      '--input-type=module',
      '--eval',
      probe,
    ],
    { cwd: root, env, encoding: 'utf8' }
  );
  fs.rmSync(isolatedRoot, { recursive: true, force: true });
  assert.equal(result.status, 0, `${worker ? 'worker' : 'parent'} probe failed: ${result.stderr}`);
  const line = result.stdout.trim().split('\n').at(-1);
  return JSON.parse(line);
}

const parent = run(false);
const worker = run(true);
const childRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-shepherd-child-marker-'));
fs.writeFileSync(path.join(childRoot, 'child-context.json'), '{}');
const strippedWorker = spawnSync(
  process.execPath,
  [
    '--experimental-strip-types',
    '--disable-warning=ExperimentalWarning',
    '--input-type=module',
    '--eval',
    probe,
    '--',
    '--session',
    path.join(childRoot, 'session-worker.jsonl'),
  ],
  { cwd: root, env: { ...process.env, PI_SHEPHERD_SESSION: '' }, encoding: 'utf8' }
);
fs.rmSync(childRoot, { recursive: true, force: true });
assert.equal(strippedWorker.status, 0, `stripped-env worker probe failed: ${strippedWorker.stderr}`);
const strippedWorkerCalls = JSON.parse(strippedWorker.stdout.trim().split('\n').at(-1));
const compatRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-shepherd-parent-surface-'));
const compatAgentDir = path.join(compatRoot, 'agent');
const compatConfig = path.join(compatAgentDir, 'pi-shepherd', 'config.json');
fs.mkdirSync(path.dirname(compatConfig), { recursive: true });
fs.writeFileSync(compatConfig, JSON.stringify({ subagentCompatibility: true }));
const compat = spawnSync(
  process.execPath,
  [
    '--experimental-strip-types',
    '--disable-warning=ExperimentalWarning',
    '--input-type=module',
    '--eval',
    `process.env.PI_CODING_AGENT_DIR=${JSON.stringify(compatAgentDir)};${probe}`,
  ],
  { cwd: root, env: { ...process.env }, encoding: 'utf8' }
);
fs.rmSync(compatRoot, { recursive: true, force: true });
assert.equal(compat.status, 0, `compatibility probe failed: ${compat.stderr}`);
const compatCalls = JSON.parse(compat.stdout.trim().split('\n').at(-1));

assert.equal(parent.tools.length, 9, 'compatibility facade is opt-in and absent by default');
assert.ok(parent.tools.includes('shepherd'), 'parent registers the umbrella shepherd tool');
assert.ok(!parent.tools.includes('subagent'), 'default install does not collide with another subagent tool');
assert.ok(compatCalls.tools.includes('subagent'), 'user opt-in registers the compatibility facade');
assert.ok(parent.tools.includes('shepherd_delegate'), 'parent registers tracked delegation');
assert.ok(parent.commands.includes('shepherd'), 'parent registers the /shepherd command');
const umbrella = parent.toolDetails.shepherd;
assert.ok(
  umbrella.description.includes('shepherd_spawn'),
  'umbrella description names the lifecycle tools'
);
assert.ok(
  umbrella.description.includes('shepherd_delegate'),
  'umbrella description names tracked delegation'
);
const guidance = umbrella.promptGuidelines.join(' ');
assert.ok(
  guidance.includes('shepherd_watch'),
  'umbrella guidance explains the non-blocking lifecycle workflow'
);
assert.ok(guidance.includes('shepherd_watch'), 'umbrella guidance explains asynchronous watching');
assert.ok(guidance.includes('shepherd_delegate'), 'umbrella guidance explains tracked delegation');
assert.ok(guidance.includes('close each agent'), 'umbrella guidance explains close semantics');
assert.ok(guidance.includes('shepherd.md'), 'umbrella guidance explains fieldnotes');
const messageTool = parent.toolDetails.shepherd_message;
assert.ok(
  messageTool.description.includes('exact opaque agent id returned by shepherd_spawn'),
  'message description requires the exact spawned id'
);
assert.ok(
  messageTool.description.includes('agent definition name'),
  'message description rejects definition names'
);
assert.ok(
  messageTool.description.includes('will be rejected'),
  'message description promises invalid-target rejection'
);
assert.ok(
  messageTool.promptGuidelines.join(' ').includes('angle-bracket placeholder'),
  'message guidance rejects unresolved placeholders'
);
assert.equal(worker.tools.length, 0, 'worker does not register parent Shepherd tools');
assert.equal(strippedWorkerCalls.tools.length, 0, 'session marker excludes parent tools after env stripping');
assert.equal(worker.commands.length, 0, 'worker does not register parent Shepherd commands');
assert.deepEqual(
  parentMessageDeliveryOptions({ kind: 'message' }),
  { deliverAs: 'followUp', triggerTurn: false },
  'ordinary child messages remain passive'
);
assert.deepEqual(
  parentMessageDeliveryOptions({ kind: 'message', expectsReply: true }),
  { deliverAs: 'steer', triggerTurn: true },
  'child requests wake the parent to answer'
);
assert.deepEqual(
  parentMessageDeliveryOptions({ kind: 'reply' }),
  { deliverAs: 'steer', triggerTurn: true },
  'child replies wake the parent to resume waiting work'
);

console.log('PASS parent registers the Shepherd control plane');
console.log('PASS launched worker excludes parent Shepherd tools and commands');
console.log('All parent-surface assertions passed.');
