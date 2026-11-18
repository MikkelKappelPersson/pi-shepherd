#!/usr/bin/env node
/**
 * Classify a change set by host for release notes (T017).
 *
 * Usage:
 *   node scripts/host-impact.mjs <git-range>       e.g. v0.5.1..HEAD
 *   node scripts/host-impact.mjs --files a,b,c     synthetic/uncommitted set
 *
 * Print-only: the verdict informs the release notes; it never blocks a build.
 */
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error('usage: node scripts/host-impact.mjs <git-range> | --files a,b,c');
  process.exit(2);
}

let files;
if (args[0] === '--files') {
  files = (args[1] ?? '').split(',').map(s => s.trim()).filter(Boolean);
} else {
  files = execFileSync('git', ['diff', '--name-only', args.join(' ')], {
    encoding: 'utf8',
  })
    .split('\n')
    .map(s => s.trim())
    .filter(Boolean);
}

const groups = { pi: [], opencode: [], shared: [], docs: [] };
for (const file of files) {
  const normalized = file.replace(/\\/g, '/');
  if (normalized.startsWith('src/opencode/') || normalized.includes('/src/opencode/'))
    groups.opencode.push(file);
  else if (
    normalized === 'index.ts' ||
    normalized.startsWith('src/extension/') ||
    normalized.includes('/src/extension/')
  )
    groups.pi.push(file);
  else if (
    normalized.startsWith('src/') ||
    normalized.includes('/src/') ||
    normalized === 'package.json' ||
    normalized.endsWith('/package.json')
  )
    groups.shared.push(file);
  else groups.docs.push(file);
}

const label = {
  pi: 'Pi-only files',
  opencode: 'OpenCode-only files',
  shared: 'Shared engine/runtime/packaging files (cross-host)',
  docs: 'Docs/tests/spec files (no runtime impact)',
};
for (const key of ['pi', 'opencode', 'shared', 'docs']) {
  console.log(`${label[key]}: ${groups[key].length}`);
  for (const file of groups[key]) console.log(`  ${file}`);
}

const codeHosts = [groups.pi.length > 0, groups.opencode.length > 0].filter(Boolean).length;
const verdict =
  codeHosts === 0 && groups.shared.length === 0
    ? 'docs-and-tests-only release'
    : codeHosts === 0
      ? 'shared-engine release — call out impact for BOTH hosts'
      : codeHosts === 2 || groups.shared.length > 0
        ? 'cross-host release — call out impact for BOTH hosts'
        : groups.pi.length > 0
          ? 'Pi-only code release — OpenCode impact must be none'
          : 'OpenCode-only code release — Pi impact must be none';
console.log(`\nVerdict: ${verdict}`);
