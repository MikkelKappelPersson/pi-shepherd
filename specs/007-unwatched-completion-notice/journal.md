# Journal — 007 unwatched completion notice

## Status — 2026-10-18

- **Scope: implement all of spec 007** (unseen-settlement ledger + settle
  boundary / idle-wake notice). The design is the approved direction in
  GitHub issue #15.
- Branch: `feat/007-unwatched-completion-notice`, created off `main`.
- No auto-watch on `delegate`; no child-side `task_done_ack` (deferred); no
  broker protocol, tool schema, prompt, or settings changes; no new
  dependencies; existing `verify-*.mjs` suites must stay untouched.
- **Merge condition:** reviewer pass + `npm test` green (existing suites
  untouched, new `verify-unseen-completions` in the chain) + live smoke
  (an unwatched settlement produces the boundary notice with the retrieval
  command; `shepherd_watch` retrieves the result; no duplicate notice).
  Then merge `feat/007-unwatched-completion-notice` back into `main`.
- **Status: implemented, reviewed, and verified.** Full `npm test`
  EXIT=0 with 487 PASS assertions (new suite in the chain; no existing
  test file modified); live Herdr smoke ALL PASS twice, including once
  after the review fixes.

## Decisions

- The runtime-neutral seam is a registry observer:
  `onTaskSettled(result, { hadWatchers, agent?, label?, source? })`, fired
  after the watcher fan-out on the transition into a terminal task state.
- The ledger is pure core (`src/core/unseen-completions.ts`, singleton like
  `taskWatcherService`, structural `UnseenSettlement`, no runtime imports);
  delivery policy lives in `src/extension/unseen-completions.ts`.
- The ledger is a queue of **un-noticed** settlements: notify drains the
  entry, so notify-once and loop-safety hold by construction. Entries clear
  on retrieval (watch action) / close (`clearForAgent`, reported) / session
  end.
- Clearing for a late `shepherd_watch` lives in the **watch action**, not
  the watcher notifier: settled tasks are delivered inline inside
  `TaskWatcherService.watch` before the watcher id exists, so the notifier
  never sees them.
- Parent-initiated cancellations (`shepherd_close` → `cancelled`) never
  enter the ledger; neither do `delegateAgent` submission failures (tagged
  `source: "delegate-submission-failure"` — the Shepherd already sees the
  error in the tool result).
- No persistence: the ledger is session-scoped like the task registry.
- The bridge is wired in `index.ts` (parent surface), not in
  `registerShepherdTools`, and subscribes only while a parent session is
  active.

## Log

- 2026-10-18: spec/plan/tasks drafted
  (`specs/007-unwatched-completion-notice/`), branch
  `feat/007-unwatched-completion-notice` created off `main`.
- 2026-10-18: static spec review delegated to the `reviewer` sheep
  (`shepherd-task-3a2282a0-d0e0c413-…`), watcher registered.
- 2026-10-18: review returned 3 Critical + 6 Warning + suggestions; verified
  against source and folded in before the implementation commit:
  1. clear-on-watch was impossible as specified (late delivery bypasses the
     notifier) → clear in the watch action;
  2. wiring inside `registerShepherdTools` would break six fake-pi suites →
     wire in `index.ts` after the worker guard, session-scoped subscription,
     `sendMessage` surface guard;
  3. the core ledger could not import `TaskResult` from the Herdr runtime →
     structural `UnseenSettlement` in core;
  4. observer context now carries `agent`/`label`/`source`;
  5. delegate submission failures no longer produce a false notice;
  6. `details` uses `settlements` (the generic collapsed formatter owns
     `completions`); close reports dropped entries; drop-on-notify replaces
     the `unseen|notified` two-state design; debounce/ledger injectable for
     deterministic tests; docs fix for the stale "follow-ups" wording.
- 2026-10-18: implementation delegated to worker-05
  (`shepherd-task-3a2282a0-93277d49-…`, watched). It delivered the ledger,
  observer + `source` tag, bridge, wiring, tests, and docs without
  committing. I inspected the diff, ran the full suite, and ran the live
  smoke, which caught one harness bug (counting every `sendMessage` instead
  of the unseen-notice custom type) and then passed.
