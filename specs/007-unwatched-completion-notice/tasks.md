# Tasks: Unwatched completion notice

Work in order. A task is done only when its implementation + verification
are complete. This spec is `007-unwatched-completion-notice`
(`spec.md` contract, `plan.md` design). Related: issue #15.

## Phase 1 — Detection + ledger (core)

- [ ] **1.1 Add `src/core/unseen-completions.ts`**
  - `UnseenCompletionLedger` keyed by `taskId`, entries are the structural
    `UnseenSettlement` (result fields + optional `agent`/`label`),
    insertion order; a queue of un-noticed settlements.
  - `record(result, { hadWatchers, agent?, label?, source? })` adds only
    when `hadWatchers === false`, `result.status !== "cancelled"`,
    `source !== "delegate-submission-failure"`, and no entry exists;
    returns whether a new entry was added.
  - `pending()`, `drain(ids)`, `clear(ids): string[]`,
    `clearForAgent(agentId): string[]`, `clearAll()`.
  - Pure module: no `@earendil-works/*`, `src/runtimes/`, or
    `src/extension/` imports; export the class and a
    `unseenCompletionLedger` singleton (mirroring `taskWatcherService`).

- [ ] **1.2 Add the settlement observer to the task registry**
  - `onTaskSettled(listener): () => void` in
    `src/runtimes/herdr/orchestration.ts`; listener receives
    `(result, { hadWatchers, agent?, label?, source? })`, with `result`
    passed as a shallow copy.
  - `hadWatchers` is true only when at least one watcher callback actually
    ran for the settlement (set inside the existing fan-out); capture the
    agent handle for `agent`/`label` in the same place.
  - `settleTask` takes an optional internal options argument carrying
    `source`; `src/runtimes/herdr/lifecycle.ts` `delegateAgent` failure path
    passes `source: "delegate-submission-failure"`.
  - Listeners run after the fan-out, inside `try/catch`; observer failure
    cannot affect settlement; no listener = identical behavior.
  - Fires only on an actual transition into a terminal state; legacy
    prompt settlements are not observed.
  - Document the hook in the code as part of the runtime contract so the
    durable runtime (spec 006 Phase 1+) implements it identically.

- [ ] **1.3 Core cases in `test/verify-unseen-completions.mjs`**
  - Create the suite file with ledger + observer cases first (run it
    directly; chain wiring happens in 3.1).
  - Ledger: cancelled exclusion, had-watchers exclusion,
    delegate-submission-failure exclusion, dedupe, insertion order, drain,
    `clear`/`clearForAgent` returning ids, `clearAll`.
  - Observer: settle with watcher → `hadWatchers: true`; without → `false`
    plus `agent`/`label`; `source` passthrough; listener throw does not
    break `settleTask`; unsubscribe stops delivery.

## Phase 2 — Notice delivery (extension)

- [ ] **2.1 Session-scoped bridge + activity tracking + idle wake**
  - New `src/extension/unseen-completions.ts`,
    `configureUnseenCompletionBridge(pi, { coalesceMs?, ledger? })`.
  - Subscribe `lifecycleRegistry.onTaskSettled` on `session_start`
    (idempotent), release on `session_shutdown`; no subscription without a
    parent session.
  - `session_start`/`agent_settled` → idle; `agent_start` → busy; transition
    to idle re-checks pending entries (aborted/errored runs still get one
    later wake); prefer `ctx.isIdle()` when the captured lifecycle context
    exposes it.
  - `record()` while idle schedules one debounced flush
    (`UNSEEN_NOTICE_COALESCE_MS = 250`); a burst sends exactly one
    `pi.sendMessage(notice, { triggerTurn: true })` and drains after the
    call returns.
  - Timer firing while busy is a no-op; flush no-ops without a
    `pi.sendMessage` function; synchronous send failure leaves entries
    pending (no unbounded retry).

