#!/usr/bin/env node
// Phase 1.2 backend matrix (spec 009): the same prompts behave the same on
// both runtimes, raw native ids are refused as handles on both, and closing
// what we did not create is refused before any kill primitive runs.
//
// No live spawn: every path below rejects (or proves ownership mechanics)
// before any agent boots, so this stays deterministic with or without a
// `herdr` binary. The hc ownership-primitive block runs only when `hc` is
// reachable and cleans up after itself. Live spawn/delegate/watch parity was
// proven manually in 1.1; the resolver wiring it exercises lives in
// src/extension/shepherd.ts (delegate/close routed, rest concrete).
import { currentParentBroker, shutdownParentBroker } from '../src/runtimes/herdr/lifecycle.ts';
import { createHerdrRuntime } from '../src/runtimes/herdr/runtime.ts';
import {
  isHcAvailable,
  loadCreatedTerminals,
  pruneStaleCreatedTerminals,
  recordCreatedTerminal,
  terminalExists,
} from '../src/runtimes/hc/hc.ts';
import { createHcRuntime } from '../src/runtimes/hc/runtime.ts';

let failures = 0;
function assert(ok, label) {
  if (ok) console.log(`PASS  ${label}`);
  else {
    failures++;
    console.log(`FAIL  ${label}`);
  }
}

function codeOf(error) {
  return error && typeof error.code === 'string' ? error.code : undefined;
}

async function rejectsWithCode(fn, code, label) {
  try {
    await fn();
  } catch (error) {
    assert(codeOf(error) === code, `${label} (code=${codeOf(error) ?? error?.name})`);
    return;
  }
  assert(false, `${label} (no throw)`);
}

// A broker-capable owner identity so parent-message paths reach handle
// validation instead of failing on session resolution.
const previousOwner = process.env.PI_SHEPHERD_OWNER_SESSION;
process.env.PI_SHEPHERD_OWNER_SESSION = 'hc-matrix-test';

const herdr = createHerdrRuntime({ cwd: process.cwd() });
const hc = createHcRuntime({ cwd: process.cwd() });

try {
  // ── surface: both runtimes implement the 7-method contract ──────────────
  for (const method of ['spawn', 'delegate', 'message', 'watch', 'status', 'close', 'read']) {
    assert(typeof herdr[method] === 'function', `pane runtime implements ${method}`);
    assert(typeof hc[method] === 'function', `hc runtime implements ${method}`);
  }

  // ── same unknown agent name on spawn: identical discovery failure ───────
  for (const [name, rt] of [['pane', herdr], ['hc', hc]]) {
    try {
      await rt.spawn({ name: 'no-such-agent-xyz' }, {});
      assert(false, `${name} spawn unknown agent throws`);
    } catch (error) {
      assert(/Unknown agent/.test(String(error?.message)), `${name} spawn unknown agent throws Unknown agent`);
    }
  }

  // ── opaque-ID refusal: raw native ids are junk on BOTH backends ─────────
  // 't4' is an hc terminal address; 'w1:p1' is a pane id. Neither is ever a
  // valid opaque handle, on either runtime.
  for (const raw of ['t4', 'w1:p1']) {
    await rejectsWithCode(() => herdr.delegate(raw, 'x', {}), 'unknown_handle', `pane delegate(${raw}) refused`);
    await rejectsWithCode(() => hc.delegate(raw, 'x', {}), 'unknown_handle', `hc delegate(${raw}) refused`);
    await rejectsWithCode(() => herdr.message(raw, 'hi', {}), 'invalid_target', `pane message(${raw}) refused`);
    await rejectsWithCode(() => hc.message(raw, 'hi', {}), 'invalid_target', `hc message(${raw}) refused`);
    await rejectsWithCode(() => herdr.status(raw), 'unknown_handle', `pane status(${raw}) refused`);
    await rejectsWithCode(() => hc.status(raw), 'unknown_handle', `hc status(${raw}) refused`);
    await rejectsWithCode(() => herdr.read(raw), 'unknown_handle', `pane read(${raw}) refused`);
    await rejectsWithCode(() => hc.read(raw), 'unknown_handle', `hc read(${raw}) refused`);
    await rejectsWithCode(() => herdr.close(raw), 'unknown_handle', `pane close(${raw}) refused`);
    await rejectsWithCode(() => hc.close(raw), 'unknown_handle', `hc close(${raw}) refused`);
  }

  // ── unknown opaque ids: same codes both sides ───────────────────────────
  const ghostAgent = 'shepherd-agent-00000000-00000000-0000-4000-8000-000000000000';
  const ghostTask = 'shepherd-task-00000000-00000000-0000-4000-8000-000000000000';
  for (const [name, rt] of [['pane', herdr], ['hc', hc]]) {
    await rejectsWithCode(() => rt.delegate(ghostAgent, 'x', {}), 'unknown_handle', `${name} delegate unknown agent`);
    await rejectsWithCode(() => rt.status(ghostAgent), 'unknown_handle', `${name} status unknown agent`);
    await rejectsWithCode(() => rt.read(ghostAgent), 'unknown_handle', `${name} read unknown agent`);
    await rejectsWithCode(() => rt.close(ghostAgent), 'unknown_handle', `${name} close unknown agent`);
    await rejectsWithCode(() => rt.watch([ghostTask]), 'unknown_task', `${name} watch unknown task`);
  }

  // ── watch shape: empty and duplicate lists rejected identically ─────────
  for (const [name, rt] of [['pane', herdr], ['hc', hc]]) {
    await rejectsWithCode(() => rt.watch([]), 'invalid_handle', `${name} watch([]) rejected`);
    // Resolution precedes dedup on both runtimes, so duplicate unknown ids
    // surface unknown_task identically (same order, same outcome).
    await rejectsWithCode(
      () => rt.watch([ghostTask, ghostTask]),
      'unknown_task',
      `${name} watch duplicate-unknown rejected`
    );
  }

  // ── ownership refusal: close never reaches kill for unowned terminals ───
  // Recording a bogus terminal address proves the registry mechanics; the
  // close still refuses at handle lookup, before any `hc kill` could run.
  if (isHcAvailable()) {
    recordCreatedTerminal({ terminalId: 't4', name: 'matrix-bogus', cwd: '/tmp', createdAt: Date.now() });
    assert(
      loadCreatedTerminals().some(t => t.terminalId === 't4'),
      'hc registry records the bogus terminal'
    );
    await rejectsWithCode(() => hc.close('t4'), 'unknown_handle', 'hc close(t4) refused before kill');
    assert(!terminalExists('t4'), 'bogus terminal does not exist');
    const pruned = pruneStaleCreatedTerminals();
    assert(pruned >= 1, `hc prune drops the bogus entry (pruned=${pruned})`);
    assert(
      !loadCreatedTerminals().some(t => t.terminalId === 't4'),
      'bogus terminal forgotten after prune'
    );
  } else {
    console.log('INFO  hc unreachable: ownership-primitive block skipped');
  }
  await rejectsWithCode(() => herdr.close('w1:p1'), 'unknown_handle', 'pane close(w1:p1) refused before pane close');
} finally {
  if (previousOwner === undefined) delete process.env.PI_SHEPHERD_OWNER_SESSION;
  else process.env.PI_SHEPHERD_OWNER_SESSION = previousOwner;
  try {
    if (currentParentBroker()) shutdownParentBroker(() => true);
  } catch {
    /* best effort mailbox cleanup */
  }
}

if (failures) process.exit(1);
console.log('All hc-matrix assertions passed.');
