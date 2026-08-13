/**
 * Phase 4 — Herd tool: manage pi agents living in Herdr panes.
 *
 * Depends only on the `herdr` CLI (no JS library). Requires a running Herdr
 * session with `HERDR_ENV=1`. This is the "herd" capability — driving
 * agents that are actually running in Herdr panes (as opposed to the
 * `subagent` tool, which spawns isolated pi subprocesses).
 *
 * Safety rules (from the Herdr skill):
 *   - Verify HERDR_ENV=1 first; fail cleanly otherwise.
 *   - Split the pane we're running in (HERDR_PANE_ID) as a sibling — never
 *     guess topology.
 *   - Use --no-focus for background panes; never close panes we didn't create;
 *     never kill the Herdr server.
 */

import { execFile, execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Message } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import { loadSettings } from "./settings.ts";

const execFileAsync = promisify(execFile);

/** True when the caller is inside a Herdr session and the CLI is reachable. */
export function isHerdrAvailable(): boolean {
	if (!isHerdrCliPresent()) return false;
	if (process.env.HERDR_ENV === "1") return true;
	// Herdr-native: the CLI talks to the headless server over a socket, so we
	// can drive Herdr from a plain terminal too (as long as the server runs).
	return isHerdrServerRunning();
}

/** True when the `herdr` binary is on PATH. */
export function isHerdrCliPresent(): boolean {
	try {
		execFileSync("herdr", ["--version"], { stdio: "ignore", timeout: 3000 });
		return true;
	} catch {
		return false;
	}
}

/** True when the headless Herdr server is currently reachable. */
export function isHerdrServerRunning(): boolean {
	try {
		const stdout = execFileSync("herdr", ["status", "server"], {
			encoding: "utf8",
			timeout: 3000,
		});
		return /status:\s*running/i.test(stdout);
	} catch {
		return false;
	}
}

/**
 * Ensure a Herdr runtime exists: the CLI is present and the headless server is
 * running. From a plain terminal (no HERDR_ENV) the server is started in the
 * background (detached) if needed.
 */
export async function ensureHerdrRuntime(
	options: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
	if (!isHerdrCliPresent()) {
		throw new Error(
			"pi-shepherd is Herdr-native and needs the `herdr` CLI on PATH. Install Herdr (herdr.dev), then retry. " +
				"For isolated subprocess-style runs without Herdr, use the `subagent` tool from the pi-herdr-agents package.",
		);
	}
	if (isHerdrServerRunning()) return;
	try {
		const child = spawn("herdr", ["server"], {
			detached: true,
			stdio: "ignore",
		});
		child.unref();
	} catch {
		/* poll below; the server may already be starting */
	}
	const timeoutMs = options.timeoutMs ?? 20_000;
	const intervalMs = options.intervalMs ?? 500;
	const deadline = Date.now() + timeoutMs;
	while (Date.now() <= deadline) {
		if (isHerdrServerRunning()) return;
		await new Promise((r) => setTimeout(r, intervalMs));
	}
	throw new Error(
		"Could not start a Herdr server (herdr server). Start Herdr manually (run `herdr`) and retry.",
	);
}

/**
 * Resolve the workspace a new delegation tab should live in: the current
 * workspace when inside Herdr, otherwise the focused/first workspace of the
 * running server, creating one if none exist.
 */
export function getHerdrWorkspaceId(): string {
	const envId = process.env.HERDR_WORKSPACE_ID;
	if (envId) return envId;
	const out = herdrExecSync(["workspace", "list"]) as any;
	const workspaces = out?.result?.workspaces;
	if (Array.isArray(workspaces) && workspaces.length > 0) {
		const chosen =
			workspaces.find((w: any) => w.focused === true) ?? workspaces[0];
		if (typeof chosen?.workspace_id === "string" && chosen.workspace_id) {
			return chosen.workspace_id;
		}
	}
	const created = herdrExecSync([
		"workspace",
		"create",
		"--cwd",
		process.cwd(),
		"--no-focus",
	]) as any;
	const id =
		created?.result?.workspace_id ?? created?.result?.root_pane?.workspace_id;
	if (typeof id !== "string" || !id) {
		throw new Error(
			`Could not create a Herdr workspace: ${JSON.stringify(created)}`,
		);
	}
	return id;
}

