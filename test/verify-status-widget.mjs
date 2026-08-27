#!/usr/bin/env node
/**
 * Status widget render-path regression.
 *
 * Reproduces the historical crash: the "below the editor" subagent widget's
 * render closure referenced `shepherdCommandCwd`, a local of the export
 * default body — invisible from inside registerSubagentStatusWidget(). The
 * ReferenceError surfaced only once a live working agent made the snapshot
 * non-empty and pi measured/rendered the widget.
 *
 * The probe drives the real render path: a sandboxed agent dir
 * (PI_CODING_AGENT_DIR) + a fake `herdr` CLI serve one working shepherd
 * agent whose pane is in the created-panes registry (owned by this session)
 * plus a foreign working agent owned by another shepherd session, which the
 * widget must filter out. HERDR_ENV=1 forces Herdr availability so
 * workingSubagents() -> listHerdrAgents() -> shim.
 *
 * Phase 1: render right after session_start (session cwd → project layer
 * missing → default emojiSheep=true → 🐑).
 * Phase 2: session_start re-fired with a second cwd that has
 * `.shepherd/config.json` with emojiSheep=false → the sheep glyph must
 * switch to the plain "o". This proves render reads the *active session*
 * cwd.
 */
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { visibleWidth } from "@earendil-works/pi-tui";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const indexUrl = pathToFileURL(path.join(root, "index.ts")).href;
const sandbox = mkdtempSync(path.join(tmpdir(), "pi-shepherd-widget-"));
const agentDir = path.join(sandbox, "agent");
const homeCwd = path.join(sandbox, "home");
const otherCwd = path.join(sandbox, "other");
for (const dir of [agentDir, path.join(agentDir, "pi-shepherd"), homeCwd, otherCwd, path.join(otherCwd, ".shepherd")]) {
	mkdirSync(dir, { recursive: true });
}

// Sandbox user layer: routes the effective values through the project delta
// (.shepherd/config.json), which is the repo's only way the session cwd picks
// per-project emojiSheep. Without settingsScope=project the project layer is
// ignored by loadSettings and both phases would render the default glyph.
writeFileSync(
	path.join(agentDir, "pi-shepherd", "config.json"),
	JSON.stringify({ settingsScope: "project" }, null, 2),
);

// Project layer for the second session cwd: emojiSheep=false is observable in
// the rendered rows (the walking sheep glyph switches from 🐑 to "o").
writeFileSync(path.join(otherCwd, ".shepherd", "config.json"), JSON.stringify({ emojiSheep: false }, null, 2));

// Sandboxed created-panes registry: one working shepherd agent owned by this
// probe session (the foreign working agent reported by the fake Herdr is not
// registered here, so the widget must not show it).
const PANE_ID = "test-pane-1";
const FOREIGN_PANE_ID = "test-pane-foreign"; // owned by another shepherd session
const PROBE_SESSION = "widget-probe-session";
writeFileSync(
	path.join(agentDir, "pi-shepherd", "created-panes.json"),
	JSON.stringify(
		[{ paneId: PANE_ID, tabId: "test-tab-1", name: "worker", cwd: otherCwd, createdAt: Date.now(), ownerSession: PROBE_SESSION }],
		null,
		2,
	),
);

// Fake herdr CLI: satisfies isHerdrCliPresent (`herdr --version`) and serves
// the agent list (`herdr agent list`) with two working agents: this
// session's own pane plus a foreign pane owned by another shepherd session,
// which the widget must filter out.
const agentListOut = JSON.stringify({
	result: {
		agents: [
			{
				agent: "pi",
				agent_status: "working",
				pane_id: PANE_ID,
				tab_id: "test-tab-1",
				workspace_id: "test-ws-1",
				foreground_cwd: otherCwd,
				focused: false,
				terminal_title: "pi",
			},
			{
				agent: "pi",
				agent_status: "working",
				pane_id: FOREIGN_PANE_ID,
				tab_id: "test-tab-foreign",
				workspace_id: "test-ws-1",
				foreground_cwd: otherCwd,
				focused: false,
				terminal_title: "pi",
			},
		],
	},
});
const binDir = path.join(sandbox, "bin");
mkdirSync(binDir, { recursive: true });
writeFileSync(
	path.join(binDir, "herdr"),
	`#!/bin/sh
case "$1" in
  --version)
    echo "herdr 9.9.9-test"
    exit 0 ;;
  agent)
    if [ "$2" = "list" ]; then
      echo '${agentListOut}'
      exit 0
    fi
    exit 0 ;;
esac
exit 0
`,
);
chmodSync(path.join(binDir, "herdr"), 0o755);

