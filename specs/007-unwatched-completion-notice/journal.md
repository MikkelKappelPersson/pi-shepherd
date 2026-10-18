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
