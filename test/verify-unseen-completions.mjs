#!/usr/bin/env node
/**
 * Spec 007 verification: unseen-settlement ledger + unwatched-completion
 * notice bridge.
 *
 * Core cases (task 1.3): ledger exclusions, dedupe, insertion order, drain and
 * clear semantics, and the registry settlement observer. Bridge cases (task
 * 3.1): session-scoped subscription, debounced idle wake, boundary
 * continuation, retrieval/close clearing, renderer registration, and shutdown
 * release. The bridge is driven directly through a fake pi surface (no pi
 * subprocess), with an isolated ledger and injected coalesce windows.
 */
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { UnseenCompletionLedger, unseenCompletionLedger } from '../src/core/unseen-completions.ts';
import {
  configureUnseenCompletionBridge,
  formatUnseenCompletionNotice,
  UNSEEN_NOTICE_COALESCE_MS,
  UNSEEN_NOTICE_CUSTOM_TYPE,
} from '../src/extension/unseen-completions.ts';
import { doAction } from '../src/extension/shepherd.ts';
import { delegateAgent } from '../src/runtimes/herdr/lifecycle.ts';
import { LifecycleRegistry, lifecycleRegistry } from '../src/runtimes/herdr/orchestration.ts';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// ── Ledger ──────────────────────────────────────────────────────────────
{
  const ledger = new UnseenCompletionLedger();
  const result = overrides => ({
    taskId: 'shepherd-task-ledger-1',
    agentId: 'shepherd-agent-ledger-1',
    status: 'completed',
    ok: true,
    returnCode: 0,
    text: 'done',
    ...overrides,
  });
  const context = overrides => ({
    hadWatchers: false,
    agent: 'worker',
    label: 'ledger',
    ...overrides,
  });

  assert.equal(
    ledger.record(
      result({ taskId: 'shepherd-task-cancelled', status: 'cancelled', ok: false, returnCode: 130 }),
      context()
    ),
    false,
    'cancelled settlements are excluded'
  );
  assert.equal(
    ledger.record(result({ taskId: 'shepherd-task-watched' }), context({ hadWatchers: true })),
    false,
    'watched settlements are excluded'
  );
  assert.equal(
    ledger.record(
      result({ taskId: 'shepherd-task-failed-submit', status: 'failed', ok: false }),
      context({ source: 'delegate-submission-failure' })
    ),
    false,
    'delegate submission failures are excluded'
  );
  assert.equal(ledger.pending().length, 0);
  console.log('PASS ledger excludes cancelled, watched, and delegate-submission-failure settlements');

  assert.equal(ledger.record(result(), context()), true, 'a first record adds an entry');
  assert.deepEqual(
    ledger.pending(),
    [
      {
        taskId: 'shepherd-task-ledger-1',
        agentId: 'shepherd-agent-ledger-1',
        agent: 'worker',
        label: 'ledger',
        status: 'completed',
        ok: true,
        returnCode: 0,
        text: 'done',
      },
    ],
    'record flattens result fields plus observer identity'
  );
  assert.equal(ledger.record(result(), context()), false, 'an existing entry is never replaced');
  assert.equal(ledger.pending().length, 1);
  const snapshot = ledger.pending();
  snapshot[0].status = 'failed';
  assert.equal(ledger.pending()[0].status, 'completed', 'pending() returns defensive copies');
  console.log('PASS ledger flattens, dedupes by task id, and returns copies');

  ledger.record(result({ taskId: 'shepherd-task-ledger-2' }), context({ label: '' }));
  ledger.record(
    result({ taskId: 'shepherd-task-other-agent' }),
    context({ agent: 'reviewer', label: 'other' })
  );
  assert.deepEqual(
    ledger.pending().map(settlement => settlement.taskId),
    ['shepherd-task-ledger-1', 'shepherd-task-ledger-2', 'shepherd-task-other-agent'],
    'pending preserves insertion order'
  );
  ledger.drain(['shepherd-task-ledger-1', 'missing']);
  assert.deepEqual(
    ledger.pending().map(settlement => settlement.taskId),
    ['shepherd-task-ledger-2', 'shepherd-task-other-agent'],
    'drain removes only present ids'
  );
  assert.deepEqual(
    ledger.clear(['missing', 'shepherd-task-ledger-2']),
    ['shepherd-task-ledger-2'],
    'clear returns removed ids in request order'
  );
  assert.deepEqual(
    ledger.clearForAgent('shepherd-agent-ledger-1'),
    ['shepherd-task-other-agent'],
    'clearForAgent returns the removed ids for that agent'
  );
  assert.equal(ledger.pending().length, 0);
  ledger.record(result({ taskId: 'shepherd-task-ledger-3' }), context());
  ledger.clearAll();
  assert.equal(ledger.pending().length, 0);
  console.log('PASS ledger supports insertion order, drain, clear, clearForAgent, and clearAll');
}

