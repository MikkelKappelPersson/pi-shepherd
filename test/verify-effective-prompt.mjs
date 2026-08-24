#!/usr/bin/env node
/**
 * End-to-end verification of Pi context-file loading for discovered agents.
 *
 * The extractor aborts from before_agent_start, before making a provider
 * request. A dummy Anthropic key is enough to let Pi initialize while keeping
 * this test network-free.
 */
import * as fs from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const project = path.join(root, "test", "fixtures", "context-project");
const script = path.join(root, "scripts", "extract-pi-system-prompt.mjs");
const marker = "UNIQUE_CONTEXT_FIXTURE_MARKER_7f3d2c9a";
const failures = [];

if (spawnSync("pi", ["--version"], { stdio: "ignore" }).status === null) {
  console.log("SKIP  effective prompt integration: pi is not available");
  process.exit(0);
}

const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-shepherd-effective-prompt-"));
try {
  const agentsDir = path.join(agentDir, "agents");
  fs.mkdirSync(agentsDir, { recursive: true });
  fs.writeFileSync(
    path.join(agentsDir, "context-enabled.md"),
    "---\nname: context-enabled\ndescription: Receives project context\n---\nUNIQUE_AGENT_BODY_ENABLED_1a2b3c4d\n",
  );
  fs.writeFileSync(
    path.join(agentsDir, "context-disabled.md"),
    "---\nname: context-disabled\ndescription: Omits project context\nomitContextFiles: true\n---\nUNIQUE_AGENT_BODY_DISABLED_5e6f7a8b\n",
  );

  function extract(agent) {
    const output = execFileSync(
      process.execPath,
      [
        "--experimental-strip-types",
        "--disable-warning=ExperimentalWarning",
        script,
        "sheep",
        agent,
        "--scope",
        "user",
        "--cwd",
        project,
        "--model",
        "anthropic/claude-sonnet-4-5",
        "--json",
      ],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: agentDir,
          PI_CODING_AGENT_DIR: agentDir,
          ANTHROPIC_API_KEY: "dummy",
        },
      },
    );
    return JSON.parse(output);
  }

  const enabled = extract("context-enabled");
  const disabled = extract("context-disabled");
  const enabledPrompt = enabled.systemPrompt ?? "";
  const disabledPrompt = disabled.systemPrompt ?? "";

  if (!enabledPrompt.includes(marker)) failures.push("enabled agent receives AGENTS.md context");
  if (disabledPrompt.includes(marker)) failures.push("disabled agent omits AGENTS.md context");
  if (!enabledPrompt.includes("UNIQUE_AGENT_BODY_ENABLED_1a2b3c4d")) failures.push("enabled agent body remains present");
  if (!disabledPrompt.includes("UNIQUE_AGENT_BODY_DISABLED_5e6f7a8b")) failures.push("disabled agent body remains present");
  if (enabled.cwd !== project || disabled.cwd !== project) failures.push("child cwd remains the requested project");

  for (const label of [
    "enabled agent receives AGENTS.md context",
    "disabled agent omits AGENTS.md context",
    "enabled agent body remains present",
    "disabled agent body remains present",
    "child cwd remains the requested project",
  ]) {
    console.log(`${failures.includes(label) ? "FAIL" : "PASS"}  ${label}`);
  }
} finally {
  fs.rmSync(agentDir, { recursive: true, force: true });
}

if (failures.length > 0) process.exit(1);
console.log("All effective prompt assertions passed.");
