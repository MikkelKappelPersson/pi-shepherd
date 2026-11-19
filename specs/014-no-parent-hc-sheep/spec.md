# Spec — No-parent sheep in the Herdr app

`specs/014-no-parent-hc-sheep` · agreed · 2026-11-19 · From: `intent.md` (Mikkel)

## Summary

Sheep spawning in the Herdr app gains an explicit choice between the current
subagent and a no-parent agent that has its own tab and is not nested under
its parent. Subagent remains the default; manual spawning always produces a
no-parent agent. Both kinds stay fully managed by Shepherd.

## User Scenarios & Testing

### User Story 1 — Delegation still makes subagents (Priority: P1)

As a Shepherd user, when I delegate work normally, I want the new agent to
appear under the current one exactly as it does today, so my existing workflow
and mental model do not change.

**Why this priority**: Guards against the default silently changing.

**Independent test**: Delegate a task in an hc/herdr-app session and inspect
Herdr's agents list; the sheep is nested under its parent and no new option
was needed.

**Acceptance scenarios**:

1. **Given** an hc/herdr-app Shepherd session, **when** a subagent is spawned
   without asking for no-parent, **then** it is listed under its parent in
   Herdr's agents list and has no tab of its own.
2. **Given** an existing project or prompt that never mentions no-parent,
   **when** it delegates work, **then** the result is indistinguishable from
   today's behaviour.

### User Story 2 — Request a no-parent agent (Priority: P1)

As a Shepherd user, when I need a separate agent at the same level, I want to
ask for it when spawning, so it gets its own tab and is not listed under any
parent.

**Why this priority**: This is the new capability the whole effort is for.

**Independent test**: Spawn with the no-parent request in an hc/herdr-app
session; confirm in Herdr that the agent has its own tab and is absent from the
parent's subagents, then delegate and complete a task through the usual opaque
id.

**Acceptance scenarios**:

1. **Given** an hc/herdr-app session with a visible Herdr space, **when** a
   no-parent agent is spawned, **then** it appears in a tab at the same level
   and does not appear as a child of the parent.
2. **Given** a no-parent agent, **when** I delegate, message, watch, or close
   it using its opaque id, **then** all of those work as for any other sheep.
3. **Given** a no-parent agent, **when** its task finishes, **then** the
   result and fieldnotes are shared with the parent session in the usual way.

### User Story 3 — Manual spawn is always no-parent (Priority: P1)

As a human using the manual spawn command, I want `/shepherd spawn <agent>` to
give me a separate, ready-to-talk agent with the right context, without having
to know about a special option.

**Why this priority**: This is the most common reason to spawn by hand.

**Independent test**: Run `/shepherd spawn worker` in an hc/herdr-app session;
the resulting agent has its own tab and is not under the parent.

**Acceptance scenarios**:

1. **Given** a manual `/shepherd spawn <agent>` in the Herdr app, **when** the
   agent starts, **then** it is no-parent regardless of any default.
2. **Given** a manual spawn, **when** I then talk to it in its tab, **then** it
   has the agent definition, context and fieldnotes it would normally have.

### User Story 4 — Other hosts and backends are unaffected (Priority: P2)

As a Herdr TUI user, I want no change at all, and as a model controlling
Shepherd I want to keep being unable to choose a backend.

**Why this priority**: Prevents regressions outside the app.

**Independent test**: Run the existing TUI verification suite and confirm a
TUI spawn still creates one visible pane per agent; confirm no backend choice
is exposed on any tool.

**Acceptance scenarios**:

1. **Given** a Herdr TUI session, **when** an agent is spawned, **then** its
   placement, lifecycle and available options are unchanged.
2. **Given** any session, **when** tools are inspected, **then** no parameter
   can select the execution backend.

### Edge cases

- No usable Herdr space can be determined for a no-parent spawn — the user
  gets a clear reason and no wrongly-placed agent is created.
