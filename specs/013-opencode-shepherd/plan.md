# Plan — Shepherd for OpenCode

`specs/013-opencode-shepherd` · draft · 2026-11-17 · spec: `spec.md`

## Summary

Satisfy FR-001–FR-012 with Path A: keep the Herdr/hc pane runtimes, the
file broker, and the orchestration registries untouched, and add an OpenCode
server-plugin adapter beside the existing Pi adapter in one package. The Pi
import surface in today's `src/core` is decoupled behind injected
directories/parsers so both adapters share one engine; OpenCode children boot
as interactive sessions in panes (the `opencode run` subcommand is one-shot
and unsuitable for persistent sheep) and get their `shepherd_message` /
`shepherd_done` tools from the same installed plugin.

## Requirement coverage

- **FR-001** (OpenCode parity: spawn/delegate/message/watch/status/read/close)
  → new OpenCode server-plugin adapter exposing one tool per operation with
  the same lifecycle semantics as the Pi tools; all calls route through the
  shared runtime resolver.
- **FR-002** (sheep run in visible Herdr panes/terminals) → reuse of the two
  existing pane runtimes unchanged; only the child boot command is
  parameterized (boot `opencode` instead of `pi`).
- **FR-003** (explicit-completion settlement) → reuse of the broker's
  `task_done` envelope + `shepherd_done` as the single settlement signal;
  new OpenCode child tool publishes the same envelope shape.
- **FR-004** (results retrievable, delivered once) → reuse of the task
  registries, watcher services, and unseen-completion ledger unchanged.
- **FR-005** (shared definitions/config) → discovery and config move to
  directory-injected helpers shared by both adapters; project
  `.shepherd/config.json` stays the single project source.
- **FR-006** (cross-host fieldnotes) → artifact sessions are host-neutral
  files; the OpenCode adapter resolves/creates the same parent session
  layout the Pi adapter uses.
- **FR-007** (no Pi regression) → zero behavior change in the Pi adapter;
  the full existing `verify-*` suites stay green and run on every change.
- **FR-008** (no cross-host code paths) → layout rule: shared engine
  imports nothing host-specific; each adapter imports the engine, never the
  other adapter. New modules, no edits to Pi-owned behavior.
- **FR-009** (both suites green, per-host release notes) → a mirrored
  OpenCode verification harness plus a release checklist entry.
- **FR-010** (one package, clear docs) → single manifest carrying both a Pi
  extension entry and an OpenCode plugin entry; README splits into
  per-host tracks on the first screen.
- **FR-011** (clean failure when Herdr is unreachable) → the existing
  backend resolver and setup-hint errors are reused verbatim by the
  OpenCode adapter.
- **FR-012** (deadlines, bounded waits, nudges) → reuse of the timeout,
  stale-wait, and done-nudge machinery; OpenCode child turn-end maps onto
  the same nudge boundary the Pi child uses.

## Technical context

- **Language / runtime**: TypeScript run directly by both hosts, no build
  step (matches the current repo: no bundler, no compiled output).
- **Dependencies**: host SDKs stay peer/optional and adapter-local — the Pi
  SDK inside the Pi adapter only, `@opencode/plugin` inside the OpenCode
  adapter only. The shared engine depends on neither.
- **Storage**: today's file layout is kept — created-pane/terminal
  registries, parent-owned mailbox broker directories, artifact session
  files, per-host user config plus shared project `.shepherd/config.json`.
- **Platform**: any machine with Herdr (or `hc`) plus the host CLI
  installed; Node 22+.
- **Constraints**: opaque lifecycle ids stay opaque on both hosts (native
  pane/terminal/session ids never cross tool boundaries); backend choice
  stays app-side (the model never selects it).

## Architecture

One engine, two thin adapters:

```text
                    +------------------ shared engine ------------------+
                    | discovery · config · ids · broker/messaging        |
                    | orchestration registries · artifacts · runtimes   |
                    | (herdr panes · hc terminals · backend resolver)   |
                    +-----------+------------------+--------------------+
                                |                  |
                 Pi adapter (today)     OpenCode adapter (new)
                 tools · /shepherd      server tools · commands
                 settings UI · widget   (settings UI deferred, see Q2)
                 child extension        child plugin tools
```

- The engine gains no host concepts: today's Pi imports in discovery/config
  (agent directory, frontmatter parser, config-dir name) become injected
  parameters with each adapter supplying its host's values.
