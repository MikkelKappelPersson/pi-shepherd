#!/usr/bin/env node
/**
 * Focused verification: the OpenCode human `/shepherd` command displays its
 * result in full without starting an assistant turn (spec 013, T011 finding).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';

const { displayCommandOutput, supportsDisplayOnly } = await import('../src/opencode/display.ts');

const calls = [];
const ctx = {
  session: {
    prompt: async input => { calls.push(['prompt', input]); },
  },
};

const text = '[shepherd agents]\nreviewer (user)\nworker (user)\nplanner (project)\nscout (project)';
await displayCommandOutput(ctx, 'sess-1', text);
assert.equal(calls.length, 1, 'exactly one delivery');
assert.equal(calls[0][0], 'prompt', 'uses a normal session prompt so the full multi-line text renders');
assert.deepEqual(
  calls[0][1],
  { sessionID: 'sess-1', text, resume: false },
  'resume:false suppresses the model wake (no assistant turn)'
);

assert.equal(supportsDisplayOnly(ctx), true, 'detects the session primitive');
const legacy = { session: { synthetic() {} } };
assert.equal(supportsDisplayOnly(legacy), false, 'detects a host without the primitive');
await assert.rejects(
  () => displayCommandOutput(legacy, 'sess-1', 'x'),
  /session\.prompt is unavailable/,
  'fails loudly rather than starting a turn'
);

// Source guard: the command handler must not call ctx.session.prompt directly
// (only via the helper). Parent-session notices elsewhere may.
const source = fs.readFileSync(new URL('../src/opencode/server.ts', import.meta.url), 'utf8');
const commandStart = source.indexOf('await ctx.command.transform');
assert.ok(commandStart >= 0, 'command transform is registered');
const commandBlock = source.slice(commandStart);
const directPrompts = commandBlock.match(/ctx\.session\.prompt/g) ?? [];
assert.equal(directPrompts.length, 0, 'command block contains no direct session.prompt call');
assert.ok(commandBlock.includes('showCommandOutput'), 'command block uses the display-only helper');

console.log('opencode command display: ok');