const HERDR_SETUP_HINT = "Run `herdr` to start/attach Herdr (or ensure the headless server is up), and keep `herdr` on PATH.";

function herdrExecSync(args: string[]): unknown {
	const stdout = execFileSync("herdr", args, { encoding: "utf8" });
	return JSON.parse(stdout);
}

/**
 * Sync snapshot of every agent keyed in Herdr. Cheap enough to call from a
 * status widget every second or so. Returns [] when Herdr isn't reachable.
 * The result is never cached (live view reflects the current state).
 */
export function listHerdrAgents(): HerdAgentSummary[] {
	if (!isHerdrAvailable()) return [];
	try {
		return agentSummaries(herdrExecSync(["agent", "list"]));
	} catch {
		return [];
	}
}

/**
 * The subagents pi-shepherd is currently working on: our own panes whose
 * agent is not idle (working, waiting on input, errored, …). Used for the
 * persistent "below the editor" status line.
 */
export function workingSubagents(): HerdAgentSummary[] {
	// `rec.agent` in `herdr agent list` is always the program name (“pi”),
	// not the agent kind. For shepherd panes the agent kind (scout/worker/…)
	// is what we recorded when the tab was created — use that for the label.
	const kindByPane = new Map(
		loadCreatedPanes().map((p) => [p.paneId, p.name]),
	);
	return listHerdrAgents()
		.filter((s) => s.shepherd && s.state !== "idle")
		.map((s) => {
			const kind = kindByPane.get(s.paneId);
			return kind && kind !== "pi" ? { ...s, name: kind } : s;
		});
}

async function herdrExec(args: string[]): Promise<unknown> {
	const { stdout } = await execFileAsync("herdr", args, { encoding: "utf8" });
	return JSON.parse(stdout);
}

function paneIdOf(output: unknown, context: string): string {
	const paneId = (output as { result?: { pane?: { pane_id?: unknown } } })?.result
		?.pane?.pane_id;
	if (typeof paneId !== "string" || !paneId) {
		throw new Error(`Unexpected herdr ${context} output: ${JSON.stringify(output)}`);
	}
	return paneId;
}

export interface HerdAgentSummary {
	name: string;
	state: string;
	paneId: string;
	tabId: string;
	workspaceId: string;
	cwd: string;
	focused: boolean;
	shepherd: boolean;
	terminalTitle: string;
}

function agentSummaries(listOutput: unknown): HerdAgentSummary[] {
	const agents = (listOutput as { result?: { agents?: unknown[] } })?.result
		?.agents;
	if (!Array.isArray(agents)) return [];
	const out: HerdAgentSummary[] = [];
	for (const a of agents) {
		const rec = a as Record<string, unknown>;
		out.push({
			name: typeof rec.agent === "string" ? rec.agent : "?",
			state: typeof rec.agent_status === "string" ? rec.agent_status : "unknown",
			paneId: typeof rec.pane_id === "string" ? rec.pane_id : "?",
			tabId: typeof rec.tab_id === "string" ? rec.tab_id : "?",
			workspaceId: typeof rec.workspace_id === "string" ? rec.workspace_id : "?",
			cwd: typeof rec.foreground_cwd === "string" ? rec.foreground_cwd : "",
			focused: rec.focused === true,
			shepherd: typeof rec.pane_id === "string" && isShepherdPane(rec.pane_id),
			terminalTitle: typeof rec.terminal_title === "string" ? rec.terminal_title : "",
		});
	}
	return out;
}

function formatSummary(s: HerdAgentSummary): string {
	const who = s.focused ? `${s.name} (self/focused)` : s.name;
	const mark = s.shepherd ? " ●(shepherd)" : "";
	return `• ${who}${mark} [${s.state}] pane=${s.paneId}${s.cwd ? ` cwd=${s.cwd}` : ""}`;
}

