# Unwatched completion notice

## Status

Reviewed specification (reviewer pass 2026-10-18 folded in, see journal).
No behavior change yet. Implements the approved direction in issue #15
(`bug: unwatched task completions are silently missed`).

## Summary

A tracked task that settles while the Shepherd has zero watchers is
currently silent: `settleTask` fans out only to registered watchers
(`src/runtimes/herdr/orchestration.ts`), so the durable result is never
surfaced and an idle Shepherd can sleep through it.

Add an **unseen-settlement ledger** and a parent-side notice:

- **Shepherd busy** → the notice is appended at pi's `agent_before_settle`
  boundary and the handler returns `continue: true` for one extra model
  request. No mid-turn interruption; the batch is read at the point where
  the run would otherwise end.
- **Shepherd idle** → one coalesced notice sent with
  `pi.sendMessage(..., { triggerTurn: true })`. This is the overnight
  guarantee.
- **Aborted/errored run** → no boundary continuation; entries stay pending
  and the idle path still delivers them once.

`shepherd_watch` stays the explicit, opt-in batching primitive (choose when
to become observable, choose which set of agents is one wake-up batch).
`shepherd_delegate` stays subscription-free. Nothing auto-subscribes.

## Problem

- `src/runtimes/herdr/orchestration.ts` — the task settlement fan-out
  delivers only to `taskWatchers`; with zero watchers the result is durable
  but unobserved.
- `src/extension/shepherd.ts` — `taskWatcherService.watch(...)` is the only
  subscription point (the `watch` action). `delegate` never subscribes.
