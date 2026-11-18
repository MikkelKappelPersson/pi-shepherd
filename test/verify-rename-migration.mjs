#!/usr/bin/env node
/**
 * T019 — `@luminascale/pi-shepherd` → `@luminascale/shepherd`.
 *
 * Verifies the npm name changed while functional identifiers stayed frozen,
 * and simulates old-install → remove → new-install to prove settings and
 * herd registrations survive (SC-005).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const repo = path.resolve(import.meta.dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'));
assert.equal(pkg.name, '@luminascale/shepherd', 'manifest carries the new npm name');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-shepherd-rename-'));
process.env.HOME = tmp;
process.env.PI_CODING_AGENT_DIR = path.join(tmp, 'pi-agent');
process.env.OPENCODE_CONFIG_DIR = path.join(tmp, 'opencode');
const { setHostCapabilities } = await import('../src/core/host.ts');
setHostCapabilities({
  getAgentDir: () => process.env.PI_CODING_AGENT_DIR,
  projectConfigDirName: '.pi',
  dataDirName: 'pi-shepherd',
  parseFrontmatter: () => ({ frontmatter: {}, body: '' }),
});
const { hostCapabilities } = await import('../src/core/host.ts');
const { loadSettings, userConfigFile } = await import('../src/core/config.ts');
const { loadCreatedPanes } = await import('../src/runtimes/herdr/herdr.ts');

const dataDir = path.join(hostCapabilities().getAgentDir(), hostCapabilities().dataDirName);
assert.equal(dataDir, path.join(tmp, 'pi-agent', 'pi-shepherd'), 'user data path stays frozen');
const settingsFile = userConfigFile();
const registryFile = path.join(dataDir, 'created-panes.json');

// Frozen functional identifiers must not mention the package name.
assert.equal(hostCapabilities().dataDirName, 'pi-shepherd');
assert.equal(path.basename(settingsFile), 'config.json');
assert.doesNotMatch(fs.readFileSync(path.join(repo, 'src/opencode/host.ts'), 'utf8'), /@luminascale\//);
const configSource = fs.readFileSync(path.join(repo, 'src/core/config.ts'), 'utf8');
assert.match(configSource, /['"]\.shepherd['"]/);
assert.match(configSource, /['"]config\.json['"]/);
console.log('PASS npm name changed; tool/env/config/registry identifiers stay frozen');

// Old install: data in the frozen paths, plus an old-name package directory.
const oldPackageDir = path.join(tmp, 'consumer', 'node_modules', '@luminascale', 'pi-shepherd');
fs.mkdirSync(oldPackageDir, { recursive: true });
fs.writeFileSync(
  path.join(oldPackageDir, 'package.json'),
  JSON.stringify({ name: '@luminascale/pi-shepherd', version: '0.5.1' })
);
fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
fs.writeFileSync(
  settingsFile,
  JSON.stringify({ timeout: 17, fieldnotes: false, backend: 'herdr', projectScope: false })
);
fs.writeFileSync(
  registryFile,
  JSON.stringify([
    {
      paneId: 'wF:p7',
      name: 'scout',
      cwd: tmp,
      createdAt: 1234,
      ownerSession: 'ses-old-install',
      dir: path.join(tmp, 'launch-old'),
    },
  ])
);
assert.equal(loadSettings().timeout, 17);
assert.equal(loadSettings().fieldnotes, false);
assert.equal(loadCreatedPanes()[0].ownerSession, 'ses-old-install');
console.log('PASS old install has settings and a live herd registration');

// Remove old install, then install the renamed package from a fresh tarball.
fs.rmSync(path.join(tmp, 'consumer', 'node_modules'), { recursive: true, force: true });
const consumer = path.join(tmp, 'consumer');
fs.mkdirSync(consumer, { recursive: true });
fs.writeFileSync(
  path.join(consumer, 'package.json'),
  JSON.stringify({ name: 'rename-consumer', private: true, version: '1.0.0' })
);
const packResult = JSON.parse(
  execFileSync('npm', ['pack', '--json', '--pack-destination', tmp], {
    cwd: repo,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
);
const packed = Array.isArray(packResult) ? packResult[0] : Object.values(packResult)[0];
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('npm_config_')));
execFileSync('npm', ['install', path.join(tmp, packed.filename), '--legacy-peer-deps', '--no-audit', '--no-fund'], {
  cwd: consumer,
  env,
  stdio: 'ignore',
});
assert.equal(fs.existsSync(path.join(consumer, 'node_modules', '@luminascale', 'shepherd')), true);
assert.equal(fs.existsSync(oldPackageDir), false, 'old name is gone after remove + install');
assert.equal(loadSettings().timeout, 17, 'settings survive the rename');
assert.equal(loadSettings().fieldnotes, false);
assert.equal(loadCreatedPanes()[0].ownerSession, 'ses-old-install', 'herd survives the rename');
assert.match(
  fs.readFileSync(settingsFile, 'utf8'),
  /"timeout":17/,
  'frozen user config file was not rewritten'
);
console.log('PASS remove + new install keeps settings and herd intact (SC-005)');

console.log('\nAll rename assertions passed.');
