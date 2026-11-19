# Tasks — No-parent sheep in the Herdr app

`specs/014-no-parent-hc-sheep` · complete · spec: `spec.md` · plan: `plan.md`

## Phase 1 — Baseline and guardrails (US1, US4)

**Goal**: Lock in today's behaviour before adding the new mode.
**Checkpoint**: Existing hc and herdr verification suites pass unchanged; a
default hc spawn is still nested under its parent.

- [x] T001 [US1] Add a regression test asserting a default `shepherd_spawn` on
      hc passes the current launch flags and produces a nested subagent.
- [x] T002 [US4] Add a regression test asserting the herdr backend spawn path
      and tool schemas are unchanged, including no backend parameter.
- [x] T003 [US1] Record a `herdr-app ls` snapshot of a default spawn as the
      visual baseline for later comparison.

## Phase 2 — No-parent hc launch (US2)

**Goal**: A no-parent request produces a parentless hc terminal in its own
Herdr tab while remaining a fully managed sheep.
**Checkpoint**: In an hc/herdr-app session, a no-parent spawn appears as its
own tab, is absent from `sub_agents`, and can complete a delegated task.

- [x] T004 [US2] Add the `no_parent` spawn option to the tool schema, parser,
      and CLI option table with default `false`.
- [x] T005 [US2] Implement caller-space resolution from the calling terminal's
      `herdr.space` label, failing with the FR-008 hint when absent.
- [x] T006 [US2] Extend the hc launch helper to add `--no-parent`, the
      `herdr.space` label and `shepherd.no-parent=true` only for no-parent
      spawns.
- [x] T007 [US2] Keep the subagent launch path byte-for-byte unchanged; verify
      T001 still passes.
- [x] T008 [US2] Add tests for both modes' launch arguments, labels, and
      resulting `parent` / `sub_agents` state.
- [x] T009 [US4] Make the herdr backend accept and ignore the mode, reporting
      its existing pane placement; test that no herdr flags change.

## Phase 3 — Manual spawn is no-parent (US3)

**Goal**: `/shepherd spawn <agent>` in the Herdr app always yields a separate
agent, with no extra typing.
**Checkpoint**: Running the command by hand in the app shows a new sibling tab
and a ready-to-chat agent.

- [x] T010 [US3] Set `no_parent: true` on the slash command's hc spawn path.
- [x] T011 [US3] Verify manual spawn keeps agent definition, context, model
      inheritance and fieldnotes identical to today.
- [x] T012 [US3] Add a test asserting manual spawn ignores any default that
      would produce a subagent.

  Follow-up (2026-11-19): T010 was implemented only on Pi's `/shepherd spawn`
  command. The OpenCode host's command forwarded the tool's `no_parent: false`
  default, so a manual spawn there still produced a subagent (parented to the
  OpenCode host terminal rather than the calling session). The command now
  routes through `manualSpawnArgs` like Pi, and the OpenCode surface suite
  guards the path.

## Phase 4 — Lifecycle, recovery and documentation (US2, US4)

**Goal**: No-parent sheep are no worse to manage and clean up than subagents.
**Checkpoint**: Restart/reap and close tests pass; docs describe both modes.

- [x] T013 [US2] Store the no-parent marker in the created-terminal registry
      at launch time and assert restart-time reaping finds it without a parent
      link.
- [x] T014 [US2] Verify delegate, message, watch, completion notice and close
      on a no-parent sheep, using the same opaque-id calls as a subagent.
- [x] T015 [US2] Add failure-path tests for missing space label and rejected
      `--no-parent`, asserting no fallback spawn occurs.
- [x] T016 [US4] Run the full hc and herdr verification suites; confirm no TUI
      expectations changed.
- [x] T017 [US2] Document both modes, the manual-spawn rule, and the hc-only
      constraint in the README and command reference.

## Later

- [ ] Optional `--subagent` escape hatch on `/shepherd spawn` — deferred: not
      requested, and the product owner's intent says manual spawn is always
      no-parent.
- [ ] Let a no-parent sheep opt back into a parent relationship later —
      deferred: new behaviour with no current use case.

## Notes

- Change code and spec together; update `plan.md` if the interface differs.
- Tick a task only when its verification passes.
- `research.md` holds the evidence for the hc-only decision; fold it into
  `plan.md` if the decision is later reopened.
