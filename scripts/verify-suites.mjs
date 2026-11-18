#!/usr/bin/env node
/**
 * Mirrored verification harnesses (T016).
 *
 * Partitions the `*:test` scripts into the Pi-side and OpenCode-side suites
 * and runs one suite in fresh child processes. `npm test` chains both, so a
 * change on either side gates the whole package. The lists are derived from
 * package.json, so a new test script cannot silently escape both suites.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const repo = path.resolve(import.meta.dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'));

const OPENCODE_SUITE = new Set([
  'opencode-display:test',
  'opencode-notice:test',
  'opencode-nudge:test',
  'opencode-fieldnotes:test',
  'opencode-surface:test',
  'cross-host-notes:test',
  'packaging:test',
  'host-docs:test',
  'host-impact:test',
  'migration-notice:test',
  'rename-migration:test',
]);

const suite = process.argv[2];
if (suite !== 'pi' && suite !== 'opencode') {
  console.error('usage: node scripts/verify-suites.mjs <pi|opencode>');
  process.exit(2);
}
const names = Object.keys(pkg.scripts)
  .filter(
    name =>
      name.endsWith(':test') &&
      name !== 'smoke:poll' &&
      name !== 'pi-suite:test' &&
      name !== 'opencode-suite:test'
  )
  .filter(name => OPENCODE_SUITE.has(name) === (suite === 'opencode'));

if (names.length === 0) {
  console.error(`no tests found for the ${suite} suite`);
  process.exit(2);
}
console.log(`== ${suite} suite: ${names.length} test scripts ==`);
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('npm_config_')));
const failed = [];
for (const name of names) {
  const result = spawnSync(pkg.scripts[name], {
    shell: true,
    cwd: repo,
    stdio: 'inherit',
    env,
  });
  if (result.status !== 0) failed.push(name);
}
if (failed.length) {
  console.error(`\n${suite} suite FAILED: ${failed.join(', ')}`);
  process.exit(1);
}
console.log(`\n${suite} suite OK (${names.length} scripts)`);
