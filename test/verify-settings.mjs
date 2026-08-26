#!/usr/bin/env node
/** Filesystem-only verification for persisted Shepherd settings. */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-shepherd-settings-"));
const previousHome = process.env.HOME;
process.env.HOME = home;

try {
  const mod = await import(`../src/extension/settings.ts?settings-test=${Date.now()}`);
  const {
    DEFAULT_SETTINGS,
    fieldnotesEnabled,
    initializeSessionSettings,
    loadSettings,
    saveSettings,
    settingsFile,
  } = mod;

  assert.equal(DEFAULT_SETTINGS.fieldnotes, true);
  assert.equal(loadSettings().fieldnotes, true, "missing fieldnotes setting defaults on");
  assert.equal(DEFAULT_SETTINGS.emojiSheep, true);
  assert.equal(loadSettings().emojiSheep, true, "missing emoji sheep setting defaults on");

  saveSettings({ ...DEFAULT_SETTINGS, fieldnotes: false, emojiSheep: false });
  assert.equal(loadSettings().fieldnotes, false, "disabled fieldnotes setting persists");
  assert.equal(loadSettings().emojiSheep, false, "disabled emoji sheep setting persists");
  initializeSessionSettings();
  assert.equal(fieldnotesEnabled(), false, "new session snapshots disabled fieldnotes");

  // Settings changes remain persisted but do not alter the active session.
  saveSettings({ ...DEFAULT_SETTINGS, fieldnotes: true, emojiSheep: true });
  assert.equal(loadSettings().fieldnotes, true);
  assert.equal(loadSettings().emojiSheep, true);
  assert.equal(fieldnotesEnabled(), false, "active session keeps its fieldnotes mode");

  // A subsequent parent session picks up the newly persisted value.
  initializeSessionSettings();
  assert.equal(fieldnotesEnabled(), true, "new session picks up enabled fieldnotes");

  const raw = JSON.parse(fs.readFileSync(settingsFile(), "utf8"));
  assert.equal(raw.fieldnotes, true);
} finally {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  fs.rmSync(home, { recursive: true, force: true });
}

console.log("All settings assertions passed.");
