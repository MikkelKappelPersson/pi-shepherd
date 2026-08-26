#!/usr/bin/env node
/**
 * Parent/worker registration boundary.
 *
 * Launched workers inherit the user extension set, but herdr.ts explicitly
 * injects shepherd-done.ts as their worker-side Shepherd surface. The parent
 * control plane must not also be registered in those sessions.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const indexUrl = pathToFileURL(path.join(root, "index.ts")).href;
const probe = `
  const calls = { tools: [], toolDetails: {}, commands: [], events: [] };
  const pi = {
    registerTool(tool) {
      calls.tools.push(tool.name);
      calls.toolDetails[tool.name] = {
        description: tool.description,
        promptGuidelines: tool.promptGuidelines,
      };
    },
    registerCommand(name) { calls.commands.push(name); },
    on(event) { calls.events.push(event); },
  };
  const mod = await import(${JSON.stringify(indexUrl)});
  mod.default(pi);
  console.log(JSON.stringify(calls));
`;

function run(worker) {
  const env = { ...process.env };
  if (worker) env.PI_SHEPHERD_SESSION = "/tmp/pi-shepherd-worker-session.jsonl";
  else delete env.PI_SHEPHERD_SESSION;
  const result = spawnSync(
    process.execPath,
    ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", "--input-type=module", "--eval", probe],
    { cwd: root, env, encoding: "utf8" },
  );
  assert.equal(result.status, 0, `${worker ? "worker" : "parent"} probe failed: ${result.stderr}`);
  const line = result.stdout.trim().split("\n").at(-1);
  return JSON.parse(line);
}

const parent = run(false);
const worker = run(true);

assert.equal(parent.tools.length, 7, "parent registers the umbrella and six lifecycle tools");
assert.ok(parent.tools.includes("shepherd"), "parent registers the umbrella shepherd tool");
assert.ok(parent.commands.includes("shepherd"), "parent registers the /shepherd command");
const umbrella = parent.toolDetails.shepherd;
assert.ok(umbrella.description.includes("shepherd_spawn"), "umbrella description names the lifecycle tools");
const guidance = umbrella.promptGuidelines.join(" ");
assert.ok(guidance.includes("shepherd_wait"), "umbrella guidance explains the lifecycle workflow");
assert.ok(guidance.includes("Waiting does not close"), "umbrella guidance explains close semantics");
assert.ok(guidance.includes("shepherd.md"), "umbrella guidance explains fieldnotes");
assert.equal(worker.tools.length, 0, "worker does not register parent Shepherd tools");
assert.equal(worker.commands.length, 0, "worker does not register parent Shepherd commands");

console.log("PASS parent registers the Shepherd control plane");
console.log("PASS launched worker excludes parent Shepherd tools and commands");
console.log("All parent-surface assertions passed.");
