# Per-workspace self-contained Shepherd settings

## Status

Implemented. The per-workspace configuration model, security boundary,
lifecycle cwd fixes, documentation, and automated tests are complete. Live
interactive `/shepherd settings` verification remains an operational follow-up.

## Confirmed decisions

- `confirmProjectAgents` remains user-owned. A committed project config cannot
  disable the project-agent confirmation gate; a user's explicit user-level
  opt-out remains effective.
- Existing keyless project deltas remain dormant until explicitly activated.
  The old global `settingsScope: "project"` preference is not automatically
  converted across workspaces.
- `.shepherd/config.json` is intended to be optionally committed and shared,
  while runtime fieldnote sessions remain ignored.
- The existing workspace-cwd bugs in reply deadlines and stale-wait monitoring
  are included in this implementation.
- The settings UI will clearly describe `confirmProjectAgents` as user-only.

## Summary

Replace pi-shepherd's machine-global `settingsScope` plus sparse project-delta
model with the per-workspace, self-contained project configuration model used
by pi-zvec-grep.

The new model keeps personal defaults in the user configuration and puts a
boolean activation flag in each project's configuration file. A project can
therefore opt into its own committed settings without changing the behavior of
any other workspace or relying on each user's private configuration.

The existing Shepherd setting fields and their runtime behavior remain. This
feature changes configuration ownership, activation, persistence, migration,
and the settings menu—not the meaning of agent, lifecycle, fieldnotes, or
watcher settings.

## Goals

- Make project settings independently activatable per workspace.
- Make an active project configuration self-contained and reproducible across
  machines.
- Prevent a project from changing the settings source for unrelated projects.
- Preserve all existing Shepherd settings and defaults.
- Preserve the existing user-file rename migration from `settings.json` to
  `config.json`.
- Preserve legacy project files using `settingsScope: "project"` as a
  read-only compatibility format.
- Make dormant project settings reversible without deleting their stored
  values.
- Allow a committed `.shepherd/config.json` to carry team-wide Shepherd
  defaults while keeping runtime fieldnote sessions ignored.
- Keep model-facing lifecycle APIs and opaque id semantics unchanged.
- Preserve `confirmProjectAgents` as a user-owned security control so a
  committed project file cannot suppress confirmation for project-local agents.

## Non-goals

- Do not change the set or meaning of the existing Shepherd settings.
- Do not add a second configuration root or walk up parent directories.
- Do not automatically activate every existing keyless project delta. Such a
  conversion could silently enable repository-controlled settings and cannot
  safely translate one global user preference to all workspaces.
- Do not change explicit tool-call or lifecycle arguments that already override
  configured defaults.
- Do not delete old configuration files automatically except for the existing
  one-shot `settings.json` → `config.json` rename migration.
- Do not change fieldnote session snapshot semantics: `fieldnotes` still takes
  effect for a new Shepherd session.

## Configuration model

### Files

| Layer | Path | Contents |
| --- | --- | --- |
| User | `~/.pi/agent/pi-shepherd/config.json`, resolved through `getAgentDir()` | Value fields only; personal defaults for workspaces without active project scope. |
| Project | `<cwd>/.shepherd/config.json`, anchored at the current cwd | All project-overridable fields plus boolean `projectScope`; self-contained when active. |

Both files continue to use the active pi agent directory and
`PI_CODING_AGENT_DIR` override. Project lookup remains cwd-anchored with no
walk-up. The per-file mtime cache remains in place.

### Value fields

The effective settings retain the current `ShepherdSettings` value fields.
All are project-overridable except `confirmProjectAgents`, which remains a
user-owned security control and is never written to or read from the project
file:

- `agentScope` — default `user`
- `includeBundledAgents` — default `true`
- `confirmProjectAgents` — default `true`; user-owned and not project-overridable
- `keepOpen` — default `true`
- `stayOpen` — default `false`
- `fieldnotes` — default `true`
- `emojiSheep` — default `true`
- `timeout` — default `20` minutes
- `staleWaitThreshold` — default `5` minutes; zero or a negative value disables
  stale-wait reminders

The effective settings object returned by `loadSettings(cwd)` gains:

```ts
projectScope: boolean
```

`projectScope` is derived from the current workspace's project file. It is not
stored in the user file and is false when no project scope is active.

### User file

The user file stores the value fields only:

