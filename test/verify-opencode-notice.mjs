#!/usr/bin/env node
/**
 * Focused verification: completion notices reach only human parent sessions,
 * and a transient parent-busy failure is retried instead of dropped
 * (spec 013, T011 watcher-notice finding).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  bindChildSession,
  forgetTaskParent,
  isParentSession,
  isSheepSession,
  markParentSession,
  noteTaskParent,
  recordSheepSpawn,
} from '../src/opencode/bridge.ts';

// A sheep session must never be registered as a completion-notice recipient,
// even if the caller learned the task id (relayed question, peer reply, ...).
recordSheepSpawn({
  agentId: 'sheep-agent-test',
  backend: 'pane',
  cwd: '/tmp',
  parentSessionId: 'parent-session',
  childCapability: 'oc',
  brokerRootDir: '/tmp',
  brokerSessionId: 'broker',
  brokerId: 'broker',
  parentBrokerId: 'parent-broker',
  spawnedAt: 0,
});
// A pre-binding parent-tool call marks the session as a parent; binding as a
// sheep must win so the sheep can use shepherd_message for peer replies.
markParentSession('sheep-session');
assert.equal(isParentSession('sheep-session'), true, 'an unbound caller can be marked parent');
bindChildSession('sheep-agent-test', 'sheep-session');
assert.equal(isSheepSession('sheep-session'), true, 'sheep session is recognised');
assert.equal(isParentSession('sheep-session'), false, 'sheep binding clears the stale parent mark');
markParentSession('sheep-session');
assert.equal(isParentSession('sheep-session'), false, 're-marking a bound sheep is a no-op');
noteTaskParent('task-1', 'sheep-session');

// A human parent session is still registered.
markParentSession('parent-session');
assert.equal(isParentSession('parent-session'), true, 'parent session is recognised');
noteTaskParent('task-1', 'parent-session');
forgetTaskParent('task-1');

// Source guards: both entry points refuse sheep sessions, and promptParent
// retries rather than swallowing the first failure.
const source = fs.readFileSync(new URL('../src/opencode/bridge.ts', import.meta.url), 'utf8');
const guardCount = (source.match(/if \(!parentSessionId \|\| isSheepSession\(parentSessionId\)\) return/g) ?? []).length;
assert.ok(guardCount >= 1, 'notice delivery refuses sheep sessions');
assert.ok(
  /if \(!parentSessionId \|\| isSheepSession\(parentSessionId\)\) return;\s*\n\s*parentMapFor/.test(source),
  'noteTaskParent refuses sheep sessions'
);
assert.ok(source.includes('PARENT_NOTICE_RETRIES = 3'), 'notice delivery is bounded-retry');
assert.ok(
  /for \(let attempt = 0; attempt < PARENT_NOTICE_RETRIES; attempt\+\+\)/.test(source),
  'promptParent retries on failure'
);
assert.ok(!/await ctx\.session\.prompt\(\{ sessionID: parentSessionId, text: content \}\);\s*\}\s*catch \{\s*\}\s*\}/.test(source),
  'the old silent-drop catch is gone');

const roleSource = fs.readFileSync(new URL('../src/opencode/bridge.ts', import.meta.url), 'utf8');
assert.ok(
  /return parentSessions\.has\(sessionId\) && !isSheepSession\(sessionId\)/.test(roleSource),
  'isParentSession excludes sheep sessions'
);
assert.ok(
  /parentSessions\.delete\(childSessionId\)/.test(roleSource),
  'bindChildSession clears stale parent marks'
);

console.log('opencode notice routing: ok');
