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

import { execFile, execFileSync } from "node:child_process";
import * as path from "node:path";
import { promisify } from "node:util";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";

const execFileAsync = promisify(execFile);

/** True when the caller is inside a Herdr session and the CLI is reachable. */
export function isHerdrAvailable(): boolean {
	if (process.env.HERDR_ENV !== "1") return false;
	try {
		execFileSync("herdr", ["--version"], { stdio: "ignore", timeout: 3000 });
		return true;
	} catch {
		return false;
	}
}

const HERDR_SETUP_HINT = "Start pi inside herdr (run `herdr`, then `pi`), or set HERDR_ENV=1 with herdr on PATH.";

function herdrExecSync(args: string[]): unknown {
	const stdout = execFileSync("herdr", args, { encoding: "utf8" });
	return JSON.parse(stdout);
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
			terminalTitle: typeof rec.terminal_title === "string" ? rec.terminal_title : "",
		});
	}
	return out;
}

function formatSummary(s: HerdAgentSummary): string {
	const who = s.focused ? `${s.name} (self/focused)` : s.name;
	return `• ${who} [${s.state}] pane=${s.paneId}${s.cwd ? ` cwd=${s.cwd}` : ""}`;
}

// ── Tool schema ────────────────────────────────────────────────────────────

const ActionSchema = StringEnum(["list", "start", "prompt", "status", "read"] as const, {
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
				return textResult(
					`Started pi agent "${name}" in pane ${paneId}.\nYou can target it with herd (name=${name} or pane=${paneId}).`,
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

		default:
			return textResult(`Unknown herd action: ${action}`, {});
	}
}

export function registerHerdTool(pi: ExtensionAPI) {
	pi.registerTool({
		name: "herd",
		label: "Herd (Herdr agents)",
		description: [
			"Manage pi agents running in Herdr panes: list, start a sibling, prompt, status, read.",
			`Actions: list | start | prompt | status | read. Requires a running Herdr session (HERDR_ENV=1).`,
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