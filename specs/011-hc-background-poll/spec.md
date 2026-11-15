# Spec — hc background poll

## Status

Proposed. No behavior change yet. Direct continuation of 010: the settle
path is converged, but nothing *triggers* it promptly on hc. Spec-only:
no `src` changes in this spec; implementation follows one worker per
phase (see `plan.md`).

## Background: the gap

010 proved the ledger/observer/notice contract on both backends, and
Phase 3 made the deadline timer drain-first. The remaining hole is what
*pumps* the drain on hc:

- Herdr: `startParentBrokerMonitor()` (`src/runtimes/herdr/lifecycle.ts`
  ~line 84) runs `processParentBrokerMessages()` every 250 ms, unref'd,
  from broker creation until shutdown. Tool calls never need to drain;
  completions settle within ~250 ms of arrival, watchers fire, the
  unseen bridge notices.
- hc: `drainBrokerInbox()` (`src/runtimes/hc/runtime.ts`) runs only
  inside `message`, the `watch` blocking loop, and the delegate
  deadline timer. The extension's `watch` action uses the non-blocking
  `hcTaskWatcherService.watch` (no drain) and `status` uses
  `describeHcStatusView` (no drain).

Live evidence (010 smoke-1): `task_done` + `reply` sat in
`parent/inbox` ~10 minutes across several `status`/`watch` calls; only
the deadline timer's drain settled them (`completed`, done beat
timeout — the Phase 3 guarantee working as a backstop). With the
default 60-minute delegate timeout, an idle hc parent could wait an
hour for a completion it already holds.

A second, smaller defect rides along: `applyMessageEnvelope` resolves
its own broker with a bare `ensureBroker()` (no session id), which —
when that helper runs outside a session-keyed drain — mints a
fallback-keyed junk broker (`hc-parent-<gen>`), replaces the module
broker, orphans the session mailbox for later drains, and addresses
reply relays to a store the child never polls (010 journal: junk dirs
`AyfED1`, `84O93R`). Any background poller must never do this: it must
drain through the session-keyed broker only.

## Contract

### 1. Background drain while work is open

The hc runtime runs one background poll while delegated work may still
settle:

- Interval 250 ms, matching Herdr. Single timer per process, idempotent
  start, `unref`'d so it never keeps the host alive.
- Started on the first `delegate` (first open task — before that no
  completion can arrive); stopped when zero unsettled tasks remain.
  A later `delegate` restarts it. Stopped on module shutdown alongside
  the existing `shutdownHcStaleWaitMonitor` /
  `shutdownHcTaskWatchers` seams.
- Each tick calls exactly the existing `drainBrokerInbox()` (which
  already ends with `settleDueReplyTimeouts()`). Synchronous poll;
  a tick never overlaps the previous one in a way tool-call drains
  don't already handle (all drains are idempotent; settlement is
  first-wins per 010 §3).
- No session-identity drift, ever: the tick drains through the same
  session-keyed broker the tool calls use. It must not call bare
  `ensureBroker()` (see §3).

### 2. Observable behavior

- `delegate` with no `watch` and no `message` settles within ~1 s of
  child `shepherd_done` while the poller runs (bounded by the 250 ms
  tick, not by the delegate deadline).
- `watch` registration and `status` drain first, then report: an
  already-settled task returns `completed` synchronously instead of
  `pending`. Return shapes are unchanged, only the staleness is gone.
  (Decision: drain-first AND the background poll. Drain-first covers
  active parents at read time; the poll covers idle parents that make
  no calls at all — without it an idle Shepherd would still wait for
  the delegate deadline, up to the 60-minute default, before anything
  settles and the unseen notice fires. Herdr has both; parity needs
  both.)
- The unseen-notice contract (007/010) is unchanged; notices now fire
  promptly instead of at the deadline. No new entry kinds, no new
  timing guarantees beyond "tick-bounded".
- No new broker dirs, no new diagnostics, no retained timers after
  quiescence/shutdown. The process exits exactly as before with no
  open work.

### 3. Bare-`ensureBroker` hardening

`applyMessageEnvelope` already takes the drain's `active` broker (010
follow-up fix). The same rule becomes an invariant: **no settle-path
code may resolve a broker without the caller's session id.** The
background tick uses the session-keyed broker; if no session broker
can be resolved (no session context — e.g., after shutdown), the tick
skips instead of minting a fallback store.

### 4. Verification: deterministic, no live spawn

- Unit-tick seam: the poller exposes start/stop plus a synchronous
  single-tick entry (same precedent as 010 Phase 0 exporting the
  observer call for testability), so suites drive it without
  wall-clock waits and without live terminals.
- New suite file (e.g., `test/verify-hc-poll.mjs`), wired into
  `package.json` scripts + the `test` chain: tick with queued
  `task_done` settles it; tick with empty inbox is a no-op; timer
  starts on delegate and stops at quiescence; no fallback broker is
  ever minted by the tick; `unref` is set so the timer can't hold the
  process open.
- Live smoke (throwaway, both runtimes for contrast): delegate with no
  watch and no message; Herdr settles in ~250 ms as today, hc now too
  (previously hc waited for a message or the deadline).

## Non-goals

- Changing `watch` (still non-blocking registration), `status` (still a
  view), watcher batching, legacy prompt paths, or notice semantics.
- Persisting timers/ledgers across sessions; new settings (the 250 ms
  interval is fixed, mirroring Herdr — not configurable).
- Touching the Herdr poller, the broker transport, envelopes, or
  fieldnotes.
- Retrying failed drains, backoff, jitter, or adaptive intervals.

## Invariants (007/010 carried forward)

- Settlement is authoritative; the tick never settles directly and
  never invents a completion.
- First-wins ordering unchanged (010 §3); `cancelled` still excluded;
  `delegate-submission-failure` still excluded.
- Watched deliveries byte-for-byte unchanged; no new wake kinds.
- No tool-schema, prompt, settings, broker, or fieldnote changes.
- Existing suites pass untouched.