// ── Shepherd panes registry ───────────────────────────────────────────────
// Tracks panes/tabs pi-shepherd created so `herd close` only ever closes our
// own panes (safety invariant: never close panes we didn't create).

interface CreatedPane {
	paneId: string;
	tabId: string;
	name: string;
	cwd: string;
	createdAt: number;
}

function registryFile(): string {
	return path.join(os.homedir(), ".pi", "agent", "pi-shepherd", "created-panes.json");
}

function loadCreatedPanes(): CreatedPane[] {
	try {
		const parsed = JSON.parse(fs.readFileSync(registryFile(), "utf8"));
		return Array.isArray(parsed) ? (parsed as CreatedPane[]) : [];
	} catch {
		return [];
	}
}

function saveCreatedPanes(panes: CreatedPane[]): void {
	const file = registryFile();
	try {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, JSON.stringify(panes, null, 2));
	} catch {
		/* best effort */
	}
}

function recordCreatedPane(entry: CreatedPane): void {
	const panes = loadCreatedPanes();
	if (!panes.some((p) => p.paneId === entry.paneId)) {
		panes.push(entry);
		saveCreatedPanes(panes);
	}
}

function forgetCreatedPane(paneId: string): void {
	saveCreatedPanes(loadCreatedPanes().filter((p) => p.paneId !== paneId));
}

/** True when this pane id (or the agent name it was created under) belongs to pi-shepherd. */
function isShepherdPane(idOrName: string): boolean {
	return loadCreatedPanes().some((p) => p.paneId === idOrName || p.name === idOrName);
}

// ── Herdr-backed agent runner ────────────────────────────────────────────
// One-shot delegation for the `pi-subagent` tool: create a new tab labelled
// after the agent, run pi in it with the delegated system prompt + task, wait
// for completion, pick up the result, and (optionally) close the tab.