```json
{
  "agentScope": "both",
  "includeBundledAgents": true,
  "confirmProjectAgents": true,
  "keepOpen": true,
  "stayOpen": false,
  "fieldnotes": true,
  "emojiSheep": true,
  "timeout": 20,
  "staleWaitThreshold": 5
}
```

A stray `projectScope` or legacy `settingsScope` key in the user file is
ignored for resolution. The next user-layer save strips both keys.

### Project file

A project file managed by Shepherd stores every project-overridable value
and the activation flag. It does not store `confirmProjectAgents`, because
that setting is user-owned:

```json
{
  "agentScope": "project",
  "includeBundledAgents": true,
  "keepOpen": false,
  "stayOpen": false,
  "fieldnotes": true,
  "emojiSheep": true,
  "timeout": 30,
  "staleWaitThreshold": 5,
  "projectScope": true
}
```

When `projectScope` is `true`, the project file is authoritative for that
workspace's project-overridable settings. User values are not mixed into those
settings. Missing or invalid project-overridable fields in an active project
file fall back to the built-in defaults, not to the user layer.

`confirmProjectAgents` is the deliberate security exception: it always comes
from the trusted user layer. A committed project file may select project agents
through `agentScope`, but it cannot disable the interactive confirmation gate.
A user may still explicitly disable that gate in their own user configuration.
This is the only user value mixed into an active project result.

When `projectScope` is `false`, the project values remain stored but dormant;
the user layer applies. A missing, keyless, invalid, or malformed project file
also leaves project scope inactive and falls back to the user layer.

A legacy project file containing `settingsScope: "project"` and no boolean
flag is treated as active for compatibility. The legacy string is never
written by Shepherd. If both keys are present, a real boolean `projectScope`
takes precedence.

## Resolution behavior

`loadSettings(cwd?)` must resolve as follows:

1. Load built-in defaults and overlay validated values from the user file.
2. Force the effective `projectScope` to `false` for the user-only result.
3. If no cwd is supplied, return that user-layer result.
4. Read `<cwd>/.shepherd/config.json`.
5. If the project file is active (`projectScope: true`, or the supported legacy
   string), create the effective result from built-in defaults and overlay only
   the validated project values; set `projectScope: true`.
6. For an active project, retain the trusted user-layer
   `confirmProjectAgents` value while keeping all other settings project-owned.
7. Otherwise, return the user-layer result with `projectScope: false`.

This means a project file with `{ "timeout": 30, "projectScope": true }`
uses the built-in defaults for every other project-overridable setting, while a
dormant project file with the same value leaves the user's timeout in effect.
The effective `confirmProjectAgents` value always comes from the user layer.

## Persistence behavior

Replace the current `ConfigScope`/`settingsScope` persistence contract with a
plain target scope (`"user" | "project"`) while keeping the scope argument
internal to the settings UI and config module.

### User save

`saveSettings(next, "user")` writes only the value fields. It strips
`settingsScope` and `projectScope` from legacy user files and updates the mtime
cache.

### Project save

`saveSettings(next, "project", cwd)` writes all project-overridable fields and
`projectScope: next.projectScope`; it never writes `confirmProjectAgents`. It
creates `.shepherd/` and reports whether the file was newly created.

Project saves are never deltas. This guarantees that an active committed
project config has the same meaning on every machine.

### Deactivation

Add `deactivateProjectScope(cwd)` with the following behavior:

- If the project file is missing or malformed, report no change.
- If it is a valid object with `projectScope: false`, report no change.
- A valid keyless, legacy-string, or `projectScope: true` object is considered
  a normalization/deactivation change and receives `projectScope: false`.
- Otherwise set `projectScope` to `false`.
- Preserve all stored project values.
- Remove a legacy `settingsScope` key when touching the file.
- Never delete the project file or its stored values.
- Make the user layer effective immediately.

Add `loadProjectFileValues(cwd)` so activating a dormant project preserves its
parked values instead of replacing them with the current user's values. Missing
parked fields use built-in defaults.

## Settings menu behavior

The existing `/shepherd` and `/shepherd settings` commands remain. The menu
continues to use the inline `SettingsList`/`DynamicBorder` presentation and
fuzzy search.

Change the first item from `settingsScope` to `projectScope`:

- `project` when this workspace's project file is active.
- `user (project file dormant)` when a project file exists but is inactive.
- `user` when no project file exists.

The scope item must keep its current display value inside its cycle values so
that the third dormant state cycles correctly.

