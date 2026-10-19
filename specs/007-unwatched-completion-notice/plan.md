# Implementation Plan: Unwatched completion notice

This plan implements `spec.md` (reviewer fixes folded in). Three stages:
core detection + ledger, extension notice delivery, verification + docs. No
behavior change for watched tasks, no broker or tool-surface change.

## Files

| File | Change |
|---|---|
| `src/core/unseen-completions.ts` | new: `UnseenCompletionLedger` + singleton, structural `UnseenSettlement` |
| `src/runtimes/herdr/orchestration.ts` | `onTaskSettled(listener)` observer + `source` tag on the delegate failure settle |
| `src/runtimes/herdr/lifecycle.ts` | tag the `delegateAgent` failure settle with `source: "delegate-submission-failure"` |
| `src/extension/unseen-completions.ts` | new: session-scoped subscription, activity tracking, idle wake, boundary continuation, renderer |
| `src/extension/shepherd.ts` | export `renderShepherdNotification`; clear-on-watch in the `watch` action; clear-on-close with report in the `close` action |
| `index.ts` | call `configureUnseenCompletionBridge(pi)` after the worker guard (parent surface only) |
| `test/verify-unseen-completions.mjs` | new suite (core cases first, bridge cases added in Stage 3) |
| `package.json` | register `unseen-completions:test` in the `test` chain |
| `README.md`, `docs/guides/tool-reference.md` | watch/notification behavior note; fix the stale "follow-ups" wording |

## Stage 1 — Detection + ledger (core)

1. `UnseenCompletionLedger` (`src/core/unseen-completions.ts`):
   - `tasks: Map<taskId, UnseenSettlement>` insertion-ordered.
   - `record` flattens a `TaskResult` + observer context into
     `UnseenSettlement`; returns false for `hadWatchers === true`,
     `status === "cancelled"`, `source === "delegate-submission-failure"`,
     or an existing entry.
   - `pending()`; `drain(ids)`; `clear(ids): string[]`;
     `clearForAgent(agentId): string[]`; `clearAll()`.
   - Pure module: only builtins; no `@earendil-works/*`, `src/runtimes/`,
     or `src/extension/` imports. Export the class and the
     `unseenCompletionLedger` singleton.
2. Registry observer in `orchestration.ts`:
   - `private readonly settlementListeners = new Set<...>()`.
   - `onTaskSettled(listener)` adds and returns an unsubscribe function.
   - Compute `hadWatchers` in the fan-out by marking when
     `notifyTaskWatcher(...)` actually runs (the watcher `delivered` check
     already gates duplicates), capture the agent handle for
     `agent`/`label`, then invoke listeners inside a `try/catch` after the
     fan-out. Pass `{ ...result }` and a fresh context object; carry the
     internal `source` tag through from `settleTask`.
   - Fire only on the transition to terminal (the existing early-return for
     already-settled tasks stays untouched); prompt settlement paths are not
     touched.
   - `settleTask` gains an optional internal options argument for `source`;
     only `delegateAgent`'s failure path in `lifecycle.ts` passes it.

Rationale: the observer gives one runtime-neutral seam. The extension
subscribes; tests can subscribe directly. The durable runtime (spec 006,
Phase 1) implements the same hook instead of duplicating the ledger.

## Stage 2 — Notice delivery (extension)

`src/extension/unseen-completions.ts`, module state:

- `active` subscription flag, `unsubscribe`, `idle` boolean (default true),
  `flushTimer`, captured lifecycle `ctx`.
