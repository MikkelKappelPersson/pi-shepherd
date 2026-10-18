# Journal — 006 dual-runtime Shepherd (Herdr + Durable)

## Status — 2026-10-18

- Spec restructured to the agreed `src/runtimes/` layout, with review
  fixes folded in (`c4f0daa`, `65c0011`).
- **Scope decision: implement Phase 0 only.** Land the 2-runtimes-1-core
  boundary (runtime interface + `src/core/ids.ts` + Herdr rename-only move
  + temporary shims) with zero behavior change.
- Phases 1–4 (durable backend, message/status parity, fieldnotes bridge,
  auto viewer, docs/live proof) are **not** implemented at this point and
  remain future work on this spec.
- **Merge condition:** when Phase 0 is green — `npm test` plus live Herdr
  checks (idle spawn, non-blocking prompt, single + multi-wait, status,
  close, ownership refusal, focus preservation; the project-agent gate is
  covered by the suite rather than live, to avoid mutating user settings)
  — merge `feat/006-dual-runtime-herdr-durable` back into `main`.
  Unfinished Phase 1+ work must not be carried to `main`.
- Herdr-only install stays dependency-clean: no `pi-durable` /
  `@earendil-works/chord` added in Phase 0.

## Decisions

- Layout: `src/core/` = shared domain only; `src/runtimes/runtime.ts` =
  `ShepherdRuntime` interface; `src/runtimes/herdr/` = Herdr
  implementation; `src/runtimes/durable/` = future; `src/extension/` =
  pi-coding-agent surface.
- Phase 0 keeps re-export shims at the old
  `src/core/{herdr,orchestration,lifecycle,messaging}.ts` and
  `src/extension/config.ts` paths so existing `verify-*.mjs` imports stay
  untouched. Shims are removed (with import-path updates) in task 1.5,
  i.e. after a durable path exists.
- The settings store moves to `src/core/config.ts` so runtimes never
  import the extension layer; `/shepherd settings` UI stays in
  `src/extension/`.
- The runtime interface is lifecycle-only. Discovery stays shared;
  `herd`/`agents`/`prune`/widget keep runtime introspection accessors.

## Log

- 2026-10-18: spec intent/plan/tasks landed (`4960f35`).
- 2026-10-18: adopted `src/runtimes/` layout + shim policy (`c4f0daa`).
- 2026-10-18: review fixes — ID codec task, one-contract wording, tool
  list, task 1.5 scope (`65c0011`).
- 2026-10-18: scope narrowed to Phase 0 until green; merge to `main` on
  success.
- 2026-10-18: Phase 0 implementation (tasks 0.1–0.3) via worker sheep:
  `src/runtimes/runtime.ts` (pure 7-method contract), `src/core/ids.ts`
  (byte-identical mint/validation, wired into orchestration/lifecycle),
  rename-only moves into `src/runtimes/herdr/` + `src/core/config.ts`,
  `export *` shims at old paths, `src/runtimes/herdr/runtime.ts` adapter,
  derived `delegate`/`close` routed in `doAction`, new `verify-ids.mjs`.
  Full suite green (465 PASS, 31 sub-suites).
- 2026-10-18: review (reviewer-02): no critical findings; rename-only
  proof, shim export coverage, ID parity and routing equivalence all
  verified. Findings triaged: `read()` trailing-newline off-by-one and
  contract-doc clarity fixed (reviewer-03 delta): `watch` rejection
  semantics, `waitingOn` as opaque `MessageId`, terminal proc states. The
  unrouted `spawn`/`message`/`status`/`read` adapter methods and the
  single umbrella routing comment are recorded as an explicit Phase 0
  deferral in `spec.md` and `tasks.md` 0.3 (partial routing is correct
  under the zero-behavior-change rule). Residuals accepted as pre-existing
  or task-1.5 scope: `closeAgent` record cleanup may race pane teardown;
  the `src/extension/config.ts` shim bypasses `verify-settings.mjs`'s
  cache-busting query until 1.5.
- 2026-10-18: live Herdr smoke (`/tmp/phase0-live-smoke.mjs`, not
  committed): worker/`reviewer` sheep over the real Herdr server — idle
  spawn, focus preservation, non-blocking prompt (1.3 s), delegate +
  single wait, concurrent multi-wait across two sheep, status projection,
  close, ownership refusal (`Refusing to close an unowned pane.`), raw
  pane id rejected as handle. The smoke exposed one real adapter bug:
  `spawn` resolved to the internal handle record instead of the opaque id
  string; fixed, and the rerun is **13/13 green**. Project-agent gate is covered by the
  suite (`verify-discovery`/`verify-command-ux`) rather than live, to
  avoid mutating the user settings file. Stale pane registrations left by
  the pre-existing `closeAgent` cleanup race were removed with `shepherd
  prune`.
- 2026-10-18: **Phase 0 landed on `main`** (`42182eb`, fast-forward from
  `feat/006-dual-runtime-herdr-durable`); `npm test` green on `main`
  (465 PASS, 32 sub-suites). Phases 1–4 remain future work on this spec.
