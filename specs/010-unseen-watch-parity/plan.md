# Plan — 010 unseen-watch parity

## Target

Converge the hc settle path onto the 007 contract with wiring only:

```text
src/runtimes/hc/runtime.ts        onTaskSettled hook + source tag; remove direct ledger write
src/extension/unseen-completions.ts  subscribe via active runtime's registry (resolveBackend),
                                     not the Herdr import
src/core/unseen-completions.ts    UNCHANGED (ledger is already runtime-neutral)
test/verify-unseen-completions.mjs  + hc matrix case (same-prompts, no-id-leak, race, close)
package.json / test chain          UNCHANGED (suite file already wired)
docs                               one-row parity note where 007 documented the notice
```

## Design decisions

1. **Observer, not direct write.** The hc `settleTask` (~line 812)
   currently calls `unseenCompletionLedger.record(...)` inline. Replace
   with an `onTaskSettled` listener set + post-fan-out invocation
   mirroring `src/runtimes/herdr/orchestration.ts` (~line 380): compute
   `hadWatchers` from the hc fan-out (`notifyHcTaskWatchers`), capture
   the agent handle for `agent`/`label`, carry the internal `source` tag
   from `settleTask` options, invoke inside `try/catch`. The bridge then
   owns the only `record` call site on each path, so `scheduleIdleWake`
   fires for hc settles too — that is the actual parity fix.
2. **Subscribe through the active runtime.** The bridge currently imports
   `lifecycleRegistry` from the Herdr orchestration module. Resolve the
   registry per command from the same backend resolution 009 built
   (`resolveBackend`: explicit pin, else `detectCaller`), subscribing to
   whichever runtime is active. Session scoping stays as-is: subscribe on
   `session_start` (idempotent), release on `session_shutdown`, no
   subscription without a parent session.
3. **Ledger untouched.** `record` / `pending` / `drain` / `clear` /
   `clearForAgent` / `clearAll` already encode the whole policy
   (`hadWatchers === false`, `cancelled` excluded,
   `delegate-submission-failure` excluded, dedupe by `taskId`). Both
   observers feed it; no new states, no new API.
4. **Race and close need no new machinery.** Already-settled guards make
   the second settle a no-op; `cancelled` is already ledger-excluded;
   `clearForAgent` + close-result reporting already exist. The work is
   asserting both backends do it, not building it.
5. **One worker per phase.** Implementation runs strictly sequential —
   one worker per phase (Phase 0, then 1, then 2). No parallel
   implementation workers: both phases touch the settle/notify seam and
   would conflict. This spec task is spec-only (no `src` changes); the
   rule binds the later implementation.

## Order

Phase 0 — hc observer hook + source tag (settle-path only, bridge
unwired: no behavior change, suite green).
Phase 1 — bridge subscribes via active runtime; direct hc ledger write
removed; notice parity live on both backends.
Phase 2 — matrix verification (same-prompts, no-id-leak, timeout-vs-done
race, close-cancels-watch) + docs + live proof.

## Open questions

1. Where does the "active runtime's registry" handle live — return the
   registry from `createHcRuntime`/`createHerdrRuntime`, or expose a
   `resolveRegistry()` beside `resolveBackend`? Proposal: beside
   `resolveBackend`, keeping the seven `ShepherdRuntime` methods
   unchanged (007 already ruled the hook is a registry capability, not a
   runtime method).
2. Does the hc delegate-failure path settle through the same `settleTask`
   internal function (so the `source` option threads trivially), or does
   it need a new tag site? Proposal: same function, one options argument
   — verify by reading the hc `delegateAgent` failure path in Phase 0.
3. `verify-hc-matrix.mjs` vs `verify-unseen-completions.mjs` for the new
   matrix case? Proposal: unseen suite owns it (it has the fake-pi +
   isolated-ledger harness); hc-matrix keeps the ownership/id-refusal
   cases. Cross-link both.
