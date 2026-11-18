#!/usr/bin/env node
/**
 * OpenCode-side coverage for the two remaining T011 gaps:
 *  - done-nudge delivered from session.execution.* events (bridge.ts), and
 *  - sheep-context shepherd_done with an unknown task id (actions.ts).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-shepherd-oc-nudge-'));
process.env.HOME = home;
const bin = path.join(home, 'bin');
fs.mkdirSync(bin, { recursive: true });
const deliveries = path.join(home, 'deliveries.log');
const fakeHerdr = path.join(bin, 'herdr');
fs.writeFileSync(
  fakeHerdr,
  `#!/bin/sh
case "$1 $2" in
  "--version "*|"--version") echo herdr-test; exit 0 ;;
  "agent list") echo '{"id":"cli:agent:list","result":{"agents":[]}}'; exit 0 ;;
  "agent get") echo '{"id":"cli:agent:get","result":{"agent":{"agent_status":"idle","pane_id":"pane-test","tab_id":"tab-test","workspace_id":"ws-test"}}}'; exit 0 ;;
  "agent prompt") printf '%s\\n' "$*" >> '${deliveries}'; echo '{"id":"cli:prompt","result":{}}'; exit 0 ;;
  "pane send-text") printf '%s\\n' "$*" >> '${deliveries}'; echo '{"id":"cli:send","result":{}}'; exit 0 ;;
  "pane send-keys") echo '{"id":"cli:keys","result":{}}'; exit 0 ;;
  *) echo '{"id":"cli:ok","result":{}}'; exit 0 ;;
esac
`
);
fs.chmodSync(fakeHerdr, 0o755);
process.env.PATH = `${bin}${path.delimiter}${process.env.PATH ?? ''}`;
process.env.SHEPHERD_DONE_NUDGES = '1';
// Resolve backend "auto" to the fake Herdr CLI above instead of depending on
// a real Herdr session being present on the machine running the suite.
process.env.HERDR_ENV = '1';
process.env.HERDR_PANE_ID = 'pane-test';

const { lifecycleRegistry } = await import('../src/runtimes/herdr/orchestration.ts');
const {
  bindChildSession,
  installOpencodeBridges,
  markParentSession,
  recordSheepSpawn,
} = await import('../src/opencode/bridge.ts');

// ── 1. Done-nudge from a forgotten sheep ─────────────────────────────────
const handle = lifecycleRegistry.registerAgent({ agent: 'scout', label: 'nudge', paneId: 'pane-test' });
const task = lifecycleRegistry.createTask(handle, 'forget to call shepherd_done');
lifecycleRegistry.setTaskRunning(task.id);
recordSheepSpawn({
  agentId: handle.id,
  backend: 'pane',
  paneId: 'pane-test',
  cwd: home,
  parentSessionId: 'parent-session',
  childCapability: 'oc',
  brokerRootDir: path.join(home, 'broker'),
  brokerSessionId: 'broker-session',
  brokerId: 'broker',
  parentBrokerId: 'parent-broker',
  spawnedAt: 0,
});
bindChildSession(handle.id, 'sheep-session');
markParentSession('parent-session');

const queue = [];
let consumed = 0;
let streamDone = false;
const stream = {
  async *[Symbol.asyncIterator]() {
    while (!streamDone) {
      while (queue.length) { consumed++; yield queue.shift(); }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  },
};
const parentPrompts = [];
const ctx = {
  session: {
    list: async () => [],
    prompt: async input => { parentPrompts.push(input); },
  },
  event: { subscribe: () => stream },
};
// Two identical run-completion events: first nudges, second escalates.
queue.push({ type: 'session.execution.succeeded', properties: { sessionID: 'sheep-session' } });
queue.push({ type: 'session.execution.succeeded', properties: { sessionID: 'sheep-session' } });
installOpencodeBridges(ctx);
await new Promise(resolve => setTimeout(resolve, 1000));

const first = fs.existsSync(deliveries) ? fs.readFileSync(deliveries, 'utf8') : '';
assert.match(first, /shepherd_done/, 'nudge tells the sheep to call shepherd_done');
assert.match(first, new RegExp(task.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'nudge names the open task id');

const second = fs.readFileSync(deliveries, 'utf8');
assert.equal(second, first, 'a bounded nudge is never repeated');
assert.equal(consumed, 2, 'both execution events were observed');
assert.ok(
  parentPrompts.some(p => /Shepherd completion stalled/.test(p.text) && p.text.includes(task.id)),
  'exhausted nudge budget escalates to the parent session'
);
console.log('PASS OpenCode done-nudge fires once, then escalates to the parent');

// ── 2. Sheep-context shepherd_done with an unknown task id ───────────────
const { sheepDone } = await import('../src/opencode/actions.ts');
const bogus = 'shepherd-task-0000-0000';
await assert.rejects(
  () => sheepDone({ cwd: home, sessionId: 'sheep-session-2' }, { taskId: bogus, status: 'completed' }, 'sheep-session-2'),
  error => {
    assert.match(String(error), /Unknown task id/);
    assert.ok(String(error).includes(bogus), 'error names the bad id');
    return true;
  }
);
console.log('PASS OpenCode sheep-context shepherd_done rejects an unknown task id by name');

streamDone = true;
console.log('All OpenCode nudge/error-path assertions passed.');