const probe = `
  const calls = { events: [], widgets: [] };
  const pi = {
    registerTool() {},
    registerCommand() {},
    on(event, handler) { calls.events.push({ event, handler }); },
  };
  const mod = await import(${JSON.stringify(indexUrl)});
  mod.default(pi);
  const handlers = calls.events.filter(e => e.event === "session_start");
  const fakeUi = { setWidget(id, factory) { calls.widgets.push({ id, factory }); } };
  const driveSessionStart = (cwd) => {
    for (const { handler } of handlers) handler(null, { hasUI: true, cwd, ui: fakeUi });
  };
  driveSessionStart(${JSON.stringify(homeCwd)});
  const widget = calls.widgets.find(w => w.id === "pi-shepherd-working");
  assert.ok(widget, "status widget is registered on session_start");
  const theme = { fg: (_c, t) => t };
  function renderOnce() {
    const w = widget.factory({ requestRender() {} }, theme);
    const lines = w.render(80);
    w.dispose();
    return lines;
  }
  const phase1 = renderOnce();
  driveSessionStart(${JSON.stringify(otherCwd)});
  const phase2 = renderOnce();
  console.log("PHASE1 " + JSON.stringify(phase1));
  console.log("PHASE2 " + JSON.stringify(phase2));
`;

function runProbe() {
	const env = {
		...process.env,
		PI_CODING_AGENT_DIR: agentDir,
		HERDR_ENV: "1",
		PATH: `${binDir}:${process.env.PATH}`,
	};
	// Deterministic parent (non-worker) surface regardless of the calling env.
	delete env.PI_SHEPHERD_SESSION;
	// This probe session's identity; the registered pane carries the same owner
	// so it is included, while the foreign pane must be filtered out.
	delete env.PI_SHEPHERD_OWNER_SESSION;
	env.PI_SHEPHERD_OWNER_SESSION = PROBE_SESSION;
	return {
		cwd: homeCwd,
		encoding: "utf8",
		env,
	};
}

const result = spawnSync(
	process.execPath,
	["--experimental-strip-types", "--disable-warning=ExperimentalWarning", "--input-type=module", "--eval", probe],
	runProbe(),
);
assert.equal(
	result.status,
	0,
	`widget probe failed:\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
);
const outLines = result.stdout.trim().split("\n");
const parsePhase = (name) => {
	const line = outLines.find((l) => l.startsWith(`${name} `));
	assert.ok(line, `probe did not emit ${name}`);
	return JSON.parse(line.slice(name.length + 1));
};
const phase1 = parsePhase("PHASE1");
const phase2 = parsePhase("PHASE2");
// The box frames use truecolor ANSI, so compare structure on stripped text.
const stripAnsi = (s) => s.replace(/\u001b\[[0-9;]*m/g, "");
const p1 = phase1.map(stripAnsi);
const p2 = phase2.map(stripAnsi);

// The crash regression: render must produce the bordered box, not throw.
assert.ok(Array.isArray(p1) && p1.length === 3, "render returns top border, one agent row, bottom border");
assert.match(p1[0], /shepherd/, "top border shows the title");
assert.match(p1[0], /1 working/, "top border shows the worker count (other sessions' sheep excluded)");
assert.match(p1.at(-1), /╰─+╯/, "bottom border present");
const row1 = p1[1];
assert.match(row1, /worker/, "agent row names the recorded agent kind");
assert.match(row1, /working/, "agent row shows the state");
for (const line of p1) {
	const w = visibleWidth(line);
	assert.ok(w <= 80, `row fits the viewport width (visible width ${w} for ${JSON.stringify(line)})`);
}

// Session scoping: the foreign pane (registered by another shepherd session)
// is detected by Herdr but must not appear in this session's widget.
for (const line of [...p1, ...p2]) {
	assert.ok(!line.includes(FOREIGN_PANE_ID), "foreign-session pane never appears in this widget");
}
assert.equal(p1.length, 3, "exactly one row: foreign sheep filtered out");

// emojiSheep is read from the active session cwd at render time.
assert.ok(row1.includes("🐑"), "phase 1 renders the emoji sheep (default emojiSheep=true)");
const row2 = p2[1];
assert.ok(!row2.includes("🐑"), "phase 2 no longer renders the emoji sheep after the session cwd changes");
assert.match(row2, /\bo\b/, "phase 2 renders the plain walking glyph");
assert.equal(p2.length, 3, "phase 2 still renders the full box");

console.log("PASS widget render survives a non-empty snapshot (no out-of-scope ReferenceError)");
console.log("PASS widget honors the active session cwd after session_start");
console.log("PASS widget shows only the sheep owned by this shepherd session");
console.log("All status widget assertions passed.");
