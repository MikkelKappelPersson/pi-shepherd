#!/usr/bin/env node
/**
 * T014 — one package, two host entries.
 *
 * Verifies the manifest exposes the Pi extension entry and the OpenCode
 * plugin entry, that a fresh tarball install contains both, and that a bare
 * package import resolves to the OpenCode plugin (what `plugins` in
 * opencode.json loads) without dragging in a host-specific tool path.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const repo = path.resolve(import.meta.dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'));

assert.deepEqual(manifest.pi?.extensions, ['./index.ts'], 'Pi extension entry is declared');
assert.ok(fs.existsSync(path.join(repo, 'index.ts')), 'Pi extension entry exists');
const opencodeEntry = manifest.exports?.['.'];
assert.ok(typeof opencodeEntry === 'string', 'package root exports the OpenCode entry');
assert.equal(opencodeEntry, './src/opencode/server.ts');
assert.ok(fs.existsSync(path.join(repo, opencodeEntry)), 'OpenCode plugin entry exists');
const pluginSource = fs.readFileSync(path.join(repo, opencodeEntry), 'utf8');
assert.match(pluginSource, /from "@opencode\/plugin"/);
assert.match(pluginSource, /Plugin\.define\(/);
assert.match(pluginSource, /id: "shepherd"/);
console.log('PASS manifest declares both host entries');

// The lockfile must track the published package identity, not the pre-rename
// name. `npm ci` tolerates the drift, but `npm pack`/publish metadata should
// never disagree with the manifest.
const lockfile = JSON.parse(fs.readFileSync(path.join(repo, 'package-lock.json'), 'utf8'));
assert.equal(lockfile.name, manifest.name, 'lockfile name matches the manifest');
assert.equal(lockfile.version, manifest.version, 'lockfile version matches the manifest');
assert.equal(lockfile.packages?.['']?.name, manifest.name, 'root lockfile entry name matches');
console.log('PASS lockfile identity matches the manifest');

// OpenDock and similar OpenCode directories discover plugins by npm keyword.
assert.ok(
  manifest.keywords?.includes('opencode-plugin'),
  'npm metadata carries the opencode-plugin discovery keyword'
);
console.log('PASS npm metadata is discoverable as an OpenCode plugin');

// Pack and install into an isolated consumer, the way each host's docs say.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-shepherd-packaging-'));
const packResult = JSON.parse(
  execFileSync('npm', ['pack', '--json', '--pack-destination', tmp], {
    cwd: repo,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
);
const packed = Array.isArray(packResult) ? packResult[0] : Object.values(packResult)[0];
const tarball = path.join(tmp, packed.filename);
assert.ok(fs.existsSync(tarball), 'npm pack produced a tarball');
const names = new Set(packed.files.map(f => f.path));
assert.ok(names.has('index.ts'), 'tarball contains the Pi extension');
assert.ok(names.has('src/opencode/server.ts'), 'tarball contains the OpenCode plugin');
assert.ok(names.has('src/core/artifact-sessions.ts'), 'tarball contains the shared engine');
assert.ok(names.has('README.md'), 'tarball contains host docs');
console.log('PASS tarball contains both host entries and the shared engine');

const consumer = path.join(tmp, 'consumer');
fs.mkdirSync(consumer, { recursive: true });
fs.writeFileSync(
  path.join(consumer, 'package.json'),
  JSON.stringify({ name: 'shepherd-consumer', private: true, version: '1.0.0' })
);
// `npm run` exports npm_config_* values that a nested npm treats as a
// project-scoped script-approval directive; strip them for the fresh install.
const cleanEnv = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith('npm_config_'))
);
execFileSync('npm', ['install', tarball, '--legacy-peer-deps', '--no-audit', '--no-fund'], {
  cwd: consumer,
  env: cleanEnv,
  stdio: 'ignore',
});
const resolved = execFileSync(
  process.execPath,
  ['--input-type=module', '-e', 'console.log(import.meta.resolve("@luminascale/shepherd"))'],
  { cwd: consumer, encoding: 'utf8' }
).trim();
assert.match(resolved, /src[\\/]opencode[\\/]server\.ts$/, 'bare import resolves to the OpenCode plugin');
const installedManifest = JSON.parse(
  fs.readFileSync(path.join(consumer, 'node_modules', '@luminascale', 'shepherd', 'package.json'), 'utf8')
);
assert.deepEqual(
  installedManifest.pi.extensions,
  ['./index.ts'],
  'installed manifest still declares the Pi entry'
);
console.log('PASS fresh install resolves both host entries independently');

console.log('\nAll packaging assertions passed.');
