# Plan — 009 hc-runtime

## Target

2-runtimes-1-core, same pattern as 006 Phase 0:

```text
src/core/        discovery, ids, config, artifact-sessions (shared, no CLI import)
src/runtimes/
  runtime.ts     ShepherdRuntime (unchanged)
  detect.ts      NEW: detectCaller() -> herdr-tui | hc-app | plain
  herdr/         existing
  hc/            NEW: runtime.ts + hc.ts (ownership, launch, read)
src/extension/   resolve runtime per command from (setting + detect), no schema change
```

## Design decisions

1. **Setting, not tool param.** `backend: auto|herdr|hc` lives in
   `src/core/config.ts` store + `/shepherd settings` UI only.
   No `shepherd_*` schema, promptSnippet, or result mentions it.
2. **Per-command resolve** (not per-session sticky):
   `resolveBackend() = explicit pin if set, else detectCaller()`.
   Env check is free; binary/socket probe cached ~1s with 3s timeout cap
   so status-widget ticks stay cheap.
3. **Spawn parity, impl may differ.** TUI keeps `pane split/tab create +
   launchPiInPane`; hc uses `hc run --bg` + label + `hc read` tail.
   Both retain: background by default, cwd preserved, temp launch dir
   lifetime tied to owned terminal/pane, `shepherd_done` 1-nudge.
4. **Introspection stays per-runtime.** `herd/agents/prune`/widget read
   owned-panes OR owned-terminals summaries; IDs stay opaque in display.
5. **No migration.** Default `auto` == current behavior when called from
   TUI; app callers get local runs without config.

## Order

Phase 0 — detect + setting + shim (zero behavior change, TUI default intact).
Phase 1 — `src/runtimes/hc/` spawn/delegate/watch/done + mapping tests.
Phase 2 — message/status parity, fieldnotes bridge check, auto-viewer rules,
  docs + live proof.

## Open questions

1. `placement` on `hc`: ignore vs map to `hc` spaces/tabs? Proposal: ignore
   for execution in Phase 1, honor for viewer in `auto` later.
2. `read --lines` over `hc read` frames vs full view? Proposal: tail same
   120-line default, slice after.
3. Project-forced backend? Proposal: no — same user-owned rule as
   `confirmProjectAgents`; project file can suggest `auto` only.
