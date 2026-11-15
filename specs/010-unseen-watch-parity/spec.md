# Spec — Unseen Watch Parity (herdr pane + hc)

## Status

Proposed. No behavior change yet. Continuation of 009 (hc runtime),
converging the hc settle path onto the 007 (unwatched completion notice)
contract. Spec-only: no `src` changes in this spec; implementation follows
one worker per phase (see `plan.md`).

## Background: the gap

007 built the guarantee from three parts:

- `UnseenCompletionLedger` (`src/core/unseen-completions.ts`) + singleton
  `unseenCompletionLedger` — queue of un-noticed settlements.
- Registry settlement observer — `onTaskSettled(listener)` in
  `src/runtimes/herdr/orchestration.ts`, firing `(result, { hadWatchers,
  agent?, label?, source? })` after the watcher fan-out.
- Notice bridge (`src/extension/unseen-completions.ts`) —
  `configureUnseenCompletionBridge(pi, { coalesceMs?, ledger? })`:
  subscribes to the observer on `session_start`, tracks busy/idle
  (`agent_start` / `agent_settled`, preferring `ctx.isIdle()`), delivers
  at the `agent_before_settle` boundary (`{ entries: [entry], continue:
  true }` on `completed` runs only) or via one debounced
  `pi.sendMessage(notice, { triggerTurn: true })` after
  `UNSEEN_NOTICE_COALESCE_MS = 250`.

The hc runtime (`src/runtimes/hc/runtime.ts`, `settleTask` ~line 812)
currently bypasses the observer: it calls `notifyHcTaskWatchers(result)`
for its own fan-out and then records **directly** into the shared ledger.
Consequences:

1. No idle wake is scheduled for hc settles — `scheduleIdleWake()` only
   runs inside the bridge's Herdr-observer callback. An hc settle while
   idle records an entry that waits for the next `agent_settled` tick or
   boundary instead of one coalesced wake.
2. No `source` tag — the `delegate-submission-failure` exclusion (007
   §1/§2: a delegate call that fails before the child ever receives the
   task settles `failed` but is already visible in the `shepherd_delegate`
   tool result) is not passed through on hc, risking a false-positive
   notice for an error the Shepherd already saw.
3. The bridge subscribes to exactly one registry
   (`lifecycleRegistry.onTaskSettled` from
   `src/runtimes/herdr/orchestration.ts`); the hc settle point has no
   `onTaskSettled` equivalent for the bridge (or tests) to subscribe to.

## Contract

### 1. No-watch done → settle-or-idle-wake, both backends

`delegate` with no subsequent `watch`, followed by child
`shepherd_done`, must notify the Shepherd identically on Herdr panes and
hc terminals:

- **Shepherd busy** → one `agent_before_settle` continuation
  (`completed` outcome only): a single `custom_message` entry with
  `customType: "shepherd.task.unseen"`, drained task ids, `continue:
  true`. Aborted/errored runs return nothing; entries stay pending for
  the idle path.
- **Shepherd idle** → exactly one debounced
  `pi.sendMessage(notice, { triggerTurn: true })` per burst, after
  `UNSEEN_NOTICE_COALESCE_MS`. Entries drain only after the synchronous
  send returns without throwing; a throw leaves entries pending for retry.
- Notice content is backend-agnostic and identical: header `Shepherd
  notice — N task(s) settled with no watcher attached:`, per-entry
  `- <taskId> (<agent>[, "label"]): <status> — <summary|error>`, footer
  `Full results: shepherd_watch({ id: [ "id", ... ] })`, with
  `details: { taskIds, settlements }` (never `completions` — that key
  collides with the watcher collapsed formatter).
- `shepherd_watch` after the notice still retrieves the settled result
  synchronously and clears the entry (authoritative retrieval clear in the
  `watch` action, not the watcher notifier — late-watch deliveries never
  reach the notifier).

### 2. Observer parity on hc

The hc settle point gains an `onTaskSettled` hook with the same semantics
as the Herdr registry observer (007 §1):

- Fires once per actual transition into a terminal task state, after the
  hc watcher fan-out, with a shallow copy of the result and `{ hadWatchers,
  agent?, label?, source? }`.
- `hadWatchers` is true only when at least one hc watcher callback
  actually ran for the settlement.
- `source: "delegate-submission-failure"` marks the hc delegate-failure
  settle path; the ledger ignores it (the error is already in the
  `shepherd_delegate` tool result).
- Listeners run inside `try/catch` after the fan-out; listener failure
  never affects settlement; no subscriber means identical behavior.
- Prompt (legacy) settlements are not observed.

