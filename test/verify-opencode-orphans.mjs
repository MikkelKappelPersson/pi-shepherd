#!/usr/bin/env node
/** Reload resilience — orphan detection, one-time notice, and ownership-safe reap. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-shepherd-orphans-'));
process.env.HOME = home;
process.env.OPENCODE_CONFIG_DIR = path.join(home, 'config', 'opencode');
const bin = path.join(home, 'bin');
fs.mkdirSync(bin, { recursive: true });
fs.mkdirSync(process.env.OPENCODE_CONFIG_DIR, { recursive: true });

const panesFile = path.join(home, 'panes.txt');
const terminalsFile = path.join(home, 'terminals.txt');
fs.writeFileSync(panesFile, 'p1\n');
fs.writeFileSync(terminalsFile, 't1\n');
fs.writeFileSync(
  path.join(bin, 'herdr'),
  `#!/bin/sh
if [ "$1" = "--version" ]; then echo herdr-test; exit 0; fi
if [ "$1 $2" = "pane list" ]; then
  printf '{"id":"cli:pane:list","result":{"panes":['
  first=1
  while read -r id; do [ -z "$id" ] && continue; [ $first -eq 0 ] && printf ','; printf '{"pane_id":"%s"}' "$id"; first=0; done < '${panesFile}'
  printf ']}}'; exit 0
fi
if [ "$1 $2" = "pane close" ]; then
  grep -vx "$3" '${panesFile}' > '${panesFile}.tmp' || true
  mv '${panesFile}.tmp' '${panesFile}'
  echo '{"id":"cli:pane:close","result":{}}'; exit 0
fi
echo '{"id":"cli:ok","result":{}}'
`
);
fs.writeFileSync(
  path.join(bin, 'hc'),
  `#!/bin/sh
if [ "$1" = "--version" ]; then echo hc-test; exit 0; fi
if [ "$1" = "get" ]; then
  grep -qx "$2" '${terminalsFile}' && echo '{"address":"addr","state":"live"}' || echo '{"kind":"not_found"}'
  exit 0
fi
if [ "$1" = "kill" ] || [ "$1" = "rm" ]; then
  grep -vx "$2" '${terminalsFile}' > '${terminalsFile}.tmp' || true
  mv '${terminalsFile}.tmp' '${terminalsFile}'
fi
echo '{"id":"cli:ok","result":{}}'
`
);
fs.chmodSync(path.join(bin, 'herdr'), 0o755);
fs.chmodSync(path.join(bin, 'hc'), 0o755);
process.env.PATH = `${bin}${path.delimiter}${process.env.PATH ?? ''}`;

const dataDir = path.join(process.env.OPENCODE_CONFIG_DIR, 'pi-shepherd');
fs.mkdirSync(dataDir, { recursive: true });
const paneDir = path.join(home, 'launch-p1');
const terminalDir = path.join(home, 'launch-t1');
fs.mkdirSync(paneDir, { recursive: true });
fs.mkdirSync(terminalDir, { recursive: true });
const writeRegistries = () => {
  fs.writeFileSync(
    path.join(dataDir, 'created-panes.json'),
    JSON.stringify([
      {
        paneId: 'p1',
        name: 'scout',
        cwd: home,
        createdAt: 1,
        dir: paneDir,
        ownerSession: 'ses-owner',
      },
    ])
  );
  fs.writeFileSync(
    path.join(dataDir, 'created-terminals.json'),
    JSON.stringify([
      {
        terminalId: 't1',
        name: 'worker',
        cwd: home,
        createdAt: 1,
        dir: terminalDir,
        ownerSession: 'ses-owner',
      },
    ])
  );
};
writeRegistries();

const { installOpencodeHost } = await import('../src/opencode/host.ts');
installOpencodeHost();
const { findOrphans, noticeNewOrphans, reapOrphans } = await import('../src/opencode/orphans.ts');

const orphans = findOrphans();
assert.deepEqual(
  orphans.map(o => o.backend).sort(),
  ['hc', 'herdr'],
  'live owned transports with no in-memory SheepRecord are orphans'
);
console.log('PASS live owned transports are detected as orphans');

const prompts = [];
const ctx = { session: { prompt: async input => prompts.push(input) } };
await noticeNewOrphans(ctx);
assert.equal(prompts.length, 1, 'one notice to the owning session');
assert.equal(prompts[0].sessionID, 'ses-owner');
assert.equal(prompts[0].resume, false, 'notice is display-only, no assistant turn');
assert.match(prompts[0].text, /action "reap"/);
assert.match(prompts[0].text, /scout/);
assert.doesNotMatch(prompts[0].text, /p1/, 'native pane ids never leak into the notice');
await noticeNewOrphans(ctx);
assert.equal(prompts.length, 1, 'the same orphan set is not reported twice');
console.log('PASS one-time display-only orphan notice');

// A new orphan after reload is reported once too.
fs.writeFileSync(panesFile, 'p1\np2\n');
fs.writeFileSync(
  path.join(dataDir, 'created-panes.json'),
  JSON.stringify([
    ...JSON.parse(fs.readFileSync(path.join(dataDir, 'created-panes.json'), 'utf8')),
    { paneId: 'p2', name: 'reviewer', cwd: home, createdAt: 2, ownerSession: 'ses-owner' },
  ])
);
await noticeNewOrphans(ctx);
assert.equal(prompts.length, 2, 'a newly orphaned sheep gets its own notice');
assert.match(prompts[1].text, /reviewer/);
console.log('PASS newly orphaned sheep are reported without repeating old ones');

// Reap closes only orphans owned by the caller and clears their registrations.
const result = reapOrphans('ses-owner');
assert.match(result, /reaped 3 orphaned sheep/);
assert.equal(fs.readFileSync(panesFile, 'utf8').trim(), '');
assert.equal(fs.readFileSync(terminalsFile, 'utf8').trim(), '');
assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dataDir, 'created-panes.json'), 'utf8')), []);
assert.deepEqual(
  JSON.parse(fs.readFileSync(path.join(dataDir, 'created-terminals.json'), 'utf8')),
  []
);
assert.equal(fs.existsSync(paneDir), false, 'launch dir cleaned');
assert.equal(fs.existsSync(terminalDir), false);
assert.deepEqual(findOrphans(), []);
assert.match(reapOrphans('ses-owner'), /No orphaned sheep/);
console.log('PASS ownership-safe reap closes sheep, clears registries, and cleans launch dirs');

// A different owner's entry is never reaped by this session.
fs.writeFileSync(panesFile, 'p3\n');
fs.writeFileSync(
  path.join(dataDir, 'created-panes.json'),
  JSON.stringify([
    { paneId: 'p3', name: 'planner', cwd: home, createdAt: 3, ownerSession: 'ses-other' },
  ])
);
assert.deepEqual(findOrphans('ses-owner'), [], 'other sessions are filtered out');
assert.match(reapOrphans('ses-owner'), /No orphaned sheep/);
assert.equal(fs.readFileSync(panesFile, 'utf8').trim(), 'p3');
console.log('PASS reap never touches another session’s sheep');

console.log('\nAll orphan-recovery assertions passed.');
