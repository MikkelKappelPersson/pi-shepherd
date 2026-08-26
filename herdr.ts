/**
 * Herdr runtime — the Herdr integration layer for pi-shepherd.
 *
 * Shells out to the `herdr` CLI (no JS library) and provides the building
 * blocks both sides of the extension depend on: the Herdr session guard
 * (isHerdrAvailable), pane/tab creation (createHerdrTab), the launch-script
 * writer (writePiLaunchFiles / launchPiInPane), the delegation runner
 * the created-panes registry, and
 * agent listing (listHerdrAgents / workingSubagents, used by the status
 * widget). The model-facing `shepherd` tool lives in shepherd.ts and imports
 * from here; the in-tab completion extension is shepherd-done.ts.
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
import { Text } from "@earendil-works/pi-tui";

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

export const HERDR_SETUP_HINT = "Run `herdr` to start/attach Herdr (or ensure the headless server is up), and keep `herdr` on PATH.";

export function herdrExecSync(args: string[]): unknown {
	// Keep expected polling misses (for example, `agent get` immediately after
	// pane creation) out of the parent's terminal. The CLI still attaches its
	// captured stderr to a thrown error, so callers can inspect real failures.
	const stdout = execFileSync("herdr", args, {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	return JSON.parse(stdout);
}

/**
 * Sync snapshot of every agent keyed in Herdr. Cheap enough to call from a
 * status widget every second or so. Returns [] when Herdr isn't reachable.
 * The result is never cached (live view reflects the current state).
 */
