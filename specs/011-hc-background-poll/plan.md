# Plan — 011 hc background poll

## Target

One timer, existing drain, both wired and removable:

```text
src/runtimes/hc/runtime.ts   background poller (start/stop/tick) + tick uses
                             session-keyed broker only; bare-ensureBroker ban
src/runtimes/herdr/lifecycle.ts  UNCHANGED (reference implementation only)
test/verify-hc-poll.mjs      NEW deterministic suite (no live spawn,
                             no wall-clock waits)
package.json / test chain    wire the new suite (script + chain entry)
docs                         one-row note where 007/010 documented notices
                             (README delegate-watch paragraph +
                             tool-reference shepherd_watch entry)
```

## Design decisions

1. **Mirror Herdr's shape exactly.** Herdr: module `parentBrokerTimer`,
   `startParentBrokerMonitor` (idempotent, 250 ms, `unref`), stopped on
   shutdown/quiescence. hc: module `hcDrainTimer` (or equivalent),
   started on first `delegate` (first open task — `tasks` already
   records `deadlineAt`, so "open" is cheap to compute), stopped when
   zero unsettled tasks remain, restarted by the next `delegate`.
   250 ms fixed, unref'd — no new setting (boring rule).
2. **Tick = one `drainBrokerInbox()` call, nothing else.** It already
   drains the parent inbox, applies completions/replies through the
   010 paths, and settles due reply timeouts. The tick adds no logic;
   settlement still flows observer → ledger → bridge exactly as today.
   Separately, hc `watch`-registration drains first (before the
   non-blocking `hcTaskWatcherService.watch`) and `describeHcStatusView`
   drains first: same drain function, synchronous, return shapes
   unchanged — an already-settled task reports `completed` instead of
   stale `pending`/`running`.
3. **Session-keyed broker only.** The tick resolves the broker the same
   way tool-call drains do (the adapter's `sessionId`); if no session
   key is available it skips the tick. It never calls bare
   `ensureBroker()`. This is the 010 follow-up invariant made
   structural: grep must show exactly one bare `ensureBroker()` left
   in the module (none — every call site passes a session id; verify
   by inspection in Phase 0).
4. **Test seam, not timers, in suites.** Export start/stop plus a
   synchronous `tickHcDrain`-style entry (name TBD in Phase 0;
   precedent: 010 exporting `notifyHcTaskSettledObservers` "so observer
   parity is unit-testable without a live terminal"). Suites drive the
   seam with isolated ledgers/registries; no `setInterval` fires in
   tests, no wall-clock waits.
5. **Shutdown joins the existing seams.** `shutdownHcTaskWatchers()`
   and `shutdownHcStaleWaitMonitor()` already exist as module exports;
   the poller stops alongside them (and is also safe to leave stopped:
   quiescence stops it anyway, and `unref` means it can never hold the
   process open).
6. **One worker per phase.** The timer touches the drain/settle seam
   that 010 just stabilized: Phase 0 (wiring) and Phase 1
   (verification) run strictly sequential, no parallel implementation
   workers.

## Order

Phase 0 — poller wiring + drain-first watch/status, no behavior
contract change beyond promptness/freshness:
timer + start/stop + tick seam + bare-`ensureBroker` audit (every
settle-path call site passes a session id); drain-first hc watch
registration + `describeHcStatusView`; `npm test` green, no
existing suite modified.

Phase 1 — deterministic suite (`verify-hc-poll.mjs`) + package.json
wiring + docs one-row + live smoke (throwaway, both backends:
delegate with no watch and no message settles in ~1 s on hc, ~250 ms
on Herdr as today) + journal + landing.

## Open questions

1. Start on `delegate` vs `spawn`? Decided: `delegate` (no completion
   can arrive before the first task exists; avoids waking the timer
   for agents that never receive work).
2. Stop condition: zero unsettled tasks — or also require zero live
   agents? Proposal: tasks only (agents without tasks cannot settle
   anything). Cheap either way; decide in Phase 0.
3. Tick seam shape: exported `tick` function vs injectable interval
   with `0` meaning manual? Proposal: exported tick + start/stop
   (simplest, mirrors the 010 observer-hook precedent).
4. ~~Should `watch`-registration/`status` also drain first?~~ Decided:
   yes — drain-first in both paths (return shapes unchanged). The
   250 ms poll is still required for idle parents that make no calls.
