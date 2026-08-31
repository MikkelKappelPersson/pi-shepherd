# Plan: Scoped Settings — user config + project config override

Status: implemented (
`src/extension/config.ts` replaces the old single-file settings store).
Implementation note: the user file lives in the pi agent dir as resolved by
`getAgentDir()` (`~/.pi/agent` by default, `PI_CODING_AGENT_DIR` overridable)
rather than a hard-coded home path.

## 1. Problem

All persisted settings live in a single user-level file
(`~/.pi/agent/pi-shepherd/settings.json`), so a project cannot carry its own
shepherd defaults (timeout, keepOpen, stayOpen, …). There is also no
project-level config surface at all, despite projects already carrying
`.pi/`/`.agents/` agent dirs and `.shepherd/sessions/` fieldnotes.

## 2. Decisions (agreed)

1. **Scope top-level item.** The settings menu (`/shepherd settings`) gains a
   first, top-level entry: **Settings scope** — `user` (default) | `project`.
2. **Project file path.** `.shepherd/config.json` in the current working
   directory (same `.shepherd` root fieldnotes already use; anchored at cwd,
   no walk-up — consistent with `artifact-sessions.ts`).
3. **File creation.** Switching scope to `project` when
   `.shepherd/config.json` does not exist creates it (as `{}` — empty delta,
   no overrides) and sends a notification that the file was created.
4. **Override semantics.** The project file is a **delta**: fields override
   the user layer one by one. Only fields that actually differ from the user
   layer are written to the project file ("write only changed").
5. **Menu writes follow the current scope.** Scope is `user` → edits go to
   the user file; scope is `project` → edits go to the project file.
6. **All fields are project-overridable** — except `settingsScope` itself,
   which by definition lives only in the user file (it is the pointer to
   where to look; a project file cannot select its own scope).
7. **Naming.** "Settings" is the interactive menu; the persisted artifacts are
   *config*. Rename user file `settings.json` → `config.json` (one-shot
   migration), module `settings.ts` → `config.ts`. Project file is
   `.shepherd/config.json`.

## 3. Design

### 3.1 Storage core — `src/extension/settings.ts` → `src/extension/config.ts`

- New type `ConfigScope = "user" | "project"`. `ShepherdSettings` gains
  `settingsScope: ConfigScope`, default `"user"` (user-file-only field).
- `userConfigFile()` → `~/.pi/agent/pi-shepherd/config.json` (same dir as
  `created-panes.json`).
- `projectConfigFile(cwd)` → `path.resolve(cwd, ".shepherd", "config.json")`.
- One-time migration, same pattern as the existing timeout ms→min migration
  in `loadSettings()`:
  - `config.json` missing AND old `~/.pi/agent/pi-shepherd/settings.json`
    exists → move the old file to `config.json`, silently.
  - Both exist → `config.json` wins; old file left in place (no deletion).
  - Only old file / neither / parse errors behave as today (defaults).
- `loadSettings(cwd?)`:
  1. Load user layer: file (or defaults), validated/merged, **mtime-cached
     per file path** (replaces the single global cache).
  2. Resolve effective scope from the user layer's `settingsScope`.
  3. If `project` and `cwd` given: read `.shepherd/config.json`, validate each
     known field, overlay over the user layer. `{}` / missing / unreadable →
     pure user layer. `settingsScope` in a project file is ignored (the merge
     function simply never applies it).
  4. Return merged `ShepherdSettings`.
- `saveSettings(next: ShepherdSettings, scope: ConfigScope = "user",
  projectRoot?: string): { file: string, created: boolean }`:
  - `user`: write the full object (today's behavior; `settingsScope`
    always written).
  - `project`: diff `next` against the current user layer; write only the
    fields whose values differ (`{}` when all equal). Create the file (and
    `.shepherd/` dir) if missing; `created` is true when a new file is born.
    The `settingsScope` field is never written to the project file.
  - Keep the mtime cache in sync after writes.
