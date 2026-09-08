# Tasks: Per-workspace self-contained Shepherd settings

Implement in order. Keep the current settings behavior passing until the new
resolution model is fully covered. Do not change lifecycle tool schemas or
opaque id contracts as part of this work.

## Phase 1 — Configuration core

- [ ] **1.1 Define the new settings shape**
  - Replace `settingsScope`/`ConfigScope` with effective `projectScope`.
  - Keep all existing Shepherd value fields and defaults unchanged.
  - Define separate project-overridable and user-only field lists.
  - Keep `confirmProjectAgents` user-owned as a security control.

- [ ] **1.2 Add project activation parsing**
  - Parse boolean `projectScope` only from project configuration.
  - Honor legacy project `settingsScope: "project"` as active.
  - Give a real boolean flag precedence over the legacy string.
  - Ignore user-file scope flags for resolution.
  - Treat absent, invalid, and malformed project activation as inactive.

- [ ] **1.3 Implement per-workspace resolution**
  - Load user values over built-in defaults.
  - Resolve the project file for the supplied cwd only.
  - When active, resolve project values over built-in defaults without user
    values leaking into missing project fields.
  - Preserve the trusted user-layer `confirmProjectAgents` value even when
    project scope is active.
  - Return `projectScope: false` for user-layer results and no-cwd results.

- [ ] **1.4 Implement self-contained persistence**
  - Make user saves write values only.
  - Make project saves write every project-overridable field plus
    `projectScope`; never write `confirmProjectAgents` to the project file.
  - Preserve `created` reporting and mtime-cache updates.
  - Remove delta comparison and `loadProjectDelta()` after callers migrate.

- [ ] **1.5 Implement parked-value lifecycle**
  - Add `loadProjectFileValues()` with built-in fallback for missing fields.
  - Add `deactivateProjectScope()`.
  - Preserve values on deactivation.
  - Drop legacy `settingsScope` when normalizing a project file.
  - Never delete the project file during deactivation.

- [ ] **1.6 Preserve existing migrations**
  - Keep `settings.json` → `config.json` migration behavior.
  - Keep timeout millisecond-to-minute migration behavior.
  - Ensure user saves strip both old and new scope keys.

## Phase 2 — Settings UI

- [ ] **2.1 Convert the scope menu item**
  - Rename the item id to `projectScope`.
  - Display `project`, `user (project file dormant)`, or `user` as applicable.
  - Ensure the current display value is included in the cycle values.

- [ ] **2.2 Implement activation and deactivation actions**
  - Activation reads parked values and writes a complete project config with
    `projectScope: true`.
  - Missing project files are created with a creation notification.
  - User selection calls `deactivateProjectScope()` and preserves the file.
  - Resync the menu after each successful scope change.

- [ ] **2.3 Route value edits by effective scope**
  - Save user values only while project scope is inactive.
  - Save complete project values while project scope is active.
  - Always save `confirmProjectAgents` to the user file.
  - Label or describe `confirmProjectAgents` as user-only in the menu.
  - Preserve the existing fieldnotes and project-agent notifications.
  - Preserve error notifications for failed writes.

## Phase 3 — Runtime integration

- [ ] **3.1 Migrate config API callers**
  - Remove `settingsScope`, `ConfigScope`, and `loadProjectDelta` references.
  - Verify all `loadSettings()` calls pass the appropriate cwd.
  - Store the owning workspace cwd on agent/task records.
  - Replace `process.cwd()` in reply-deadline and stale-wait settings lookups
    with the owning agent/task cwd.
  - Keep session-start fieldnote initialization cwd-aware.

- [ ] **3.2 Verify effective runtime settings**
  - Confirm delegation/prompt timeout uses the active workspace settings.
  - Confirm stale-wait threshold uses the active workspace settings.
  - Confirm agent scope and bundled-agent inclusion use the active workspace.
  - Confirm project-agent confirmation uses the trusted user-layer setting;
    project config cannot disable it.
  - Confirm tab/process retention and emoji rendering still use settings.