// ── Registry settlement observer ────────────────────────────────────────
{
  const registry = new LifecycleRegistry();
  const events = [];
  const unsubscribe = registry.onTaskSettled((result, context) => {
    events.push({ result, context });
  });

  const worker = registry.registerAgent({ agent: 'worker', label: 'observer-worker' });
  const watchedTask = registry.createTask(worker, 'watched');
  registry.setTaskRunning(watchedTask.id);
  registry.watchTasks(watchedTask.id, () => {});
  registry.settleTask(watchedTask.id, { status: 'completed', text: 'watched done' });
  assert.equal(events.length, 1, 'one observation per settlement');
  assert.equal(events[0].context.hadWatchers, true, 'a watcher callback marks hadWatchers');
  assert.equal(events[0].result.status, 'completed');
  events[0].result.status = 'failed';
  assert.equal(
    registry.taskResult(watchedTask.id).status,
    'completed',
    'the observer receives a shallow result copy'
  );
  console.log('PASS observer reports hadWatchers true for a watched settlement with a result copy');

  const idleAgent = registry.registerAgent({ agent: 'scout', label: 'observer-idle' });
  const unseenTask = registry.createTask(idleAgent, 'unseen');
  registry.settleTask(unseenTask.id, { status: 'failed', error: 'nope' });
  const unseenEvent = events.at(-1);
  assert.equal(unseenEvent.context.hadWatchers, false);
  assert.equal(unseenEvent.context.agent, 'scout');
  assert.equal(unseenEvent.context.label, 'observer-idle');
  assert.equal(unseenEvent.context.source, undefined);
  assert.equal(unseenEvent.result.error, 'nope');
  const eventCount = events.length;
  registry.settleTask(unseenTask.id, { status: 'completed' });
  assert.equal(events.length, eventCount, 'an already-settled task is not observed again');
  console.log('PASS observer reports hadWatchers false with agent/label for an unwatched settlement');

  const silentAgent = registry.registerAgent({ agent: 'worker', label: 'observer-silent' });
  const silentTask = registry.createTask(silentAgent, 'silent');
  registry.watchTasks(silentTask.id);
  registry.settleTask(silentTask.id, { status: 'completed', text: 'silent done' });
  assert.equal(
    events.at(-1).context.hadWatchers,
    false,
    'a callback-less watcher registration does not count as observed'
  );
  console.log('PASS a callback-less watcher registration does not suppress the notice');

  const sourceAgent = registry.registerAgent({ agent: 'worker', label: 'observer-source' });
  const sourceTask = registry.createTask(sourceAgent, 'source');
  registry.settleTask(
    sourceTask.id,
    { status: 'failed', error: 'submit' },
    { source: 'delegate-submission-failure' }
  );
  assert.equal(
    events.at(-1).context.source,
    'delegate-submission-failure',
    'the internal source tag reaches the observer'
  );
  console.log('PASS observer passes the delegate-submission-failure source tag through');

  const offThrow = registry.onTaskSettled(() => {
    throw new Error('observer boom');
  });
  const safeAgent = registry.registerAgent({ agent: 'worker', label: 'observer-safe' });
  const safeTask = registry.createTask(safeAgent, 'safe');
  const safeResult = registry.settleTask(safeTask.id, { status: 'completed', text: 'safe' });
  assert.equal(safeResult.status, 'completed', 'a throwing observer cannot break settlement');
  assert.equal(events.at(-1).result.taskId, safeTask.id, 'later observers still run');
  offThrow();
  console.log('PASS a throwing settlement observer cannot affect settlement');

  const beforeUnsubscribe = events.length;
  unsubscribe();
  const afterAgent = registry.registerAgent({ agent: 'worker', label: 'observer-after' });
  const afterTask = registry.createTask(afterAgent, 'after');
  registry.settleTask(afterTask.id, { status: 'completed' });
  assert.equal(events.length, beforeUnsubscribe, 'unsubscribe stops delivery');
  console.log('PASS unsubscribe stops settlement observations');
}

