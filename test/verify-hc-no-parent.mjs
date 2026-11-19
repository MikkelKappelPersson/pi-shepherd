#!/usr/bin/env node
/**
 * Spec 014 — hc `no_parent` launch contract, owner-based reap, and failure
 * paths. Herdr-independent: no agent is booted and the real registry is never
 * touched (host capabilities point at a temp dir).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-shepherd-no-parent-'));
const { setHostCapabilities } = await import('../src/core/host.ts');
setHostCapabilities({
  getAgentDir: () => path.join(temp, 'agent'),
  projectConfigDirName: '.pi',
  dataDirName: 'pi-shepherd',
  parseFrontmatter: () => ({ frontmatter: {}, body: '' }),
});

const {
  buildHcLaunchArgs,
  readCallerHerdrSpace,
  readHerdrSpace,
  recordCreatedTerminal,
  loadCreatedTerminals,
  forgetOwnedTerminal,
} = await import('../src/runtimes/hc/hc.ts');

let failures = 0;
function check(ok, label) {
  if (ok) console.log(`PASS  ${label}`);
  else {
    failures++;
    console.log(`FAIL  ${label}`);
  }
}

// T001 / T007: the default argv is byte-for-byte the original launch path.
const DEFAULT = [
  'run',
  '--bg',
  '--json',
  '--cwd',
  '/work',
  '--label',
  'shepherd.owned=true',
  '--label',
  'shepherd.agent=worker',
  '--no-notify',
  '--outlive-parent',
  'bash',
  '/tmp/launch.sh',
];
assert.deepEqual(
  buildHcLaunchArgs({ cwd: '/work', agent: 'worker', scriptFile: '/tmp/launch.sh' }),
  DEFAULT,
  'default spawn keeps the original hc run flags (T001, T007)'
);
check(true, 'default spawn keeps the original hc run flags (T001, T007)');

// T008: no-parent adds the space label and --no-parent, drops --no-notify.
const detached = buildHcLaunchArgs({
  cwd: '/work',
  agent: 'worker',
  scriptFile: '/tmp/launch.sh',
  noParent: true,
  space: 'sp-123',
});
assert.deepEqual(detached, [
  'run',
  '--bg',
  '--json',
  '--cwd',
  '/work',
  '--label',
  'shepherd.owned=true',
  '--label',
  'shepherd.agent=worker',
  '--label',
  'shepherd.no-parent=true',
  '--label',
  'herdr.space=sp-123',
  '--no-parent',
  '--outlive-parent',
  'bash',
  '/tmp/launch.sh',
]);
check(true, 'no-parent launch adds labels + --no-parent and drops --no-notify (T008)');
assert.ok(!detached.includes('--no-notify'), 'no parent means no notification flag');
assert.ok(!detached.some(a => a.startsWith('herdr.tab=')), 'no herdr.tab: Herdr picks a new tab');
assert.ok(detached.includes('--outlive-parent'), 'detached sheep still outlive the caller');

// T015: missing space fails before any terminal is created; no fallback.
assert.throws(
  () => buildHcLaunchArgs({ cwd: '/work', agent: 'worker', scriptFile: 's', noParent: true }),
  /require a Herdr app space/,
  'no-parent without a space is refused'
);
const savedTerminalId = process.env.HC_TERMINAL_ID;
delete process.env.HC_TERMINAL_ID;
assert.throws(() => readCallerHerdrSpace(), /no Herdr app space/, 'missing caller space has a clear hint');
if (savedTerminalId !== undefined) process.env.HC_TERMINAL_ID = savedTerminalId;
assert.equal(readHerdrSpace(''), undefined, 'empty terminal id has no space');
check(true, 'failure paths refuse with a hint and never fall back to a subagent (T015)');

// T013: the marker is recorded and owner-based reap works with no parent link.
recordCreatedTerminal({
  terminalId: 't-no-parent',
  name: 'worker',
  cwd: '/work',
  createdAt: 1,
  ownerSession: 'ses-owner',
  noParent: true,
});
const entry = loadCreatedTerminals().find(t => t.terminalId === 't-no-parent');
assert.equal(entry?.noParent, true, 'registry records the no-parent marker');
assert.equal(forgetOwnedTerminal('t-no-parent', 'another-session'), false, 'wrong owner cannot reap');
assert.equal(forgetOwnedTerminal('t-no-parent', 'ses-owner'), true, 'owner can reap after restart');
assert.ok(
  !loadCreatedTerminals().some(t => t.terminalId === 't-no-parent'),
  'reaped no-parent sheep leaves the registry'
);
check(true, 'no-parent marker survives in the registry and reaps by owner (T013)');

// T002 / T009: the herdr/TUI backend stays untouched and ignores the mode.
const extension = fs.readFileSync(
  new URL('../src/extension/shepherd.ts', import.meta.url),
  'utf8'
);
const herdrBranch = extension.slice(extension.indexOf('const handle = await startAgent('));
assert.ok(
  herdrBranch.includes('no_parent ignored: Herdr TUI agents already have their own pane'),
  'TUI spawn reports that the hc-only mode is ignored'
);
assert.ok(
  !herdrBranch.slice(0, herdrBranch.indexOf('case ')).includes('no_parent:'),
  'no_parent is not passed into the TUI startAgent path'
);
check(true, 'herdr/TUI backend ignores no_parent and reports its existing pane (T002, T009)');

fs.rmSync(temp, { recursive: true, force: true });
if (failures > 0) {
  console.log(`\n${failures} no-parent assertion(s) failed.`);
  process.exit(1);
}
console.log('All hc no-parent assertions passed.');