function shellQuote(value: string): string {
	return "'" + value.replace(/'/g, "'\\''") + "'";
}

/** Create a new tab in a workspace and return its root pane + tab ids. */
function createHerdrTab(
	label: string,
	cwd: string,
	workspaceId?: string,
): { paneId: string; tabId: string } {
	const args = ["tab", "create", "--label", label, "--cwd", cwd, "--no-focus"];
	if (workspaceId) args.splice(2, 0, "--workspace", workspaceId);
	const out = herdrExecSync(args) as any;
	const result = out?.result;
	const root = result?.root_pane as Record<string, unknown> | undefined;
	const paneId =
		typeof root?.pane_id === "string" && root.pane_id ? root.pane_id : undefined;
	const tabId =
		typeof root?.tab_id === "string" && root.tab_id
			? root.tab_id
			: (result?.tab?.tab_id as string | undefined);
	if (!paneId) {
		throw new Error(`Unexpected herdr tab create output: ${JSON.stringify(out)}`);
	}
	try {
		herdrExecSync(["pane", "rename", paneId, label]);
	} catch {
		/* cosmetic */
	}
	recordCreatedPane({
		paneId,
		tabId: tabId ?? "",
		name: label,
		cwd,
		createdAt: Date.now(),
	});
	return { paneId, tabId: tabId ?? "" };
}

/** Wait until the freshly created pane's foreground shell is at a prompt. */
async function waitForHerdrShellReady(
	paneId: string,
	options: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
	const timeoutMs = options.timeoutMs ?? 15_000;
	const intervalMs = options.intervalMs ?? 250;
	const deadline = Date.now() + timeoutMs;
	let last = "no shell process observed";
	while (Date.now() <= deadline) {
		try {
			const { stdout } = await execFileAsync(
				"herdr",
				["pane", "process-info", "--pane", paneId],
				{ encoding: "utf8" },
			);
			const info = (JSON.parse(stdout) as any)?.result?.process_info ?? {};
			const shellPid =
				typeof info.shell_pid === "number" ? info.shell_pid : null;
			const fgpg =
				typeof info.foreground_process_group_id === "number"
					? info.foreground_process_group_id
					: null;
			if (shellPid != null && fgpg === shellPid) return;
			last = `pid ${shellPid} fg ${fgpg}`;
		} catch (error: any) {
			last = String(error?.message ?? error);
		}
		if (Date.now() >= deadline) break;
		await new Promise((r) => setTimeout(r, intervalMs));
	}
	throw new Error(
		`Timed out waiting for interactive shell in Herdr pane ${paneId}: ${last}`,
	);
}

function sendCommandInHerdr(paneId: string, command: string): void {
	try {
		execFileSync("herdr", ["pane", "run", paneId, command], { stdio: "ignore" });
	} catch (error: any) {
		throw new Error(
			`Failed to run command in pane ${paneId}: ${error?.message ?? error}`,
		);
	}
}

function sendEscapeInHerdr(paneId: string): void {
	try {
		execFileSync("herdr", ["pane", "send-keys", paneId, "Escape"], {
			stdio: "ignore",
		});
	} catch {
		/* best effort */
	}
}

async function readPaneTail(paneId: string): Promise<string> {
	try {
		const { stdout } = await execFileAsync(
			"herdr",
			["pane", "read", paneId, "--source", "recent", "--lines", "40"],
			{ encoding: "utf8" },
		);
		return stdout;
	} catch {
		return "";
	}
}

/** Reconstruct messages/model from the child's JSONL session file. */
function parseSessionFile(sessionFile: string): {
	messages: Message[];
	model?: string;
} {
	const messages: Message[] = [];
	let model: string | undefined;
	if (!fs.existsSync(sessionFile)) return { messages, model };
	for (const line of fs.readFileSync(sessionFile, "utf8").split("\n")) {
		if (!line.trim()) continue;
		let ev: any;
		try {
			ev = JSON.parse(line);
		} catch {
			continue;
		}
		if (ev?.type === "model_change" && typeof ev.modelId === "string") {
			model = ev.modelId;
		}
		if (
			ev?.type === "message" &&
			ev.message &&
			typeof ev.message.role === "string"
		) {
			messages.push({
				role: ev.message.role,
				content: Array.isArray(ev.message.content) ? ev.message.content : [],
				timestamp: ev.message.timestamp,
			});
		}
	}
	return { messages, model };
}

function lastAssistantText(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i].role !== "assistant") continue;
		for (const part of messages[i].content) {
			if (part.type === "text" && part.text) return part.text;
		}
	}
	return "";
}

const DONE_SENTINEL = /__SHEPHERD_DONE_(\d+)__/;

/**
 * Run one delegated agent to completion in a new Herdr tab, then pick up the
 * result. The tab is left open unless `keepOpen` is false. When `stayOpen` is
 * true (default) the child pi does NOT exit on completion — it stays alive in
 * the tab so the user can keep driving it; the parent picks up the result from
 * the completion sidecar.
 */
