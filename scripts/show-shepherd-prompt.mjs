#!/usr/bin/env node
/**
 * Print the exact system-prompt body pi-shepherd passes for a discovered agent.
 *
 * Usage:
 *   node --experimental-strip-types scripts/show-shepherd-prompt.mjs scout
 *   node --experimental-strip-types scripts/show-shepherd-prompt.mjs scout --scope both --cwd /path/to/project
 *   node --experimental-strip-types scripts/show-shepherd-prompt.mjs scout --raw
 *
 * This shows Shepherd's contribution only. Pi's built-in prompt and project
 * context files (AGENTS.md / CLAUDE.md) are assembled separately by pi.
 */

import process from "node:process";
import { resolve } from "node:path";
import { discoverAgents } from "../src/core/discovery.ts";

function usage() {
	console.error(`Usage: show-shepherd-prompt <agent> [options]

Options:
  --cwd <path>       Cwd used for agent discovery (default: current directory)
  --scope <scope>    user, project, or both (default: user)
  --omit             Force replacement mode (--system-prompt)
  --append           Force append mode (--append-system-prompt)
  --raw              Print only the agent prompt body
  --help             Show this help
`);
	process.exit(2);
}

const args = process.argv.slice(2);
let agentName;
let cwd = process.cwd();
let scope = "user";
let omit;
let raw = false;

for (let i = 0; i < args.length; i++) {
	const arg = args[i];
	if (arg === "--help" || arg === "-h") usage();
	if (arg === "--raw") {
		raw = true;
		continue;
	}
	if (arg === "--omit" || arg === "--append") {
		if (omit !== undefined) usage();
		omit = arg === "--omit";
		continue;
	}
	if (arg === "--cwd") {
		cwd = args[++i];
		if (!cwd) usage();
		continue;
	}
	if (arg === "--scope") {
		scope = args[++i];
		if (!scope) usage();
		continue;
	}
	if (arg.startsWith("--")) usage();
	if (agentName) usage();
	agentName = arg;
}

if (!agentName || !["user", "project", "both"].includes(scope)) usage();
cwd = resolve(cwd);

const { agents, projectDirs } = discoverAgents(cwd, scope);
const agent = agents.find((candidate) => candidate.name === agentName);
if (!agent) {
	console.error(`Agent not found: ${agentName}`);
	console.error(`Available agents: ${agents.map((candidate) => candidate.name).join(", ") || "none"}`);
	if (projectDirs.length > 0) console.error(`Project agent dirs: ${projectDirs.join(", ")}`);
	process.exit(1);
}

if (raw) {
	process.stdout.write(agent.systemPrompt);
	if (!agent.systemPrompt.endsWith("\n")) process.stdout.write("\n");
	process.exit(0);
}

const effectiveOmit = omit ?? agent.omitSystemPrompt ?? false;
const mode = effectiveOmit ? "replacement (--system-prompt)" : "append (--append-system-prompt)";
console.log(`Agent: ${agent.name}`);
console.log(`Source: ${agent.source}`);
console.log(`Definition: ${agent.filePath}`);
console.log(`Discovery cwd: ${cwd}`);
console.log(`Scope: ${scope}`);
console.log(`Launch mode: ${mode}`);
console.log("\n=== Shepherd system-prompt contribution ===\n");
process.stdout.write(agent.systemPrompt);
if (!agent.systemPrompt.endsWith("\n")) process.stdout.write("\n");
