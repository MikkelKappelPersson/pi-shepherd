#!/usr/bin/env node
/** Focused verification for /shepherd completions and command guardrails. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Isolate persisted settings and fieldnotes from the developer's real session.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-shepherd-command-ux-"));
process.env.HOME = home;

// Keep this command-surface test independent of a developer's Herdr install.
// The command handler only needs Herdr availability to reach the error path
// being tested; no actual Herdr operation should be performed here.
const fakeBinDir = path.join(home, "bin");
fs.mkdirSync(fakeBinDir, { recursive: true });
const fakeHerdr = path.join(fakeBinDir, "herdr");
fs.writeFileSync(fakeHerdr, "#!/bin/sh\n[ \"$1\" = \"--version\" ] && echo herdr-test\n");
fs.chmodSync(fakeHerdr, 0o755);
process.env.PATH = `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`;
process.env.HERDR_ENV = "1";

const settingsDir = path.join(home, ".pi", "agent", "pi-shepherd");
fs.mkdirSync(settingsDir, { recursive: true });
fs.writeFileSync(path.join(settingsDir, "config.json"), JSON.stringify({
  agentScope: "both",
  confirmProjectAgents: false,
  fieldnotes: false,
  timeout: 20,
}));

const commands = new Map();
const events = [];
const pi = {
  registerTool() {},
  registerCommand(name, spec) { commands.set(name, spec); },
  on(event) { events.push(event); },
};
const { default: extension } = await import("../index.ts");
extension(pi);
const command = commands.get("shepherd");
assert.ok(command, "shepherd command registered");
const complete = (prefix) => command.getArgumentCompletions(prefix);

assert.ok((complete("spa") ?? []).some((item) => item.value === "spawn planner"), "partial spawn completion expands to agent entries");
assert.ok((complete("spawn ") ?? []).some((item) => item.value === "spawn planner"), "spawn completion includes discovered agent");
assert.ok((complete("sta") ?? []).some((item) => item.value === "status planner"), "status completion includes discovered agent");
assert.ok((complete("read ") ?? []).some((item) => item.value === "read planner"), "read completion includes discovered agent");

const notifications = [];
const statuses = [];
const ctx = {
  cwd: path.resolve("."),
  ui: {
    notify(message, level) { notifications.push({ message, level }); },
    setStatus(_key, value) { statuses.push(value); },
  },
  sessionManager: { getSessionId: () => "phase7-command", getSessionFile: () => undefined },
};

await command.handler("spawn", ctx);
assert.equal(notifications.at(-1).level, "warning");
assert.match(notifications.at(-1).message, /Usage/);
await command.handler("status", ctx);
assert.equal(notifications.at(-1).level, "warning");
assert.match(notifications.at(-1).message, /Usage/);

// A valid but unknown spawn reaches the long-running status guard, then clears
// it even when doAction fails before creating a pane.
await command.handler("spawn definitely-not-an-agent", ctx);
assert.deepEqual(statuses.slice(-2), ["Starting definitely-not-an-agent…", undefined]);
assert.equal(notifications.at(-1).level, "error");
assert.match(notifications.at(-1).message, /Unknown agent/);

console.log("PASS command completions, usage hints, and spawn status cleanup");
console.log("All command UX assertions passed.");