- Incident (issue #15): task `shepherd-task-3a2282a0-1dcb4518-…` settled
  `completed` at 11:50:50 with no watcher; no notification was ever
  delivered; a later explicit `shepherd_watch` recovered it at 11:53.
- Delivery machinery itself works mid-turn when a watcher exists
  (`TaskWatcherService.flush` → `configureTaskWatcherBridge` →
  `pi.sendMessage` with `steer`), so the gap is purely "no subscriber".

## Goals

- Every non-cancelled tracked-task settlement that had no watcher at settle
  time is surfaced: delivered at the next boundary, or via one wake when the
  Shepherd is idle.
- Preserve `watch` flexibility: explicit timing and multi-task batching
  remain the Shepherd's choice; no auto-watch.
- Overnight safety: an idle Shepherd cannot sleep through a completion
  batch; a busy Shepherd is never interrupted mid-run.
- Notify once per settlement; no continuation loops; results stay
  retrievable until retrieved or closed.
- Zero change for watched tasks, legacy prompt watchers, lifecycle timing,
  broker protocol, tool schemas, and settings.

## Non-goals

- Auto-watch on `delegate` (rejected in issue #15).
- Child-side `shepherd_done` return changes and a `task_done_ack` envelope
  (deferred in issue #15).
- Broker envelope/schema changes of any kind.
- Persisting the ledger across sessions; it is in-memory and session-scoped
  like the task registry.
- Changes to legacy prompt watchers, watcher delivery mode (`steer`), or
  watcher batching semantics.
- New model-facing tools; a `shepherd_status` unseen-count is a possible
  follow-up, not part of this spec.

## Design

### 1. Detection: registry settlement observer

Add `onTaskSettled(listener): () => void` to the task registry
(`src/runtimes/herdr/orchestration.ts`). It fires once per actual
transition into a terminal task state, after the watcher fan-out, with:

- `result`: a shallow copy of the settled `TaskResult`, and
- `context: { hadWatchers: boolean; agent?: string; label?: string;
  source?: "delegate-submission-failure" }`
  - `hadWatchers` means "at least one watcher callback was invoked for
    this settlement";
  - `agent`/`label` come from the settled agent's handle so the notice can
    name the sheep without a registry lookup;
  - `source` lets callers mark settlements that are not unseen-at-source
    (see below).

- The observer is inert until subscribed; no existing call site changes
  behavior.
- Listener errors must never affect settlement (same discipline as the
  existing watcher callbacks).
- Prompt (legacy) settlements are not observed.
- **Delegate submission failure is not an unseen completion.** When
  `delegateAgent` fails before the child ever receives the task, it settles
  the task `failed` and throws; the Shepherd already sees the error in the
  `shepherd_delegate` tool result. That settle path passes
  `source: "delegate-submission-failure"` and the ledger ignores it.
- The hook is a registry capability, not one of the seven
  `ShepherdRuntime` methods. When the durable runtime lands (spec 006,
  Phase 1+), its registry equivalent must expose `onTaskSettled` with the
  same semantics; the extension subscribes through the active runtime's
  registry instead of importing the Herdr module directly.

### 2. Ledger: `src/core/unseen-completions.ts`

A small pure module exporting `UnseenCompletionLedger` plus a module-level
singleton `unseenCompletionLedger`, matching the `taskWatcherService`
precedent. It must import nothing from `@earendil-works/*`,
`src/runtimes/`, or `src/extension/`; it defines its own structural result
shape so it never depends on the Herdr runtime:

```ts
export interface UnseenSettlement {
  taskId: string;
  agentId: string;
  agent?: string;
  label?: string;
  status: "completed" | "blocked" | "failed" | "timed_out";
  ok: boolean;
  returnCode: number;
  text?: string;
  error?: string;
}
```

The ledger is a **queue of settlements that have not yet been noticed**,
keyed by `taskId`, in insertion order. Entries exist only while un-noticed;
notifying (boundary or idle) drains them. API:

- `record(result, { hadWatchers, agent?, label?, source? }): boolean` — adds
  only when `hadWatchers === false`, `source !== "delegate-submission-failure"`,
  `result.status !== "cancelled"`, and no entry exists. Returns whether a
  new entry was added.
- `pending(): ReadonlyArray<UnseenSettlement>` — un-noticed entries in
  insertion order.
- `drain(taskIds: string[]): void` — called after a notice was successfully
  handed to pi (boundary entry appended / idle send returned).
- `clear(taskIds: string[]): string[]` — retrieval; returns removed ids.
- `clearForAgent(agentId: string): string[]` — close; returns removed ids
  so the close tool result can report what was dropped.
- `clearAll(): void` — session lifecycle.

Excluded: parent-initiated cancellations (`shepherd_close` → `cancelled`)
and delegate submission failures. Included: `completed`, `blocked`,
`failed`, `timed_out`.

### 3. Notice content

Custom message `customType: "shepherd.task.unseen"`, `display: true`,
`details: { taskIds, settlements }`:

```text
Shepherd notice — N task(s) settled with no watcher attached:
- shepherd-task-… (worker "label"): completed — summary
- shepherd-task-… (reviewer): failed — error
Full results: shepherd_watch({ id: [ "id", ... ] })
```

- `details` uses `settlements`, not `completions`: the generic collapsed
  formatter (`formatCollapsedNotification` in `src/extension/shepherd.ts`)
  special-cases `details.completions` with watcher wording, which would
  replace the notice text in collapsed view.
- The custom type gets its own renderer (via the existing
  `renderShepherdNotification` helper, which must be exported from
  `shepherd.ts` for that purpose); the renderer formats from `settlements`
  and never falls through to the watcher formatter.
- The wording must say "no watcher attached", never "never retrievable": a
  watcher registered after settlement still receives the result
  synchronously. The notice never claims the result is lost.

### 4. Delivery policy

New extension bridge `src/extension/unseen-completions.ts`,
`configureUnseenCompletionBridge(pi, options?)`.

- **Wiring point:** called from `index.ts` after the
  `PI_SHEPHERD_SESSION` worker guard, next to `registerShepherdTools(pi)`
  — *not* inside `registerShepherdTools`. Six existing suites call
  `registerShepherdTools` with fake pi objects that have no `on` and an
  allow-list of renderer custom types (`verify-tool-schemas.mjs`,
  `verify-compat.mjs`, `verify-delegate.mjs`, `verify-stale-wait.mjs`,
  `verify-task-watchers.mjs`, `verify-watchers.mjs`); wiring there would
  break them. The index factory is exercised by suites that already pass
  `on` + `registerMessageRenderer` and is the real parent surface.
- **Session-scoped activation:** the bridge registers the `onTaskSettled`
  subscription on `session_start` and releases it on `session_shutdown`; a
  process that only imports the factory and settles tasks without a
  session never records anything. Re-subscription is idempotent
  (repeated `session_start` keeps one subscription).
- **Options:** `{ coalesceMs?, ledger? }`, defaulting to
  `UNSEEN_NOTICE_COALESCE_MS = 250` and the `unseenCompletionLedger`
  singleton, so tests can inject small timings and an isolated ledger.
- **Idle detection:** the bridge tracks busy/idle from `agent_start` →
  busy, `agent_settled` → idle, `session_start` → idle, and prefers
  `ctx.isIdle()` from the captured lifecycle context when available
  (`ExtensionContext.isIdle()`, pi types line 236). `pi.sendMessage` during
  the run-start window joins the starting run, so the fallback is safe.
- **Surface guard:** `flush` no-ops unless `pi.sendMessage` is a function;
  the fake-pi suites stay safe even if a timer fires.

Idle wake:

- `record()` returning true while idle schedules one debounced flush. A
  burst produces exactly one `pi.sendMessage(notice, { triggerTurn: true })`
  covering all pending entries; entries are drained after the call returns
  without throwing.
- If the timer fires while busy, it does nothing; the boundary path owns
  delivery.
- Delivery is best-effort: `pi.sendMessage` returns `void`, so only a
  synchronous throw is observable; that throw leaves entries pending so a
  later boundary/wake retries. Rejections and async failures inside pi are
  invisible and are not retried (consistent with the existing bridges).
- `session_shutdown` clears the timer; pending entries are dropped with the
  session-scoped ledger.

Boundary continuation:

- `pi.on("agent_before_settle", event)` — when `event.outcome ===
  "completed"` and pending entries exist, build one
  `custom_message` entry, drain those task ids, and return
  `{ entries: [entry], continue: true }`.
- Aborted/errored runs return no continuation. In real pi an aborted run
  generally never reaches the boundary; this guard is defense-in-depth and
  the idle path is the actual catch-all.
- The pre-entry `event.context` is not authoritative, so the handler always
  offers the continuation for a completed run with pending entries. pi
  builds that snapshot from the entries that existed before the handler
  ran, so it is non-continuable at a completed boundary; pi then commits
  the returned drafts and decides. A committed `custom_message` projects
  through `convertToLlm` as a user-role message, so the run continues. If
  pi still declines, the entry is already committed (rendered, not lost).
  See #16.
- pi may discard a boundary result it considers invalid (the runner's
  `valid: false` window). Our entry is a well-formed
  `CustomMessageEntryDraft`, so this is a rare residual: entries are
  drained when handed to pi and are not re-notified if pi rejects the
  result. This is documented, not retried.
- Loop safety: only the pending → drained transition produces a
  continuation; a second boundary with no pending entries returns
  `undefined`.

### 5. Clearing

- **Watch action** (`src/extension/shepherd.ts`, `watch` case):
  `unseenCompletionLedger.clear(registration.taskIds)` after
  `taskWatcherService.watch(...)` returns. This is the authoritative
  retrieval clear. It must not rely on the watcher notifier: for an
  already-settled task `watchTasks` delivers inline inside
  `TaskWatcherService.watch` *before* `watcherId` is assigned, so the
  queued delivery is dropped (`lifecycle.ts` `queue()` early-returns on an
  empty watcher id) and the notifier never sees it
  (`test/verify-task-watchers.mjs` already asserts that).
- **Close action:** after a successful `runtime.close(id)`, call
  `clearForAgent(handle.id)`; if it removed entries, the close tool result
  reports the dropped task ids (the Shepherd can `shepherd_watch` them
  before closing instead).
- `session_start` and `session_shutdown`: `clearAll()`.
- Pending entries are removed by retrieval, close, or session end. There is
  no second chance after a notice: a noticed entry is gone from the ledger.

### 6. Invariants

- Settlement is authoritative; the ledger and notice never change task
  state and never invent a completion.
- The settlement observer cannot slow or break settlement.
- Watched deliveries are byte-for-byte unchanged (mid-turn `steer`).
- No `continue: true` after an aborted or errored run.
- Notify-once per entry: no duplicate notices, no continuation loops.
- No tool-schema, prompt, settings, broker, or fieldnote changes.
- `registerShepherdTools` behavior is unchanged; all existing suites pass
  untouched.
- The ledger does not record while no parent pi session is active; session
  teardown clears it.

## Compatibility

- Existing `verify-*.mjs` suites pass untouched.
- Herdr-only installs keep working with no new dependencies and no
  settings.
- The observer hook is additive; `settleTask` behavior without a subscriber
  is identical.
