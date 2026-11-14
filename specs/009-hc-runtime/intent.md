# Intent — hc-app Runtime (Herdr TUI + hc core)

## Why this exists

pi-shepherd is Herdr-TUI-native today (`herdr` CLI, panes/tabs/workspaces).
The Herdr app (`hc` / herdr-core terminals) is now available in the same
sessions. Users run Shepherd from either place and expect sheep to run
where they are, not cross-spawned into the other UI.

This spec adds a second runtime (`hc`) beside `herdr` behind one Shepherd
surface, with per-command auto-detect and `auto` as default.

This spec is independent from `006-dual-runtime-herdr-durable` (paused).
Same 2-runtimes-1-core pattern, different second runtime.

## Who it serves

1. **TUI user** — runs in `herdr` terminal, sheep appear as panes/tabs.
   Must notice zero change by default.
2. **App user** — runs in `hc` terminal (`HC_TERMINAL_ID`, `hc ls`), sheep
   appear as `hc` terminals. Must get same `spawn -> delegate -> watch ->
   done` flow.
3. **Maintainer** — one tool surface, one agent format, two executors.
   No `herdr_*` vs `hc_*` tool fork.

## What success looks like

- Same orchestrator prompt runs unchanged in TUI and in app.
- Default setting `backend: auto` means: every command runs where it was
  called from, unless the settings UI explicitly pins `herdr` or `hc`.
- Explicit pin is respected but fails cleanly with a hint when that
  runtime is unreachable (no silent cross-spawn).
- The model never chooses a runtime. No `backend` param on any
  `shepherd_*` tool. Backend lives only in settings (app side).
- `shepherd.md` + per-agent fieldnotes stay the shared memory on both.

## Guiding values

1. **Same shepherd, different field.** Tool names, opaque IDs, agent
   Markdown, handoff habits do not fork.
2. **Auto by default.** Detect per command, run local.
3. **No magic / no cross-spawn.** Never spawn a TUI pane from the app
   (or vice versa) unless explicitly pinned *and* reachable.
4. **Boring.** No new deps, no migration, default stays working.
