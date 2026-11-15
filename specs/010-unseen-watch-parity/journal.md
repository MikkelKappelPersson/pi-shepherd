# Journal — 010 unseen-watch parity, Phase 2

## Status — 2026-11-15

- **Scope: Phase 2 only** (matrix verification, docs, landing). Phase 0
  (hc `onTaskSettled` hook) and Phase 1 (bridge via active runtime,
  hc observer-owned record) are committed (`c3df761`, `5d18cac`) and
  untouched by this phase — no `src` changes here.
- Branch: `feat/010-unseen-watch-parity`, off `main`.
- No auto-watch, no broker/tool/schema/settings/fieldnote changes, no new
  dependencies. `src` unchanged; only `test/verify-unseen-completions.mjs`
  (new matrix blocks), one cross-link comment in
  `test/verify-hc-matrix.mjs`, one-row parity notes in `README.md` +
  `docs/guides/tool-reference.md`, `tasks.md` checkboxes, and this journal.
- **Status: implemented and verified.** `unseen-completions:test` EXIT 0
  (31 PASS, 8 new); `hc-matrix:test` EXIT 0 (73 PASS, behavior unchanged);
  every other runnable suite EXIT 0 with zero FAIL; throwaway live smoke
  ALL PASS on both backends. Two suites (`command-ux`, `session-boundary`)
  fail identically on `main` (environment drift, pre-existing) — see
  Residuals.

## Decisions

- The hc matrix lives in the unseen suite because that file already owns
  the fake-pi + isolated-ledger harness the spec demands; `hc-matrix`
  keeps the ownership/id-refusal cases both suites rely on. The suites
  cross-link by comment in both directions (unseen header/block header →
  `verify-hc-matrix.mjs` pattern; hc-matrix header → unseen suite).
- hc settle paths are driven through `notifyHcTaskSettledObservers` —
  the exact function Phase 0 exported "so observer parity is
  unit-testable without a live terminal" — subscribed via the production
  `subscribeToTaskSettlements` seam (both registries) in the bridge
  block, and via direct `onTaskSettled` capture with isolated ledgers in
  the matrix block. No live spawn anywhere in the committed tests.
- Same-prompts parity is asserted on normalized formatter output
  (`shepherd-(task|agent)-…` → placeholder): the Herdr side settles a
  real isolated `LifecycleRegistry`, the hc side fires the real observer
  call with the same prompt/summary/label, and both must produce
  byte-identical notices.
- Race/close need no new machinery (spec §3/§4): already-settled guards
  make the second settle a no-op and `cancelled` is ledger-excluded, so
  the matrix asserts the guards exist on both paths (source-text parity
  check, same precedent as the hc-matrix blocked-copy check) plus
  ledger-level first-wins/single-winner and
  resolve-then-cancelled/clearForAgent behavior; close-result reporting
  (`clearForAgent` + `clearedUnseenCompletions`) is asserted against the
  shared `shepherd.ts` close branch that serves both backends.
- Docs stay one row per location, where 007 documented the notice:
  README `### Delegate, then watch` paragraph + tool-reference
  `shepherd_watch` table row and entry paragraph.

## Log

- 2026-11-15: read spec/plan/tasks + Phase 0/1 diffs; confirmed no `src`
  work remains for Phase 2 (observer hook, source tag, bridge seam, and
  both close branches already in place).
- 2026-11-15: extended `test/verify-unseen-completions.mjs` (header
  note, hc-runtime + `readFileSync` imports, two blocks: hc matrix —
  same-prompts, no-id-leak, submission-failure, race, close — and hc
  bridge seam — idle wake, retrieval clear, busy boundary, all through
  the production subscription with isolated ledgers and injected
  15 ms coalesce).
- 2026-11-15: one-row parity notes in `README.md` (delegate-watch
  paragraph) and `docs/guides/tool-reference.md` (`shepherd_watch` row
  + entry paragraph); reciprocal cross-link comment in
  `test/verify-hc-matrix.mjs`; checked the three Phase 2 boxes in
  `tasks.md`.
- 2026-11-15: wrote throwaway `/tmp/010-phase2-smoke.mjs` (not
  committed): production singletons, default 250 ms coalesce, one
  cross-backend idle burst → exactly one `triggerTurn` wake naming both
  tasks; retrieval clear silent; busy settles → one boundary continuation
  covering both backends; close `clearForAgent` reports ids; race keeps
  the deadline winner with readable transcript. ALL PASS.
- 2026-11-15: `npm test` runs the `&&` chain, which stops at the
  pre-existing `command-ux` failure; ran every remaining suite
  individually instead: all EXIT 0, zero FAIL (627 PASS total across
  runnable suites), except the two pre-broken suites below.

## Landing — 2026-11-15

- Evidence at handoff: `unseen-completions:test` EXIT 0, 31 PASS
  (8 new Phase 2 lines); `hc-matrix:test` EXIT 0, 73 PASS; all other
  runnable suites EXIT 0, zero FAIL; live smoke ALL PASS (idle
  cross-backend burst → one wake; retrieval silent; busy → one boundary
  continuation; close reports; race keeps winner); `hc` backend
  reachable (`hc server status` ok).
- Env limits: no `herdr` binary on this machine, so pane spawn is
  impossible here — Herdr proof goes through the real singleton
  registry/broker path; no model-backed child spawn (cost), so hc
  settles go through the real settle-path observer. Live
  spawn/delegate/watch parity was proven manually in 009 1.1; this
  phase proves the settle/notify seam live through production
  singletons on both backends.
- Ready to merge `feat/010-unseen-watch-parity` into `main` (no commit
  made by this worker; landing commit left to the session owner).

## Residuals (pre-existing, out of scope)

- `command-ux:test` ("shepherd command registered") and
  `session-boundary:test` ("parent extension registers session_start
  handlers") fail identically on `main` with this worker's changes
  stashed — environment drift, not Phase 2. Untouched, as required.
