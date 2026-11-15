# Tasks — 010 unseen-watch parity

Work in order. One worker per phase — phases run strictly sequential (no
parallel implementation workers; both phases touch the settle/notify
seam). A task is done only when its implementation + verification are
complete. This spec is `010-unseen-watch-parity` (spec.md contract,
plan.md design). Continues 009, converges onto the 007 contract.

**This task is spec-only: no `src` changes.** The checkboxes below bind
the later implementation.

## Overnight run + testing (no reload)

- The main Pi session cannot reload extensions, so never rely on in-place
  reload for live verification (same rule as 009).
- For live tests needing new code: `hc run --bg` a fresh herdr-core agent
  (full `pi` path), then have that child call `shepherd_*`
  (`spawn`/`delegate`/`watch`/`done`) to spawn agents — a fresh Pi session
  with updated code.
- Keep `npm test` green in the current session for unit checks; use the
  fresh `hc` child only for live spawn/delegate/watch proof.

## Phase 0 — hc observer hook, no behavior change

- [ ] **0.1 Add `onTaskSettled` to the hc settle path**
  - In `src/runtimes/hc/runtime.ts`: listener set + `onTaskSettled`
    returning unsubscribe, mirroring
    `src/runtimes/herdr/orchestration.ts` `onTaskSettled`.
  - Fire after the hc watcher fan-out (`notifyHcTaskWatchers`), with a
    shallow result copy and fresh `{ hadWatchers, agent?, label?,
    source? }`; `hadWatchers` true only when a watcher callback actually
    ran; agent handle captured for `agent`/`label`; listeners inside
    `try/catch`; fires only on the transition to terminal; prompt paths
    untouched.
  - `settleTask` gains the optional internal `source` options argument;
    the hc `delegateAgent` failure path passes `source:
    "delegate-submission-failure"`.
  - Bridge NOT rewired yet; direct ledger write stays until Phase 1, so
    behavior is unchanged.

- [ ] **0.2 Verify Phase 0**
  - `npm test` green; no existing suite modified.
  - Observer unit cases (hc side, in the unseen suite file or a scratch
    harness): settle with watcher → `hadWatchers: true`; without →
    `false` + agent/label; `source` passthrough; listener throw does not
    break `settleTask`; unsubscribe stops delivery.

## Phase 1 — bridge via active runtime; parity live

- [ ] **1.1 Subscribe through the resolved runtime**
  - `src/extension/unseen-completions.ts`: replace the direct Herdr
    `lifecycleRegistry` import with subscription through the active
    runtime's registry (per-command `resolveBackend` result; see plan.md
    open question 1 for placement).
  - Session scoping unchanged: subscribe on `session_start`
    (idempotent), release on `session_shutdown`; busy/idle tracking
    (`agent_start` / `agent_settled`, `ctx.isIdle()` preferred),
    `UNSEEN_NOTICE_COALESCE_MS` debounce, `triggerTurn` idle wake,
    `agent_before_settle` boundary continuation (`completed` only), no
    pre-entry `canContinue` check (#16), drain-on-hand-to-pi, best-effort
    send (throw keeps pending).
  - Remove the hc direct-ledger write: hc settles flow observer →
    `record` → `scheduleIdleWake`, exactly like Herdr. The bridge owns
    the only `record` call sites.

- [ ] **1.2 Verify Phase 1**
  - No-watch done → settle-or-idle-wake on BOTH backends: busy → one
    boundary continuation; idle → exactly one debounced wake per burst;
    notice text backend-agnostic (ids differ, wording identical).
  - `npm test` green, existing suites untouched.

## Phase 2 — matrix verification, docs, landing

- [x] **2.1 Unseen matrix case for hc** (in
  `test/verify-unseen-completions.mjs`; cross-link `verify-hc-matrix.mjs`)
  - Same prompts both runtimes: delegate + no watch + settle-as-done →
    byte-identical notice text modulo task/agent ids, Herdr and hc.
  - No id leak on hc: notices, tool results, widget rows carry opaque ids
    only (no raw `t4` / `w1:p1`, socket paths, `HERDR_*` / `HC_*`).
  - `delegate-submission-failure` on hc records nothing.
  - Timeout-vs-done race on hc: first settlement wins (deadline wins),
    loser ignored, transcript readable via `shepherd_read`, single
    winner-only unseen entry when unwatched.
  - Close-cancels-watch on hc: `cancelled`, ledger clean,
    `clearForAgent` ids reported in the close result, blocked watch
    resolves with cancellation.
  - Deterministic: injected small `coalesceMs`, isolated ledger, fake pi
    surface, no live spawn.

- [x] **2.2 Docs + live proof**
  - One-row parity note where 007 documented the notice (README `###
    Delegate, then watch` + `docs/guides/tool-reference.md`
    `shepherd_watch` entry): the notice holds on both backends.
  - Live smoke (throwaway script, both backends): delegate with no watch;
    boundary notice + `shepherd_watch` retrieval; idle wake fires once;
    close drops + reports; race keeps winner + transcript.

- [x] **2.3 Full suite + landing**
  - `npm test` green with all existing suites untouched.
  - Record scope, evidence, and the landing note in a `journal.md`
    before merging (follow the 007 journal precedent).

## Phase 3 — deadline drains inbox before settling timeout (live bug)

- [ ] **3.1 Drain-first deadline timer on hc**
  - In `src/runtimes/hc/runtime.ts` delegate deadline `setTimeout`:
    call `drainBrokerInbox()` first, settle `timed_out` only if the
    record still has no result (mirrors the `watch`-loop
    drain-then-check order). No other behavior change.
  - Done-in-inbox-before-deadline wins; genuinely late done still
    loses (first-wins by arrival). `delegate-submission-failure` path
    unchanged.

- [ ] **3.2 Regression test (deterministic, no live spawn)**
  - Inbox has queued `task_done` + expired deadline → `completed`,
    no timeout entry. Empty inbox + expired deadline → `timed_out`
    unseen entry. Late done after terminal timeout ignored, transcript
    readable, single winner-only entry.
  - `npm test` green, existing suites untouched.
