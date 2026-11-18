#!/usr/bin/env node
/**
 * T015 — README splits into per-host tracks on the first screen, so a user
 * of either host can find their install steps without reading the other's.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const readme = fs.readFileSync(path.resolve(import.meta.dirname, '../README.md'), 'utf8');
const firstScreen = readme.split('\n').slice(0, 60).join('\n');

assert.match(firstScreen, /^# Shepherd$/m, 'host-neutral title');
assert.match(firstScreen, /## Choose your host/, 'host picker is on the first screen');
const piTrack = firstScreen.indexOf('## Pi track');
const ocTrack = firstScreen.indexOf('## OpenCode track');
const sharedContent = firstScreen.indexOf('## Key Features');
assert.ok(piTrack > -1 && ocTrack > -1, 'both host tracks are on the first screen');
assert.ok(piTrack < sharedContent && ocTrack < sharedContent, 'tracks precede shared content');
assert.match(firstScreen, /\[Pi\]\(#pi-track\)/, 'Pi track is linked from the picker');
assert.match(firstScreen, /\[OpenCode\]\(#opencode-track\)/, 'OpenCode track is linked from the picker');
assert.match(firstScreen, /pi install npm:@luminascale\/pi-shepherd/, 'Pi install command is shown');
assert.match(
  firstScreen,
  /"plugins": \["@luminascale\/pi-shepherd"\]/,
  'OpenCode plugin config is shown'
);
assert.equal((readme.match(/^## Install$/gm) ?? []).length, 0, 'no duplicate Pi-only Install section');
const piTrackText = readme.slice(piTrack, ocTrack);
const ocTrackText = readme.slice(ocTrack, sharedContent);
assert.doesNotMatch(piTrackText, /You do not need to install pi/);
assert.match(ocTrackText, /You do not need to install pi/, 'OpenCode-only note stays in its track');
console.log('PASS README first screen splits into Pi and OpenCode tracks');

console.log('\nAll host-doc assertions passed.');
