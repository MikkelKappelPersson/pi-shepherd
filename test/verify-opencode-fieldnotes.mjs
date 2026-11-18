#!/usr/bin/env node
/**
 * T012 — OpenCode parent artifact-session resolution onto the shared layout.
 *
 * Proves the OpenCode adapter resolves/creates the same durable
 * `.shepherd/sessions` collection Pi uses, that the OpenCode session id is
 * the opaque parent identity, that fieldnotes-disabled stays off, and that
 * spawn/delegate thread the resolved session into both runtimes.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-shepherd-oc-fieldnotes-'));
process.env.HOME = home;
process.env.OPENCODE_CONFIG_DIR = path.join(home, 'config', 'opencode');
fs.mkdirSync(process.env.OPENCODE_CONFIG_DIR, { recursive: true });
const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-shepherd-oc-project-'));

const { installOpencodeHost } = await import('../src/opencode/host.ts');
installOpencodeHost();
const {
  parentArtifactSession,
  resetOpencodeFieldnotesCache,
} = await import('../src/opencode/fieldnotes.ts');
const {
  finalizeArtifact,
  markArtifactStarted,
  readSessionMetadata,
  resolveOrCreateParentArtifactSession,
  reserveArtifacts,
} = await import('../src/core/artifact-sessions.ts');

const ctx = (sessionId, cwd = projectRoot) => ({ sessionId, cwd });

// 1. Resolution creates the shared layout with the OpenCode session id bound.
const first = parentArtifactSession(ctx('ses-opencode-alpha'));
assert.ok(first, 'fieldnotes enabled by default resolve a session');
assert.equal(first.artifactSessionVersion, 2);
assert.equal(first.parentPiSession.identity, 'ses-opencode-alpha');
assert.equal(first.projectRoot, projectRoot);
assert.match(first.sessionPath, /\.shepherd[\\/]sessions[\\/]\d{4}-/);
assert.equal(first.sessionRelativePath, path.relative(projectRoot, first.sessionPath));
assert.equal(fs.existsSync(first.mocPath), true, 'MOC is created');
assert.equal(fs.existsSync(first.sessionMetadataPath), true, 'session.json is created');
console.log('PASS OpenCode resolution creates the shared .shepherd/sessions layout');

// 2. One binding reuses one session; a different session or root gets its own.
const reused = parentArtifactSession(ctx('ses-opencode-alpha'));
assert.equal(reused.sessionPath, first.sessionPath, 'same binding reuses the session');
assert.equal(reused.resumed, true, 'a second call resumes rather than allocates');
const otherSession = parentArtifactSession(ctx('ses-opencode-beta'));
assert.notEqual(otherSession.sessionPath, first.sessionPath, 'a different parent identity separates');
const otherRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-shepherd-oc-root-'));
const otherRootSession = parentArtifactSession(ctx('ses-opencode-alpha', otherRoot));
assert.notEqual(otherRootSession.sessionPath, first.sessionPath, 'a different root separates');
console.log('PASS same (session id, root) reuses; either difference allocates a new session');

// 3. Cross-host readability at the layout level: the Pi resolver finds the
//    OpenCode-created session and notes written by either side are shared.
const piView = resolveOrCreateParentArtifactSession({
  parentPiSessionId: 'ses-opencode-alpha',
  projectRoot,
});
assert.equal(piView.sessionPath, first.sessionPath, 'Pi resolver finds the OpenCode session');
const artifact = reserveArtifacts(first, [
  { agent: 'scout', mode: 'single', task: 'leave a note for the next host' },
])[0];
markArtifactStarted(first, artifact);
finalizeArtifact(first, artifact, { status: 'completed', output: 'note from OpenCode' });
const stored = JSON.parse(fs.readFileSync(first.sessionMetadataPath, 'utf8'));
const storedArtifact = stored.artifacts.find(a => a.id === artifact.id);
assert.equal(storedArtifact?.status, 'completed');
assert.equal(storedArtifact?.task, 'leave a note for the next host');
assert.match(fs.readFileSync(piView.mocPath, 'utf8'), /\.\/scout-01\.md/);
assert.match(fs.readFileSync(artifact.filePath, 'utf8'), /note from OpenCode/);
const piCreated = resolveOrCreateParentArtifactSession({
  parentPiSessionId: 'ses-shared-pi',
  projectRoot,
});
const ocFound = parentArtifactSession(ctx('ses-shared-pi'));
assert.equal(ocFound.sessionPath, piCreated.sessionPath, 'OpenCode finds a Pi-created session');
console.log('PASS Pi and OpenCode resolve the same session and share notes');

// 4. Disabled fieldnotes stay off, including a mid-session flip (snapshot).
const disabledRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-shepherd-oc-disabled-'));
const configFile = path.join(disabledRoot, '.shepherd', 'config.json');
fs.mkdirSync(path.dirname(configFile), { recursive: true });
const writeConfig = fieldnotes =>
  fs.writeFileSync(configFile, JSON.stringify({ projectScope: true, fieldnotes }));
writeConfig(false);
resetOpencodeFieldnotesCache();
assert.equal(parentArtifactSession(ctx('ses-no-notes', disabledRoot)), undefined);
assert.equal(fs.existsSync(path.join(disabledRoot, '.shepherd', 'sessions')), false);
writeConfig(true);
assert.equal(
  parentArtifactSession(ctx('ses-no-notes', disabledRoot)),
  undefined,
  'a mid-session config flip does not change an existing session'
);
assert.ok(
  parentArtifactSession(ctx('ses-with-notes', disabledRoot)),
  'a new session observes the updated setting'
);
console.log('PASS disabled fieldnotes stay off, and the setting is session-scoped');

// 5. Wiring: spawn resolves and threads the session into both runtimes;
//    delegate re-resolves so it always reserves a note.
const actionsSource = fs.readFileSync(new URL('../src/opencode/actions.ts', import.meta.url), 'utf8');
assert.match(actionsSource, /const artifactSession = parentArtifactSession\(ctx\)/);
assert.equal(
  (actionsSource.match(/artifactSession,\n\s+launch: \{\s*\.\.\.OPENCODE_LAUNCH_OVERRIDES\s*\}/g) ?? [])
    .length,
  2
);
assert.match(actionsSource, /runtimeFor\(ctx, backend, parentArtifactSession\(ctx\)\)/);
assert.match(actionsSource, /fieldnote: \$\{artifactSession\.sessionRelativePath\}/);
console.log('PASS spawn/delegate thread the resolved artifact session into both runtimes');

console.log('\nAll OpenCode fieldnote assertions passed.');