The bridge subscribes through the **active runtime's registry** (resolved
per command, same as 009's `resolveBackend`) instead of importing the
Herdr module directly — the seam 007 §1 anticipated ("its registry
equivalent must expose `onTaskSettled` with the same semantics; the
extension subscribes through the active runtime's registry"). The hc
direct-ledger write is removed; hc settles flow through observer →
`ledger.record` → `scheduleIdleWake`, exactly like Herdr.

### 3. Timeout-vs-done race: inbox drains before the deadline wins

A tracked reply deadline (`shepherd_delegate` `timeout`) and a child
`shepherd_done` racing each other settle the task exactly once, on both
backends:

- First settlement wins. The task registry's already-settled guard
  (Herdr `settleTask` early-return on non-running state; hc `if
  (record.result)` guard) makes the second settle a no-op — same rule as
  today, now asserted for both runtimes.
- The deadline timer MUST drain the parent inbox before settling. hc
  `drainBrokerInbox()` runs only on tool calls (`message`/`watch`/
  `status`/`read`/`close`) — an idle parent with no watch makes none,
  so a `task_done` envelope can sit in the broker inbox while the bare
  `setTimeout(deadline)` fires `timed_out` first. The fix: the deadline
  callback drains first and settles timeout only if still no result.
  A done already in the inbox before the deadline then wins (it was
  truly first); a done arriving after keeps losing (correct first-wins).
  The `watch`-loop deadline check already drains first — the timer is
  brought to the same order.
- In practice a late `shepherd_done` still loses: it arrives at an
  already-terminal task and is ignored (child sees the settled state,
  not a second completion).
- The losing side's work is not lost: the agent transcript remains
  readable via `shepherd_read`, and the winning settlement's text/error
  names the outcome. No unseen entry is recorded for the ignored loser
  (it was never a settlement).
- If the timeout settles with no watcher attached, §1 applies: the
  `timed_out`/`blocked` entry is itself an unseen settlement and is
  notified once.

### 4. Close cancels pending watch

Closing an agent with an outstanding delegated task (`shepherd_close`)
cancels the task on both backends:

- Settlement is `cancelled`; the ledger never records `cancelled`
  (007 §2), so no unseen entry and no wake/boundary continuation arise
  from the close itself.
- `clearForAgent(handle.id)` after a successful `runtime.close` drops any
  still-pending unseen entries for that agent and reports the dropped
  task ids in the close tool result (retrievable-before-close via
  `shepherd_watch` remains the Shepherd's choice).
- A `shepherd_watch` already blocked on the task resolves with the
  cancellation rather than hanging; no new watch may attach to a closed
  agent's tasks.

### 5. Verification: unseen matrix case for hc

Extend the unseen suite (`test/verify-unseen-completions.mjs`) with an hc
matrix case alongside the `verify-hc-matrix.mjs` pattern (009 Phase 1.2):

- Same prompts on both runtimes: `delegate` + no `watch` +
  settle-as-`done` produces byte-identical notice text modulo task/agent
  ids, on Herdr and hc settle paths.
- No id leak: notices, tool results, and widget rows on the hc path
  contain opaque ids only — no raw `t4` / `w1:p1`, no socket paths, no
  `HERDR_*` / `HC_*` values.
- `delegate-submission-failure` on hc records nothing.
- Timeout-vs-done race on hc: settle-then-settle keeps the first result;
  transcript readable; single (winner-only) unseen entry when unwatched.
- Close on hc: `cancelled`, ledger clean, close result reports dropped
  ids.
- Deterministic: injected small `coalesceMs` + isolated ledger instance,
  fake pi surface (capture `on` / `registerMessageRenderer` /
  `sendMessage`), no live spawn — same discipline as the existing unseen
  bridge cases.

## Non-goals

- Auto-watch on `delegate` (rejected in 007, stays rejected on hc).
- Child-side `shepherd_done` return or `task_done_ack` envelope changes.
- Broker envelope/schema changes; new model-facing tools; new settings;
  `shepherd_status` unseen-count (still a possible follow-up, not this
  spec).
- Persisting the ledger across sessions (in-memory, session-scoped, both
  backends).
- Changing watched-task delivery (`steer`), watcher batching, legacy
  prompt watchers, or lifecycle timing.

## Invariants (007 carried forward, both backends)

- Settlement is authoritative; ledger and notice never change task state
  and never invent a completion.
- The settlement observer cannot slow or break settlement (either
  runtime).
- Watched deliveries byte-for-byte unchanged.
- No `continue: true` after an aborted or errored run.
- Notify-once per entry; no continuation loops.
- No tool-schema, prompt, settings, broker, or fieldnote changes.
- `registerShepherdTools` behavior unchanged; existing suites pass
  untouched.
