# Spec — Shepherd for OpenCode

`specs/013-opencode-shepherd` · agreed · 2026-11-17 · From: `intent.md` (Mikkel)

## Summary

Shepherd becomes usable from OpenCode as well as Pi: the same herding of
visible Herdr sheep, tracked task delegation, agent messaging, and shared
fieldnotes — shipped as one package with a Pi entry and an OpenCode entry,
with Herdr remaining the execution substrate.

## User Scenarios & Testing

### User Story 1 — Spawn a sheep from OpenCode (Priority: P1)

An OpenCode user asks for a specialist (e.g. a planner). A sheep starts in a
visible Herdr pane, owned by that OpenCode session, and the user can see and
inspect it the same way a Pi user can today.

**Why this priority**: without spawning there is no product; this is the
entry point everything else builds on.

**Independent test**: from OpenCode, request a named agent; confirm a live,
visible sheep exists and is owned by the session, then close it.

**Acceptance scenarios**:

1. **Given** Herdr is reachable and an agent named `planner` exists, **when**
   the user asks OpenCode for a planner, **then** a visible sheep running
   that agent appears and reports back as ready.
2. **Given** Herdr is not reachable, **when** the user asks for a sheep,
   **then** they get a clear setup hint instead of a hang or a cryptic
   error.
3. **Given** an unknown agent name, **when** the user asks for it, **then**
   they are told the name is unknown and how to list exact names.

### User Story 2 — Delegate tracked work and get the result (Priority: P1)

An OpenCode user delegates a task to a sheep and continues working; when the
sheep finishes, the result is delivered and nothing is lost even if nobody
was watching at the moment of completion.

**Why this priority**: this is Shepherd's core loop; spawning without
delegation has no value.

**Independent test**: delegate a small task, do other work, receive the
completion and verify its content matches what the sheep did.

**Acceptance scenarios**:

1. **Given** a spawned sheep, **when** the user delegates a task, **then**
   delegation returns immediately with a task reference and the sheep starts
   working.
2. **Given** a delegated task finishes while no watcher is attached, **when**
   the user next checks, **then** the result is still retrievable exactly
   once — never lost, never delivered twice.
3. **Given** a sheep that never finishes, **when** its deadline passes,
   **then** the task settles as timed-out/blocked with an explanation
   instead of hanging forever.

### User Story 3 — Agents talk to each other (Priority: P2)

A sheep working a task can ask the user-side session or a peer sheep a
question and wait for the answer; replies resume the waiting work.

**Why this priority**: real tasks need clarification; without messaging,
delegated work stalls or guesses.

**Independent test**: have a sheep ask a question mid-task, answer it, and
confirm the sheep resumes and completes.

**Acceptance scenarios**:

1. **Given** a sheep needs input, **when** it asks a question expecting a
   reply, **then** its task is visibly marked as waiting and the question
   reaches the right recipient.
2. **Given** a waiting task, **when** the reply arrives, **then** the task
   resumes and the reply is correlated to the original question.

### User Story 4 — Sheep share fieldnotes (Priority: P2)

Delegated work in OpenCode leaves durable notes in the same shared place Pi
sheep use, so a later agent (from either host) can pick up the context.

**Why this priority**: continuity across agents and across hosts is the
multiplier; without it every delegation starts from zero.

**Independent test**: delegate two sequential tasks and confirm the second
sheep can see what the first one left behind.

**Acceptance scenarios**:

1. **Given** a completed delegation with notes enabled, **when** a new
   sheep is delegated follow-up work, **then** it can read the earlier
   sheep's notes.
2. **Given** notes from a Pi delegation, **when** an OpenCode sheep does
   follow-up work, **then** the Pi notes are visible to it (and vice
   versa).

### User Story 5 — Pi users notice nothing (Priority: P1)

A Pi user who never touches OpenCode experiences zero regression: same
commands, same tools, same behavior, same install.

**Why this priority**: the installed base must not pay for a host they
don't use; this constraint gates the whole effort.

**Independent test**: run the existing Pi verification suites unchanged and
green, and walk the core Pi flows manually.

**Acceptance scenarios**:

1. **Given** the combined package installed in Pi, **when** the user herds
   sheep as before, **then** every flow behaves exactly as it did before
   the OpenCode work.
2. **Given** a Pi-only change, **when** it ships, **then** it requires no
   OpenCode-side change (and vice versa).
3. **Given** an existing `@luminascale/pi-shepherd` install, **when** the
   farewell release runs, **then** the user sees a one-time migration
   notice pointing at the new name; **and when** they remove-then-install
   the new package, **then** settings and herd registrations are intact.

### User Story 6 — One package, two homes (Priority: P2)

A new user finds one Shepherd package, installs it in their host (Pi or
OpenCode), and gets host-appropriate guidance without confusion about which
host the docs describe.

**Why this priority**: the packaging decision only pays off if discovery
and install are genuinely unified.

**Independent test**: fresh install in each host following only the docs;
confirm working sheep in both.

**Acceptance scenarios**:

1. **Given** a Pi user, **when** they install the package, **then** no
   OpenCode-specific setup is required of them (and vice versa).
2. **Given** the documentation, **when** a user of either host reads it,
   **then** they can tell within seconds which instructions apply to them.

### Edge cases

- Herdr reachable but the child agent never becomes ready: the user gets
  the failure plus whatever the child produced, not a silent timeout.
