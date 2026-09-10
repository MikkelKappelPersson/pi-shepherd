#!/usr/bin/env node
/**
 * Filesystem-only verification for per-workspace Shepherd settings:
 * user values in ~/.pi/agent/pi-shepherd/config.json and a self-contained
 * .shepherd/config.json activated by projectScope: true.
 */
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-shepherd-settings-'));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = path.join(home, '.pi', 'agent');

try {
  const mod = await import(`../src/extension/config.ts?settings-test=${Date.now()}`);
  const {
    DEFAULT_SETTINGS,
    deactivateProjectScope,
    fieldnotesEnabled,
    initializeSessionSettings,
    loadProjectFileValues,
    loadSettings,
    projectConfigFile,
    saveSettings,
    userConfigFile,
  } = mod;
  const legacyFile = path.join(path.dirname(userConfigFile()), 'settings.json');

  assert.equal(
    userConfigFile(),
    path.join(home, '.pi', 'agent', 'pi-shepherd', 'config.json'),
    'user config path honors PI_CODING_AGENT_DIR'
  );
  assert.equal(DEFAULT_SETTINGS.projectScope, false, 'default project scope is inactive');
  assert.equal(DEFAULT_SETTINGS.confirmProjectAgents, true, 'confirmation defaults on');
  assert.equal(loadSettings().fieldnotes, true, 'missing fieldnotes defaults on');
  assert.equal(loadSettings().emojiSheep, true, 'missing sheep marker defaults on');

  // --- user layer persistence: values only -------------------------------
  const user = {
    ...DEFAULT_SETTINGS,
    fieldnotes: false,
    emojiSheep: false,
    confirmProjectAgents: false,
    timeout: 25,
  };
  saveSettings(user, 'user');
  const rawUser = JSON.parse(fs.readFileSync(userConfigFile(), 'utf8'));
  assert.ok(!('projectScope' in rawUser), 'user file does not store projectScope');
  assert.ok(!('settingsScope' in rawUser), 'user file does not store settingsScope');
  assert.equal(rawUser.confirmProjectAgents, false, 'user file stores the security setting');
  assert.equal(loadSettings().fieldnotes, false, 'user fieldnotes persists');
  assert.equal(loadSettings().emojiSheep, false, 'user sheep marker persists');
  assert.equal(loadSettings().timeout, 25, 'user timeout persists');
  saveSettings({ ...user, timeout: 1_000 }, 'user');
  assert.equal(loadSettings().timeout, 1, 'short legacy millisecond timeout clamps to one minute');
  saveSettings(user, 'user');

  // --- user scope keys are ignored and stripped on save ------------------
  const noiseCwd = path.join(home, 'noise');
  fs.mkdirSync(noiseCwd, { recursive: true });
  fs.writeFileSync(
    userConfigFile(),
    JSON.stringify({ settingsScope: 'project', projectScope: true, timeout: 11 })
  );
  assert.equal(
    loadSettings(noiseCwd).projectScope,
    false,
    'user scope keys cannot activate a project'
  );
  assert.equal(loadSettings(noiseCwd).timeout, 11, 'user value still applies');
  saveSettings({ ...DEFAULT_SETTINGS, timeout: 11 }, 'user');
  const cleanedUser = JSON.parse(fs.readFileSync(userConfigFile(), 'utf8'));
  assert.ok(!('settingsScope' in cleanedUser), 'user save strips legacy settingsScope');
  assert.ok(!('projectScope' in cleanedUser), 'user save strips stray projectScope');

  // Restore a deliberate user layer for project-resolution assertions.
  saveSettings(user, 'user');
  const cwd = path.join(home, 'project');
  const otherCwd = path.join(home, 'other');
  const freshCwd = path.join(home, 'fresh');
  for (const dir of [cwd, otherCwd, freshCwd]) fs.mkdirSync(dir, { recursive: true });
  const projectFile = projectConfigFile(cwd);

  assert.equal(loadSettings(cwd).projectScope, false, 'no project file uses user scope');
  assert.equal(loadSettings(cwd).timeout, 25, 'no project file uses user timeout');
  assert.equal(
    loadSettings(cwd).confirmProjectAgents,
    false,
    'no project file uses user confirmation'
  );

  // --- dormant project files never override user values ------------------
  fs.mkdirSync(path.dirname(projectFile), { recursive: true });
  fs.writeFileSync(
    projectFile,
    JSON.stringify({
      projectScope: false,
      timeout: 30,
      fieldnotes: true,
      confirmProjectAgents: true,
    })
  );
  assert.equal(loadSettings(cwd).projectScope, false, 'false flag leaves project dormant');
  assert.equal(loadSettings(cwd).timeout, 25, 'dormant project timeout is ignored');
  assert.equal(loadSettings(cwd).fieldnotes, false, 'dormant project fieldnotes are ignored');
  assert.equal(loadSettings(cwd).confirmProjectAgents, false, 'project cannot own confirmation');

  fs.writeFileSync(projectFile, JSON.stringify({ timeout: 30 }));
  assert.equal(loadSettings(cwd).projectScope, false, 'keyless project file is dormant');
  assert.equal(loadSettings(cwd).timeout, 25, 'keyless project values are dormant');

  fs.writeFileSync(projectFile, JSON.stringify({ projectScope: 'yes', timeout: 30 }));
  assert.equal(loadSettings(cwd).projectScope, false, 'invalid project flag is dormant');
  assert.equal(loadSettings(cwd).timeout, 25, 'invalid project flag does not apply values');

  // --- active project files are self-contained ---------------------------
  fs.writeFileSync(
    projectFile,
    JSON.stringify({
      projectScope: true,
      timeout: 30,
      fieldnotes: true,
      confirmProjectAgents: true,
    })
  );
  const active = loadSettings(cwd);
  assert.equal(active.projectScope, true, 'true flag activates this workspace');
  assert.equal(active.timeout, 30, 'active project timeout applies');
  assert.equal(active.fieldnotes, true, 'active project fieldnotes apply');
  assert.equal(active.emojiSheep, true, 'missing active field falls back to built-in default');
  assert.equal(active.agentScope, 'user', 'missing active agent scope uses built-in default');
  assert.equal(
    active.confirmProjectAgents,
    false,
    'active project cannot override user confirmation'
  );
  assert.equal(loadSettings().projectScope, false, 'no-cwd resolution remains user-scoped');
  assert.equal(loadSettings(otherCwd).projectScope, false, 'another workspace is unaffected');
  assert.equal(loadSettings(otherCwd).timeout, 25, 'another workspace retains user timeout');

  // Legacy project scope is read-only compatible.
  fs.writeFileSync(projectFile, JSON.stringify({ settingsScope: 'project', timeout: 31 }));
  assert.equal(loadSettings(cwd).projectScope, true, 'legacy project settingsScope activates');
  assert.equal(loadSettings(cwd).timeout, 31, 'legacy project values apply');
  fs.writeFileSync(projectFile, JSON.stringify({ settingsScope: 'user', timeout: 31 }));
  assert.equal(loadSettings(cwd).projectScope, false, 'legacy user scope does not activate');

  // Malformed and non-object project files fall back to the user layer.
  fs.writeFileSync(projectFile, 'not json');
  assert.equal(loadSettings(cwd).projectScope, false, 'malformed project file is inactive');
  assert.equal(loadSettings(cwd).timeout, 25, 'malformed project file uses user values');
  fs.writeFileSync(projectFile, JSON.stringify([]));
  assert.equal(loadSettings(cwd).projectScope, false, 'array project file is inactive');

  // --- full project writes and fresh creation ----------------------------
  let result = saveSettings(
    { ...DEFAULT_SETTINGS, projectScope: true, timeout: 42, confirmProjectAgents: false },
    'project',
    cwd
  );
  assert.equal(result.created, false, 'existing project file reports created=false');
  const rawProject = JSON.parse(fs.readFileSync(projectFile, 'utf8'));
  assert.equal(rawProject.projectScope, true, 'project save writes the activation flag');
  assert.equal(rawProject.timeout, 42, 'project save writes project values');
  assert.ok(!('confirmProjectAgents' in rawProject), 'project save omits user-only confirmation');
  assert.equal(loadSettings(cwd).timeout, 42, 'saved project value applies');

  result = saveSettings(
    { ...DEFAULT_SETTINGS, projectScope: true, timeout: 30 },
    'project',
    freshCwd
  );
  assert.equal(result.created, true, 'fresh project file reports created=true');
  assert.equal(JSON.parse(fs.readFileSync(projectConfigFile(freshCwd), 'utf8')).projectScope, true);
  assert.equal(loadSettings(freshCwd).timeout, 30, 'fresh project activates independently');
  assert.equal(loadSettings(cwd).timeout, 42, 'fresh project does not alter another workspace');

  // --- parked values and deactivation -----------------------------------
  const parked = loadProjectFileValues(cwd);
  assert.equal(parked.timeout, 42, 'parked project timeout is readable');
  assert.equal(
    parked.confirmProjectAgents,
    undefined,
    'parked project values exclude confirmation'
  );
  const deactivated = deactivateProjectScope(cwd);
  assert.equal(deactivated.changed, true, 'active project deactivation reports a change');
  const dormantRaw = JSON.parse(fs.readFileSync(projectFile, 'utf8'));
  assert.equal(dormantRaw.projectScope, false, 'deactivation writes false');
  assert.ok(fs.existsSync(projectFile), 'deactivation does not delete the file');
  assert.equal(loadSettings(cwd).projectScope, false, 'deactivation restores user scope');
  assert.equal(loadSettings(cwd).timeout, 25, 'deactivation restores user values');
  assert.equal(deactivateProjectScope(cwd).changed, false, 'already-false deactivation is a no-op');

  // Keyless and legacy objects normalize safely when explicitly deactivated.
  fs.writeFileSync(projectFile, JSON.stringify({ timeout: 9 }));
  assert.equal(
    deactivateProjectScope(cwd).changed,
    true,
    'keyless object is normalized on deactivation'
  );
  assert.equal(JSON.parse(fs.readFileSync(projectFile, 'utf8')).projectScope, false);
  fs.writeFileSync(projectFile, JSON.stringify({ settingsScope: 'project', timeout: 9 }));
  assert.equal(
    deactivateProjectScope(cwd).changed,
    true,
    'legacy object is normalized on deactivation'
  );
  const normalizedLegacy = JSON.parse(fs.readFileSync(projectFile, 'utf8'));
  assert.equal(normalizedLegacy.projectScope, false);
  assert.ok(!('settingsScope' in normalizedLegacy), 'legacy key is removed on deactivation');
  assert.equal(
    deactivateProjectScope(path.join(home, 'missing')).changed,
    false,
    'missing file deactivation is a no-op'
  );

  // --- fieldnotes session snapshot uses effective workspace settings -------
  saveSettings({ ...user, fieldnotes: false }, 'user');
  fs.writeFileSync(projectFile, JSON.stringify({ projectScope: true, fieldnotes: true }));
  initializeSessionSettings(cwd);
  assert.equal(fieldnotesEnabled(), true, 'active project fieldnotes are snapshotted');
  fs.rmSync(projectFile);
  initializeSessionSettings(cwd);
  assert.equal(fieldnotesEnabled(), false, 'user fieldnotes are snapshotted without project file');

  // --- user settings.json migration remains intact ----------------------
  fs.rmSync(userConfigFile(), { force: true });
  fs.rmSync(legacyFile, { force: true });
  fs.writeFileSync(legacyFile, JSON.stringify({ agentScope: 'both', timeout: 25 }));
  assert.equal(loadSettings().agentScope, 'both', 'legacy user file is migrated');
  assert.equal(loadSettings().timeout, 25, 'legacy timeout survives migration');
  assert.ok(fs.existsSync(userConfigFile()), 'new config file exists after migration');
  assert.ok(!fs.existsSync(legacyFile), 'legacy user file is renamed away');

  fs.writeFileSync(userConfigFile(), JSON.stringify({ timeout: 7 }));
  fs.writeFileSync(legacyFile, JSON.stringify({ timeout: 99 }));
  assert.equal(loadSettings().timeout, 7, 'new config wins when both files exist');
  assert.ok(fs.existsSync(legacyFile), 'legacy file remains when new file exists');

  console.log('All settings assertions passed.');
} finally {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  fs.rmSync(home, { recursive: true, force: true });
}