Selecting `project`:

1. Read parked project values with `loadProjectFileValues(cwd)`.
2. Preserve the trusted user-layer `confirmProjectAgents` value.
3. Save the complete project settings with `projectScope: true`.
4. Create `.shepherd/config.json` if it does not exist and notify the user.
5. Resync the menu from `loadSettings(cwd)`.

Selecting `user` calls `deactivateProjectScope(cwd)`, preserving the project
file and values while making the user layer effective.

Changing any other setting saves to the user file when project scope is
inactive and to the complete project file when project scope is active.
`confirmProjectAgents` is always saved to the user file, even while the menu is
showing active project settings. The existing notifications for `fieldnotes`
(next session) and `agentScope` (repo-controlled agents) remain.

## Migration and compatibility

### User file rename

Keep the current one-shot migration:

```text
~/.pi/agent/pi-shepherd/settings.json
→ ~/.pi/agent/pi-shepherd/config.json
```

When both files exist, `config.json` wins and the legacy file remains in place.
The existing timeout millisecond-to-minute migration remains.

### Existing user scope key

After migration, a user-file `settingsScope` value is no longer authoritative.
It is ignored immediately and removed on the next user-layer save. There is no
safe automatic way to turn one machine-global `"project"` preference into
per-workspace activation for every directory, so existing workspaces must be
explicitly activated through `/shepherd settings` or by adding
`projectScope: true` to their project file.

This is a deliberate safety behavior: visiting a repository must not silently
activate repository-controlled settings merely because a private global flag
used to be set.

### Existing project deltas

Existing `.shepherd/config.json` files without `projectScope` are treated as
dormant. Their values are not deleted. Selecting `project` in the menu converts
the file to a complete self-contained configuration, preserving any stored
fields and filling missing fields from built-in defaults.

An existing project file with `settingsScope: "project"` remains active through
legacy compatibility and is normalized to the boolean form when saved or
deactivated. Any legacy `confirmProjectAgents` value found in a project file is
ignored; confirmation remains user-owned.

### Security boundary

Project files are repository-controlled input. They may select project agent
sources through `agentScope`, but they cannot turn off `confirmProjectAgents`.
The confirmation setting is loaded from the user file even when project scope is
active. A user who deliberately disables confirmation accepts responsibility for
that choice across workspaces, and the setting should be clearly labeled as a
trust decision in the menu and documentation.

### Repository tracking

Because `.shepherd/` currently ignores both settings and runtime fieldnotes,
update `.gitignore` so a project config can be committed without tracking
session artifacts:

```gitignore
.shepherd/*
!.shepherd/config.json
```

Document that committing `.shepherd/config.json` is an explicit choice
because it can contain project-controlled settings such as agent discovery and
agent lifecycle defaults. It must not be able to disable the user-owned
project-agent confirmation gate.

## Runtime integration

All existing consumers must continue to use the effective result from
`loadSettings(cwd)`:

- lifecycle prompt/delegation timeout resolution;
- stale-wait threshold resolution;
- agent discovery scope and bundled-agent inclusion;
- project-agent confirmation, using the trusted user-layer setting rather
  than a project-controlled value;
- tab/process retention;
- fieldnote session initialization;
- status widget sheep rendering;
- settings command completion and rendering.

No public lifecycle tool schema changes are required. Explicit tool arguments
continue to take precedence over configuration defaults.

## Verification requirements

The implementation is complete only when:

- the new config-layer contract is covered by filesystem tests;
- all existing settings consumers use per-workspace resolution;
- `sendParentMessage()` and the stale-wait monitor use the owning agent/task
  workspace cwd rather than the Shepherd process cwd;
- status-widget and command-UX fixtures use the new project activation flag;
- legacy user-file rename and timeout migration still pass;
- legacy project `settingsScope: "project"` compatibility passes;
- malformed, keyless, false, and invalid project files remain dormant;
- active project files do not inherit user values for missing fields;
- activation preserves dormant project values;
- deactivation writes `false` without deleting values;
- project files can be committed independently of fieldnote sessions;
- `npm test` passes; and
- live `/shepherd settings` verification confirms activation, deactivation,
  creation notification, and effective runtime behavior;
- a committed project file cannot suppress `confirmProjectAgents` and an
  explicit user opt-out remains user-owned;
- timeout and stale-wait behavior is tested with agents/tasks whose cwd differs
  from the parent process cwd.