- [ ] **2.2 Boundary continuation**
  - `pi.on("agent_before_settle", event)`: only when
    `event.outcome === "completed"`, `event.context.canContinue !== false`,
    and pending entries exist — build one `custom_message` entry, drain
    those ids, return `{ entries: [entry], continue: true }`.
  - Aborted/errored outcomes return nothing; entries stay pending.
  - Loop guard: drained entries never re-notify; a second boundary with no
    new entries returns `undefined`.

- [ ] **2.3 Notice content + renderer**
  - One formatter (exported for tests) producing the spec's text: header,
    `- <taskId> (<agent>[, "label"]): <status> — <summary|error>` lines,
    and `Full results: shepherd_watch({ id: [ "id", ... ] })`.
  - `details: { taskIds, settlements }` (not `completions`, which collides
    with the generic collapsed formatter); export
    `renderShepherdNotification` from `src/extension/shepherd.ts` and
    register `shepherd.task.unseen` with it plus the notice formatter.

- [ ] **2.4 Clearing wiring**
  - `src/extension/shepherd.ts` `watch` action:
    `unseenCompletionLedger.clear(registration.taskIds)` after
    `taskWatcherService.watch(taskIds)` — the authoritative retrieval
    clear. Do not add clearing to the watcher notifier (late watch
    deliveries never reach it).
  - `close` action: `clearForAgent(handle.id)` after a successful
    `runtime.close`; report dropped task ids in the tool result when any.
  - `session_shutdown` clears timers, observer subscription, and the
    ledger; `session_start` clears stale entries before going idle.

- [ ] **2.5 Wire the bridge in `index.ts`**
  - Call `configureUnseenCompletionBridge(pi)` after the
    `PI_SHEPHERD_SESSION` guard and `registerShepherdTools(pi)`
    (`index.ts` ~447). Not inside `registerShepherdTools`: six suites pass
    fake pi objects without `on` and with renderer allow-lists there.
  - No tool schema, prompt, settings, or message-delivery changes for
    watchers.

## Phase 3 — Verification, docs, landing

- [ ] **3.1 Finish `test/verify-unseen-completions.mjs` + wiring**
  - Add bridge cases with a fake pi surface (capture `on`,
    `registerMessageRenderer`, `sendMessage` like
    `test/verify-parent-surface.mjs`): idle burst → exactly one
    `triggerTurn` notice and no duplicates; busy settle → one boundary
    result with `continue: true`; second boundary → `undefined`; `aborted`
    and `canContinue: false` outcomes → none; late `watch` clears; close
    clears and reports; renderer registered; missing `sendMessage` never
    throws; `session_shutdown` unsubscribes.
  - Inject small `coalesceMs` and an isolated ledger for determinism.
  - Register `unseen-completions:test` in `package.json` and append it to
    the `test` chain.

- [ ] **3.2 Full suite untouched and green**
  - `npm test` with `PI_*`/`HERDR_*` unset: all existing suites + the new
    script pass; no existing test file modified.

- [ ] **3.3 Docs**
  - README `### Delegate, then watch`: unwatched settlements surface at the
    next settle boundary, or as one wake when the Shepherd is idle; the
    notice names `shepherd_watch` for retrieval.
  - `docs/guides/tool-reference.md`: same note on the `shepherd_watch`
    entry; reiterate that `shepherd_watch` retrieves already-settled tasks
    synchronously.
  - Fix the pre-existing "delivered as follow-ups" wording for
    `shepherd_watch` (`docs/guides/tool-reference.md` and the tool
    description in `src/extension/shepherd.ts` ~1570) to match the actual
    `steer` delivery.

- [ ] **3.4 Live smoke + journal**
  - Throwaway script (not committed): delegate to a real agent with **no**
    watch; the boundary notice appears with the retrieval command; the
    result is retrievable; no duplicate notice follows.
  - Record scope, evidence, and the landing note in `journal.md` before
    merging; note the branch name (`feat/007-unwatched-completion-notice`).
