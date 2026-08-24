#!/usr/bin/env node
/**
 * Boot a diagnostic pi session and extract the fully assembled system prompt.
 *
 * The public pi extension API exposes the final prompt in before_agent_start.
 * This script starts pi with a harmless diagnostic message, captures that
 * prompt before the provider request, and terminates the diagnostic process.
 * No model response (or API request) is needed.
 *
 * Usage:
 *   node --experimental-strip-types scripts/extract-pi-system-prompt.mjs shepherd
 *   node --experimental-strip-types scripts/extract-pi-system-prompt.mjs sheep scout
 *   node --experimental-strip-types scripts/extract-pi-system-prompt.mjs sheep scout --scope both --cwd /path/to/project
 *
 * By default only the requested pi-shepherd extension is loaded explicitly,
 * which makes the result deterministic and avoids loading this extension a
 * second time when the script is run from an installed pi environment.
 */

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

// Piping a large prompt through `head` should be a normal successful use.
process.stdout.on("error", (error) => {
	if (error.code === "EPIPE") process.exit(0);
	throw error;
});

const scriptDir = dirname(fileURLToPath(import.meta.url));
const packageDir = resolve(scriptDir, "..");
const captureExtension = resolve(scriptDir, "capture-system-prompt.mjs");
const resolverExtension = resolve(scriptDir, "resolve-agent.mjs");
const shepherdExtension = resolve(packageDir, "index.ts");
const sheepExtension = resolve(packageDir, "shepherd-done.ts");

function usage(exitCode = 2) {
	console.error(`Usage:
  extract-pi-system-prompt shepherd [options]
  extract-pi-system-prompt sheep <agent> [options]

Options:
  --cwd <path>       Cwd used for discovery (default: current directory)
  --scope <scope>    user, project, or both (sheep only; default: user)
  --output <path>    Write the raw prompt to this path as well as stdout
  --json             Print metadata and the prompt as JSON
  --model <model>    Override the model used by the diagnostic session
  --prompt <text>    Diagnostic user message (default: an internal marker)
  --timeout <sec>    Startup timeout (default: 20)
  --pi <command>     Pi executable (default: pi)
  --help             Show this help

The sheep mode uses the discovered agent's system prompt, model, and tools.
The shepherd mode loads pi-shepherd's parent extension and captures the
parent/shepherd prompt contribution. The process is stopped immediately after
before_agent_start, before a provider request is made.
`);
	process.exit(exitCode);
}

const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h")) usage(0);

const role = argv.shift();
if (role !== "shepherd" && role !== "sheep") usage();
const agentName = role === "sheep" ? argv.shift() : undefined;
if (role === "sheep" && !agentName) usage();

let cwd = process.cwd();
let scope = "user";
let output;
let json = false;
let model;
let diagnosticPrompt = "[pi-shepherd system-prompt diagnostic]";
let timeoutSeconds = 20;
let piCommand = "pi";

for (let i = 0; i < argv.length; i++) {
	const arg = argv[i];
	if (arg === "--json") {
		json = true;
		continue;
	}
	if (["--cwd", "--scope", "--output", "--model", "--prompt", "--timeout", "--pi"].includes(arg)) {
		const value = argv[++i];
		if (!value) usage();
		if (arg === "--cwd") cwd = value;
		else if (arg === "--scope") scope = value;
		else if (arg === "--output") output = value;
		else if (arg === "--model") model = value;
		else if (arg === "--prompt") diagnosticPrompt = value;
		else if (arg === "--timeout") timeoutSeconds = Number(value);
		else if (arg === "--pi") piCommand = value;
		continue;
	}
	console.error(`Unknown option: ${arg}`);
	usage();
}

if (!["user", "project", "both"].includes(scope)) {
	console.error(`Invalid scope: ${scope}`);
	usage();
}
if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
	console.error("--timeout must be a positive number of seconds.");
	process.exit(2);
}
cwd = resolve(cwd);
if (output) output = resolve(output);

const temporaryDir = mkdtempSync(resolve(tmpdir(), "pi-system-prompt-"));

async function resolveSheep() {
	const discoveryFile = resolve(temporaryDir, "agent.json");
	const child = spawn(piCommand, [
		"--mode",
		"json",
		"--no-session",
		"--no-extensions",
		"--approve",
		"-e",
		resolverExtension,
	], {
		cwd,
		stdio: ["ignore", "ignore", "pipe"],
		env: {
			...process.env,
			PI_AGENT_DISCOVERY_FILE: discoveryFile,
			PI_AGENT_DISCOVERY_CWD: cwd,
			PI_AGENT_DISCOVERY_SCOPE: scope,
			PI_AGENT_DISCOVERY_NAME: agentName,
		},
	});
	let stderr = "";
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk) => {
		stderr += chunk;
		if (stderr.length > 8_000) stderr = stderr.slice(-8_000);
	});
	let spawnError;
	child.on("error", (error) => {
		spawnError = error;
	});
	const deadline = Date.now() + timeoutSeconds * 1000;
	while (!existsSync(discoveryFile) && !spawnError && Date.now() < deadline) {
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
	}
	if (spawnError) throw new Error(`Could not start pi for agent discovery: ${spawnError.message}`);
	if (!existsSync(discoveryFile)) {
		if (!child.killed && child.exitCode === null) child.kill("SIGTERM");
		await new Promise((resolvePromise) => {
			if (child.exitCode !== null || child.signalCode !== null) resolvePromise();
			else child.once("close", resolvePromise);
		});
		throw new Error(
			`Timed out discovering agent "${agentName}" (${timeoutSeconds}s).${stderr.trim() ? `\n${stderr.trim()}` : ""}`,
		);
	}
	const result = JSON.parse(readFileSync(discoveryFile, "utf8"));
	if (!result.ok) throw new Error(result.error ?? `Agent not found: ${agentName}`);
	if (!child.killed && child.exitCode === null) child.kill("SIGTERM");
	return result.agent;
}