## Phase 4 — Config and integration tests

- [ ] **4.1 Rewrite the config-layer test**
  - Test defaults and `projectScope: false`.
  - Test values-only user persistence.
  - Test ignored and stripped user scope keys.
  - Test dormant false/keyless/invalid/malformed project files.
  - Test active project isolation from user values.
  - Test per-workspace independence.
  - Test legacy project string compatibility.

- [ ] **4.2 Test full project writes**
  - Verify project saves contain all project-overridable fields plus the
    boolean flag, and omit `confirmProjectAgents`.
  - Verify fresh project creation.
  - Verify missing active-project fields use built-in defaults.
  - Verify explicit runtime values still take precedence where applicable.

- [ ] **4.3 Test parked values and deactivation**
  - Verify activation preserves dormant project values.
  - Verify deactivation writes `false` rather than deleting the file.
  - Verify deactivation preserves values and removes legacy scope keys.
  - Verify repeated deactivation and missing-file deactivation are no-ops.
  - Verify keyless and legacy-string object deactivation normalizes to
    `projectScope: false`.
  - Verify invalid parked values fall back to built-in defaults and unknown
    values are normalized away on a complete project save.

- [ ] **4.4 Update dependent fixtures**
  - Update status-widget fixtures to use `projectScope: true`.
  - Update command-UX fixtures to use the new file shapes.
  - Add/adjust fieldnotes, timeout, stale-wait, discovery, confirmation, and
    widget coverage.
  - Add a child/task cwd test where the parent process cwd differs from the
    workspace cwd.
  - Cover timeout unit migration, stale thresholds at/below zero, non-object
    project files, and filesystem failure paths.

## Phase 5 — Repository hygiene and documentation

- [ ] **5.1 Update ignore rules**
  - Keep `.shepherd` runtime sessions ignored.
  - Allow an explicit `.shepherd/config.json` to be tracked.
  - Verify generated fieldnotes remain ignored.
  - Verify `.shepherd/config.json` is trackable in a temporary git repository
    and remains present after a fresh checkout.

- [ ] **5.2 Update user documentation**
  - Rewrite the README settings section for the new model.
  - Document the per-workspace boolean activation flag.
  - Document self-contained project files and built-in fallback behavior.
  - Document the migration behavior and repository-commit guidance.
  - Add the repository-agent security boundary: project files cannot disable
    the user-owned confirmation gate.

- [ ] **5.3 Update maintainer documentation**
  - Update `AGENTS.md`.
  - Mark the old settings-scope plan as superseded or link to this spec.
  - Add this spec/plan to any applicable documentation index.

## Phase 6 — Verification and completion

- [ ] **6.1 Run automated verification**
  - Run `git diff --check`.
  - Run `npm run settings:test`.
  - Run `npm test`.

- [ ] **6.2 Perform live settings verification**
  - Test creation, activation, edit, deactivation, and reactivation through
    `/shepherd settings`.
  - Test two independent workspaces.
  - Test hand-edited mtime reload with a changed file mtime; document the
    same-mtime cache limitation or strengthen cache invalidation if required.
  - Test fieldnotes session snapshot behavior.
  - Test active project files with missing and invalid fields.
  - Test timeout and stale-wait resolution with a child/task cwd different from
    the parent process cwd.

- [ ] **6.3 Review migration and security behavior**
  - Confirm keyless legacy project files do not silently activate.
  - Confirm committed project settings are clearly documented as
    repository-controlled.
  - Confirm no user scope pointer can affect another workspace.
  - Confirm a committed project file cannot set `confirmProjectAgents: false`
    to suppress project-agent confirmation.

- [ ] **6.4 Complete the specification**
  - Update `spec.md` status after implementation and verification.
  - Record any intentional deviations or migration caveats.