- Two sheep given the same display label: the second spawn is rejected
  clearly instead of creating an ambiguous herd.
- A sheep's turn ends without reporting its task done: it gets a bounded
  reminder, then the stall is escalated visibly instead of looping forever.
- A project-local agent definition the user hasn't approved: OpenCode asks
  first, same trust gate as Pi.
- Human `/shepherd …` command results are display-only: listing agents (or
  herd/status/read) via the command shows the result and returns control to
  the user, without starting an assistant turn. Command output is delivered
  as a normal session message with `resume: false` (full TUI rendering, but no
  model wake); parent-session notices omit `resume: false` because those are
  meant to wake the model.

## Requirements

- **FR-001**: OpenCode users MUST be able to spawn, delegate to, message,
  check on, read output from, watch, and close sheep with the same semantics
  Pi users have.
- **FR-002**: Sheep delegated from OpenCode MUST run in visible Herdr
  panes/terminals (Path A); no hidden or host-native-only execution in this
  effort.
- **FR-003**: A tracked task MUST settle only through an explicit completion
  signal from the working sheep, a cancellation/close, or its deadline —
  never through a turn ending, idleness, or silence.
- **FR-004**: Settled task results MUST remain retrievable after settlement
  and MUST be delivered exactly once to watchers. Automatic completion notices
  MUST go only to human parent sessions, never to a sheep pane, and MUST be
  retried when the parent session is temporarily busy.
- **FR-015**: A delegated sheep session MUST remain recognised as a sheep even
  if it called a parent-only tool before its session was lazily bound. Such an
  early call MUST NOT permanently classify it as a parent, which would block
  the sheep form of `shepherd_message` for peer replies.
- **FR-005**: Agent definitions and project configuration MUST be shared
  between hosts, not forked; a definition written for Pi MUST work from
  OpenCode unchanged.
- **FR-006**: Fieldnotes written from one host MUST be readable from the
  other.
- **FR-007**: The Pi experience MUST NOT regress: existing Pi verification
  suites stay green and Pi-only flows behave identically.
- **FR-008**: A change to one host's adapter MUST NOT require a change to
  the other; the two adapters MUST share no code paths that can couple
  their releases.
- **FR-009**: Every change MUST be verified against both hosts' suites
  before shipping, and releases MUST call out per-host impact.
- **FR-010**: One installable package MUST serve both hosts, with
  documentation that lets each host's users identify their instructions
  immediately.
- **FR-011**: When the Herdr runtime is unreachable, the system MUST fail
  with a setup hint and MUST NOT silently fall back to a different
  execution substrate.
- **FR-012**: Stuck tracked work MUST settle by deadline with an explanation,
  and messages awaiting replies MUST have a bounded wait after which the
  waiter is reminded or the task settles as blocked.
- **FR-013**: The package MUST ship as `@luminascale/shepherd` with both
  host entries, while tool names, env vars, and config/registry paths MUST
  stay unchanged so existing installs migrate without loss.
- **FR-014**: The final `@luminascale/pi-shepherd` release MUST show
  existing users a one-time migration notice (human sessions only, never
  repeated, never in child sheep panes) and MUST ship before the rename.

## Key entities

- **Sheep**: a persistent specialist agent running in a visible Herdr
  pane/terminal, owned by exactly one parent session; has a definition name
  and an optional label.
- **Tracked task**: one unit of delegated work on a sheep; has a lifecycle
  (running → waiting → settled) and exactly one terminal outcome.
- **Message / reply**: asynchronous communication between sheep, or between
  sheep and the parent session; a reply is correlated to the question it
  answers.
- **Fieldnote session**: durable shared notes for one parent session's
  delegations, readable by later sheep from either host.
- **Package**: the single installable unit exposing a Pi entry and an
  OpenCode entry.

## Success criteria

- **SC-001**: An OpenCode user completes spawn → delegate → watch → close
  end-to-end with a visible sheep, following only the docs.
- **SC-002**: All pre-existing Pi verification suites pass unchanged, and a
  mirrored OpenCode verification suite covering FR-001–FR-004 passes.
- **SC-003**: Fresh installs in Pi and in OpenCode (each following only
  their host's instructions) both yield working sheep, with no steps from
  the other host required.
- **SC-004**: A Pi-only change ships with zero OpenCode-side edits, and the
  release notes state per-host impact.
- **SC-005**: An existing `@luminascale/pi-shepherd` user sees the
  migration notice exactly once and completes remove-then-install with
  settings and herd intact.

## Assumptions

- Herdr (or `hc`) is installed and reachable wherever sheep are herded;
  Shepherd does not install or manage Herdr itself.
- The OpenCode plugin interface used is the current (v2) one; tracking its
  future breaking changes is maintenance, not part of this effort.
- One maintainer ships both sides, so release gating across both suites is
  acceptable overhead.
- Agent frontmatter conventions (Markdown + YAML) stay host-agnostic.

## Open questions from intent

- What is the package called, and does `pi-shepherd` get renamed? —
  answered: `@luminascale/shepherd`; only the package name changes,
  functional identifiers stay frozen (see FR-013).
- Does the OpenCode side need its own settings surface from day one, or is
  file-based config enough for the first slice? — carried forward (owner:
  Mikkel; proposed default: file-based config first, settings UI later).
