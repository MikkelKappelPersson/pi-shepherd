#!/usr/bin/env node
/**
 * Phase 10 compatibility verification.
 *
 * Decisions implemented (spec "Compatibility"):
 *   - shepherd_prompt: retained as a DEPRECATED compatibility path (one child
 *     turn per prompt). Its descriptions no longer present it as the primary
 *     way to assign work; they name the migration target (shepherd_delegate).
 *   - shepherd_wait: retained as a compatibility wait that now accepts
 *     TASK ids (preferred) in addition to legacy prompt ids. A wait timeout
 *     bounds the wait only — it never settles the underlying work — so no
 *     task or message depends on the parent calling shepherd_wait to
 *     make progress. New orchestration should use shepherd_watch instead;
 *     the wait descriptions say so explicitly.
 *
 * Behavioral coverage: task waits resolve in input order from terminal task
 * results, resolve instantly for already-settled tasks, reject unknown and
 * mixed ids, and time out without touching the tasks. The legacy prompt
 * path is unchanged (covered by the launch/watch suites).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { LifecycleRegistry, LifecycleError, lifecycleRegistry } from '../src/core/orchestration.ts';
import { doAction, registerShepherdTools } from '../src/extension/shepherd.ts';

// ── 1. Active tool descriptions are honest about the migration ──────────

const registered = [];
registerShepherdTools({
  registerTool(tool) { registered.push(tool); },
  registerMessageRenderer() {},
});

const byName = Object.fromEntries(registered.map(t => [t.name, t]));

const promptDesc = byName.shepherd_prompt.description;
assert.match(promptDesc, /Deprecated compatibility path/i,
  'shepherd_prompt is described as a deprecated compatibility path');
assert.match(promptDesc, /shepherd_delegate/,
  'shepherd_prompt points at its migration target shepherd_delegate');

const waitDesc = byName.shepherd_wait.description;
assert.match(waitDesc, /task ids \(from shepherd_delegate, preferred\)/i,
  'shepherd_wait presents task ids as the preferred target');
assert.match(waitDesc, /legacy prompt ids \(from shepherd_prompt\)/i,
  'shepherd_wait still documents the legacy prompt path');
assert.match(waitDesc, /timeout only ends the wait, not the work/i,
  'shepherd_wait states that a timeout never settles the work');

// The wait schema must accept a task id union member (flat object root stays).
const waitSchema = JSON.stringify(byName.shepherd_wait.parameters);
assert.ok(byName.shepherd_wait.parameters.type === 'object',
  'wait schema keeps the flat object root');
assert.match(waitSchema, /Opaque task id returned by shepherd_delegate/,
  'wait schema accepts opaque task ids');
assert.match(waitSchema, /Opaque prompt id returned by shepherd_prompt/,
  'wait schema still accepts legacy prompt ids');

// The deprecated prompt path still points its users at the wait tool for the
// result, so the legacy loop stays coherent; its timeout is the wait's, not
// the prompt's.
const promptParams = JSON.stringify(byName.shepherd_prompt.parameters);
assert.match(promptParams, /completion timeout belongs to shepherd_wait/i,
  'shepherd_prompt keeps its documented relation to shepherd_wait');

// ── 2. shepherd_wait task behavior (registry, hermetic) ─────────────────

const registry = new LifecycleRegistry();
const keepAlive = setInterval(() => undefined, 50); void keepAlive;
const worker = registry.registerAgent({ agent: 'worker', label: 'compat-worker' });
const scout = registry.registerAgent({ agent: 'scout', label: 'compat-scout' });

const taskA = registry.createTask(worker, 'first task');
const taskB = registry.createTask(scout, 'second task');
setTimeout(() => registry.settleTask(taskB.id, { status: 'completed', ok: true, text: 'B done' }), 40);
setTimeout(() => registry.settleTask(taskA.id, { status: 'completed', ok: true, text: 'A done' }), 80);
const results = await registry.waitForTasks([taskA.id, taskB.id], 5000);
assert.deepEqual(results.map(r => r.text), ['A done', 'B done'],
  'task wait results follow the input order even if B settles first');
assert.equal(results[0].ok, true);
console.log('PASS shepherd_wait task results resolve in input order');

const instant = await registry.waitForTasks(taskA.id, 1000);
assert.equal(instant[0].status, 'completed',
  'an already-settled task resolves without blocking');
console.log('PASS waiting on an already-settled task resolves instantly');

const hanging = registry.createTask(worker, 'long task');
let timedOut = null;
try {
  await registry.waitForTasks(hanging.id, 120);
} catch (error) {
  timedOut = error;
}
assert.ok(timedOut instanceof LifecycleError, 'a wait timeout rejects with a LifecycleError');
assert.equal(timedOut.code, 'timeout');
assert.match(timedOut.message, /watch them later with shepherd_watch/,
  'the timeout error steers the model toward shepherd_watch');
assert.equal(registry.getTask(hanging.id).state, 'created',
  'a wait timeout never settles, fails, or otherwise touches the task');
console.log('PASS a wait timeout only ends the wait; the task keeps running');

let unknownRejected = null;
try { registry.waitForTasks('shepherd-task-does-not-exist'); } catch (e) { unknownRejected = e; }
assert.ok(unknownRejected instanceof LifecycleError && unknownRejected.code === 'unknown_task',
  'unknown ids are rejected as unknown tasks');
console.log('PASS unknown wait ids are rejected (no silent agent/pane fallback)');

// ── 3. doAction('wait') on task ids: public mapping + validation ─────────

const pub = lifecycleRegistry;
const pubWorker = pub.registerAgent({ agent: 'worker', label: 'public-worker' });
const pubTask = pub.createTask(pubWorker, 'public wait task');
setTimeout(() => pub.settleTask(pubTask.id, { status: 'completed', ok: true, text: 'public done' }), 40);

const result = await doAction({ action: 'wait', id: pubTask.id }, { cwd: process.cwd() });
assert.equal(result.details.returnCode, 0, 'a completed task wait reports returnCode 0');
assert.deepEqual(result.details.tasks, [{
  taskId: pubTask.id, agentId: pubWorker.id, status: 'completed',
  ok: true, returnCode: 0, text: 'public done',
}], 'public wait result carries the terminal task mapping');
assert.match(result.content.find(c => c.type === 'text').text, /waited for/,
  'the wait summary names the waited agent');

// Mixed ids are rejected up front (same rule as shepherd_watch).
const pub2 = pub.registerAgent({ agent: 'scout', label: 'public-scout' });
const pubTask2 = pub.createTask(pub2, 'second public task');
let mixed = null;
try { await doAction({ action: 'wait', id: [pubTask.id, 'some-prompt-id-unknown'] }, { cwd: process.cwd() }); } catch (e) { mixed = e; }
assert.ok(mixed instanceof LifecycleError, 'unknown non-task ids surface a LifecycleError');
// clean up the public task so the global registry stays tidy
await new Promise(r => setTimeout(r, 60));
pub.settleTask(pubTask2.id, { status: 'completed', ok: true, text: 'x' });
console.log('PASS doAction(wait) maps task settles to a public result with returnCode');

// ── 4. Compatibility decision is explicit in the handoff ────────────────

const handoffPath = fileURLToPath(new URL('../docs/specs/001-agent-messaging-and-task-lifecycle/handoff.md', import.meta.url));
const handoff = readFileSync(handoffPath, 'utf8');
assert.match(handoff, /### Phase 10 — Compatibility decisions/,
  'the handoff records the Phase 10 compatibility decisions');

clearInterval(keepAlive);
console.log('PASS shepherd_prompt is a documented deprecated alias pointing at shepherd_delegate');
console.log('PASS shepherd_wait is a documented compatibility adapter for task (and legacy prompt) ids');
console.log('All compatibility assertions passed.');
