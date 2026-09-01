#!/usr/bin/env node
/** Compatibility verification after removal of the blocking shepherd_wait tool. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { registerShepherdTools } from '../src/extension/shepherd.ts';

const registered = [];
registerShepherdTools({ registerTool(tool) { registered.push(tool); }, registerMessageRenderer() {} });
const byName = Object.fromEntries(registered.map(tool => [tool.name, tool]));
assert.equal(byName.shepherd_wait, undefined, 'blocking shepherd_wait is removed from the public surface');
assert.ok(byName.shepherd_watch, 'shepherd_watch remains available');
assert.match(byName.shepherd_watch.description, /non-blocking/i);
assert.match(JSON.stringify(byName.shepherd_watch.promptGuidelines), /status/i);
const promptParams = JSON.stringify(byName.shepherd_prompt.parameters);
assert.match(promptParams, /shepherd_watch/i, 'deprecated prompt path points at shepherd_watch');
const handoffPath = fileURLToPath(new URL('../docs/specs/001-agent-messaging-and-task-lifecycle/handoff.md', import.meta.url));
const handoff = readFileSync(handoffPath, 'utf8');
assert.match(handoff, /shepherd_wait.*removed|removed.*shepherd_wait/i, 'handoff records removal');
console.log('PASS shepherd_wait is hard-removed from the model-facing surface');
console.log('All compatibility assertions passed.');
