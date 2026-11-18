#!/usr/bin/env node
/**
 * T013 acceptance — sequential delegated notes shared across hosts.
 *
 * Drives the Pi and OpenCode gates/resolvers against one project without a
 * live TUI or Herdr: both hosts present the same opaque parent identity and
 * project root, so their sequential delegations land in exactly one
 * `.shepherd/sessions/NNNN-*` collection, linked by one MOC. Also proves
 * disabled-notes mode stays off on both hosts, including mid-session flips.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-shepherd-t013-home-'));
process.env.HOME = home;
process.env.OPENCODE_CONFIG_DIR = path.join(home, 'config', 'opencode');
fs.mkdirSync(process.env.OPENCODE_CONFIG_DIR, { recursive: true });
const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-shepherd-t013-project-'));

const { installOpencodeHost } = await import('../src/opencode/host.ts');
installOpencodeHost();
const { parentArtifactSession, resetOpencodeFieldnotesCache } = await import(
  '../src/opencode/fieldnotes.ts'
);
const {
  resolveOrCreateParentArtifactSession,
  reserveArtifacts,
  markArtifactStarted,
  finalizeArtifact,
  readSessionMetadata,
} = await import('../src/core/artifact-sessions.ts');
const { fieldnotesEnabled, initializeSessionSettings } = await import('../src/core/config.ts');

const ctx = sessionId => ({ sessionId, cwd: projectRoot });
const sessionDirs = root =>
  fs.readdirSync(path.join(root, '.shepherd', 'sessions')).filter(n => /^\d{4,}-/.test(n));

// 1. Pi opens the binding; OpenCode presents the SAME opaque identity.
const sharedIdentity = 'ses-t013-shared';
const piSession = resolveOrCreateParentArtifactSession({
  parentPiSessionId: sharedIdentity,
  projectRoot,
  parentSessionFile: '/tmp/pi-parent.jsonl',
});
const ocSession = parentArtifactSession(ctx(sharedIdentity));
assert.equal(ocSession.sessionPath, piSession.sessionPath, 'OpenCode reuses the Pi-bound session');
assert.equal(ocSession.resumed, true);
assert.equal(ocSession.artifactSessionVersion, 2);

// 2. Sequential delegation 1 — Pi side leaves a note.
const a1 = reserveArtifacts(piSession, [{ agent: 'scout', mode: 'single', task: 'pi delegation' }])[0];
markArtifactStarted(piSession, a1);
finalizeArtifact(piSession, a1, { status: 'completed', output: 'note from Pi host' });

// 3. Sequential delegation 2 — OpenCode re-resolves (separate tool call) and
//    leaves a follow-up note in the same collection.
const ocReresolved = parentArtifactSession(ctx(sharedIdentity));
assert.equal(ocReresolved.resumed, true, 'a later tool call reloads the same binding');
const a2 = reserveArtifacts(ocReresolved, [
  { agent: 'worker', mode: 'single', task: 'oc follow-up' },
])[0];
markArtifactStarted(ocReresolved, a2);
finalizeArtifact(ocReresolved, a2, { status: 'completed', output: 'note from OpenCode host' });

// 4. One session directory, two distinct notes, one MOC linking both.
assert.deepEqual(sessionDirs(projectRoot).length, 1, 'exactly one numbered session directory');
assert.equal(path.dirname(a1.filePath), piSession.sessionPath);
assert.equal(path.dirname(a2.filePath), piSession.sessionPath);
assert.notEqual(a1.filePath, a2.filePath, 'two distinct note files');
const stored = JSON.parse(fs.readFileSync(piSession.sessionMetadataPath, 'utf8'));
assert.equal(stored.artifacts.length, 2);
assert.deepEqual(stored.artifacts.map(a => a.status), ['completed', 'completed']);
const moc = fs.readFileSync(piSession.mocPath, 'utf8');
assert.match(moc, /\.\/scout-01\.md/);
assert.match(moc, /\.\/worker-01\.md/);
assert.match(fs.readFileSync(a1.filePath, 'utf8'), /note from Pi host/);
assert.match(fs.readFileSync(a2.filePath, 'utf8'), /note from OpenCode host/);
assert.equal(readSessionMetadata(piSession.sessionPath).artifacts.length, 2);
assert.equal(fs.existsSync(path.join(projectRoot, '.shepherd', 'shepherd.md')), false);
console.log('PASS sequential Pi→OpenCode delegations share one session and one MOC');

// 5. Reverse direction, self-contained: OpenCode opens a fresh binding, the
//    Pi resolver finds it and adds a note.
const reverseRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-shepherd-t013-reverse-'));
const reverseIdentity = 'ses-t013-reverse';
const reverseCtx = { sessionId: reverseIdentity, cwd: reverseRoot };
const ocFirst = parentArtifactSession(reverseCtx);
const piSecond = resolveOrCreateParentArtifactSession({
  parentPiSessionId: reverseIdentity,
  projectRoot: reverseRoot,
});
assert.equal(piSecond.sessionPath, ocFirst.sessionPath);
const a3 = reserveArtifacts(piSecond, [{ agent: 'reviewer', mode: 'single', task: 'pi follow-up' }])[0];
markArtifactStarted(piSecond, a3);
finalizeArtifact(piSecond, a3, { status: 'completed', output: 'note from Pi after OpenCode' });
assert.equal(sessionDirs(reverseRoot).length, 1);
assert.match(fs.readFileSync(ocFirst.mocPath, 'utf8'), /\.\/reviewer-01\.md/);
console.log('PASS sequential OpenCode→Pi delegations share one session and one MOC');

// 6. Disabled notes stay off on both hosts, including mid-session flips.
const offRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-shepherd-t013-off-'));
const configFile = path.join(offRoot, '.shepherd', 'config.json');
fs.mkdirSync(path.dirname(configFile), { recursive: true });
const writeConfig = fieldnotes =>
  fs.writeFileSync(configFile, JSON.stringify({ projectScope: true, fieldnotes }));
writeConfig(false);
initializeSessionSettings(offRoot);
resetOpencodeFieldnotesCache();
assert.equal(fieldnotesEnabled(), false, 'Pi gate sees disabled fieldnotes');
assert.equal(parentArtifactSession({ sessionId: 'ses-t013-off', cwd: offRoot }), undefined);
assert.equal(fs.existsSync(path.join(offRoot, '.shepherd', 'sessions')), false);

writeConfig(true);
assert.equal(fieldnotesEnabled(), false, 'Pi session snapshot stays disabled');
assert.equal(
  parentArtifactSession({ sessionId: 'ses-t013-off', cwd: offRoot }),
  undefined,
  'OpenCode session snapshot stays disabled'
);
initializeSessionSettings(offRoot);
resetOpencodeFieldnotesCache();
assert.equal(fieldnotesEnabled(), true, 'a new Pi session observes the change');
assert.ok(parentArtifactSession({ sessionId: 'ses-t013-on', cwd: offRoot }));
console.log('PASS disabled fieldnotes stay off on both hosts; new sessions see changes');

console.log('\nAll T013 cross-host fieldnote assertions passed.');
