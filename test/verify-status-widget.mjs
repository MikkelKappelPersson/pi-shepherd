#!/usr/bin/env node
/**
 * Status widget render-path regression + Phase 9 task awareness.
 *
 * Reproduces the historical crash: the "below the editor" subagent widget's
 * render closure referenced `shepherdCommandCwd`, a local of the export
 * default body — invisible from inside registerSubagentStatusWidget(). The
 * ReferenceError surfaced only once a live working agent made the snapshot
 * non-empty and pi measured/rendered the widget.
 *
 * The probe drives the real render path: a sandboxed agent dir
 * (PI_CODING_AGENT_DIR) + a fake `herdr` CLI serve this session's own panes
 * plus a foreign working agent owned by another shepherd session, which the
 * widget must filter out. HERDR_ENV=1 forces Herdr availability so
 * workingOrWaitingSubagents() -> listHerdrAgents() -> shim.
 *
 * Phase 9 adds task awareness to the projection:
 *  - an IDLE process that owns a WAITING task is still shown (the child is
 *    parked on a required reply, not done) — rendered as "waiting (stale)"
 *    with the elapsed-wait and pending-recipient markers;
 *  - a working process with a RUNNING task is shown with the task state;
 *  - once the waiting task completes, the idle pane drops out of the widget.
 *
 * Phase 1: render right after session_start (default emojiSheep=true → 🐑).
 * Phase 2: session_start re-fired with a second cwd that has
 * `.shepherd/config.json` with emojiSheep=false → the sheep glyph switches to
 * the plain "o".
 * Phase 3: the waiting task is settled completed → the idle pane is gone.
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
// per-project emojiSheep.
writeFileSync(
	path.join(agentDir, "pi-shepherd", "config.json"),
	JSON.stringify({ settingsScope: "project" }, null, 2),
);

// Project layer for the second session cwd: emojiSheep=false is observable in
// the rendered rows (the walking sheep glyph switches from 🐑 to "o").
writeFileSync(path.join(otherCwd, ".shepherd", "config.json"), JSON.stringify({ emojiSheep: false }, null, 2));

// Sandboxed created-panes registry: three of this probe session's panes —
// PANE_ID (working process, no task), PANE_ID_TASK (working process with a
// running task), PANE_ID_WAIT (idle process with a waiting, stale task) —
// plus a foreign pane owned by another shepherd session, which the widget
// must filter out.
const PANE_ID = "test-pane-1";
const PANE_ID_TASK = "test-pane-task";
const PANE_ID_WAIT = "test-pane-wait";
const FOREIGN_PANE_ID = "test-pane-foreign"; // owned by another shepherd session
const PROBE_SESSION = "widget-probe-session";
writeFileSync(
	path.join(agentDir, "pi-shepherd", "created-panes.json"),
	JSON.stringify(
		[
			{ paneId: PANE_ID, tabId: "test-tab-1", name: "worker", cwd: otherCwd, createdAt: Date.now(), ownerSession: PROBE_SESSION },
			{ paneId: PANE_ID_TASK, tabId: "test-tab-task", name: "planner", cwd: otherCwd, createdAt: Date.now(), ownerSession: PROBE_SESSION },
			{ paneId: PANE_ID_WAIT, tabId: "test-tab-wait", name: "scout", cwd: otherCwd, createdAt: Date.now(), ownerSession: PROBE_SESSION },
		],
		null,
		2,
	),
);

// Fake herdr CLI: satisfies isHerdrCliPresent (`herdr --version`) and serves
// the agent list (`herdr agent list`) with the three owned panes (two working,
// one idle) plus the foreign working pane owned by another session.
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
				pane_id: PANE_ID_TASK,
				tab_id: "test-tab-task",
				workspace_id: "test-ws-1",
				foreground_cwd: otherCwd,
				focused: false,
				terminal_title: "pi",
			},
			{
				agent: "pi",
				agent_status: "idle",
				pane_id: PANE_ID_WAIT,
				tab_id: "test-tab-wait",
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
    registerMessageRenderer() {},
    on(event, handler) { calls.events.push({ event, handler }); },
  };
  const mod = await import(${JSON.stringify(indexUrl)});
  mod.default(pi);

  // Seed the global lifecycle registry with the two tasks the fake Herdr
  // panes will own. sessionOwner() picks up PI_SHEPHERD_OWNER_SESSION (set in
  // runProbe), so activeTasksByPane()/workingOrWaitingSubagents() scope to
  // exactly these panes, and the foreign pane stays excluded.
  const { lifecycleRegistry } = await import(${JSON.stringify(pathToFileURL(path.join(root, "src/core/orchestration.ts")).href)});
  const taskAgent = lifecycleRegistry.registerAgent({ agent: "planner", label: "worker-2", paneId: ${JSON.stringify(PANE_ID_TASK)} });
  const waitingAgent = lifecycleRegistry.registerAgent({ agent: "scout", label: "stale-scout", paneId: ${JSON.stringify(PANE_ID_WAIT)} });
  const runningTask = lifecycleRegistry.createTask(taskAgent, "Draft the rollout plan.");
  lifecycleRegistry.setTaskRunning(runningTask.id);
  const waitingTask = lifecycleRegistry.createTask(waitingAgent, "Chase the missing retry backoff.");
  lifecycleRegistry.setTaskRunning(waitingTask.id);
  lifecycleRegistry.openPendingRequest(waitingTask.id, {
    messageId: "msg-pending-1",
    targetAgentId: taskAgent.id,
    text: "What is the retry backoff?",
  });
  lifecycleRegistry.markStaleNotified(waitingTask);

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
    const lines = w.render(140);
    w.dispose();
    return lines;
  }
  const phase1 = renderOnce();
  driveSessionStart(${JSON.stringify(otherCwd)});
  const phase2 = renderOnce();
  // The waiting task completes: the idle pane must drop out of the widget.
  lifecycleRegistry.settleTask(waitingTask, { status: "completed", ok: true, text: "got the backoff" });
  const phase3 = renderOnce();
  console.log("PHASE1 " + JSON.stringify(phase1));
  console.log("PHASE2 " + JSON.stringify(phase2));
  console.log("PHASE3 " + JSON.stringify(phase3));
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
	// This probe session's identity; the registered panes carry the same owner
	// so they are included, while the foreign pane must be filtered out.
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
const phase3 = parsePhase("PHASE3");
// The box frames use truecolor ANSI, so compare structure on stripped text.
const stripAnsi = (s) => s.replace(/\u001b\[[0-9;]*m/g, "");
const p1 = phase1.map(stripAnsi);
const p2 = phase2.map(stripAnsi);
const p3 = phase3.map(stripAnsi);

// The crash regression: render must produce the bordered box, not throw.
assert.ok(Array.isArray(p1) && p1.length === 5, "render returns top border, three agent rows, bottom border");
assert.match(p1[0], /shepherd/, "top border shows the title");
assert.match(p1[0], /2 working/, "top border counts the working processes");
assert.match(p1[0], /1 waiting/, "top border counts the waiting tasks");
assert.match(p1.at(-1), /╰─+╯/, "bottom border present");

// Row 1: plain working process (no task).
const rowWorker = p1[1];
assert.match(rowWorker, /worker/, "row names the recorded agent kind");
assert.match(rowWorker, /working/, "working process shows the working state");
assert.ok(!rowWorker.includes("⏳"), "no wait marker on a plain working process");

// Row 2: working process with a running task — the task state is projected.
const rowTask = p1[2];
assert.match(rowTask, /planner/, "row names the recorded agent kind");
assert.match(rowTask, /running/, "working process with a running task shows the running task state");

// Row 3: IDLE process with a WAITING, STALE task — still visible, rendered
// distinctly with the elapsed wait and the waiting-on recipient.
const rowWait = p1[3];
assert.match(rowWait, /\bscout\b/, "idle process owning a waiting task is still shown (agent kind)");
assert.match(rowWait, /waiting\s*\(stale\)/, "stale waiting task renders distinctly");
assert.ok(rowWait.includes("⏳"), "waiting row surfaces the elapsed wait");
assert.ok(rowWait.includes("←"), "waiting row surfaces the waiting-on recipient");

// Every row fits the viewport width (visible width), across all phases.
for (const line of [...p1, ...p2, ...p3]) {
	const w = visibleWidth(line);
	assert.ok(w <= 140, `row fits the viewport width (visible width ${w} for ${JSON.stringify(line)})`);
}

// Session scoping: the foreign pane (registered by another shepherd session)
// is detected by Herdr but must not appear in this session's widget.
for (const line of [...p1, ...p2]) {
	assert.ok(!line.includes(FOREIGN_PANE_ID), "foreign-session pane never appears in this widget");
}
assert.equal(p1.length, 5, "exactly three rows: foreign sheep filtered out");

// Parent/child (session) separation: the widget content never leaks raw pane
// ids or opaque task ids — public views only.
for (const line of [...p1, ...p2]) {
	assert.ok(!line.includes("test-pane-"), "raw Herdr pane ids stay internal");
	assert.ok(!line.includes("shepherd-task-"), "opaque task ids are not painted into rows");
}

// emojiSheep is read from the active session cwd at render time.
assert.ok(rowWorker.includes("🐑"), "phase 1 renders the emoji sheep (default emojiSheep=true)");
assert.ok(!p2.some((line) => line.includes("🐑")), "phase 2 no longer renders the emoji sheep after the session cwd changes");
assert.match(p2[1], /\bo\b/, "phase 2 renders the plain walking glyph on the working row");
assert.equal(p2.length, 5, "phase 2 still renders the full box");

// Completed-task removal: settling the waiting task (completed) clears the
// active task; the idle pane then drops out because it is idle with no task.
assert.equal(p3.length, 4, "phase 3: waiting row disappears after the task completes");
assert.ok(p3.every((line) => !line.includes("⏳") && !line.includes("stale")), "no wait/stale markers remain");
assert.match(p3[0], /2 working/, "phase 3 header counts only the two working processes");
assert.ok(p3.every((line) => !line.includes("stale-scout")), "completed waiting task's idle pane is removed");

console.log("PASS widget render survives a non-empty snapshot (no out-of-scope ReferenceError)");
console.log("PASS widget honors the active session cwd after session_start");
console.log("PASS widget shows only the sheep owned by this shepherd session");
console.log("PASS idle process with a waiting task stays visible (distinct from working)");
console.log("PASS stale waiting task renders distinctly with recipient and elapsed wait");
console.log("PASS working process with a running task projects the task state");
console.log("PASS completed waiting task drops the idle pane from the widget");
console.log("All status widget assertions passed.");