export async function runAgentInHerdr(opts: {
	agentName: string;
	systemPrompt: string;
	task: string;
	cwd: string;
	model?: string;
	tools?: string[];
	label?: string;
	keepOpen?: boolean;
	stayOpen?: boolean;
	timeout?: number;
	signal?: AbortSignal;
	onProgress?: (text: string) => void;
}): Promise<{
	ok: boolean;
	exitCode: number;
	messages: Message[];
	model?: string;
	errorMessage?: string;
	finalText?: string;
	paneId: string;
	tabId: string;
}> {
	const label = opts.label ?? opts.agentName;
	const settings = loadSettings();
	const keepOpen = opts.keepOpen ?? settings.keepOpen;
	const stayOpen = opts.stayOpen ?? settings.stayOpen;
	const timeout = opts.timeout ?? settings.timeout;

	// Herdr-native: make sure a server is up (auto-starting it from a plain
	// terminal), then resolve a workspace for the new tab.
	await ensureHerdrRuntime();
	const workspaceId = getHerdrWorkspaceId();
	const { paneId, tabId } = createHerdrTab(label, opts.cwd, workspaceId);

	await waitForHerdrShellReady(paneId);

	const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-shepherd-"));
	const safe = opts.agentName.replace(/[^\w.-]+/g, "_") || "agent";
	const sessionFile = path.join(dir, `session-${safe}.jsonl`);
	const sysFile = path.join(dir, `sysprompt-${safe}.md`);
	const taskFile = path.join(dir, `task-${safe}.md`);
	const scriptFile = path.join(dir, `launch-${safe}.sh`);
	const doneExt = fileURLToPath(new URL("./shepherd-done.ts", import.meta.url));

	await fs.promises.writeFile(sysFile, opts.systemPrompt, {
		encoding: "utf8",
		mode: 0o600,
	});
	const task = `${opts.task}\n\n[Autonomous subagent]\nComplete this task autonomously in this Herdr tab. When finished, call the shepherd_done tool to signal completion and return your output to the caller. Keep your FINAL assistant message a concise summary of what you did and found.`;
	await fs.promises.writeFile(taskFile, task, { encoding: "utf8", mode: 0o600 });

	const args: string[] = [
		"--session",
		shellQuote(sessionFile),
		"-e",
		shellQuote(doneExt),
	];
	if (opts.model) args.push("--model", shellQuote(opts.model));
	const tools =
		opts.tools && opts.tools.length > 0
			? [...opts.tools, "shepherd_done"].join(",")
			: undefined;
	if (tools) args.push("--tools", tools);
	args.push("--append-system-prompt", shellQuote(sysFile));
	args.push(`'@${taskFile}'`);

	const launchScript = [
		"#!/bin/bash",
		`export PI_SHEPHERD_SESSION=${shellQuote(sessionFile)}`,
		"export PI_SHEPHERD_AUTO_EXIT=1",
		stayOpen ? "export PI_SHEPHERD_STAY_OPEN=1" : "export PI_SHEPHERD_STAY_OPEN=0",
		`pi ${args.join(" ")}; echo '__SHEPHERD_DONE_'$?'__'`,
	].join("\n");
	await fs.promises.writeFile(scriptFile, launchScript, { mode: 0o700 });

	let settled = false;
	let outcome: "done" | "error" | null = null;
	let errorMessage: string | undefined;
	const started = Date.now();

	try {
		sendCommandInHerdr(paneId, `bash ${shellQuote(scriptFile)}`);

		while (Date.now() - started < timeout) {
			if (opts.signal?.aborted) {
				sendEscapeInHerdr(paneId);
				throw new Error("Subagent was aborted");
			}

			const exitFile = `${sessionFile}.exit`;
			if (fs.existsSync(exitFile)) {
				let sidecar: any = null;
				try {
					sidecar = JSON.parse(fs.readFileSync(exitFile, "utf8"));
				} catch {
					/* retry */
				}
				if (sidecar?.type === "done") {
					outcome = "done";
					break;
				}
				if (sidecar?.type === "error") {
					outcome = "error";
					errorMessage =
						sidecar.errorMessage || "Agent terminated with stopReason=error.";
					break;
				}
			}

			const pickup = parseSessionFile(sessionFile);
			const tail = await readPaneTail(paneId);
			const sentinel = tail.match(DONE_SENTINEL);
			if (sentinel) {
				const code = Number(sentinel[1]);
				outcome = code === 0 ? "done" : "error";
				if (code !== 0)
					errorMessage = `pi exited with code ${code} (no completion sidecar).`;
				settled = true;
				break;
			}

			opts.onProgress?.(lastAssistantText(pickup.messages) || "(running...)");
			await new Promise((r) => setTimeout(r, 1000));
		}

		if (outcome === null) {
			outcome = "error";
			errorMessage =
				`Timed out after ${Math.round((Date.now() - started) / 1000)}s. ` +
				`The tab "${label}" (pane ${paneId}) is left open with pi still running — ` +
				`inspect it there, or close with herd close ${paneId}.`;
		} else if (stayOpen && !settled) {
			// The child pi stays alive in the tab (completion was signalled via
			// the sidecar, not a process exit), so there is no exit to wait for.
			// Keep `settled` false so the temp files are preserved — pi still
			// owns the session file and would hit ENOENT writing to it if we
			// removed them.
		} else if (!settled) {
			// The completion sidecar is written while the child pi is still
			// finishing its shutdown. Wait (bounded) for the shell to echo the
			// sentinel — i.e. for pi to have fully exited — before reading the
			// session file and cleaning up temp files.
			const settleDeadline = Date.now() + 20_000;
			while (Date.now() < settleDeadline) {
				if (opts.signal?.aborted) break;
				const tail = await readPaneTail(paneId);
				if (DONE_SENTINEL.test(tail)) {
					settled = true;
					break;
				}
				await new Promise((r) => setTimeout(r, 500));
			}
		}

		const pickup = parseSessionFile(sessionFile);
		const finalText =
			lastAssistantText(pickup.messages) || (await readPaneTail(paneId)).trim();

		if (!keepOpen) {
			try {
				herdrExecSync(["pane", "close", paneId]);
			} catch {
				/* already gone */
			}
			forgetCreatedPane(paneId);
		}

		return {
			ok: outcome === "done",
			exitCode: outcome === "done" ? 0 : 1,
			messages: pickup.messages,
			model: pickup.model ?? opts.model,
			errorMessage: outcome === "done" ? undefined : errorMessage,
			paneId,
			tabId: tabId ?? "",
			...(finalText ? { finalText } : {}),
		};
	} finally {
		// Only remove temp files once pi has actually stopped writing to them.
		if (settled) {
			try {
				fs.rmSync(dir, { recursive: true, force: true });
			} catch {
				/* best effort */
			}
		}
	}
}

