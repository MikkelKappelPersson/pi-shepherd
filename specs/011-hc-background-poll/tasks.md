# Tasks — 011 hc background poll

Work in order. One worker per phase — phases run strictly sequential (the
timer touches the drain/settle seam 010 just stabilized). A task is done
only when its implementation + verification are complete. This spec is
`011-hc-background-poll` (spec.md contract, plan.md design). Continues
010, converges hc onto the Herdr promptness contract.

**This task is spec-only: no `src` changes.** The checkboxes below bind
the later implementation.

## Overnight run + testing (no reload)

- The main Pi session cannot reload extensions, so never rely on in-place
  reload for live verification (same rule as 009/010).
- For live tests needing new code: `hc run --bg` a fresh herdr-core agent
  (full `pi` path), then have that child call `shepherd_*`
  (`spawn`/`delegate`/`watch`/`done`) to spawn agents — a fresh Pi session
  with updated code.
- Keep `npm test` green in the current session for unit checks; use the
  fresh `hc` child only for live spawn/delegate/watch proof.

## Phase 0 — poller wiring + drain-first watch/status

- [x] **0.1 Background poller in the hc runtime**
  - In `src/runtimes/hc/runtime.ts`: module timer (250 ms fixed,
    `unref`'d, idempotent start), started on first `delegate`, stopped
    when zero unsettled tasks remain, restarted by the next `delegate`,
    stopped on module shutdown alongside `shutdownHcTaskWatchers` /
    `shutdownHcStaleWaitMonitor`.
  - Each tick calls exactly the existing `drainBrokerInbox()`; no new
    settle logic, no reordering, no invented completions.
  - Session-keyed broker only: the tick never calls bare
    `ensureBroker()`; audit every settle-path call site so each passes
    a session id (grep must show no bare settle-path calls left).
  - Export start/stop + a synchronous tick entry for tests (name TBD;
    precedent: 010 Phase 0 exporting the observer call).

- [x] **0.2 Drain-first hc watch registration + status view**
  - `shepherd_watch` (hc path): drain first via the session-keyed
    `drainBrokerInbox`, then the existing non-blocking
    `hcTaskWatcherService.watch`. Already-settled tasks report
    `completed` synchronously; return shapes unchanged.
  - `describeHcStatusView`: drain first for the same reason (stale
    `running` for settled tasks goes away).
  - The background poll stays required: it covers idle parents that
    make no calls (drain-first alone would still leave them
    deadline-bound).

- [x] **0.3 Verify Phase 0**
  - `npm test` green; no existing suite modified.
  - No fallback broker is minted by any settle-path call (source audit
    + unit probe); timer is `unref`'d; start is idempotent; stop fires
    at quiescence.

## Phase 1 — verification, docs, landing

- [x] **1.1 Deterministic suite** (`test/verify-hc-poll.mjs`, wired into
  `package.json` scripts + the `test` chain)
  - Tick with a queued `task_done` settles it through the 010 observer
    path (single winner, transcript readable); tick with an empty inbox
    is a no-op; tick with no session context skips without minting a
    store.
  - Timer starts on `delegate`, stops at zero unsettled tasks,
    restarts on the next `delegate`; `unref` set (cannot hold the
    process open).
  - Deterministic: exported tick seam, isolated ledger/registry, fake
    pi surface where needed, no live spawn, no wall-clock waits.

- [x] **1.2 Docs + live proof**
  - One-row note where 007/010 documented the notice (README `###
    Delegate, then watch` paragraph + `docs/guides/tool-reference.md`
    `shepherd_watch` entry): hc completions now settle tick-promptly
    even with no `watch` and no `message`.
  - Live smoke (throwaway script, both backends): delegate with no
    watch and no message; Herdr settles in ~250 ms as today, hc now in
    ~1 s (previously waited for a message or the deadline); no junk
    broker dirs; close drops + reports as before.

- [x] **1.3 Full suite + landing**
  - `npm test` green with all existing suites untouched.
  - Record scope, evidence, and the landing note in a `journal.md`
    before merging (follow the 007/010 journal precedent).
