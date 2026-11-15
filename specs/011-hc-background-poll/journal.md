# Journal — 011 hc background poll

## Scope (single turn, per user request)

Full spec in one turn: poller wiring + drain-first watch/status (Phase 0),
deterministic suite + docs + live smoke (Phase 1), landing (Phase 2).

## What changed

- `src/runtimes/hc/runtime.ts`
  - Hoisted the drain pipeline (`settleTask`, `resolveReplyForTask`,
    `openPendingRequest`, `writeTaskDoneDiagnostic`,
    `applyTaskDoneEnvelope`, `applyMessageEnvelope`,
    `settleDueReplyTimeouts`) from the `createHcRuntime` closure to
    module scope — verified closure-free (module maps/services only).
    The closure keeps a thin `drainBrokerInbox()` wrapper, so all four
    existing call sites (delegate, message, watch loop, deadline timer)
    behave exactly as before.
  - New module poller: `HC_DRAIN_POLL_MS = 250` (mirrors Herdr),
    single idempotent unref'd timer, `registerHcPollSession` /
    `startHcInboxPoller` / `stopHcInboxPoller` /
    `isHcInboxPollerRunning` / `pollHcInboxOnce` /
    `drainHcInboxForSession` / `hcInboxPollerStateForTests`.
    `delegate` registers its session at task creation. Tick drains the
    registered session, then stops at quiescence (no unsettled tasks).
  - `registerHcPollSession` resolves through `ownerSessionKey` exactly
    like the drains (explicit id → env session → process fallback),
    never skipped: the tick always polls the same store tool calls use.
    Found live: the first version validated only the passed arg, so an
    env-session runtime (the smoke) never started the poller.
- `src/extension/shepherd.ts`: hc `watch` registration and `status`
  view drain first via `drainHcInboxForSession` (best-effort try/catch,
  returns false without touching anything when no session resolves —
  a read can never mint a broker). Return shapes unchanged.
- `test/verify-hc-poll.mjs` (new, wired as `hc-poll:test` at the end of
  the `test` chain): 7 assertions, no live spawn, no wall-clock waits —
  seam lifecycle (idempotent start, unref, stop), quiescence stop,
  no-mint guarantee, full tick→poll→apply pump with a real on-disk
  broker (queued `task_done` consumed to `processed/` + dropped
  diagnostic), latest-registration-wins.
- Docs: one row each in `README.md` (delegate-watch paragraph) and
  `docs/guides/tool-reference.md` (watch entry).

## Design finding: single session, not a set

The first cut tracked a *set* of poll sessions. Live-trace reasoning
showed the module caches exactly one broker: alternating session keys
would mint a fresh store on every `ensureBroker` call, so a multi-key
tick would poll fresh empty stores and never find completions. The hc
runtime is already single-session-per-process (module `generationId`
baked into every id), so the poller tracks one key, latest wins. This
is load-bearing, not style — recorded here so nobody "generalizes" it
back into a set.

## Live evidence (throwaway `/tmp/011-live-smoke.mjs`, fresh process)

Real `hc run --bg` worker, `delegate` with a 30-minute deadline (so the
Phase-3 deadline drain cannot confound), then **no watch, no message,
no status calls** — observation only via `describeHcStatusView` (pure
map read) and direct inbox dir stats:
`spawn → delegate → poller running → done arrives → settled 3 s later`
(granularity-bounded; tick is 250 ms), close clean, zero new
`hc-parent-*` junk stores. Note: the status view only carries
*unsettled* tasks, so a delegated task vanishing from the view while
the agent is known IS the settlement signal.

## Verification

- `npm test` exit 0 (676 PASS lines), all pre-existing suites untouched,
  `hc-poll:test` green at the end of the chain.
- Live smoke passed (above).

## Landing

Single commit on `feat/011-hc-background-poll`, fast-forward merged to
`main`. 010's branch is already merged; 011 builds directly on it.
