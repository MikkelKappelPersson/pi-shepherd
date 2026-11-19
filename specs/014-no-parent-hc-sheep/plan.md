# Plan — No-parent sheep in the Herdr app

`specs/014-no-parent-hc-sheep` · draft · 2026-11-19 · spec: `spec.md`

## Summary

Add an hc-only spawn mode that launches a sheep as a parentless hc terminal
adopted into a Herdr app tab, while leaving the default hc launch path and the
whole herdr/TUI backend untouched. Manual `/shepherd spawn` selects the new
mode unconditionally.

## Requirement coverage

- **FR-001** → spawn-mode resolution defaults to `subagent` in the shared
  tool action.
- **FR-002** → optional `no_parent` flag on the `shepherd_spawn` tool schema
  and the `/shepherd spawn` parser (app-side only).
- **FR-003** → no-parent branch of the hc launch helper: `--no-parent` plus
  `herdr.space` label; no `herdr.tab` label so Herdr creates a sibling tab.
- **FR-004** → broker/launch-file mechanism stays exactly as today; mode
  affects only the terminal launch flags and labels.
- **FR-005** → slash-command path passes `no_parent: true` for `/shepherd
  spawn` on hc.
- **FR-006** → mode is resolved only after backend selection; herdr backend
  ignores it and reports its existing pane placement.
- **FR-007** → no schema or parser change for backend selection; existing
  `backend` setting remains the only control.
- **FR-008** → space-label resolution helper with explicit failure before any
  terminal is created.
- **FR-009** → existing owner-based created-terminal registry and reap path.
- **FR-010** → no settings, definition, or storage format changes.

## Technical context

- **Language / runtime**: TypeScript, existing runtime adapter structure.
- **Dependencies**: none; uses the already-installed `hc` and `herdr` CLIs.
- **Storage**: existing created-terminal registry and fieldnote directories;
  no new files.
- **Platform**: hc terminals attached to the Herdr desktop app; Linux/macOS/
  Windows as supported today.
- **Constraints**: default spawn path byte-for-byte unchanged for subagents;
  opaque ids only in tool results.

## Architecture

```text
shepherd_spawn / /shepherd spawn
        |  mode = no_parent? (slash: always on hc)
        v
backend resolver (auto | herdr | hc)   [unchanged]
        |                       \
      herdr                      hc
   [unchanged]          subagent: current hc run flags
                        no-parent: + --no-parent
                                    + herdr.space label
        |                       |
   herdr tab/pane            hc terminal -> Herdr app adopts into tab
   (own pane already)        (parent: null, no sub_agents entry)
        \                       /
         same broker, opaque ids, fieldnotes, registry
```

Mode selection happens after backend resolution. It never influences which
backend is used.

## Data model

- `SpawnMode`: `subagent | no_parent`; resolved per call, not persisted.
- Created-terminal registry entry: gains an optional `no_parent` marker used
  only for diagnostics and tests; ownership fields stay as they are.
- Labels on a no-parent hc terminal: existing `shepherd.owned` and
  `shepherd.agent` labels, plus `shepherd.no-parent=true` and
  `herdr.space=<caller space>`. No `herdr.tab` label.
- Paths: unchanged launch script/session files in the existing temp location.

## Interfaces

| interface | behavior |
|---|---|
| `shepherd_spawn({ ..., no_parent? })` | `true` requests a no-parent sheep on hc; omitted/`false` keeps today's subagent. |
| `/shepherd spawn <agent>` | Always sets no-parent when the caller is hc; unchanged result format. |
| `/shepherd spawn <agent> --subagent` | Optional escape hatch if approved; otherwise out of scope. |
| Backend resolver | Still `auto`/`herdr`/`hc` from settings only; no tool parameter. |
| Spawn result | Reports the resolved placement in the existing human-readable line; ids stay opaque. |

Env: `HC_TERMINAL_ID` — address of the calling terminal; used to read its
`herdr.space` label via `hc get`. No new environment variables.

## Invariants

- A spawn with no no-parent request MUST produce exactly the current hc
  terminal flags and labels.
- A no-parent sheep MUST have no recorded hc parent and MUST NOT inherit
  notifications typed into the parent terminal.
- Mode selection MUST never change backend selection or cross-spawn.
- `shepherd_close`, `shepherd_delegate`, `shepherd_watch`, messaging and
  fieldnotes MUST NOT branch on spawn mode.
- The herdr/TUI backend MUST NOT gain a new user-facing option.

## Failure behavior

- No `herdr.space` label on the caller ⇒ refuse no-parent before creating a
  terminal, with a hint to run from a Herdr app terminal.
- hc rejects `--no-parent` or the space label ⇒ surface the core error; do not
  retry as a subagent, because that would silently change the requested kind.
- No-parent requested on the herdr backend ⇒ ignore the mode and report that
  the agent already has its own pane; no error, no flag passed to `herdr`.
- Space label present but app not showing the tab ⇒ the launch still succeeds
  and the terminal remains addressable by its opaque id; diagnostics note the
  unexpected layout.

## Recovery

- `--outlive-parent` remains on both paths; a no-parent sheep already has no
  parent to die with.
- Orphan reaping continues to match by recorded owner, not hc parent; store
  the no-parent marker in the registry at creation time so a restarted parent
  can still identify and close it.
- Fieldnotes and queued envelopes keep their current lifecycle untouched.

## Open questions

1. ~~Tool flag name~~ — decided: `no_parent`, mirroring hc's `--no-parent`
   (product owner, 2026-11-19).
2. Whether to add the optional `--subagent` escape hatch on `/shepherd spawn`
   (out of scope unless the product owner asks).
3. hc version floor for `--no-parent` — confirm against the supported Herdr
   app toolchain; if a floor is needed, document it in the failure hint.