- `configureUnseenCompletionBridge(pi, options?: { coalesceMs?, ledger? })`:
  - `pi.on("session_start")` → `clearAll()`, idle, subscribe to
    `ledger`'s registry observer (`lifecycleRegistry.onTaskSettled`) if not
    already subscribed. Idempotent across repeated session starts.
  - `pi.on("agent_start")` → busy; `pi.on("agent_settled")` → idle +
    `scheduleIdleWake()` (no-op without pending entries; catches settlements
    whose boundary did not run).
  - `pi.on("session_shutdown")` → clear timer, `clearAll()`, unsubscribe,
    reset to idle.
  - `pi.on("agent_before_settle", event => ...)`:
    - return `undefined` unless `event.outcome === "completed"`,
    - **and** the ledger has pending entries (no pre-entry
      `event.context.canContinue` check: that snapshot predates our draft,
      and pi recomputes `canContinue` after committing the drafts; #16),
    - build the `custom_message` entry, drain its task ids, and return
      `{ entries: [entry], continue: true }`.
  - `pi.registerMessageRenderer("shepherd.task.unseen", ...)` using
    `renderShepherdNotification` (exported from `shepherd.ts`) with the
    notice formatter reading `details.settlements`.
- Observer callback:
  `lifecycleRegistry.onTaskSettled((result, context) => {
     if (ledger.record(result, context)) scheduleIdleWake(); })`.
- `scheduleIdleWake()`: return if a timer is pending or not idle;
  `setTimeout(flush, coalesceMs)` (unref) → `flush()`:
  - return unless `typeof pi.sendMessage === "function"`, idle, and
    `ledger.pending().length > 0`;
  - build the notice, `pi.sendMessage(notice, { triggerTurn: true })`,
    drain only after the synchronous call returns without throwing;
    wrap in try/catch so a throw leaves entries pending.
- Notice formatter (exported for tests) produces the exact spec text:
  header `Shepherd notice — N task(s) settled with no watcher attached:`,
  per-entry `- <taskId> (<agent>[, "label"]): <status> — <summary|error>`,
  and `Full results: shepherd_watch({ id: [ "id", ... ] })`.

Wiring in `src/extension/shepherd.ts`:

- Export `renderShepherdNotification` (its internals stay private; new
  module imports it — no cycle because `shepherd.ts` imports only the core
  ledger).
- In the `watch` action, after `taskWatcherService.watch(taskIds)` returns:
  `unseenCompletionLedger.clear(registration.taskIds)`. Do **not** add
  clearing to the watcher notifier: late `shepherd_watch` deliveries never
  reach it (verified against `TaskWatcherService.watch` and
  `verify-task-watchers.mjs`).
- In the `close` action, after `runtime.close(id)` succeeds:
  `const cleared = unseenCompletionLedger.clearForAgent(handle.id)` and
  append a report line/details when `cleared.length > 0`.

Wiring in `index.ts` (after `if (process.env.PI_SHEPHERD_SESSION) return;`
and `registerShepherdTools(pi)`, line ~447):

- `configureUnseenCompletionBridge(pi);`
- Not inside `registerShepherdTools` (six suites pass fakes without `on`
  and with renderer allow-lists).

## Stage 3 — Tests, docs, verification

- `test/verify-unseen-completions.mjs` (created in Stage 1 for core cases,
  extended here):
  - ledger: cancelled excluded; had-watchers excluded;
    delegate-submission-failure excluded; dedupe; drain; `clear` /
    `clearForAgent` return ids; `clearAll`.
  - observer: settle with watcher → `hadWatchers: true`; without → `false`
    + agent/label; `source` passthrough; listener throw does not break
    `settleTask`; unsubscribe works.
  - bridge with a fake pi surface (capture `on`,
    `registerMessageRenderer`, `sendMessage` like
    `test/verify-parent-surface.mjs`): idle burst → exactly one
    `triggerTurn` send and no duplicates; busy settle → single
    `agent_before_settle` result with `continue: true`; second boundary →
    `undefined`; `aborted` outcome → no continuation; a completed boundary
    with `canContinue: false` (pi's real pre-entry shape) → still
    continues; late `shepherd_watch` clears (assert through the real watch
    action or a direct `clear`); close clears and reports; renderer
    registered; fake pi without `sendMessage` never throws; unsubscribe on
    `session_shutdown`.
  - Use injected `coalesceMs` and an isolated ledger instance to keep the
    suite deterministic.
  - Register `unseen-completions:test` in `package.json` and append it to
    the `test` chain.
- Full `npm test` green with all existing suites untouched.
- Docs: README `### Delegate, then watch` gains the no-watcher notice
  paragraph; `docs/guides/tool-reference.md` `shepherd_watch` entry notes
  that unwatched settlements surface at the next settle boundary or as one
  idle wake, and that `shepherd_watch` still retrieves settled tasks
  synchronously. While there, fix the pre-existing "delivered as
  follow-ups" wording in the `shepherd_watch` description
  (`docs/guides/tool-reference.md`, `src/extension/shepherd.ts` ~1570) to
  match the actual `steer` delivery.
- Live smoke (throwaway script): delegate to a real agent without a watch,
  confirm the boundary notice + retrieval command; confirm `shepherd_watch`
  returns the result and no duplicate notice follows.

## Risks and decisions

- **pi boundary continuation safety** — guarded by the pending → drained
  transition; a second boundary with no new entries returns `undefined`.
- **Boundary `valid: false` drop window** — entries are drained when handed
  to pi; a pi-side rejection is not retried (documented residual). The
  entry is a well-formed `CustomMessageEntryDraft`, so rejection is
  unlikely.
- **Busy/idle desync** — `agent_settled` always transitions to idle and
  re-checks pending entries, so a missed boundary (abort/error) still
  yields one idle wake; `ctx.isIdle()` is preferred when available.
- **Delegate failure false positive** — eliminated by the
  `delegate-submission-failure` source tag.
- **Send failure** — synchronous throw keeps entries pending; no unbounded
  retry. `sendMessage` has no return value, so an async failure inside pi is
  invisible (same as existing bridges).
- **Race: watcher registers between drain and flush** — `clear` in the
  watch action removes the entry; a notice already sent can list a just
  retrieved entry, which is harmless (the model still has the result). No
  locking added.
- **Close drops pending entries** — reported in the close tool result so
  nothing vanishes silently.
- **No persistence** — a parent restart drops the ledger with the
  session-scoped registry; recovery for orphaned children is unchanged and
  outside this spec.
- **Existing suites** — subscription is session-scoped and the busy-pi
  flush checks the `sendMessage` surface, so suites that settle tasks with
  fake pi objects never break.

## Verification gates

1. Stage 1 + 2 unit suites green.
2. Full `npm test` green, existing suites untouched.
3. Live smoke passes (notice delivered, retrieval works, no duplicate).
4. No new dependencies; no tool schema, prompt, or settings diff.
