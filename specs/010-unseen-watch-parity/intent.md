# Intent — Unseen Watch Parity (herdr pane + hc)

## Why this exists

Spec 007 gave the Shepherd an overnight guarantee: a tracked task that
settles with zero watchers attached is never silent — it surfaces at the
next `agent_before_settle` boundary, or as one coalesced idle wake.
Spec 009 added a second runtime (`hc`) beside Herdr panes behind one
Shepherd surface.

The guarantee currently only holds on one backend. The notice bridge
(`src/extension/unseen-completions.ts`) subscribes to the Herdr
`lifecycleRegistry.onTaskSettled` observer; the `hc` runtime
(`src/runtimes/hc/runtime.ts`) feeds the shared `unseenCompletionLedger`
directly at its own settle point instead of through an equivalent
observer — so an `hc` settle records an entry but never schedules the
coalesced idle wake, never tags `delegate-submission-failure`, and never
passes through the same `hadWatchers` gate the bridge relies on.

This spec closes that gap as a direct continuation of 009: unwatched-done
parity. `delegate` + no `watch` + child `shepherd_done` must still notify
the Shepherd via the settle boundary / coalesced idle wake on **both**
backends.

## Who it serves

1. **App user (hc)** — delegates to a sheep, keeps working, never calls
   `shepherd_watch`. Must get the same "settled with no watcher attached"
   notice the TUI user gets — at the boundary when busy, as one wake
   when idle.
2. **TUI user (herdr)** — must notice zero change. Parity means the hc
   path converges onto the 007 contract, not that the Herdr path moves.
3. **Maintainer** — one ledger, one bridge, one notice shape, two
   settlement sources. No per-backend notice text, no per-backend
   renderer, no `herdr_*` vs `hc_*` unseen vocabulary.

## What success looks like

- Same orchestrator flow on both runtimes — `spawn -> delegate -> (no
  watch) -> shepherd_done` — ends with the Shepherd notified: boundary
  continuation when busy, exactly one `triggerTurn` wake when idle.
- A timeout and a `shepherd_done` racing each other settle exactly once:
  the deadline wins, the loser's result is ignored, the work transcript
  stays readable.
- Closing an agent with a pending watch cancels the task; no unseen
  entry, no wake, no boundary continuation for it.
- The verify suite proves same-prompts-both-runtimes with no raw-id leak
  (`t4`, `w1:p1`, socket paths never appear in a notice).

## Guiding values

1. **One contract, two sources.** 007's ledger + bridge semantics are the
   contract. The hc runtime adopts them; they are not redefined.
2. **Notify once, never interrupt.** Busy Shepherds learn at the boundary;
   idle Shepherds get one wake. No mid-turn `steer`, no loops.
3. **Boring.** No new tools, no schema change, no new settings, no new
   deps. The fix is wiring, not machinery.
