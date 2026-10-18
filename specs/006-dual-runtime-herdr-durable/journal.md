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
  close, ownership refusal, project-agent gate) — merge
  `feat/006-dual-runtime-herdr-durable` back into `main`. Unfinished
  Phase 1+ work must not be carried to `main`.
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