export function listHerdrAgents(): HerdrAgentSummary[] {
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
export function workingSubagents(): HerdrAgentSummary[] {
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

export async function herdrExec(args: string[]): Promise<unknown> {
	const { stdout } = await execFileAsync("herdr", args, { encoding: "utf8" });
	return JSON.parse(stdout);
}

export function paneIdOf(output: unknown, context: string): string {
	const paneId = (output as { result?: { pane?: { pane_id?: unknown } } })?.result
		?.pane?.pane_id;
	if (typeof paneId !== "string" || !paneId) {
		throw new Error(`Unexpected herdr ${context} output: ${JSON.stringify(output)}`);
	}
	return paneId;
}

export interface HerdrAgentSummary {
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

export function agentSummaries(listOutput: unknown): HerdrAgentSummary[] {
	const agents = (listOutput as { result?: { agents?: unknown[] } })?.result
		?.agents;
	if (!Array.isArray(agents)) return [];
	const out: HerdrAgentSummary[] = [];
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

export function formatSummary(s: HerdrAgentSummary): string {
	const who = s.focused ? `${s.name} (self/focused)` : s.name;
	const mark = s.shepherd ? " ●(shepherd)" : "";
	return `• ${who}${mark} [${s.state}] pane=${s.paneId}${s.cwd ? ` cwd=${s.cwd}` : ""}`;
}

// ── Shepherd panes registry ───────────────────────────────────────────────
// Tracks panes/tabs pi-shepherd created so `shepherd close` only ever closes our
// own panes (safety invariant: never close panes we didn't create).

interface CreatedPane {
	paneId: string;
	tabId: string;
	name: string;
	cwd: string;
	createdAt: number;
	/** Temp launch dir (if any) to remove when this pane is closed. */
	dir?: string;
}

function registryFile(): string {
	return path.join(os.homedir(), ".pi", "agent", "pi-shepherd", "created-panes.json");
}

export function loadCreatedPanes(): CreatedPane[] {
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

export function recordCreatedPane(entry: CreatedPane): void {
	const panes = loadCreatedPanes();
	if (!panes.some((p) => p.paneId === entry.paneId)) {
		panes.push(entry);
		saveCreatedPanes(panes);
	}
}

function forgetCreatedPane(paneId: string): void {
	saveCreatedPanes(loadCreatedPanes().filter((p) => p.paneId !== paneId));
}

/**
 * Attach (or overwrite) the temp launch dir for an existing pane so that
 * `shepherd close` can clean it up. The pane is registered early (for orphan
 * safety) but its launch dir is only known once pi is booted, so we set it
 * afterwards.
 */
export function setCreatedPaneDir(paneId: string, dir: string): void {
	const panes = loadCreatedPanes();
	const entry = panes.find((p) => p.paneId === paneId);
	if (!entry) return;
	entry.dir = dir;
	saveCreatedPanes(panes);
}

/** Best-effort removal of a pane's retained temp launch dir. */
export function removeCreatedPaneDir(paneId: string): void {
	const entry = loadCreatedPanes().find((p) => p.paneId === paneId);
	if (!entry?.dir) return;
	try {
		fs.rmSync(entry.dir, { recursive: true, force: true });
	} catch {
		/* best effort */
	}
}

/** True when Herdr still lists a pane with this id. */
export function paneExists(paneId: string): boolean {
	try {
		const out = herdrExecSync(["pane", "list"]) as any;
		const panes = out?.result?.panes as Array<{ pane_id?: unknown }> | undefined;
		return Array.isArray(panes) && panes.some((p) => p?.pane_id === paneId);
	} catch {
		return true; // assume present when we can't check — safer to not delete
	}
}

/**
 * Drop created-pane registrations whose pane no longer exists (and clean
 * their retained temp launch dirs). Safe: paneExists() returns true when the
 * check itself fails, so we never prune a pane we can't confirm is gone.
 * Returns how many stale entries were pruned.
 */
export function pruneStaleCreatedPanes(): number {
	const panes = loadCreatedPanes();
	if (panes.length === 0) return 0;
	const stale = panes.filter((p) => !paneExists(p.paneId));
	if (stale.length === 0) return 0;
	for (const p of stale) removeCreatedPaneDir(p.paneId);
	saveCreatedPanes(panes.filter((p) => !stale.includes(p)));
	return stale.length;
}

/** True when this pane id (or the agent name it was created under) belongs to pi-shepherd. */
function isShepherdPane(idOrName: string): boolean {
	return loadCreatedPanes().some((p) => p.paneId === idOrName || p.name === idOrName);
}

// ── Herdr-backed agent runner ────────────────────────────────────────────
// Pane lifecycle and persistent agent launch helpers.

function shellQuote(value: string): string {
	return "'" + value.replace(/'/g, "'\\''") + "'";
}

export type HerdrPlacement = 'pane' | 'tab' | 'workspace';

/**
 * Create the requested Herdr container and return the pane running the agent.
 * The default is a new tab; all placements stay in the background.
 */
export function createHerdrInstance(
	label: string,
	cwd: string,
	placement: HerdrPlacement = 'tab',
	workspaceId?: string,
	direction: 'right' | 'down' = 'right',
): { paneId: string; tabId: string; workspaceId: string } {
	let out: any;
	if (placement === 'pane') {
		const args = ['pane', 'split', '--direction', direction, '--cwd', cwd, '--no-focus'];
		if (process.env.HERDR_PANE_ID) args.push('--pane', process.env.HERDR_PANE_ID);
		else throw new Error('Pane placement requires HERDR_PANE_ID for the calling Herdr pane.');
		out = herdrExecSync(args);
	} else if (placement === 'workspace') {
		out = herdrExecSync(['workspace', 'create', '--label', label, '--cwd', cwd, '--no-focus']);
	} else {
		const args = ['tab', 'create', '--label', label, '--cwd', cwd, '--no-focus'];
		if (workspaceId) args.splice(2, 0, '--workspace', workspaceId);
		out = herdrExecSync(args);
	}

	const result = out?.result;
	const root = result?.root_pane as Record<string, unknown> | undefined;
	const pane = result?.pane as Record<string, unknown> | undefined;
	const paneId =
		(typeof root?.pane_id === 'string' && root.pane_id) ||
		(typeof pane?.pane_id === 'string' && pane.pane_id) ||
		undefined;
	const tabId =
		(typeof root?.tab_id === 'string' && root.tab_id) ||
		(typeof result?.tab?.tab_id === 'string' && result.tab.tab_id) ||
		(typeof pane?.tab_id === 'string' && pane.tab_id) ||
		'';
	const resolvedWorkspaceId =
		(typeof root?.workspace_id === 'string' && root.workspace_id) ||
		(typeof pane?.workspace_id === 'string' && pane.workspace_id) ||
		(typeof result?.workspace?.workspace_id === 'string' && result.workspace.workspace_id) ||
		(typeof result?.workspace_id === 'string' && result.workspace_id) ||
		(typeof result?.tab?.workspace_id === 'string' && result.tab.workspace_id) ||
		(placement !== 'workspace' ? workspaceId || process.env.HERDR_WORKSPACE_ID || '' : '');
	if (!paneId || !resolvedWorkspaceId) {
		// A successful create with an unexpected response must not leave an
		// unowned background pane behind. If Herdr gave us a pane id, close it
		// before reporting the malformed response.
		if (paneId) {
			try {
				herdrExecSync(['pane', 'close', paneId]);
			} catch {
				/* best effort; the caller still receives the creation error */
			}
		}
		throw new Error(`Unexpected herdr ${placement} create output: ${JSON.stringify(out)}`);
	}
	try {
		herdrExecSync(['pane', 'rename', paneId, label]);
	} catch {
		/* cosmetic */
	}
	recordCreatedPane({ paneId, tabId, name: label, cwd, createdAt: Date.now() });
	return { paneId, tabId, workspaceId: resolvedWorkspaceId };
}

/** Backwards-compatible helper for callers that always want a new tab. */
export function createHerdrTab(
	label: string,
	cwd: string,
	workspaceId?: string,
): { paneId: string; tabId: string } {
	const created = createHerdrInstance(label, cwd, 'tab', workspaceId);
	return { paneId: created.paneId, tabId: created.tabId };
}

/** Wait until the freshly created pane's foreground shell is at a prompt. */
export async function waitForHerdrShellReady(
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

/**
 * One sharable implementation of the launch files used to start a pi in a
 * Herdr pane, used by both `runAgentInHerdr` (one-shot delegation) and
 * `shepherd start` (persistent sibling). Writing is heredoc-safe: execFile
 * arrays plus a `'@taskFile'` argument that bash unquotes.
 *
 * When `task` is undefined a *bare* pi is launched (no sysprompt/task/model/
 * tools) so the pane is a plain agent the user drives later with `prompt`.
 * The shepherd-done extension + env vars are always wired in, so the pane
 * participates in the same completion sidecar lifecycle as persistent runs.
 */
export function writePiLaunchFiles(opts: {
	name: string;
	task?: string;
	systemPrompt?: string;
	omitSystemPrompt?: boolean;
	omitPiDocumentation?: boolean;
	omitContextFiles?: boolean;
	stayOpen?: boolean;
	/** Persistent lifecycle agents remain alive and have no initial task. */
	persistent?: boolean;
	model?: string;
	tools?: string[];
}): { dir: string; sessionFile: string; scriptFile: string } {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-shepherd-"));
	const safe = opts.name.replace(/[^\w.-]+/g, "_") || "agent";
	const sessionFile = path.join(dir, `session-${safe}.jsonl`);
	const scriptFile = path.join(dir, `launch-${safe}.sh`);
	const doneExt = fileURLToPath(new URL("./shepherd-done.ts", import.meta.url));

	const args: string[] = ["--session", shellQuote(sessionFile), "-e", shellQuote(doneExt)];
	if (opts.model) args.push("--model", shellQuote(opts.model));
	if (opts.omitContextFiles) args.push("--no-context-files");
	const tools =
		opts.tools && opts.tools.length > 0
			? [...opts.tools, "shepherd_done"].join(",")
			: undefined;
	if (tools) args.push("--tools", tools);

	let systemPromptFile: string | undefined;
	if (opts.systemPrompt !== undefined) {
		systemPromptFile = path.join(dir, `sysprompt-${safe}.md`);
		fs.writeFileSync(systemPromptFile, opts.systemPrompt, { encoding: "utf8", mode: 0o600 });
		// In append mode shepherd-done puts the agent file context first and
		// retains Pi's built-in prompt after it. Passing --append-system-prompt
		// here would add the same context a second time.
		if (opts.omitSystemPrompt) args.push("--system-prompt", shellQuote(systemPromptFile));
	}
	if (opts.task !== undefined) {
		const taskFile = path.join(dir, `task-${safe}.md`);
		const task = `${opts.task}\n\n[Autonomous agent]\nComplete this task autonomously in this Herdr tab. When finished, call the shepherd_done tool to signal completion and return your output to the caller. Keep your FINAL assistant message a concise summary of what you did and found.`;
		fs.writeFileSync(taskFile, task, { encoding: "utf8", mode: "0600" });
		args.push(`'@${taskFile}'`);
	}

	const launchScript = [
		"#!/bin/bash",
		`export PI_SHEPHERD_SESSION=${shellQuote(sessionFile)}`,
		systemPromptFile
			? `export PI_SHEPHERD_AGENT_SYSTEM_PROMPT_FILE=${shellQuote(systemPromptFile)}`
			: "unset PI_SHEPHERD_AGENT_SYSTEM_PROMPT_FILE",
		opts.omitPiDocumentation
			? "export PI_SHEPHERD_OMIT_PI_DOCUMENTATION=1"
			: "unset PI_SHEPHERD_OMIT_PI_DOCUMENTATION",

		`export PI_SHEPHERD_AUTO_EXIT=${opts.persistent ? 0 : 1}`,
		opts.stayOpen || opts.persistent ? "export PI_SHEPHERD_STAY_OPEN=1" : "export PI_SHEPHERD_STAY_OPEN=0",
		`pi ${args.join(" ")}; echo '__SHEPHERD_DONE_'$?'__'`,
	].join("\n");
	fs.writeFileSync(scriptFile, launchScript, { mode: 0o700 });
	return { dir, sessionFile, scriptFile };
}

/**
 * Boot pi in an existing pane via the launch script (same mechanism as the
 * one-shot delegation path). The temp dir is intentionally RETAINED while the
 * pane's pi is alive — removing it would make the still-running pi hit ENOENT
 * on its own session file (AGENTS.md invariant).
 */
export function launchPiInPane(
	paneId: string,
	opts: {
		name: string;
		task?: string;
		stayOpen?: boolean;
		persistent?: boolean;
		systemPrompt?: string;
		omitSystemPrompt?: boolean;
		omitPiDocumentation?: boolean;
		omitContextFiles?: boolean;
		model?: string;
		tools?: string[];
	},
): { dir: string; sessionFile: string; scriptFile: string } {
	const files = writePiLaunchFiles(opts);
	sendCommandInHerdr(paneId, `bash ${shellQuote(files.scriptFile)}`);
	return files;
}

/**
 * Poll until Herdr has detected the agent session for the pane (or timeout).
 * Used as the post-start readiness check and the pre-prompt gate.
 */
export async function waitForHerdrAgentDetected(
	paneId: string,
	options: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<{ detected: boolean; state?: string }> {
	const timeoutMs = options.timeoutMs ?? 20_000;
	const intervalMs = options.intervalMs ?? 500;
	const deadline = Date.now() + timeoutMs;
	let state: string | undefined;
	while (Date.now() <= deadline) {
		try {
			const out = herdrExecSync(["agent", "get", paneId]);
			const rec = (out as any)?.result?.agent as Record<string, unknown> | undefined;
			if (rec && rec.pane_id === paneId) {
				state = typeof rec.agent_status === "string" ? rec.agent_status : undefined;
				return { detected: true, state };
			}
		} catch {
			/* not yet detected */
		}
		if (Date.now() >= deadline) break;
		await new Promise((r) => setTimeout(r, intervalMs));
	}
	return { detected: false, state };
}

export interface CompletionSignal {
	type?: string;
	errorMessage?: string;
	signalId?: string;
}

/** Read the latest atomic completion signal emitted by the child. */
export function readCompletionSignal(signalPath: string): CompletionSignal | undefined {
	try {
		const value = JSON.parse(fs.readFileSync(signalPath, "utf8"));
		return value && typeof value === "object" ? value as CompletionSignal : undefined;
	} catch {
		return undefined;
	}
}

export async function readPaneTail(paneId: string): Promise<string> {
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
 * True when no `pi` process is running in the pane (the launch script has
 * finished and echoed its sentinel). Used to confirm a sentinel match is the
 * shell's real completion echo and not arbitrary subagent output.
 */
async function piProcessGone(paneId: string): Promise<boolean> {
	try {
		const { stdout } = await execFileAsync(
			"herdr",
			["pane", "process-info", "--pane", paneId],
			{ encoding: "utf8" },
		);
		const fg =
			(JSON.parse(stdout) as any)?.result?.process_info?.foreground_processes ?? [];
		return !Array.isArray(fg) || fg.every((p: any) => !p?.argv?.includes?.("pi"));
	} catch {
		return false; // assume still running when we can't check — safer
	}
}

/**
 * Read the completion sentinel, but ONLY when pi has actually exited.
 *
 * The launch script's `echo '__SHEPHERD_DONE_$?__'` runs after pi exits, so a
 * real sentinel always sits at the very end of the pane tail (a following
 * shell prompt may land after it) with no pi process left. Matching anywhere
 * in the tail is unsafe: a subagent's own output can legitimately contain the
 * literal marker (e.g. grep over this repo's PLAN.md, which documents the
 * sentinel), and during the 1s poll window that output can be the tail's last
 * line while pi is still running. Trusting it then makes the parent declare
 * the run done, delete the child's session dir mid-run (ENOENT, corrupted
 * run, "(no output)" pickup) and return before the subagent finished.
 */
async function doneSentinelInTail(paneId: string): Promise<number | null> {
	const tail = await readPaneTail(paneId);
	const nonEmpty = tail
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l.length > 0);
	let code: number | null = null;
	for (let i = nonEmpty.length - 1; i >= Math.max(0, nonEmpty.length - 3); i--) {
		const m = nonEmpty[i].match(DONE_SENTINEL);
		if (m) {
			code = Number(m[1]);
			break;
		}
	}
	if (code === null) return null;
	// Sentinel text alone is not proof (see above) — require pi to be gone.
	if (!(await piProcessGone(paneId))) return null;
	return code;
}