let agent;
try {
	if (role === "sheep") agent = await resolveSheep();
} catch (error) {
	rmSync(temporaryDir, { recursive: true, force: true });
	console.error(error?.message ?? String(error));
	process.exit(1);
}
const captureFile = resolve(temporaryDir, "system-prompt.md");
const agentSystemPromptFile = agent ? resolve(temporaryDir, "agent-system-prompt.md") : undefined;
if (agentSystemPromptFile) {
	const { writeFileSync } = await import("node:fs");
	writeFileSync(agentSystemPromptFile, agent.systemPrompt, { encoding: "utf8", mode: 0o600 });
}
const extension = role === "shepherd" ? shepherdExtension : sheepExtension;
const args = [
	"--mode",
	"json",
	"--no-session",
	"--no-extensions",
	"--approve",
	"-e",
	extension,
	"-e",
	captureExtension,
];

if (agent?.model || model) args.push("--model", model ?? agent.model);
if (agent?.omitContextFiles === true) args.push("--no-context-files");
if (agent?.tools?.length) args.push("--tools", [...agent.tools, ...(role === "sheep" ? ["shepherd_done"] : [])].join(","));
if (agent?.omitSystemPrompt) args.push("--system-prompt", agentSystemPromptFile);
args.push(diagnosticPrompt);

const child = spawn(piCommand, args, {
	cwd,
	stdio: ["ignore", "pipe", "pipe"],
	env: {
		...process.env,
		PI_SYSTEM_PROMPT_CAPTURE_FILE: captureFile,
		...(agentSystemPromptFile
			? { PI_SHEPHERD_AGENT_SYSTEM_PROMPT_FILE: agentSystemPromptFile }
			: {}),
		...(agent?.omitPiDocumentation ? { PI_SHEPHERD_OMIT_PI_DOCUMENTATION: "1" } : {}),
	},
});
let stderr = "";
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => {
	stderr += chunk;
	if (stderr.length > 8_000) stderr = stderr.slice(-8_000);
});
let spawnError;
child.on("error", (error) => {
	spawnError = error;
});

function stopChild() {
	if (!child.killed && child.exitCode === null) child.kill("SIGTERM");
}

function waitForChildClose() {
	if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
	return new Promise((resolvePromise) => child.once("close", resolvePromise));
}

const deadline = Date.now() + timeoutSeconds * 1000;
while (!existsSync(captureFile) && !spawnError && Date.now() < deadline) {
	await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
}
if (spawnError) {
	rmSync(temporaryDir, { recursive: true, force: true });
	console.error(`Could not start pi: ${spawnError.message}`);
	process.exit(1);
}
if (!existsSync(captureFile)) {
	stopChild();
	await waitForChildClose();
	rmSync(temporaryDir, { recursive: true, force: true });
	console.error(`Timed out waiting for pi's before_agent_start (${timeoutSeconds}s).`);
	if (stderr.trim()) console.error(stderr.trim());
	process.exit(1);
}

const prompt = readFileSync(captureFile, "utf8");
if (output) {
	mkdirSync(dirname(output), { recursive: true });
	// The capture is already written atomically. This copy is intentionally raw
	// so --output can be passed directly to pi's --system-prompt flag.
	const { chmodSync, writeFileSync } = await import("node:fs");
	writeFileSync(output, prompt, { encoding: "utf8", mode: 0o600 });
	chmodSync(output, 0o600);
}

stopChild();
// Do not let a slow provider request hold the diagnostic command open.
await Promise.race([
	new Promise((resolvePromise) => child.once("close", resolvePromise)),
	new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000)),
]);
if (!child.killed && child.exitCode === null) child.kill("SIGKILL");
rmSync(temporaryDir, { recursive: true, force: true });

const metadata = {
	role,
	agent: agent?.name,
	source: agent?.source,
	definition: agent?.filePath,
	cwd,
	scope: role === "sheep" ? scope : undefined,
	promptLength: prompt.length,
};
if (json) console.log(JSON.stringify({ ...metadata, systemPrompt: prompt }, null, 2));
else process.stdout.write(prompt.endsWith("\n") ? prompt : `${prompt}\n`);
