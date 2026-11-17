# Intent — Shepherd for OpenCode

`specs/013-opencode-shepherd` · Author: Mikkel (product owner) · 2026-11-17 · approved

## Problem

Shepherd (herding subagents in visible Herdr panes, with tracked tasks and
shared fieldnotes) only exists for Pi. I also work in OpenCode, and there I
have no equivalent: no persistent visible sheep, no delegate/watch flow, no
shared session notes across agents. Every OpenCode session starts from zero.

## Proposed outcome

Shepherd becomes available inside OpenCode too, working the same way it does
in Pi: I can ask for a planner/scout/worker, it spawns in a visible Herdr
pane, I can delegate tracked work to it, message it, watch for completion,
and the agents share fieldnotes. Herdr stays the execution substrate — how
sheep run today does not change. The same repo hosts both, and each host
(Pi, OpenCode) stays flexible and independent: using one must never require
or break the other.

## Affected users and systems

- Me and any other Shepherd users who work in both Pi and OpenCode.
- `pi-shepherd` extension as it exists today (must keep working untouched).
- Herdr / `hc` runtimes (reused, not replaced).
- The repo layout and npm packaging (must accommodate a second host).

## Constraints

- Herdr remains the main course: sheep still run in Herdr panes/terminals.
  Path A only — no native OpenCode session runtime in this effort.
- Pi behavior must not regress; Pi users who never touch OpenCode should
  notice nothing (apart from repo reorganization).
- One repo, one package — but host independence must hold in code layout:
  the Pi and OpenCode adapters stay separate with no cross-imports, so a
  change on one side never requires a change on the other. Both hosts'
  verification suites run on every change, and releases call out per-host
  impact.
- Agent definitions (Markdown) and project config (`.shepherd/config.json`)
  should be shared, not forked per host.

## Decisions

- **Package name: `@luminascale/shepherd` (decided 2026-11-17).** Bare
  `shepherd` is taken on npm; the scoped name is free. Only the package
  name changes — tool names, env vars, and config/registry paths stay
  frozen so existing users keep their settings and herd. A final
  `@luminascale/pi-shepherd` release carries a one-time migration notice
  and ships *before* the rename.

## Open questions

- Does the OpenCode side need its own settings surface from day one, or is
  file-based config enough for the first slice?

## Approval

- [x] Product owner reviewed and approved — Mikkel, 2026-11-17
