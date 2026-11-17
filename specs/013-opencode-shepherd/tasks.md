# Tasks — Shepherd for OpenCode

`specs/013-opencode-shepherd` · draft · spec: `spec.md` · plan: `plan.md`

## Phase 1 — Engine decoupling (US5)

**Goal**: shared engine imports nothing host-specific; Pi behaves exactly
as before.
**Checkpoint**: full existing `verify-*` suites green, zero Pi behavior change.

- [x] T001 [US5] Inject agent/config directories and frontmatter parsing into `src/core/discovery.ts` and `src/core/config.ts` (no `@earendil-works` imports left in shared engine).
- [x] T002 [US5] Parameterize the launch-file builder (`src/runtimes/herdr/herdr.ts`) by child binary, child entry, and env-capability prefix; Pi passes today's values.
- [x] T003 [US5] Run all `verify-*` suites plus manual Pi spawn → delegate → watch → close; confirm green and unchanged.

## Phase 2 — OpenCode spawn and inspect (US1)

**Goal**: an OpenCode user can herd visible sheep.
**Checkpoint**: spawn → status → read → close works from OpenCode; unknown names and unreachable Herdr fail cleanly.

- [x] T004 [US1] OpenCode server-plugin skeleton with tool surface for `spawn`, `herd`/`agents`, `status`, `read`, `close` routed through the shared runtime resolver.
- [x] T005 [US1] Child boot via interactive `opencode` in pane/terminal using the parameterized builder (T002); readiness/tail reuse as-is.
- [x] T006 [P] [US1] Human command surface mirroring Pi's (`agents`, `herd`, `spawn`, `status`, `read`).
- [x] T007 [US1] Acceptance: unknown agent name, unreachable Herdr, and duplicate-label spawn all produce their specified errors.

## Phase 3 — Tracked work and messaging (US2, US3)

**Goal**: the full delegate → watch → done loop plus mid-task questions work from OpenCode.
**Checkpoint**: delegate while doing other work, receive completion; question → reply → resume completes.

- [ ] T008 [US2] `delegate` + `watch` tools with watcher/notifier bridges and exactly-once delivery (settled results retrievable, late watchers served synchronously).
- [ ] T009 [US2] OpenCode child `shepherd_done` tool publishing the shared `task_done` envelope (task inference, mismatch rejection, broker-unavailable error).
- [ ] T010 [US3] Parent/peer `shepherd_message` on both sides with `expectsReply` waiting semantics, reply correlation, and the bounded done-nudge + stall escalation.
- [ ] T011 [US2] Acceptance: unwatched completion never lost; missed deadline settles with explanation; load/duplicate completions handled per failure rules.

## Phase 4 — Shared fieldnotes (US4)

**Goal**: notes flow across delegations and across hosts.
**Checkpoint**: Pi sheep reads OpenCode sheep's notes and vice versa.

- [ ] T012 [US4] Parent artifact-session resolution in the OpenCode adapter onto the same shared layout Pi uses.
- [ ] T013 [US4] Acceptance: sequential delegations across hosts share notes; disabled-notes mode stays off everywhere.

## Phase 5 — One package, verified twice (US5, US6)

**Goal**: single installable package, per-host docs, both suites gating every change.
**Checkpoint**: fresh installs in each host (following only that host's docs) both herd working sheep; both suites green.

- [ ] T014 [P] [US6] Manifest carries both entries (Pi extension + OpenCode plugin); install verified fresh in each host with no steps from the other host.
- [ ] T015 [P] [US6] README splits into per-host tracks on the first screen.
- [ ] T016 [US5] Mirrored OpenCode verification harness covering FR-001–FR-004; both harnesses run on every change.
- [ ] T017 [US5] Release checklist: per-host impact notes; Pi-only change ships with zero OpenCode-side edits (and vice versa).
- [ ] T018 [US5] Farewell release on the old name: one-time migration notice (marker file; human sessions only; never in child sheep panes), README banner, publish `@luminascale/pi-shepherd` last, then `npm deprecate` with pointer to the new name. Ships before T019.
- [ ] T019 [US6] Rename package to `@luminascale/shepherd` (manifest + URLs; FR-013); verify old-install → remove → new-install keeps settings and herd (SC-005).

## Later

- [ ] Native OpenCode session runtime (no Herdr dependency) — separate effort; Path A deliberately first.
- [ ] OpenCode settings UI — only if the file-config default (plan Q2) proves insufficient.

## Notes

- `[P]` = parallel: different files, no dependency.
- `[US1]` = user story from `spec.md`; every task has one.
- Keep task ids stable; add new ones, do not renumber.
- Change code and spec together; update the plan if behavior changes.
- Tick a task only when its verification passes.
