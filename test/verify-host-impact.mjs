#!/usr/bin/env node
/** T017 — release checklist and per-host impact classification. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const repo = path.resolve(import.meta.dirname, '..');
const script = path.join(repo, 'scripts', 'host-impact.mjs');
const impact = files =>
  execFileSync(process.execPath, [script, '--files', files.join(',')], {
    cwd: repo,
    encoding: 'utf8',
  });

assert.match(
  impact(['src/extension/shepherd.ts', 'index.ts', 'test/verify-parent-surface.mjs']),
  /Pi-only code release — OpenCode impact must be none/
);
assert.match(
  impact(['src/opencode/actions.ts', 'src/opencode/server.ts', 'test/verify-opencode-notice.mjs']),
  /OpenCode-only code release — Pi impact must be none/
);
assert.match(
  impact(['src/core/discovery.ts', 'package.json']),
  /shared-engine release — call out impact for BOTH hosts/
);
const mixed = impact(['src/extension/shepherd.ts', 'src/opencode/actions.ts']);
assert.match(mixed, /cross-host release — call out impact for BOTH hosts/);
assert.match(impact(['docs/releasing.md', 'test/verify-cli.mjs']), /docs-and-tests-only release/);
console.log('PASS host-impact classifies Pi-only, OpenCode-only, shared, mixed, and docs-only');

const checklist = fs.readFileSync(path.join(repo, 'docs', 'releasing.md'), 'utf8');
for (const item of [
  'npm test',
  'pi-suite:test',
  'opencode-suite:test',
  'host-impact',
  'Pi impact',
  'OpenCode impact',
  'new package first',
  '0.6.0',
  '0.5.2',
]) {
  assert.ok(checklist.includes(item), `release checklist covers: ${item}`);
}
console.log('PASS release checklist requires both suites and explicit per-host notes');

console.log('\nAll release-process assertions passed.');
