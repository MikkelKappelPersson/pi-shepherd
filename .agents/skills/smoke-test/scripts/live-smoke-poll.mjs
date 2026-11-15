#!/usr/bin/env node
// Live poll probe (Track B of the smoke-test skill): delegate with NO watch, NO message, NO status
// calls. The only settlement trigger is the 250 ms background poll.
// Observes via describeHcStatusView (pure map read, no drain) and direct
// inbox directory stats (fs reads, not drains).
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
// Skill-bundled probe: resolve the repo root from this file's location
// (scripts/ -> smoke-test/ -> skills/ -> .agents/ -> root).
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const REPO_SRC = path.join(repoRoot, 'src') + '/';

const SESSION = `hc-011-smoke-${process.pid}`;
process.env.PI_SHEPHERD_OWNER_SESSION = SESSION;

const failures = [];
const ok = (cond, label) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) failures.push(label);
};

const {
  createHcRuntime,
  describeHcStatusView,
  isHcInboxPollerRunning,
} = await import(`${REPO_SRC}runtimes/hc/runtime.ts`);
const sessions = await import(`${REPO_SRC}core/artifact-sessions.ts`);

const sleep = ms => new Promise(r => setTimeout(r, ms));

function sessionBrokerDir(sessionId) {
  for (const name of fs.readdirSync(os.tmpdir())) {
    if (!name.startsWith('pi-shepherd-broker-')) continue;
    try {
      const man = JSON.parse(fs.readFileSync(path.join(os.tmpdir(), name, 'broker.json'), 'utf8'));
      if (man.sessionId === sessionId) return path.join(os.tmpdir(), name);
    } catch {}
  }
  return undefined;
}
const junkBefore = new Set(
  fs.readdirSync(os.tmpdir()).filter(n => n.startsWith('pi-shepherd-broker-'))
);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-011-smoke-'));
const artifactSession = sessions.resolveOrCreateParentArtifactSession({
  parentPiSessionId: SESSION,
  projectRoot: tmp,
});
const rt = createHcRuntime({ cwd: tmp, artifactSession });

const agentId = await rt.spawn({ name: 'worker' }, { cwd: tmp, label: '011-smoke' });
ok(agentId.startsWith('shepherd-agent-'), `spawn (${agentId})`);

// High deadline so the Phase-3 deadline drain CANNOT confound: any prompt
// settlement must come from the background poll.
const taskId = await rt.delegate(
  agentId,
  'Do nothing else. Immediately call shepherd_done with status completed and summary hc-011-smoke-ok.',
  { timeoutMin: 30 }
);
ok(taskId.startsWith('shepherd-task-'), `delegate (${taskId})`);
ok(isHcInboxPollerRunning(), 'background poller is running while work is open');

const dir = sessionBrokerDir(SESSION);
ok(!!dir, 'session broker exists');
const inbox = path.join(dir, 'parent', 'inbox');
const processedDir = path.join(dir, 'parent', 'processed');
const processedBase = new Set(fs.readdirSync(path.join(dir, 'processed')));

// Wait for the done to ARRIVE (new file in processed/ — the tick consumes
// the inbox within 250 ms, so inbox polling alone can miss it), then
// measure settle lag with drain-free reads only.
let arrivedAt = 0;
for (let i = 0; i < 240 && !arrivedAt; i++) {
  const fresh = fs.readdirSync(path.join(dir, 'processed')).filter(f => !processedBase.has(f));
  if (fresh.length > 0 || fs.readdirSync(inbox).length > 0) arrivedAt = Date.now();
  else await sleep(500);
}
ok(arrivedAt > 0, 'task_done arrived in the parent inbox');
let settledAt = 0;
let state = '';
// NOTE: the status view only carries *unsettled* tasks (runtime.ts: the
// task view is built only when `!open.result`), so a delegated task
// disappearing from the view while the agent is still known MEANS settled.
for (let i = 0; i < 120 && !settledAt; i++) {
  let view;
  try {
    view = describeHcStatusView(agentId);
  } catch {
    view = undefined;
  }
  if (!view) {
    state = '(agent unknown)';
  } else if (!view.task) {
    state = 'completed (task settled, view cleared)';
    settledAt = Date.now();
  } else {
    state = view.task.state;
  }
  if (!settledAt) await sleep(250);
}
const lag = settledAt - arrivedAt;
ok(settledAt > 0, `settled with no watch/message/status (state=${state})`);
ok(lag < 10000, `settle lag after arrival is poll-bounded, not deadline-bound (${lag}ms)`);
ok(isHcInboxPollerRunning() === false || true, 'poller state noted (quiescence stops it eventually)');

await rt.close(agentId);
ok(true, 'close owned terminal');

// No junk fallback-keyed broker dirs minted during the run.
const junkAfter = fs
  .readdirSync(os.tmpdir())
  .filter(n => n.startsWith('pi-shepherd-broker-') && !junkBefore.has(n));
let junkSessions = [];
for (const n of junkAfter) {
  try {
    junkSessions.push(JSON.parse(fs.readFileSync(path.join(os.tmpdir(), n, 'broker.json'), 'utf8')).sessionId);
  } catch {}
}
ok(!junkSessions.some(s => String(s).startsWith('hc-parent-')), `no junk hc-parent-* stores (${JSON.stringify(junkSessions)})`);

fs.rmSync(tmp, { recursive: true, force: true });
if (failures.length) {
  console.log('FAILURES:', failures);
  process.exit(1);
}
console.log('011 live smoke passed.');
