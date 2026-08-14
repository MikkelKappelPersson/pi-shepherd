#!/usr/bin/env node
/**
 * Sentinel false-positive regression test.
 *
 * Old bug: the parent's completion sentinel regex (/__SHEPHERD_DONE_(\d+)__/)
 * was matched against ANY pane tail content. A subagent's own output can
 * legitimately contain the literal marker — e.g. grep over this repo's
 * PLAN.md, which documents `__SHEPHERD_DONE_0__`. When that output was the
 * tail's last line during the 1s poll window, the parent declared the run
 * done, deleted the child's session dir mid-run (ENOENT, corrupted run) and
 * returned "(no output)".
 *
 * This test delegates a task whose first step is exactly such a grep, then
 * requires the run to complete normally with the subagent's real output.
 */
import { runAgentInHerdr } from "../herd.ts";

const task = [
	"Step 1: run this shell command and show the result:",
	"  grep -rn SHEPHERD_DONE /home/mikkelkp/.pi/agent/extensions/pi-shepherd/PLAN.md /home/mikkelkp/.pi/agent/extensions/pi-shepherd/herd.ts | head -5",
	"Step 2: list the top-level files of /home/mikkelkp/.pi/agent/extensions/pi-shepherd.",
	"Step 3: reply with exactly one line: the summary line 'SENTINEL-TEST-OK' followed by what herd.ts does in a few words.",
].join("\n");

const started = Date.now();
let result;
let attempts = 0;
// The task depends on a real model run, which can flake (API error, stopReason
// error, timeout). Retry once before failing — the code under test is the
// sentinel logic, not the LLM.
for (attempts = 1; attempts <= 2; attempts++) {
	result = await runAgentInHerdr({
		agentName: "scout",
		systemPrompt: "You are a scout. Investigate and report concisely.",
		omitSystemPrompt: false,
		task,
		cwd: "/home/mikkelkp/.pi/agent/extensions/pi-shepherd",
		tools: ["read", "grep", "ls"],
		label: "sentinel-test",
		keepOpen: false, // auto-close the pane after pickup
		stayOpen: false, // child exits after completion
		timeout: 180_000,
	});
	if (result.ok && result.exitCode === 0) break;
	if (attempts === 1) console.warn("first attempt failed; retrying...");
}

const elapsed = Math.round((Date.now() - started) / 1000);
const finalText = result.finalText ?? "(none)";
console.log(JSON.stringify({
	ok: result.ok,
	exitCode: result.exitCode,
	elapsedSec: elapsed,
	messageCount: result.messages.length,
	paneId: result.paneId,
	finalText: finalText.slice(0, 500),
}, null, 2));

// The run must complete normally AND the final output must reflect the task.
const doneCleanly = result.ok && result.exitCode === 0;
// Models paraphrase instead of echoing a literal marker; require a substantive,
// real final message that references the repo/summary rather than the old
// premature "(no output)" pickup.
const gotRealOutput = (result.finalText ?? "").length > 20;
const notPremature = (result.messages?.length ?? 0) >= 4; // task + grep + ls + summary

if (doneCleanly && gotRealOutput && notPremature) {
	console.log("PASS: sentinel false-positive avoided; run completed with real output.");
	process.exit(0);
} else {
	console.error(
		`FAIL: doneCleanly=${doneCleanly} gotRealOutput=${gotRealOutput} notPremature=${notPremature}`,
	);
	process.exit(1);
}