const ActionSchema = StringEnum(["list", "start", "prompt", "status", "read", "close"] as const, {
	description: "Herd action to perform",
});
const DirectionSchema = StringEnum(["right", "down"] as const, {
	description: "Split direction for a new sibling pane (start)",
	default: "right",
});
const SourceSchema = StringEnum(["visible", "recent", "recent-unwrapped", "detection"] as const, {
	description: "Terminal snapshot source for read",
	default: "recent-unwrapped",
});

const HerdParams = Type.Object({
	action: ActionSchema,
	name: Type.Optional(
		Type.String({
			description:
				"Agent name or pane id target. For start: the label for the new sibling agent.",
		}),
	),
	task: Type.Optional(Type.String({ description: "Prompt to submit (action=prompt)" })),
	direction: Type.Optional(DirectionSchema),
	cwd: Type.Optional(Type.String({ description: "Working directory for a new pane (action=start)" })),
	timeout: Type.Optional(
		Type.Integer({ description: "Wait timeout (ms) for prompt settle (default 120000)", default: 120000 }),
	),
	lines: Type.Optional(Type.Integer({ description: "Number of recent lines for read (default 40)", default: 40 })),
	source: Type.Optional(SourceSchema),
});

type HerdArgs = Static<typeof HerdParams>;

function unavailableResult(): AgentToolResult<{ error: string }> {
	return {
		content: [{ type: "text", text: `Herd requires a running Herdr session.\n${HERDR_SETUP_HINT}` }],
		details: { error: "herdr not available" },
		isError: true,
	};
}

function textResult(text: string, details: Record<string, unknown>): AgentToolResult<Record<string, unknown>> {
	return { content: [{ type: "text" as const, text }], details };
}

