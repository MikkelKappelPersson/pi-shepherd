#!/usr/bin/env node
/**
 * Filesystem-only verification for the two-layer shepherd config:
 * user file (`~/.pi/agent/pi-shepherd/config.json`) + project delta
 * (`.shepherd/config.json`), scoped by the user file's `settingsScope`.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-shepherd-settings-"));
const previousHome = process.env.HOME;
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.HOME = home;
// Route the persistent extension dir into the temp home so the user config
// (and the legacy settings.json it migrates from) never touches the real one.
process.env.PI_CODING_AGENT_DIR = path.join(home, ".pi", "agent");

try {
  const mod = await import(`../src/extension/config.ts?settings-test=${Date.now()}`);
  const {
    DEFAULT_SETTINGS,
    fieldnotesEnabled,
    initializeSessionSettings,
    loadSettings,
    projectConfigFile,
    saveSettings,
    userConfigFile,
  } = mod;
  const legacyFile = path.join(path.dirname(userConfigFile()), "settings.json");

  assert.equal(userConfigFile(), path.join(home, ".pi", "agent", "pi-shepherd", "config.json"), "user config path honors PI_CODING_AGENT_DIR");

  // --- defaults with no files at all -------------------------------------
  assert.equal(DEFAULT_SETTINGS.settingsScope, "user");
  assert.equal(loadSettings().fieldnotes, true, "missing fieldnotes setting defaults on");
  assert.equal(loadSettings().emojiSheep, true, "missing emoji sheep setting defaults on");
  assert.equal(loadSettings().settingsScope, "user", "settings scope defaults to user");

  // --- user layer persistence (full object, incl. scope) ------------------
  const user = { ...DEFAULT_SETTINGS, fieldnotes: false, emojiSheep: false };
  saveSettings(user, "user");
  assert.equal(loadSettings().fieldnotes, false, "disabled fieldnotes setting persists");
  assert.equal(loadSettings().emojiSheep, false, "disabled emoji sheep setting persists");
  const rawUser = JSON.parse(fs.readFileSync(userConfigFile(), "utf8"));
  assert.equal(rawUser.fieldnotes, false, "user file holds the full object");
  assert.equal(rawUser.settingsScope, "user", "user file always carries settingsScope");
  assert.equal(rawUser.timeout, DEFAULT_SETTINGS.timeout, "unchanged fields persist to the user file");

  // --- project overlay: hand-written delta over the user layer ------------
  const cwd = path.join(home, "proj");
  fs.mkdirSync(cwd, { recursive: true });
  saveSettings({ ...user, settingsScope: "project" }, "user");
  const projFile = projectConfigFile(cwd);
  fs.mkdirSync(path.dirname(projFile), { recursive: true });
  fs.writeFileSync(projFile, JSON.stringify({ fieldnotes: true, timeout: 30 }));
  const merged = loadSettings(cwd);
  assert.equal(merged.fieldnotes, true, "project delta overrides the user fieldnotes value");
  assert.equal(merged.timeout, 30, "project delta overrides the user timeout value");
  assert.equal(merged.emojiSheep, false, "untouched fields keep the user value (not the default)");
  assert.equal(merged.settingsScope, "project", "effective scope stays the user layer's scope");
  assert.equal(loadSettings().fieldnotes, false, "no cwd: pure user layer");

  // --- delta-only writes (never settingsScope, only fields that differ) ----
  let result = saveSettings({ ...merged, keepOpen: false }, "project", cwd);
  assert.equal(result.created, false, "existing project file: created stays false");
  const rawDelta = JSON.parse(fs.readFileSync(projFile, "utf8"));
  assert.deepEqual(
    rawDelta,
    { fieldnotes: true, timeout: 30, keepOpen: false },
    "project file contains only the user-differing fields"
  );
  assert.ok(!("settingsScope" in rawDelta), "settingsScope is never written to the project file");

  result = saveSettings({ ...user, settingsScope: "project" }, "project", cwd);
  assert.deepEqual(JSON.parse(fs.readFileSync(projFile, "utf8")), {}, "nothing differs -> project file is {}");

  // --- scope switch onto a fresh project dir creates an empty delta --------
  const freshCwd = path.join(home, "fresh");
  fs.mkdirSync(freshCwd, { recursive: true });
  result = saveSettings({ ...user, settingsScope: "project" }, "project", freshCwd);
  assert.ok(result.created, "missing project file: created flag is set");
  assert.ok(fs.existsSync(projectConfigFile(freshCwd)), "project file exists after scope switch");
  assert.deepEqual(JSON.parse(fs.readFileSync(projectConfigFile(freshCwd), "utf8")), {}, "first project file is an empty delta when menu state equals the user layer");
  assert.equal(loadSettings(freshCwd).keepOpen, DEFAULT_SETTINGS.keepOpen, "empty delta: pure user values");

  // switching scope back to user leaves the project delta in place
  saveSettings({ ...DEFAULT_SETTINGS, settingsScope: "user" }, "user");
  assert.equal(loadSettings(freshCwd).settingsScope, "user", "user file owns the scope pointer");

  // --- settingsScope in a project file is ignored --------------------------
  saveSettings({ ...DEFAULT_SETTINGS, settingsScope: "project" }, "user");
  fs.writeFileSync(projFile, JSON.stringify({ settingsScope: "user", timeout: 5 }));
  const ignored = loadSettings(cwd);
  assert.equal(ignored.settingsScope, "project", "project file cannot select its own scope");
  assert.equal(ignored.timeout, 5, "other project fields still apply");

  // --- unreadable / malformed project files fall back to the user layer ----
  fs.writeFileSync(projFile, "not json");
  assert.equal(loadSettings(cwd).timeout, DEFAULT_SETTINGS.timeout, "malformed project file -> user layer");

  // --- fieldnotes session snapshot honors the merged (project) value -------
  fs.writeFileSync(projFile, JSON.stringify({ fieldnotes: false }));
  initializeSessionSettings(cwd);
  assert.equal(fieldnotesEnabled(), false, "new session snapshots the project-overridden fieldnotes value");
  fs.rmSync(projFile);
  initializeSessionSettings(cwd);
  assert.equal(fieldnotesEnabled(), true, "snapshot without project file uses the user value");

  // --- migration: legacy settings.json -> config.json ----------------------
  fs.rmSync(legacyFile, { force: true });
  fs.rmSync(userConfigFile(), { force: true });
  fs.writeFileSync(legacyFile, JSON.stringify({ agentScope: "both", timeout: 25 }));
  assert.equal(loadSettings().agentScope, "both", "legacy file is migrated, values intact");
  assert.equal(loadSettings().timeout, 25, "legacy timeout survives migration");
  assert.ok(fs.existsSync(userConfigFile()), "config.json exists after migration");
  assert.ok(!fs.existsSync(legacyFile), "legacy settings.json is gone after migration");

  // both exist -> config.json wins and the legacy file is left in place
  fs.writeFileSync(userConfigFile(), JSON.stringify({ timeout: 7 }));
  fs.writeFileSync(legacyFile, JSON.stringify({ timeout: 99 }));
  assert.equal(loadSettings().timeout, 7, "both files exist: config.json wins");
  assert.ok(fs.existsSync(legacyFile), "both files exist: legacy file untouched");
  fs.rmSync(legacyFile, { force: true });

  console.log("All settings assertions passed.");
} finally {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  fs.rmSync(home, { recursive: true, force: true });
}