- `initializeSessionSettings(cwd?)` — the fieldnotes session snapshot reads
  the merged, cwd-aware value (a session started inside a project sees
  project-overridden fieldnotes state).

### 3.2 Settings menu — `src/extension/settings-ui.ts`

- New first `SettingItem`: **Settings scope** (`user`/`project`, ≤ 30-char
  label), description notes that project values override user values.
- Menu opens with `ctx.cwd`; displayed values are the merged ones when scope
  is `project`, so the menu shows exactly what the system is using.
- Change handling on the list `onChange`:
  - **scope change** → always saved to the **user** file. If the new scope is
    `project` and the project file didn't exist → create it (`{}` or the
    current delta) and notify: `Config created at .shepherd/config.json`.
  - **any other field** → saved to the **current scope's** file (user or
    project delta). Project saves reuse the same created-notification when
    the file is born.
  - Existing notifications for `fieldnotes` (next-session effect) and
    `agentScope` (repo-controlled notice) are preserved.
  - Wrap saves in try/catch → error-level notification on failure (e.g.
    read-only project directory) instead of an uncaught throw inside the TUI.

### 3.3 Thread `cwd` into every `loadSettings()` call

| Call site | cwd source |
|---|---|
| `src/core/lifecycle.ts` `startAgent` | `ctx.cwd` (already available) |
| `src/extension/shepherd.ts` `doAction` (spawn/prompt/wait/agents) | `ctx.cwd` |
| `src/extension/settings-ui.ts` `openSettings` | `ctx.cwd` |
| `src/extension/config.ts` `initializeSessionSettings` | `ctx.cwd` in `session_start` |
| `index.ts` widget render + command arg completions | `shepherdCommandCwd` |

No change to tool parameters: scope remains implicit from the config files,
exactly as `agentScope` resolution works today.

## 4. Behavior notes (accepted)

- Stale project deltas persist: if the project file overrides `keepOpen:
  true` and you later change `keepOpen` to `false` in the user scope, the
  project layer still wins while scope is `project`. Inherent to override
  semantics.
- The merged result, not the raw files, is what tools/lifecycle consume; a
  model-facing call that passes explicit args still wins over both layers
  (no change).
- Editing `.shepherd/config.json` by hand takes effect immediately (mtime
  cache), like the user file today.

## 5. Tests (`npm test`)

`test/verify-settings.mjs` (renamed expectations to the new file names):
- Project overlay: user `fieldnotes: true` + project `{ "fieldnotes": false }`
  → merged `false`; untouched fields stay user values.
- Delta-only writes: saving one changed field in project scope writes only
  that field; unchanged fields are absent from the file; `{}` when nothing
  differs.
- Scope switch: first change with scope `project` when no file exists →
  created flag set, file exists, content is the delta (initially `{}`).
- `settingsScope` in a project file is ignored.
- Migration: old `~/.pi/agent/pi-shepherd/settings.json` without `config.json`
  → moved to `config.json`, values intact, old name gone. Both exist →
  `config.json` wins, old name untouched.
- Fieldnotes session snapshot honors the merged (project-overridden) value.

`test/verify-command-ux.mjs`: existing `settings.json` fixture → `config.json`.

Live check (this repo): `/shepherd settings` → toggle scope `project` →
`.shepherd/config.json` appears (with the creation notification) → change a
field → file contains only the delta → toggle back + delete → user values
restore.

## 6. Docs

- README/docs mentions of `settings.json` → user `~/.pi/agent/pi-shepherd/
  config.json` + project `.shepherd/config.json`, with the override model in
  one short paragraph.
- `AGENTS.md`: short note on the two-file config model (user layer + project
  delta; `settingsScope` user-only).
- Module rename `settings.ts` → `config.ts`; update the file-header comment
  and all imports (9 call sites listed in §3.3 plus tests).

## 7. Out of scope

- Per-workspace (multi-root) config; config in `.pi/` instead of `.shepherd/`.
- A config "reload" command or file-watcher (mtime cache suffices).
- Restricting which fields the project layer may override (decided: all).