- The app / core does not support the required terminal behaviour — the
  request fails cleanly with a setup hint, never a silent subagent fallback.
- A no-parent agent outlives the Shepherd session that created it, or the
  Shepherd restarts while it is running — it remains discoverable, closable,
  and reaping still works without a parent link to rely on.
- A no-parent request is made where the mode does not exist (the TUI) — the
  outcome is still one visible agent per pane, with no error.
- Repeated no-parent spawns with the same agent definition and labels remain
  distinguishable.

## Requirements

- **FR-001**: Shepherd MUST keep subagent placement as the default for every
  spawn that does not explicitly request no-parent.
- **FR-002**: Users and callers MUST be able to request no-parent placement
  at spawn time in the Herdr app.
- **FR-003**: A no-parent agent MUST appear in its own Herdr tab, at the same
  level as the parent, and MUST NOT appear in the parent's subagents list.
- **FR-004**: No-parent and subagent sheep MUST share the same opaque id
  lifecycle, messaging, task tracking, completion notices, and fieldnotes.
- **FR-005**: `/shepherd spawn <agent>` in the Herdr app MUST always produce a
  no-parent agent, without requiring any extra flag.
- **FR-006**: The no-parent mode MUST apply only to the Herdr app / hc
  backend. The Herdr TUI MUST keep its current behaviour and MUST NOT gain a
  redundant option.
- **FR-007**: No tool surface MUST expose a backend-selection parameter.
- **FR-008**: If the information needed to place a no-parent agent is
  unavailable, the spawn MUST fail with a clear, actionable message rather
  than produce a different kind of agent.
- **FR-009**: Orphan detection and reaping MUST continue to find no-parent
  agents after a Shepherd restart, without depending on a parent relationship.
- **FR-010**: Existing settings, agent definitions, registrations and
  fieldnotes MUST keep working unchanged; no migration or new dependency is
  introduced.

## Key entities

- **Spawn mode**: the placement choice for a new sheep — `subagent`
  (default) or `no_parent`.
- **Sheep**: a managed agent with an opaque id; its logical Shepherd
  relationships are independent of where Herdr displays it.
- **Herdr tab**: the visible container a no-parent sheep occupies; siblings
  of the parent's tab rather than children of its terminal.
- **Parent relationship**: the visible nesting that marks a subagent; absent
  for a no-parent sheep, while Shepherd's own tracking remains.

## Success criteria

- **SC-001**: In an hc/herdr-app session, 100% of default spawns remain nested
  under the parent; 100% of no-parent requests appear as their own tab and
  are absent from the subagents list.
- **SC-002**: `/shepherd spawn worker` always yields a no-parent agent when
  run in the Herdr app, with no extra arguments.
- **SC-003**: A no-parent sheep can be delegated to, messaged, watched and
  closed with the same success rate as a subagent.
- **SC-004**: Herdr TUI behaviour and all existing verification suites pass
  with no changes to expectations.
- **SC-005**: No user data, settings, or agent definitions require migration.

## Assumptions

- "Herdr app" means an hc terminal attached to the Herdr desktop window; the
  older Herdr TUI is a separate backend that already shows one pane per agent.
- A no-parent agent is still a Shepherd sheep, not an unmanaged terminal the
  user launches by hand.
- The product owner's manual spawn intent ("give me a separate agent with the
  right context") is stable enough to make no-parent mandatory there rather
  than a setting.

## Open questions from intent

- Is the TUI free of a parent/subagent distinction? — Answered: yes; see
  `research.md`. The mode is hc-only.
- Name of the spawn request — carried forward to `plan.md` (product owner to
  confirm the user-facing wording).
- Missing placement context — answered by FR-008: fail cleanly, no fallback.
- Reaping without a parent link — answered by FR-009 and `research.md`:
  ownership-registry based, not parent based.
- Whether manual spawn should be able to force a subagent — carried forward;
  not in this spec's scope unless the product owner asks.