// ── Notice formatter golden text ────────────────────────────────────────
{
  const golden = formatUnseenCompletionNotice([
    {
      taskId: 'shepherd-task-alpha',
      agentId: 'shepherd-agent-1',
      agent: 'worker',
      label: 'auth',
      status: 'completed',
      ok: true,
      returnCode: 0,
      text: 'implemented\nwith tests',
    },
    {
      taskId: 'shepherd-task-beta',
      agentId: 'shepherd-agent-2',
      agent: 'reviewer',
      status: 'failed',
      ok: false,
      returnCode: 1,
      error: 'boom',
    },
  ]);
  assert.equal(
    golden,
    [
      'Shepherd notice — 2 task(s) settled with no watcher attached:',
      '- shepherd-task-alpha (worker "auth"): completed — implemented with tests',
      '- shepherd-task-beta (reviewer): failed — boom',
      'Full results: shepherd_watch({ id: [ "shepherd-task-alpha", "shepherd-task-beta" ] })',
    ].join('\n')
  );
  assert.equal(
    formatUnseenCompletionNotice([
      {
        taskId: 'shepherd-task-solo',
        agentId: 'shepherd-agent-solo',
        status: 'timed_out',
        ok: false,
        returnCode: 124,
      },
    ]),
    [
      'Shepherd notice — 1 task(s) settled with no watcher attached:',
      '- shepherd-task-solo (shepherd-agent-solo): timed_out',
      'Full results: shepherd_watch({ id: [ "shepherd-task-solo" ] })',
    ].join('\n')
  );
  assert.equal(UNSEEN_NOTICE_COALESCE_MS, 250, 'the production coalesce window stays 250ms');
  assert.equal(
    formatUnseenCompletionNotice([
      {
        taskId: 'shepherd-task-empty-text',
        agentId: 'shepherd-agent-empty',
        status: 'failed',
        ok: false,
        returnCode: 1,
        text: '',
        error: 'real error',
      },
    ]).includes('failed — real error'),
    true,
    'an empty summary falls back to the error text'
  );
  const longSummary = 'x'.repeat(500);
  const clipped = formatUnseenCompletionNotice([
    {
      taskId: 'shepherd-task-long',
      agentId: 'shepherd-agent-long',
      status: 'completed',
      ok: true,
      returnCode: 0,
      text: longSummary,
    },
  ]);
  assert.ok(clipped.includes('…'), 'long summaries are clipped');
  assert.ok(!clipped.includes(longSummary), 'the full summary is not inlined into the notice');
  console.log('PASS the notice falls back to error text and clips long summaries');
  console.log('PASS the notice formatter emits the spec 007 golden text');
}