- 2026-10-18: independent code review delegated to reviewer-05
  (`shepherd-task-3a2282a0-713bd813-…`, watched). Verdict: **no
  Critical**; all 3 spec-review Criticals and all 8 warnings confirmed
  fixed, boundary semantics cross-checked against pi's runner internals.
  Two warnings fixed after review: (a) `hadWatchers` no longer counts a
  callback-less watcher registration as observed, and (b) the test suite
  now guards the delegate-failure source tag end-to-end and watched
  settlement suppression at the bridge level.
- 2026-10-18: post-review polish adopted from the suggestions: summary
  detail falls back to error text on an empty summary and is clipped at
  200 chars (full result stays one `shepherd_watch` away); the renderer
  falls back to message content when `details.settlements` is absent;
  `agent_settled` no longer schedules an empty-ledger timer; the boundary
  comment names the cross-extension projection trigger. Not adopted:
  clearing on `waitForTasks` retrieval (not reachable from the tool
  surface; the spec defines clearing on the watch action and the notice is
  accurate) and close-details duplication (consistent with existing
  actions).
- 2026-10-18: final verification after the fixes: `npm test` EXIT=0,
  487 PASS, no failures; live smoke ALL PASS; then merge to `main`.

## Landing — 2026-10-18

- Landed on `main` as `93fafe8` (fast-forward from
  `feat/007-unwatched-completion-notice`).
- Evidence at landing: `npm test` EXIT=0, 487 PASS assertions (new
  `unseen-completions:test` in the chain; every pre-existing suite
  untouched); live Herdr smoke ALL PASS — a real spawned worker with no
  watcher produced exactly one boundary notice (`continue: true`) while
  busy, exactly one coalesced `triggerTurn` notice while idle, and
  `shepherd_watch` retrieval of the settled task cleared the ledger with
  no duplicate notice.
- Review: reviewer-05 found no Critical; all three spec-review Criticals
  and all eight warnings were verified fixed before merge.
- Deferred non-goals (kept in issue #15): auto-watch on delegate;
  child-side `task_done_ack`; ledger persistence across sessions; a
  fallback when a watcher exists but its notification delivery is
  swallowed; clearing on `waitForTasks` retrieval.

## Correction — 2026-10-19

- **Defect (#16):** the `agent_before_settle` handler bailed out when
  `event.context.canContinue` was false. pi builds that snapshot from the
  entries that existed *before* the handler runs (`emitBoundary` in
  `dist/core/extensions/runner.js`), so at a completed boundary it is
  `finalRole === 'assistant'` and therefore always false: the primary
  boundary route was dead code and only the 250ms idle wake ever delivered
  a notice. `pi -p` lost notices entirely — the unref'd timer never fires
  and `session_shutdown` clears the ledger.
- **Fix:** `ccf339c` drops the pre-entry guard. The handler always returns
  `{ entries: [entry], continue: true }` for a completed run with pending
  entries; `_runBeforeSettleBoundary` in `dist/core/agent-session.js`
  commits the drafts via `_commitBoundaryDrafts` and only then recomputes
  `finalContext.canContinue` via `_buildBoundaryContext`, where a committed
  `custom_message` projects through `convertToLlm` as a user-role message.
- **Live evidence (real pi):** the `pi -p` probe logs
  `canContinue=true pending=0` followed by exactly one continuation
  (previously `canContinue=false pending=1` and the notice was discarded);
  an unwatched child settling mid-turn is announced 61ms after the
  turn-end marker. That is faster than the 250ms idle-wake debounce, so the
  idle path cannot have produced it and the boundary route is demonstrably
  the delivering path.
- **This entry (#17)** corrects the test and spec contract that still
  pinned the old behavior: the suite's busy-boundary fixture used a
  synthetic `canContinue: true` (a pre-entry shape pi only emits when
  queued or pending messages already exist) and asserted that
  `canContinue: false` returns `undefined`; `spec.md` plus the plan/tasks
  notes described the same pre-entry assumption. Fixtures now use pi's
  real clean-boundary shape and assert the continuation, with a drift-guard
  comment naming the pi internals; the post-commit gate stays covered by
  the real-pi probe, not the hermetic suite.
