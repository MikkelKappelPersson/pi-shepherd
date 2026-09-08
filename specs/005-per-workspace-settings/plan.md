# Implementation Plan: Per-workspace self-contained Shepherd settings

This plan migrates pi-shepherd's existing settings implementation to the
per-workspace activation and self-contained project-file model already used by
pi-zvec-grep. The change is intentionally staged so the config core is settled
before the menu, runtime fixtures, and documentation are updated.

## Target architecture

```text
user config (values only) ───────────────┐
                                         │ inactive project
                                         ▼
                                  effective user values

project config (values + projectScope) ─┐
                                         │ projectScope: true
                                         ▼
                         built-in defaults + project values
```

`projectScope` is read from the project file for the current cwd. It is never a
machine-global switch and is never taken from the user file.

## Design decisions

1. **Per-workspace activation** — move scope ownership from the user file to
   `.shepherd/config.json`, so activating one repository cannot affect another.
2. **Self-contained project files** — write every project-overridable Shepherd
   value to an active project file; do not write a delta against the current
   user's preferences. `confirmProjectAgents` is the user-owned security
   exception and is never project-controlled.
3. **Built-in fallback for active projects** — an active project file is
   portable. Missing or invalid values fall back to `DEFAULT_SETTINGS`, never
   to the user's private values.
4. **Dormant legacy files are safe by default** — keyless project files remain
   inactive until explicitly activated. This avoids silently enabling old
   repository-controlled deltas during migration.
5. **Read-only legacy compatibility** — accept project
   `settingsScope: "project"` as active, but write only boolean
   `projectScope` going forward.
6. **Parked-value preservation** — deactivation keeps project values, and
   reactivation restores those values rather than replacing them with user
   values.
7. **No public lifecycle API change** — runtime code consumes the same setting
   names and `loadSettings(cwd)` result; only the scope metadata and config
   persistence internals change.
8. **Project settings can be committed deliberately** — adjust `.gitignore` to
   ignore fieldnote sessions while allowing an explicit `.shepherd/config.json`
   exception.
9. **Repository configs cannot weaken the trust gate** — `confirmProjectAgents`
   remains in the user layer. A committed project file may select project agent
   definitions but cannot suppress interactive confirmation.

## Phase 1 — Replace the configuration model

Update `src/extension/config.ts`:

- Replace `ConfigScope` and `settingsScope` with `projectScope: boolean` on the
  effective settings type.
- Keep the existing nine value fields, defaults, validators, timeout migration,
  and per-file mtime cache.
- Treat `confirmProjectAgents` as user-only: validate/read/write it only in the
  user layer, ignore any project-file copy, and retain it when resolving an
  active project.
- Keep `userConfigFile()` and `projectConfigFile()` paths unchanged.
- Make `validateLayer()` parse `projectScope` and the legacy project
  `settingsScope` string, while ensuring scope flags from the user file are
  ignored for resolution.
- Implement the zvec-style `loadSettings(cwd)` resolution algorithm.
- Add `loadProjectFileValues(cwd)`.
- Add `deactivateProjectScope(cwd)`.
- Replace delta-writing project saves with full project writes containing all
  project-overridable fields plus `projectScope`; never write
  `confirmProjectAgents` to a project file.
- Make user saves values-only and strip legacy scope keys.
- Remove `overlayProject()` and `loadProjectDelta()` once all callers are
  migrated.
- Preserve the existing `settings.json` → `config.json` migration and timeout
  unit migration.
- Update cache entries after project activation, deactivation, and user saves.

The implementation should use the zvec-grep implementation as the behavioral
reference, adapted to Shepherd's larger settings object and existing legacy
migrations.

## Phase 2 — Rewrite the settings menu

Update `src/extension/settings-ui.ts`:

- Change the scope item id from `settingsScope` to `projectScope`.
- Import `deactivateProjectScope`, `loadProjectFileValues`, and
  `projectConfigFile`.
- Add the three scope display states: `project`,
  `user (project file dormant)`, and `user`.
- On project activation, merge parked project values before saving a complete
  project file with `projectScope: true`; preserve the trusted user-layer
  `confirmProjectAgents` value separately.
- On user selection, call `deactivateProjectScope()` rather than changing a
  user-file pointer.
- Route non-scope changes to the user file or complete project file according
  to the effective workspace scope; always persist `confirmProjectAgents` in
  the user file.
- Resync state and display after every successful change.
- Preserve existing notifications, especially the next-session fieldnotes
  notice and project-agent security notice.
- Preserve error notifications and the inline TUI behavior.

## Phase 3 — Migrate runtime and extension call sites

Search all settings consumers and remove assumptions that `loadSettings()`
returns `settingsScope`:

- `index.ts` widget and command completion rendering;
- `src/core/lifecycle.ts` timeout and stale-wait resolution;
- `src/extension/shepherd.ts` timeout, agent scope, bundled-agent, and
  confirmation resolution;
- `src/extension/settings-ui.ts`;
- session-start fieldnote initialization.

Fix the existing cwd-sensitive lifecycle lookups explicitly:

- Store the owning workspace cwd on the agent/task record when the agent is
  spawned.
- Use that cwd for `sendParentMessage()` reply deadlines instead of
  `process.cwd()`.
- Use the waiting task's owning cwd in the stale-wait monitor instead of
  `process.cwd()`.
- Add tests where a child/task cwd differs from the parent process cwd.

The runtime should continue passing the relevant cwd. No lifecycle tool schema
or model-facing argument changes should be introduced.

## Phase 4 — Update tests and fixtures

Rewrite `test/verify-settings.mjs` around the new contract:

- no files → built-in defaults and `projectScope: false`;
- user saves write values only;
- user-file `settingsScope` and stray `projectScope` are ignored and stripped
  on the next user save;
- no project file → user values apply;
- `projectScope: false` → project values dormant, user values apply;
- keyless project file → dormant;
- non-boolean project flag → dormant;
- malformed project file → user layer applies;
- `projectScope: true` → project values apply and missing fields use built-in
  defaults rather than user values;
- project activation is independent across two cwd values;
- legacy project `settingsScope: "project"` activates;
- user and project saves write the expected complete shapes;
- activation creates a file when needed;
- deactivation writes `projectScope: false`, preserves values, drops the legacy
  key, and does not delete the file;
- dormant project values survive reactivation through
  `loadProjectFileValues()`;
- legacy user-file migration and timeout migration still work.

Update dependent fixtures:

- `test/verify-status-widget.mjs` must put `projectScope: true` in its project
  fixture rather than relying on a user `settingsScope` pointer.
- `test/verify-command-ux.mjs` and any other configuration fixtures must use
  values-only user files and explicit project activation where required.
- Add coverage for effective settings used by fieldnotes, timeouts, stale-wait
  reminders, agent discovery, confirmation, and the status widget.
- Assert that project config cannot disable `confirmProjectAgents`, while an
  explicit user-layer opt-out remains effective.
- Add focused lifecycle tests proving reply deadlines and stale-wait thresholds
  resolve from the task/agent workspace cwd, not the parent process cwd.
- Cover all validators, including timeout unit migration, stale-wait values at
  and below zero, non-object project files, and invalid parked values.

## Phase 5 — Repository and documentation updates

Update repository guidance and user documentation:

- Replace the old scope/delta explanation in `README.md`.
- Update `AGENTS.md` to describe user values-only plus self-contained project
  settings and the project-owned activation flag.
- Mark `docs/plans/settings-scope.md` as superseded or replace its design
  details with a link to this specification.
- Update `docs/README.md` if the plan/spec index requires a new entry.
- Update `.gitignore` from a blanket `.shepherd/` ignore to a pattern that
  keeps runtime sessions ignored while allowing an explicit
  `.shepherd/config.json` exception.
- Verify the exception with `git check-ignore` and a temporary fresh checkout.
- Document the migration behavior for existing user scope pointers and
  keyless project deltas.
- Document that committing `.shepherd/config.json` is deliberate because it
  can affect project-agent discovery and lifecycle defaults, but cannot disable
  the user-owned project-agent confirmation gate.
- Add an explicit security/trust-boundary section for repository-controlled
  agent definitions.

## Phase 6 — Verification and live rollout

Run static and automated checks:

```bash
git diff --check
npm run settings:test
npm test
```

Perform live checks in a temporary project and a second independent cwd:

1. Open `/shepherd settings` with no project file; confirm `user` display.
2. Select project; confirm `.shepherd/config.json` is created with all
   project-overridable values (but not `confirmProjectAgents`) and
   `projectScope: true`.
3. Change a project value; confirm the project file remains self-contained.
4. Open settings from another cwd; confirm it still uses user settings.
5. Deactivate project scope; confirm `projectScope: false`, preserved values,
   and immediate user-layer behavior.
6. Re-enable project scope; confirm parked project values return.
7. Hand-edit a project file, confirm mtime-based reload, and document or
   address the existing same-mtime cache limitation.
8. Confirm fieldnotes still require a new Shepherd session after changing the
   setting.
9. Confirm timeout, stale-wait, agent discovery, and widget behavior resolve
   from the active workspace layer; confirm the project file cannot disable
   the user-owned project-agent confirmation gate.
10. Run a child/task with a cwd different from the parent process cwd and
    confirm its timeout and stale-wait settings come from the child/task cwd.
11. Confirm a committed-style project config does not cause other workspaces
    to change.

After implementation and verification, update the status in `spec.md` and
record any intentional deviations.