async function doAction(action: string, args: HerdArgs, ctx): Promise<AgentToolResult<Record<string, unknown>>> {
	switch (action) {
		case "list": {
			const out = herdrExecSync(["agent", "list"]);
			const agents = agentSummaries(out);
			if (agents.length === 0)
				return textResult("No agents detected in Herdr.", { agents });
			return textResult(agents.map(formatSummary).join("\n"), { agents });
		}

		case "start": {
			const name = args.name?.trim();
			if (!name) return textResult("Provide a name for the new agent (action=start).", {});
			const cwd = args.cwd ?? ctx.cwd ?? process.cwd();
			const parentPane = process.env.HERDR_PANE_ID;
			if (!parentPane)
				return textResult("Cannot start: HERDR_PANE_ID is not set (not in a Herdr pane).", {});
			const direction = args.direction ?? "right";

			// Split our own pane to create a sibling; reference target output.
			const splitOut = herdrExecSync([
				"pane", "split", parentPane,
				"--direction", direction,
				"--cwd", cwd,
				"--no-focus",
			]);
			const paneId = paneIdOf(splitOut, "pane split");
			try {
				// `herdr agent start` only accepts a pane that is at an idle shell
				// prompt. A freshly split pane can briefly report agent_pane_busy
				// while its shell spins up — retry with backoff.
				const start = async (): Promise<unknown> =>
					herdrExec(["agent", "start", name, "--kind", "pi", "--pane", paneId, "--timeout", "30000"]);

				let started: unknown;
				let lastError: unknown = null;
				for (let attempt = 0; attempt < 10; attempt++) {
					try {
						started = await start();
						lastError = null;
						break;
					} catch (error: any) {
						lastError = error;
						const raw = String(error?.stderr || error?.message || error);
						if (!raw.includes("agent_pane_busy")) throw error;
						await new Promise((r) => setTimeout(r, 700 * (attempt + 1)));
					}
				}
				if (lastError) throw lastError;

				try {
					herdrExecSync(["pane", "rename", paneId, name]);
				} catch {
					/* cosmetic — ignore */
				}
				// Track the pane so `herd close` is allowed to close it later.
				recordCreatedPane({ paneId, tabId: "", name, cwd, createdAt: Date.now() });
				return textResult(
					`Started pi agent "${name}" in pane ${paneId}.\nYou can target it with herd (name=${name} or pane=${paneId}), or close it with herd close ${paneId}.`,
					{ paneId, name, started },
				);
			} catch (error: any) {
				// If start failed, the sibling pane still exists — leave it so the
				// user can inspect/start manually, but report plainly.
				return {
					content: [
						{
							type: "text",
							text: `Created pane ${paneId} but failed to start pi agent "${name}": ${
								error?.message ?? String(error)
							}\nThe pane is left open for inspection.`,
						},
					],
					details: { paneId, name, error: String(error?.message ?? error) },
					isError: true,
				};
			}
		}

		case "prompt": {
			const target = args.name?.trim();
			const task = args.task?.trim() || "";
			if (!target || !task)
				return textResult("Provide a name/pane target and a task (action=prompt).", {});
			const timeout = args.timeout ?? 120_000;
			try {
				const out = await herdrExec([
					"agent", "prompt", target, task,
					"--wait", "--until", "done",
					"--timeout", String(timeout),
				]);
				return textResult(`Prompt returned (${JSON.stringify((out as any)?.result ?? out)}).`, {
					name: target,
					result: out,
				});
			} catch (error: any) {
				const raw = error?.stderr || error?.stdout || String(error?.message ?? error);
				return {
					content: [
						{
							type: "text",
							text: `Prompt to "${target}" did not settle: ${raw}`.slice(0, 4000),
						},
					],
					details: { name: target, error: raw },
					isError: true,
				};
			}
		}

		case "status": {
			const target = args.name?.trim();
			if (!target) return textResult("Provide a name/pane target (action=status).", {});
			try {
				const out = herdrExecSync(["agent", "get", target]);
				const rec = (out as any)?.result?.agent as Record<string, unknown> | undefined;
				if (!rec) return textResult(`No status for "${target}".`, { target });
				const lines = [
					`Agent: ${rec.agent ?? "?"}`,
					`State: ${rec.agent_status ?? "unknown"}`,
					`Pane: ${rec.pane_id ?? "?"}  Tab: ${rec.tab_id ?? "?"}  Workspace: ${rec.workspace_id ?? "?"}`,
					`Cwd: ${rec.foreground_cwd ?? rec.cwd ?? ""}`,
					`Focused: ${rec.focused === true ? "yes" : "no"}`,
				];
				return textResult(lines.join("\n"), { target, agent: rec });
			} catch (error: any) {
				return {
					content: [
						{
							type: "text",
							text: `No agent "${target}": ${error?.message ?? String(error)}`,
						},
					],
					details: { target, error: String(error?.message ?? error) },
					isError: true,
				};
			}
		}

		case "read": {
			const target = args.name?.trim();
			if (!target) return textResult("Provide a name/pane target (action=read).", {});
			const lines = args.lines ?? 40;
			const source = args.source ?? "recent-unwrapped";
			try {
				const { stdout } = await execFileAsync(
					"herdr",
					["agent", "read", target, "--source", source, "--lines", String(lines), "--format", "text"],
					{ encoding: "utf8" },
				);
				return textResult(stdout.trim() || "(no terminal output)", { target, lines, source });
			} catch (error: any) {
				return {
					content: [
						{
							type: "text",
							text: `Could not read "${target}": ${error?.message ?? String(error)}`,
						},
					],
					details: { target, error: String(error?.message ?? error) },
					isError: true,
				};
			}
		}

		case "close": {
			const target = args.name?.trim();
			if (!target) return textResult("Provide a pane id or agent name to close (action=close).", {});
			const created = loadCreatedPanes();
			const matches = created.filter((p) => p.paneId === target || p.name === target);
			if (matches.length === 0) {
				return {
					content: [
						{
							type: "text",
							text: `Refusing to close "${target}": it is not a pane pi-shepherd created. Close other panes directly in Herdr.`,
						},
					],
					details: { target },
					isError: true,
				};
			}
			const closed: string[] = [];
			for (const p of matches) {
				try {
					herdrExecSync(["pane", "close", p.paneId]);
					closed.push(p.paneId);
				} catch {
					/* already gone — still forget it */
				}
				forgetCreatedPane(p.paneId);
			}
			return textResult(
				`Closed pi-shepherd pane(s): ${closed.join(", ") || target}`,
				{ closed, target },
			);
		}

		default:
			return textResult(`Unknown herd action: ${action}`, {});
	}
}

