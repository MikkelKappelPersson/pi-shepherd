# pi-shepherd — maintenance instructions

A no-fuss pi extension for explicit agent (sheep) lifecycle orchestration and herding
pi agents inside Herdr. See `README.md` and `docs/dictionary` for terminology
and user-facing usage. Layout: `index.ts` is the pi entry point, `src/core/` is
the engine, and `src/extension/` is the pi surface (tools, commands, settings
UI). Core semantics live in `doAction()`/`src/core/lifecycle.ts`; the
model-facing tools and `/shepherd` command are thin adapters. This file contains
repository constraints only.

## Project conventions

Bundled agents are `scout`, `planner`, `worker`, and `reviewer`; run only agents
you trust. `shepherd.md` is the shared fieldnotes index, and each submitted
agent invocation receives its own note.

## Runtime and architecture

- TypeScript runs directly by pi. There is no build step or bundler.
- Herdr integration shells out to the `herdr` CLI.
- `src/core/discovery.ts` is pure and reads agent files fresh on each invocation.
- `src/core/orchestration.ts` contains internal opaque serializable handles and
  session-scoped registries; model-facing lifecycle tools expose only ids.
- `src/core/lifecycle.ts` implements `spawn`, `prompt`, `wait`, `status`, and
  `close`.
- `src/extension/shepherd.ts` exposes the umbrella control tool and separate
  lifecycle tools.
- Every `pi.registerTool({ ... })` declaration must spell out `name`, `label`,
  `description`, `promptSnippet`, and `parameters` directly in that registration.
  Do not hide or generate those tool-definition fields through nested factories,
  object spreads, or shared registration helpers.
- `src/core/herdr.ts` owns Herdr launch, pane, and created-pane registry
  operations.
- `src/extension/shepherd-done.ts` is the in-tab completion extension.

## Invariants

- Discovery precedence remains user, shared-user, project, shared-project,
  bundled pi agents, bundled shared agents.
- User agent discovery is the default. Project agent definitions are
  repo-controlled and require explicit scope and interactive confirmation.
- Model-facing lifecycle tools accept opaque agent/prompt ids; internal handles
  must never be confused with raw Herdr pane IDs.
- Only panes recorded in `~/.pi/agent/pi-shepherd/created-panes.json` may be
  closed by pi-shepherd. Raw pane IDs must not bypass ownership checks.
- Background Herdr placement uses `--no-focus`.
- Temporary launch/session resources are removed only after the child pane is
  confirmed gone.

## Reference implementation

[pi-interactive-subagents](https://github.com/amosblomqvist/pi-interactive-subagents) — a tmux-based pi extension for async subagents; useful inspiration for pi-shepherd. Local clone: `/mnt/Projects/Projects/references/pi-interactive-subagents`.

## Verification

Run `npm test`. Live Herdr verification should cover idle spawn, non-blocking
prompt, single wait/result recovery, concurrent multi-wait, iterative prompting,
status, close cancellation, focus preservation, and ownership protection.
