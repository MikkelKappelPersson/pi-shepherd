#!/usr/bin/env node
/**
 * T015 — README stays streamlined: host-neutral intro plus a compact install
 * picker on the first screen, with full per-host steps in a linked guide.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
const guide = fs.readFileSync(path.join(root, 'docs/guides/installation.md'), 'utf8');
const docsIndex = fs.readFileSync(path.join(root, 'docs/README.md'), 'utf8');
const sharedHeading = '## Key Features';
const firstScreen = readme.slice(0, readme.indexOf(sharedHeading) + sharedHeading.length);

assert.match(
  firstScreen,
  /<p align="center">[\s\S]{0,160}<strong>SHEPHERD<\/strong>/,
  'host-neutral centered title banner'
);
assert.match(firstScreen, /## Install/, 'compact install section is on the first screen');
assert.match(firstScreen, /pi install npm:@luminascale\/shepherd/, 'Pi install command is shown');
assert.match(firstScreen, /`@luminascale\/shepherd` to `plugins`/, 'OpenCode plugin entry is shown');
assert.match(firstScreen, /\/shepherd agents/, 'verify command is shared by both hosts');
assert.match(
  firstScreen,
  /\[installation guide\]\(docs\/guides\/installation\.md\)/,
  'README links to the detailed guide'
);
assert.equal((readme.match(/^## Install$/gm) ?? []).length, 1, 'one install section, no duplicate');
assert.doesNotMatch(readme, /^## (Pi|OpenCode) track$/m, 'detailed tracks moved out of the README');
console.log('PASS README first screen has a compact host-neutral install picker');

assert.match(guide, /^# Installation$/m, 'guide has its own title');
const pi = guide.indexOf('## Pi');
const oc = guide.indexOf('## OpenCode');
assert.ok(pi > -1 && oc > pi, 'guide has Pi and OpenCode sections');
const piSection = guide.slice(pi, oc);
const ocSection = guide.slice(oc);
assert.match(piSection, /pi install npm:@luminascale\/shepherd/, 'Pi install command is in the guide');
assert.match(piSection, /\/shepherd agents/, 'Pi verify command is in the guide');
assert.match(piSection, /\/shepherd settings/, 'Pi settings surface is in the guide');
assert.doesNotMatch(piSection, /You do not\s+need to install pi/);
assert.match(
  ocSection,
  /"plugins": \["@luminascale\/shepherd"\]/,
  'OpenCode plugin config is in the guide'
);
assert.match(
  ocSection,
  /You do not\s+need to install pi/,
  'OpenCode-only note stays in its section'
);
assert.match(ocSection, /display-only/, 'OpenCode command behavior is in the guide');
assert.match(ocSection, /reap/, 'OpenCode orphan recovery is in the guide');
assert.match(docsIndex, /\[Installation\]\(guides\/installation\.md\)/, 'docs index lists the guide');
console.log('PASS installation guide keeps both hosts and their differences');

console.log('\nAll host-doc assertions passed.');