export function registerHerdTool(pi: ExtensionAPI) {
	pi.registerTool({
		name: "herd",
		label: "Herd (Herdr agents)",
		description: [
			"Manage pi agents running in Herdr panes: list, start a sibling, prompt, status, read, close.",
			`Actions: list | start | prompt | status | read | close. Requires a running Herdr session (HERDR_ENV=1).`,
			`Panes created by pi-shepherd (via this tool or pi-subagent) are marked ● and can be closed with close.`,
			"For isolated one-shot delegation use the 'pi-subagent' tool instead.",
		].join(" "),
		parameters: HerdParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!isHerdrAvailable()) return unavailableResult();
			try {
				return await doAction(params.action, params as HerdArgs, ctx);
			} catch (error: any) {
				return {
					content: [
						{ type: "text", text: `Herd ${params.action} failed: ${error?.message ?? String(error)}` },
					],
					details: { action: params.action, error: String(error?.message ?? error) },
					isError: true,
				};
			}
		},

		renderCall(args, theme) {
			const action = args.action ?? "list";
			const target = args.name ? ` ${args.name}` : "";
			const extra =
				action === "prompt"
					? ` "…${((args.task ?? "").length > 40 ? (args.task ?? "").slice(0, 40) + "…" : args.task ?? "")}"`
					: "";
			return new Text(
				theme.fg("toolTitle", theme.bold("herd ")) +
					theme.fg("accent", action) +
					theme.fg("dim", `${target}${extra}`),
				0,
				0,
			);
		},

		renderResult(result, { expanded }, theme) {
			const text = result.content[0];
			const body = text?.type === "text" ? (text.text ?? "") : "";
			if (!expanded && body.includes("\n")) {
				const firstLine = body.split("\n")[0];
				return new Text(
					theme.fg("accent", firstLine) +
						`\n${theme.fg("muted", `… +${body.split("\n").length - 1} more lines (Ctrl+O to expand)`)}`,
					0,
					0,
				);
			}
			return new Text(theme.fg("toolOutput", body || "(no output)"), 0, 0);
		},
	});
}