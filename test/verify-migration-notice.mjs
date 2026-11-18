#!/usr/bin/env node
/** T018 — one-time farewell notice, human sessions only, per host marker. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-shepherd-migration-'));
const piAgentDir = path.join(tmp, 'pi-agent');
const ocAgentDir = path.join(tmp, 'opencode');
fs.mkdirSync(piAgentDir, { recursive: true });
fs.mkdirSync(ocAgentDir, { recursive: true });

const { setHostCapabilities } = await import('../src/core/host.ts');
const { migrationNoticeOnce, migrationMarkerFile, MIGRATION_NOTICE, NEW_PACKAGE_NAME } = await import(
  '../src/core/migration.ts'
);

const installHost = agentDir =>
  setHostCapabilities({
    getAgentDir: () => agentDir,
    projectConfigDirName: '.pi',
    dataDirName: 'pi-shepherd',
    parseFrontmatter: () => ({ frontmatter: {}, body: '' }),
  });

delete process.env.PI_SHEPHERD_SESSION;
delete process.env.SHEPHERD_TASK_ID;
installHost(piAgentDir);
const marker = migrationMarkerFile();
assert.equal(marker, path.join(piAgentDir, 'pi-shepherd', 'migration-notice.json'));
assert.equal(migrationNoticeOnce(), MIGRATION_NOTICE);
assert.match(MIGRATION_NOTICE, /@luminascale\/shepherd/);
assert.equal(fs.existsSync(marker), true, 'marker is written under the Pi agent dir');
assert.equal(migrationNoticeOnce(), undefined, 'never shown twice in the same host');
console.log('PASS Pi host shows the notice once and records a marker');

// Child sheep processes load the same package but must not see the notice.
fs.rmSync(marker);
process.env.PI_SHEPHERD_SESSION = '/tmp/child.jsonl';
assert.equal(migrationNoticeOnce(), undefined, 'Pi-launched child is skipped');
assert.equal(fs.existsSync(marker), false, 'a skipped child writes no marker');
delete process.env.PI_SHEPHERD_SESSION;
process.env.SHEPHERD_TASK_ID = 'shepherd-task-child';
assert.equal(migrationNoticeOnce(), undefined, 'OpenCode-launched child is skipped');
assert.equal(fs.existsSync(marker), false);
delete process.env.SHEPHERD_TASK_ID;
console.log('PASS child sheep processes never see or consume the notice');

// A different host user has its own marker, so it gets its own one-time show.
installHost(ocAgentDir);
assert.equal(migrationNoticeOnce(), MIGRATION_NOTICE);
assert.equal(fs.existsSync(path.join(ocAgentDir, 'pi-shepherd', 'migration-notice.json')), true);
assert.equal(migrationNoticeOnce(), undefined);
console.log('PASS marker is per host user, not global');

const readme = fs.readFileSync(new URL('../README.md', import.meta.url), 'utf8');
assert.match(readme, /Farewell to `@luminascale\/pi-shepherd`/);
assert.ok(readme.includes(NEW_PACKAGE_NAME), 'README banner names the new package');
const indexSource = fs.readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
assert.match(indexSource, /migrationNoticeOnce\(\)/);
assert.match(
  indexSource,
  /customType: 'shepherd-migration-notice'[\s\S]{0,180}deliverAs: 'followUp'/,
  'Pi notice uses followUp delivery so an idle session renders it without a turn'
);
const serverSource = fs.readFileSync(new URL('../src/opencode/server.ts', import.meta.url), 'utf8');
assert.match(serverSource, /migrationNoticeOnce\(\)/);
assert.match(serverSource, /!isSheepSession\(sessionID\)/, 'OpenCode notice is human-only');
const releasing = fs.readFileSync(new URL('../docs/releasing.md', import.meta.url), 'utf8');
assert.match(releasing, /npm deprecate @luminascale\/pi-shepherd/);
console.log('PASS both hosts, README banner, and release ordering are wired');

console.log('\nAll migration-notice assertions passed.');
