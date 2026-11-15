# Intent — hc background poll (011)

## Why this exists

Spec 010 closed the settle/notify seam: every hc settlement flows through
the observer into the shared ledger, and the Phase 3 deadline timer drains
first so a queued done beats an expired timeout. But settling still
requires *something to drain the parent inbox*, and on hc the only drains
are `message` tool calls and the delegate deadline timer. `watch`
(non-blocking registration) and `status` (read-only view) never drain.

Consequence, proven live in the 010 smoke runs: a child finishes,
`task_done` sits in `parent/inbox`, and with an idle Shepherd that sends
no messages, nothing settles until the delegate deadline fires — 10
minutes in the smoke, up to the 60-minute default setting in production.
The unseen notice (007/010) then arrives a full timeout late, and
`watch`/`status` report stale pending/running the whole time.

The pane backend never has this problem: it polls the parent inbox on a
250 ms background timer (`parentBrokerTimer` in
`src/runtimes/herdr/lifecycle.ts`, unref'd, started with the broker,
stopped on shutdown). hc needs the same heartbeat behind the same
surface — no new tools, no schema change, no new settings.

## Who it serves

1. **Idle Shepherd (hc)** — delegates, keeps working, never messages.
   Gets the settlement (and any unseen notice) within ~250 ms of the
   child finishing, not at the next message or the far-away deadline.
2. **Watch/status callers** — `watch` registration and `status` keep
   their current semantics, but the registry they read is drained in the
   background, so they stop reporting stale pending/running.
3. **Maintainer** — one drain function, two triggers (tool calls as
   today, plus the timer). No new machinery: the timer only calls the
   existing `drainBrokerInbox`, and settlement still flows through the
   010 observer into the shared ledger.

## What success looks like

- Same smoke as 010, minus the `message`: `spawn -> delegate -> (no
  watch, no message)` settles `completed` within seconds of
  `shepherd_done`, and the watcher/unseen notice follows at once.
- No junk output: the background poll creates no broker dirs, writes no
  diagnostics on the happy path, and never keeps the host process alive
  (unref'd, stops when quiescent).
- Deterministic suite: no wall-clock waits — an exported tick/start/stop
  seam drives the timer logic in unit tests, same precedent as 010
  Phase 0 exporting `notifyHcTaskSettledObservers` for testability.

## Guiding values

1. **Mirror Herdr, don't invent.** 250 ms, unref'd, single idempotent
   timer, stop on quiescence/shutdown. Boring on purpose.
2. **Settle path untouched.** The timer triggers drains; it never settles
   directly, never reorders, never invents completions.
3. **No new surface.** No tools, no schema, no settings, no broker
   changes. Wiring only, like 010.