// ── Parent bridge ───────────────────────────────────────────────────────
{
  const sent = [];
  const handlers = new Map();
  let renderer;
  const fakePi = {
    registerMessageRenderer(customType, fn) {
      renderer = { customType, fn };
    },
    on(event, handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    sendMessage(message, options) {
      sent.push({ message, options });
    },
  };
  const fire = async (event, payload, ctx) => {
    const results = [];
    for (const handler of handlers.get(event) ?? []) results.push(await handler(payload, ctx));
    return results;
  };
  const idleFlag = { value: true };
  const ctx = { isIdle: () => idleFlag.value };
  const bridgeLedger = new UnseenCompletionLedger();
  configureUnseenCompletionBridge(fakePi, { coalesceMs: 20, ledger: bridgeLedger });

  assert.equal(renderer?.customType, UNSEEN_NOTICE_CUSTOM_TYPE);
  assert.equal(typeof renderer?.fn, 'function');
  console.log('PASS the bridge registers the shepherd.task.unseen renderer');

  await fire('session_start', { type: 'session_start' }, ctx);
  assert.deepEqual(
    [...handlers.keys()].sort(),
    ['agent_before_settle', 'agent_settled', 'agent_start', 'session_shutdown', 'session_start'],
    'the bridge subscribes to the lifecycle activity events'
  );
  console.log('PASS the bridge wires session, activity, boundary, and shutdown handlers');

  // Idle burst: one coalesced wake, one drain, no duplicate.
  const a1 = lifecycleRegistry.registerAgent({ agent: 'worker', label: 'bridge-idle-a' });
  const t1 = lifecycleRegistry.createTask(a1, 'A');
  lifecycleRegistry.settleTask(t1.id, { status: 'completed', text: 'done A' });
  const a2 = lifecycleRegistry.registerAgent({ agent: 'reviewer', label: 'bridge-idle-b' });
  const t2 = lifecycleRegistry.createTask(a2, 'B');
  lifecycleRegistry.settleTask(t2.id, { status: 'failed', error: 'boom B' });
  await delay(60);
  assert.equal(sent.length, 1, 'an idle burst produces exactly one notice');
  assert.equal(sent[0].message.customType, UNSEEN_NOTICE_CUSTOM_TYPE);
  assert.equal(sent[0].message.display, true);
  assert.deepEqual(sent[0].options, { triggerTurn: true });
  assert.deepEqual(
    sent[0].message.details.taskIds,
    [t1.id, t2.id],
    'the notice carries every coalesced task id'
  );
  assert.deepEqual(
    sent[0].message.details.settlements.map(settlement => settlement.taskId),
    [t1.id, t2.id]
  );
  assert.match(sent[0].message.content, /no watcher attached/);
  assert.match(sent[0].message.content, /Full results: shepherd_watch\(\{ id: \[ /);
  assert.equal(bridgeLedger.pending().length, 0, 'entries are drained after the idle send');
  await delay(40);
  assert.equal(sent.length, 1, 'no duplicate notice follows');
  console.log('PASS an idle burst sends one coalesced triggerTurn notice and drains the ledger');

  // A watched settlement never enters the ledger and never wakes the Shepherd.
  const watchedAgent = lifecycleRegistry.registerAgent({ agent: 'worker', label: 'bridge-watched' });
  const watchedTask = lifecycleRegistry.createTask(watchedAgent, 'watched');
  lifecycleRegistry.watchTasks(watchedTask.id, () => {});
  lifecycleRegistry.settleTask(watchedTask.id, { status: 'completed', text: 'watched done' });
  await delay(40);
  assert.equal(bridgeLedger.pending().length, 0, 'a watched settlement never enters the ledger');
  assert.equal(sent.length, 1, 'a watched settlement produces no notice');
  console.log('PASS a watched settlement is suppressed at the bridge level');

  // Busy settlement: no mid-turn wake, delivery at the completed boundary once.
  idleFlag.value = false;
  await fire('agent_start', { type: 'agent_start' }, ctx);
  const a3 = lifecycleRegistry.registerAgent({ agent: 'worker', label: 'bridge-busy-c' });
  const t3 = lifecycleRegistry.createTask(a3, 'C');
  lifecycleRegistry.settleTask(t3.id, { status: 'completed', text: 'done C' });
  await delay(50);
  assert.equal(sent.length, 1, 'no idle wake fires while the Shepherd is busy');
  assert.equal(bridgeLedger.pending().length, 1);

  // The completed-boundary fixtures below mirror pi's real pre-entry shape.
  // `emitBoundary` (dist/core/extensions/runner.js) builds `event.context`
  // from the entries accumulated BEFORE the handler runs; at a clean
  // completed boundary that snapshot ends on the assistant's final turn, so
  // `canContinue` is false even though the bridge's `custom_message` makes
  // the run continuable.
  // `_runBeforeSettleBoundary` (dist/core/agent-session.js) commits the
  // returned drafts via `_commitBoundaryDrafts` and only then recomputes
  // `finalContext.canContinue` via `_buildBoundaryContext`, where
  // `canContinue = (hasNonSystemContext && finalRole !== 'assistant') ||
  // pendingCustomContext || ...`. That post-commit gate is pi's and cannot be
  // evaluated in this unit suite; it is covered by the real-pi probe, not
  // here. Do not "fix" a fixture to `canContinue: true`: the pre-entry
  // snapshot only reaches true when queued or pending messages already exist
  // (agent-session.js:630-632), which is not the case this bridge handles
  // (see #16/#17).
  const boundaryEvent = {
    type: 'agent_before_settle',
    outcome: 'completed',
    // The pre-entry snapshot is non-continuable at a clean completed
    // boundary, so the bridge must still deliver.
    context: { canContinue: false },
  };
  const boundary = (await fire('agent_before_settle', boundaryEvent, ctx))[0];
  assert.ok(boundary, 'a completed boundary offers a continuation');
  assert.equal(boundary.continue, true, 'a completed boundary continues once');
  assert.equal(boundary.entries.length, 1);
  const entry = boundary.entries[0];
  assert.equal(entry.type, 'custom_message');
  assert.equal(entry.customType, UNSEEN_NOTICE_CUSTOM_TYPE);
  assert.equal(entry.display, true);
  assert.deepEqual(entry.details.taskIds, [t3.id]);
  assert.equal(entry.details.settlements.length, 1);
  assert.ok(Array.isArray(entry.details.settlements));
  assert.equal(bridgeLedger.pending().length, 0, 'the boundary drains the entries it delivered');
  assert.equal(
    (await fire('agent_before_settle', boundaryEvent, ctx))[0],
    undefined,
    'a second boundary without new entries does not continue'
  );
  console.log('PASS a busy settlement is delivered once at the completed settle boundary');

  // A non-continuable pre-entry snapshot never suppresses a completed
  // boundary: the bridge offers the continuation, drains its entries, and
  // leaves the post-commit decision to pi.
  const a4b = lifecycleRegistry.registerAgent({ agent: 'worker', label: 'bridge-busy-d2' });
  const t4b = lifecycleRegistry.createTask(a4b, 'D2');
  lifecycleRegistry.settleTask(t4b.id, { status: 'completed', text: 'done D2' });
  const continuation = (
    await fire(
      'agent_before_settle',
      { type: 'agent_before_settle', outcome: 'completed', context: { canContinue: false } },
      ctx
    )
  )[0];
  assert.ok(
    continuation,
    'a completed boundary with canContinue false still offers a continuation'
  );
  assert.equal(
    continuation.continue,
    true,
    'a completed boundary always offers the continuation'
  );
  assert.equal(continuation.entries.length, 1);
  assert.equal(continuation.entries[0].type, 'custom_message');
  assert.deepEqual(continuation.entries[0].details.taskIds, [t4b.id]);
  assert.equal(ledgerCount(bridgeLedger), 0, 'the delivered entries are drained');
  assert.equal(sent.length, 1, 'the boundary delivers in-turn instead of via sendMessage');
  console.log('PASS a completed boundary with canContinue false still continues');

  // The aborted outcome returns before the context is consulted, so this
  // fixture's `canContinue` value is irrelevant; it only pins that an aborted
  // boundary never continues.
  const a4 = lifecycleRegistry.registerAgent({ agent: 'worker', label: 'bridge-busy-d' });
  const t4 = lifecycleRegistry.createTask(a4, 'D');
  lifecycleRegistry.settleTask(t4.id, { status: 'completed', text: 'done D' });
  assert.equal(
    (
      await fire(
        'agent_before_settle',
        { type: 'agent_before_settle', outcome: 'aborted', context: { canContinue: true } },
        ctx
      )
    )[0],
    undefined,
    'an aborted run never continues'
  );
  assert.equal(ledgerCount(bridgeLedger), 1);
  idleFlag.value = true;
  await fire('agent_settled', { type: 'agent_settled' }, ctx);
  await delay(60);
  assert.equal(sent.length, 2, 'the agent_settled transition wakes the pending batch once');
  assert.deepEqual(sent[1].message.details.taskIds, [t4.id]);
  assert.equal(bridgeLedger.pending().length, 0);
  console.log('PASS an aborted boundary leaves entries pending for one idle wake');

  // Session shutdown releases the observer subscription and clears state.
  await fire('session_shutdown', { type: 'session_shutdown' }, ctx);
  const a7 = lifecycleRegistry.registerAgent({ agent: 'worker', label: 'bridge-shutdown-g' });
  const t7 = lifecycleRegistry.createTask(a7, 'G');
  lifecycleRegistry.settleTask(t7.id, { status: 'completed', text: 'after shutdown' });
  await delay(60);
  assert.equal(bridgeLedger.pending().length, 0, 'no recording after shutdown');
  assert.equal(sent.length, 2, 'no notice after shutdown');
  console.log('PASS session_shutdown releases the settlement subscription and clears state');
}

// ── Retrieval/close clearing (production singleton wiring) ─────────────
{
  const sent = [];
  const handlers = new Map();
  const fakePi = {
    registerMessageRenderer() {},
    on(event, handler) {
      handlers.set(event, handler);
    },
    sendMessage(message, options) {
      sent.push({ message, options });
    },
  };
  const fire = async (event, payload, ctx) => handlers.get(event)?.(payload, ctx);
  configureUnseenCompletionBridge(fakePi, { coalesceMs: 20 });
  await fire('session_start', { type: 'session_start' }, { isIdle: () => false });
  assert.equal(unseenCompletionLedger.pending().length, 0);

  // Late explicit watch is the authoritative retrieval clear.
  await fire('agent_start', { type: 'agent_start' }, { isIdle: () => false });
  const a5 = lifecycleRegistry.registerAgent({ agent: 'worker', label: 'bridge-watch-e' });
  const t5 = lifecycleRegistry.createTask(a5, 'E');
  lifecycleRegistry.settleTask(t5.id, { status: 'completed', text: 'done E' });
  assert.equal(ledgerCount(unseenCompletionLedger), 1);
  await doAction({ action: 'watch', id: t5.id }, { cwd: process.cwd() });
  assert.equal(
    unseenCompletionLedger.pending().length,
    0,
    'an explicit watch clears the pending entry'
  );
  await delay(40);
  assert.equal(sent.length, 0, 'no notice follows a retrieval clear');
  console.log('PASS shepherd_watch retrieval clears the pending unseen settlement');

  // Close drops an agent's pending entries and reports them in the result.
  const sandbox = mkdtempSync(path.join(tmpdir(), 'pi-shepherd-unseen-'));
  const agentDir = path.join(sandbox, 'agent');
  const binDir = path.join(sandbox, 'bin');
  mkdirSync(path.join(agentDir, 'pi-shepherd'), { recursive: true });
  mkdirSync(binDir, { recursive: true });
  const paneId = 'pane-unseen-close';
  writeFileSync(
    path.join(agentDir, 'pi-shepherd', 'created-panes.json'),
    JSON.stringify([
      { paneId, tabId: 'tab-unseen-close', name: 'worker', cwd: process.cwd(), createdAt: Date.now() },
    ])
  );
  const fakeHerdr = path.join(binDir, 'herdr');
  writeFileSync(
    fakeHerdr,
    `#!/bin/sh
case "$1 $2" in
  "agent get") printf '{"result":{"agent":{"pane_id":"%s","agent_status":"idle"}}}\\n' "$3" ;;
  "pane list") printf '%s\\n' '{"result":{"panes":[]}}' ;;
  *) printf '%s\\n' '{"result":{}}' ;;
esac
exit 0
`
  );
  chmodSync(fakeHerdr, 0o755);
  const previousPath = process.env.PATH;
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PATH = `${binDir}${path.delimiter}${previousPath ?? ''}`;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    const a6 = lifecycleRegistry.registerAgent({ agent: 'worker', label: 'bridge-close-f', paneId });
    const t6 = lifecycleRegistry.createTask(a6, 'F');
    lifecycleRegistry.settleTask(t6.id, { status: 'completed', text: 'done F' });
    assert.equal(ledgerCount(unseenCompletionLedger), 1);
    const closeResult = await doAction({ action: 'close', id: a6.id }, { cwd: process.cwd() });
    const closeText = closeResult.content[0].text;
    assert.match(closeText, /cleared 1 unseen completion\(s\)/);
    assert.ok(closeText.includes(t6.id), 'the close summary names the dropped task id');
    assert.deepEqual(closeResult.details.clearedUnseenCompletions, [t6.id]);
    assert.equal(
      unseenCompletionLedger.pending().length,
      0,
      'close clears the agent pending entries'
    );
    await delay(40);
    assert.equal(sent.length, 0, 'no notice is sent for entries dropped by close');
    console.log('PASS shepherd_close clears and reports the dropped unseen completions');

    // A delegate submission failure settles the task but must never enter the
    // ledger: the Shepherd already sees the error in the shepherd_delegate
    // tool result. This guards the source tag wired in lifecycle.ts.
    const observed = [];
    const offObserved = lifecycleRegistry.onTaskSettled((_result, context) => {
      observed.push(context);
    });
    const failedAgent = lifecycleRegistry.registerAgent({
      agent: 'worker',
      label: 'bridge-delegate-fail',
      paneId: 'pane-unseen-delegate-fail',
    });
    const notADirectory = path.join(sandbox, 'not-a-directory');
    writeFileSync(notADirectory, 'this is a file, not a session directory');
    await assert.rejects(
      () =>
        delegateAgent(failedAgent, 'fails during artifact reservation', {
          sessionId: 'unseen-delegate-failure',
          artifactSession: {
            sessionName: 'broken',
            slug: 'broken',
            ordinal: 1,
            directoryName: 'broken',
            projectRoot: sandbox,
            sessionPath: notADirectory,
            sessionRelativePath: 'broken',
            mocPath: path.join(sandbox, 'broken.md'),
            sessionMetadataPath: path.join(sandbox, 'broken.json'),
            resumed: false,
            startedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            status: 'running',
          },
        }),
      /Task submission failed/
    );
    offObserved();
    assert.equal(
      observed.at(-1)?.source,
      'delegate-submission-failure',
      'the real delegate failure path tags its settlement'
    );
    assert.equal(
      unseenCompletionLedger.pending().length,
      0,
      'a delegate submission failure never records an unseen completion'
    );
    console.log('PASS delegate submission failures are excluded end-to-end');
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  }

  await fire('session_shutdown', { type: 'session_shutdown' }, { isIdle: () => true });
  assert.equal(unseenCompletionLedger.pending().length, 0);
}

// ── Fake pi without sendMessage ─────────────────────────────────────────
{
  const handlers2 = new Map();
  const fakePi2 = {
    registerMessageRenderer() {},
    on(event, handler) {
      handlers2.set(event, handler);
    },
  };
  const fire2 = async (event, payload, ctx2) => handlers2.get(event)?.(payload, ctx2);
  const ledger2 = new UnseenCompletionLedger();
  configureUnseenCompletionBridge(fakePi2, { coalesceMs: 10, ledger: ledger2 });
  await fire2('session_start', { type: 'session_start' }, { isIdle: () => true });
  const a8 = lifecycleRegistry.registerAgent({ agent: 'worker', label: 'bridge-nosend-h' });
  const t8 = lifecycleRegistry.createTask(a8, 'H');
  lifecycleRegistry.settleTask(t8.id, { status: 'completed', text: 'no send' });
  await delay(40);
  assert.equal(
    ledger2.pending().length,
    1,
    'a pi without sendMessage leaves entries pending without throwing'
  );
  await fire2('session_shutdown', { type: 'session_shutdown' });
  assert.equal(ledger2.pending().length, 0);
  console.log('PASS a fake pi without sendMessage never throws and keeps entries pending');
}

function ledgerCount(ledger) {
  return ledger.pending().length;
}

console.log('All unseen-completion assertions passed.');