- The launch-file builder is parameterized by child binary, child entry,
  env prefix, and — because the opencode CLI has no equivalent of pi's
  session/extension flags — a full-command override (`command: 'opencode'`),
  which skips Pi arg construction and runs verbatim. Pi callers omit all
  four and get byte-identical scripts. `opencode run`
  is deliberately *not* used for sheep: it executes one message and exits,
  while sheep must stay alive across turns.
- Children obtain Shepherd tools from the normally installed plugin (global
  install recommended, mirroring `pi install`, so any child cwd inherits
  it); no per-spawn plugin injection.
- The capability handoff (broker directory, session/broker/agent ids,
  token, inbox path) keeps its file+environment-variable shape so the
  shared builder stays single-sourced; each host's surface reads it under
  its own variable prefix (today's prefix keeps working for Pi).

## Data model

- Unchanged: opaque agent/task/message/watcher ids with per-process
  namespaces; broker envelopes (`task`, `message`, `reply`, `runtime`,
  `task_done`) with the same required fields; artifact reservations with
  terminal statuses (completed/blocked/failed/cancelled/timed-out).
- Config: per-host user files (Pi's agent dir; OpenCode's config dir) plus
  the one shared project file. `backend` and the project-agent trust gate
  stay user-owned on both hosts: a repository config can never force them.
- Ownership: created panes/terminals remain tagged by parent session, so
  the herd views on both hosts show only their own sheep while sharing the
  underlying registry files.

## Interfaces

| interface | behavior |
|---|---|
| OpenCode `shepherd_spawn` (+ `delegate`, `message`, `watch`, `status`, `read`, `close`, umbrella) | Same lifecycle semantics as the Pi tools; same opaque-id discipline; same setup-hint failures. |
| OpenCode command (e.g. `/shepherd`) | Same human surface as Pi's: list agents/herd, spawn, status, read; settings entry point when decided (see Q2). |
| Child `shepherd_message` / `shepherd_done` (OpenCode) | Same validation as the Pi child: task inference, reply→task match, broker-unavailable error when no capability was handed down. |
| Env capability contract | Same fields as today (root dir, session/broker/agent ids, token, inbox); per-host variable prefix. |
| Package manifest | One manifest named `@luminascale/shepherd` with two entries: Pi extension entry + OpenCode plugin entry (server part; TUI/GUI parts only if needed). |

## Invariants

- No adapter imports the other adapter; the engine imports neither.
- Native ids (pane, terminal, OpenCode session) never appear in tool
  inputs, outputs, or results — diagnostics only.
- One outstanding tracked reply per task; completion only via the
  explicit done signal, cancellation/close, or deadline.
- Watcher delivery exactly-once per settlement; late watchers still get
  already-settled results synchronously.
- A pinned backend that is unreachable fails with its setup hint; never a
  silent cross-spawn to the other runtime.
- Functional identifiers stay frozen across the rename: `shepherd_*` tool
  names, the env-capability prefix and fields, and the user config/registry
  paths. Only the npm package name changes.
- Release ordering around the rename: the farewell release (one-time
  migration notice behind a marker file, human sessions only, plus README
  banner and `npm deprecate` pointer) ships on the old name *before* the
  rename lands — never after.

## Failure behavior

- Herdr/hc unreachable ⇒ setup-hint error naming the missing runtime; no
  fallback spawn (FR-011).
- Child never becomes ready ⇒ spawn fails with the child's output tail and
  temporary resources are removed; no orphan registration.
- Broker capability missing in a child ⇒ child tools return a structured
  unavailable error; the parent task still settles by deadline (FR-012).
- Turn ends with an open tracked task ⇒ one bounded reminder turn, then a
  visible stall escalation; the task itself stays open until done,
  cancelled, or timed out.
- Rejected/duplicate completions ⇒ written to the broker's rejected store
  and surfaced, never silently applied or lost.

## Recovery

- Stale pane/terminal registrations are pruned; only owned panes/terminals
  may be closed.
- Orphaned launch directories are removed once their pane/terminal is
  confirmed gone.
- Background inbox drains are idempotent: re-polling never double-settles,
  and one bad envelope never stops the drain.

## Open questions

1. Package name — decided: `@luminascale/shepherd` (bare `shepherd` is
   taken on npm; the scoped name is free). Functional identifiers stay
   frozen per the invariant above.
2. OpenCode settings surface on day one vs file-based config first?
   Proposed default stands (files first) unless the spec review overturns it.
3. OpenCode plugin `id` and whether the child tool names need namespacing
   to avoid collisions in sessions that install other plugins.
