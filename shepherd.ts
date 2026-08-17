/**
 * Shepherd tool — the model-facing `shepherd` tool for the parent pi session.
 *
 * One tool, two surface areas:
 *   - action=delegate — delegate tasks to subagents (single/parallel/chain),
 *     each running live in its own Herdr tab (machinery in subagent.ts).
 *   - list/start/prompt/status/read/close/gc — manage pi agents living in
 *     Herdr panes (machinery in herdr.ts).
 *
 * Registered by index.ts in the parent session only. Delegated children get
 * the separate in-tab `shepherd_done` tool from shepherd-done.ts instead.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import { TaskItem, ChainItem, AgentScopeSchema } from "./types.ts";
import type { DelegatorModel } from "./discovery.ts";
import { executeDelegation } from "./subagent.ts";
import { discoverAgents, formatAgentList } from "./discovery.ts";
import {
	HERDR_SETUP_HINT,
	agentSummaries,
	createHerdrTab,
	formatSummary,
	getHerdrWorkspaceId,
	herdrExec,
	herdrExecSync,
	isHerdrAvailable,
	launchPiInPane,
	loadCreatedPanes,
	paneExists,
	paneIdOf,
	pruneStaleCreatedPanes,
	readPaneTail,
	recordCreatedPane,
	removeCreatedPaneDir,
	setCreatedPaneDir,
	waitForHerdrAgentDetected,
	waitForHerdrShellReady,
} from "./herdr.ts";

const execFileAsync = promisify(execFile);
const SourceSchema = StringEnum(["visible", "recent", "recent-unwrapped", "detection"] as const, {
	description: "Terminal snapshot source for read",
	default: "recent-unwrapped",
});

const DelegateParams = Type.Object({
	action: Type.Literal("delegate", {
		description: "Delegate a task to one or more discovered agents and wait for completion.",
	}),
	name: Type.Optional(
		Type.String({
			description:
				"Agent name or pane id target; also the label used for the new pane on start.",
		}),
	),
	agent: Type.Optional(
		Type.String({
			description:
				"Exact discovered agent name for delegation (case-sensitive). Run /shepherd agents first and copy a name exactly; do not invent aliases.",
		}),
	),
	task: Type.Optional(Type.Union([Type.String({ description: "Task to delegate." }), Type.Null({ description: "Null for bare mode." })])),
	tasks: Type.Optional(
		Type.Array(TaskItem, {
			description:
				"Parallel delegation items. Every agent must be an exact name from /shepherd agents; all names are validated before any tab or artifact starts.",
		}),
	),
	chain: Type.Optional(
		Type.Array(ChainItem, {
			description:
				"Sequential delegation items. Every agent must be an exact name from /shepherd agents; all names are validated before any tab or artifact starts.",
		}),
	),
	sessionName: Type.Optional(Type.String({ description: "Optional artifact-backed session name for delegation." })),
	cwd: Type.Optional(Type.String({ description: "Working directory for a new pane or delegated task" })),
	agentScope: Type.Optional(AgentScopeSchema),
	confirmProjectAgents: Type.Optional(
		Type.Boolean({ description: "Prompt before running project-local agents. Default: true.", default: true }),
	),
	mode: Type.Optional(
		StringEnum(["single", "parallel", "chain", "bare"] as const, {
			description: "Delegation mode. Bare starts an interactive agent with no initial task.",
		}),
	),
	keepOpen: Type.Optional(
		Type.Boolean({
			description: "Keep the Herdr tab open after completion for inspection. Default: true.",
			default: true,
		}),
	),
	stayOpen: Type.Optional(
		Type.Boolean({
			description:
				"Keep the subagent's pi process alive after it completes, so you can keep driving it in the tab. Default: false.",
			default: false,
		}),
	),
	omitSystemPrompt: Type.Optional(
		Type.Boolean({
			description: "Override the selected agent's omit-system-prompt frontmatter.",
		}),
	),
	timeout: Type.Optional(
		Type.Integer({ description: "Wait timeout (ms) for prompt settle or delegation run (default 120000)", default: 120000 }),
	),
});

const ListParams = Type.Object({
	action: Type.Literal("list", { description: "List Herdr panes and detected agents." }),
});
const AgentsParams = Type.Object({
	action: Type.Literal("agents", { description: "List available discovered agent definitions and their source metadata.",}),
	agentScope: Type.Optional(AgentScopeSchema),
});
const PromptParams = Type.Object({
	action: Type.Literal("prompt", { description: "Send a task to an existing agent and wait for completion." }),
	name: Type.String({ description: "Name or pane id of the target agent." }),
	task: Type.String({ description: "Task to send to the target agent." }),
	timeout: Type.Optional(Type.Integer({ description: "Wait timeout (ms) for prompt settle.", default: 120000 })),
});
const StatusParams = Type.Object({
	action: Type.Literal("status", { description: "Inspect the current Herdr agent status for a pane or label." }),
	name: Type.String({ description: "Name or pane id of the target agent." }),
});
const ReadParams = Type.Object({
	action: Type.Literal("read", { description: "Read recent terminal output from a pane or agent." }),
	name: Type.String({ description: "Name or pane id of the target agent." }),
	lines: Type.Optional(Type.Integer({ description: "Number of recent lines for read (default 40)", default: 40 })),
	source: Type.Optional(SourceSchema),
});
const CloseParams = Type.Object({
	action: Type.Literal("close", { description: "Close a pane that was created by pi-shepherd." }),
	name: Type.String({ description: "Name or pane id to close." }),
});
const GcParams = Type.Object({
	action: Type.Literal("gc", { description: "Prune stale pi-shepherd pane registrations." }),
});

export const ShepherdParams = Type.Union(
	[
	DelegateParams,
	ListParams,
	AgentsParams,
	PromptParams,
	StatusParams,
	ReadParams,
	CloseParams,
	GcParams,
	],
	{ description: "Action-discriminated shepherd commands for delegating work and managing Herdr panes." },
);

type ShepherdArgs = Static<typeof ShepherdParams>;

function unavailableResult(): AgentToolResult<Record<string, unknown>> {
	return {
		content: [{ type: "text", text: `Herd requires a running Herdr session.\n${HERDR_SETUP_HINT}` }],
		details: { error: "herdr not available" },
		isError: true,
	} as AgentToolResult<Record<string, unknown>>;
}

function textResult(text: string, details: Record<string, unknown>): AgentToolResult<Record<string, unknown>> {
	return { content: [{ type: "text" as const, text }], details };
}

/** Keep tool-call previews compact without rendering an empty placeholder. */
function previewText(value: unknown, maxLength = 40): string {
	const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : String(value ?? "");
	return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

function delegationItemPreview(item: unknown): string {
	if (!item || typeof item !== "object") return "?";
	const entry = item as { agent?: unknown; task?: unknown };
	const agent = previewText(entry.agent) || "?";
	const task = previewText(entry.task);
	return agent + (task ? ` "${task}"` : "");
}

/**
 * Render the arguments that select a delegation mode. In particular, don't use
 * the single-task preview for array modes: those calls have no top-level task,
 * which used to result in the unhelpful `"…"` being displayed.
 */
function delegationPreview(args: ShepherdArgs): string {
	if (args.action !== "delegate") return "";
	if (Array.isArray(args.chain) && args.chain.length > 0) {
		return ` [chain: ${args.chain.map(delegationItemPreview).join(" → ")}]`;
	}
	if (Array.isArray(args.tasks) && args.tasks.length > 0) {
		return ` [parallel: ${args.tasks.map(delegationItemPreview).join(", ")}]`;
	}

	const target = previewText(args.agent || args.name);
	const task = previewText(args.task);
	return (target ? ` ${target}` : "") + (task ? ` "${task}"` : "");
}

function reusableText(lastComponent: unknown): Text {
	return lastComponent instanceof Text ? lastComponent : new Text("", 0, 0);
}

async function doAction(
	args: ShepherdArgs,
	ctx: { cwd: string; model?: DelegatorModel; hasUI?: boolean; ui?: any },
	signal?: AbortSignal,
	onUpdate?: (partial: AgentToolResult<Record<string, unknown>>) => void,
): Promise<AgentToolResult<Record<string, unknown>>> {
	switch (args.action) {
		case "delegate": {
			const agentName = args.agent ?? args.name;
			const params = {
				sessionName: args.sessionName,
				agent: agentName,
				task: args.task,
				tasks: args.tasks,
				chain: args.chain,
				mode: args.mode,
				agentScope: args.agentScope,
				confirmProjectAgents: args.confirmProjectAgents,
				cwd: args.cwd,
				keepOpen: args.keepOpen,
				stayOpen: args.stayOpen,
				timeout: args.timeout,
				omitSystemPrompt: args.omitSystemPrompt,
			};
			return executeDelegation(params, signal, onUpdate as any, ctx);
		}

		case "agents": {
			// List discovered agent definitions (for delegation).
			const scope = args.agentScope ?? "user";
			const { agents, projectDirs } = discoverAgents(ctx.cwd, scope);
			if (agents.length === 0)
				return textResult("No agent definitions found.", { agents: [], projectDirs, scope });
			const lines = agents.map((a) => `${a.name} (${a.source}): ${a.description}`);
			return textResult(lines.join("\n"), { agents, projectDirs, scope });
		}

		case "list": {
			// Silently drop registrations for panes that no longer exist so a
			// long-lived session doesn't accumulate stale entries.
			pruneStaleCreatedPanes();
			const out = herdrExecSync(["agent", "list"]);
			const agents = agentSummaries(out);
			if (agents.length === 0)
				return textResult("No agents detected in Herdr.", { agents });
			return textResult(agents.map(formatSummary).join("\n"), { agents });
		}

		case "prompt": {
			const target = args.name?.trim();
			const task = args.task?.trim() || "";
			if (!target || !task)
				return textResult("Provide a name/pane target and a task (action=prompt).", {});
			const timeout = args.timeout ?? 120_000;
			// Resolve a shepherd pane by its recorded paneId or label — a bare
			// label like "worker" isn't directly addressable by Herdr.
			const created = loadCreatedPanes();
			const match = created.find((p) => p.paneId === target || p.name === target);
			const resolved = match?.paneId ?? target;
			// Readiness gate — never send a task to a pane Herdr hasn't detected
			// (the old code could silently eat tasks this way). Nothing is sent
			// if the agent isn't confirmed present.
			const det = await waitForHerdrAgentDetected(resolved, {
				timeoutMs: Math.min(timeout, 15_000),
			});
			if (!det.detected) {
				return {
					content: [
						{
							type: "text",
							text: `Agent "${target}" was not detected in Herdr — nothing was sent. Confirm the pane is running pi (shepherd status/read), then retry.`,
						},
					],
					details: { name: target, pane: resolved, error: "agent not detected" },
					isError: true,
				};
			}
			const preTail = await readPaneTail(resolved);
			try {
				const out = await herdrExec([
					"agent", "prompt", resolved, task,
					"--wait", "--until", "done",
					"--timeout", String(timeout),
				]);
				const postTail = await readPaneTail(resolved);
				const after = await waitForHerdrAgentDetected(resolved, { timeoutMs: 5000 });
				// Post-check: if the screen never changed and no agent state is
				// visible at all, the task may not have been received. Demoted to a
				// non-blocking note — a legitimately instant task legitimately ends
				// idle with no screen change, so we must not hard-fail on it.
				const unchanged = preTail === postTail && after.state === undefined;
				return textResult(
					`Prompt returned (${JSON.stringify((out as any)?.result ?? out)}).` +
						(unchanged
							? `\nNo screen change observed and no agent state visible — the task may not have been received. Inspect pane ${resolved} and retry if needed.`
							: ""),
					{ name: target, result: out },
				);
			} catch (error: any) {
				const raw = error?.stderr || error?.stdout || String(error?.message ?? error);
				const hang = /agent_prompt_stalled|agent not found/i.test(raw);
				return {
					content: [
						{
							type: "text",
							text: `Prompt to "${target}" did not settle: ${raw}`.slice(0, 4000) +
								(hang
									? "\nNothing was sent to the agent. Retry after herd-status confirms it is at its input prompt."
									: ""),
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
			// Resolve a shepherd pane by its recorded paneId or label (same as
			// prompt/close) so `status scout` works after a delegate/start.
			const created = loadCreatedPanes();
			const match = created.find((p) => p.paneId === target || p.name === target);
			const resolved = match?.paneId ?? target;
			try {
				const out = herdrExecSync(["agent", "get", resolved]);
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
			// Resolve a shepherd pane by its recorded paneId or label (same as
			// prompt/close) so `read scout` works after a delegate/start.
			const created = loadCreatedPanes();
			const match = created.find((p) => p.paneId === target || p.name === target);
			const resolved = match?.paneId ?? target;
			try {
				const { stdout } = await execFileAsync(
					"herdr",
					["agent", "read", resolved, "--source", source, "--lines", String(lines), "--format", "text"],
					{ encoding: "utf8" },
				);
				return textResult(stdout.trim() || "(no terminal output)", { target, lines, source });
			} catch {
				// Agent detection is dropped once the pane's pi exited — fall back
				// to a plain terminal read so finished runs stay inspectable.
				try {
					const { stdout } = await execFileAsync(
						"herdr",
						["pane", "read", resolved, "--source", source, "--lines", String(lines), "--format", "text"],
						{ encoding: "utf8" },
					);
					return textResult(stdout.trim() || "(no terminal output)", { target, lines, source, fallback: true });
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
				let gone = false;
				try {
					herdrExecSync(["pane", "close", p.paneId]);
					gone = true;
				} catch {
					// Don't assume failure means "already gone": a transient/CLI/busy
					// error leaves the pane alive with pi still writing its session
					// file — deleting the dir then would break the ENOENT invariant.
					// Only treat it as gone if Herdr no longer lists the pane.
					gone = !paneExists(p.paneId);
				}
				if (gone) {
					closed.push(p.paneId);
					// Confirmed closed (or confirmed no longer present) → safe to drop
					// the pane's retained temp launch dir now that pi is gone.
					removeCreatedPaneDir(p.paneId);
				}
				forgetCreatedPane(p.paneId);
			}
			return textResult(
				`Closed pi-shepherd pane(s): ${closed.join(", ") || target}`,
				{ closed, target },
			);
		}

		case "gc": {
			const pruned = pruneStaleCreatedPanes();
			const remaining = loadCreatedPanes().length;
			return textResult(
				pruned === 0
					? `No stale pi-shepherd panes to prune (${remaining} registered).`
					: `Pruned ${pruned} stale pane registration(s); ${remaining} remain.`,
				{ pruned, remaining },
			);
		}

		default:
			return textResult(`Unknown herd action: ${action}`, {});
	}
}

export const SHEPHERD_TOOL_DESCRIPTION = [
	"Manage and Delegate work specialized agents inside Herdr panes.",
	"Requires a running Herdr session (HERDR_ENV=1 or headless server).",
].join(" ");

export const SHEPHERD_TOOL_PROMPT_SNIPPET =
	"Manage and Delegate work specialized agents inside Herdr panes.";

export const SHEPHERD_TOOL_PROMPT_GUIDELINES = [
	"Use shepherd action=delegate for isolated scouting, planning, implementation, or review work; use exact agent names from shepherd action=agents.",
	"Use shepherd action=agents before to retrieve available agents before delegating work.",
	"Always end turn after delegating with shepherd. The harness will prompt you when subagents are complete.",
];

export function registerShepherdTool(pi: ExtensionAPI) {
	pi.registerTool({
		name: "shepherd",
		label: "Shepherd (delegate & manage Herdr agents)",
		description: SHEPHERD_TOOL_DESCRIPTION,
		promptSnippet: SHEPHERD_TOOL_PROMPT_SNIPPET,
		promptGuidelines: SHEPHERD_TOOL_PROMPT_GUIDELINES,
		parameters: ShepherdParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			if (!isHerdrAvailable()) return unavailableResult();
			try {
				return await doAction(params as ShepherdArgs, ctx, signal, onUpdate);
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

		renderCall(args, theme, context) {
			const action = args.action ?? "list";
			const target = args.agent || args.name ? ` ${args.agent || args.name}` : "";
			const extra =
				action === "delegate"
					? delegationPreview(args as ShepherdArgs)
					: action === "prompt"
						? (previewText(args.task) ? ` "${previewText(args.task)}"` : "")
						: "";
			const component = reusableText(context.lastComponent);
			component.setText(
				theme.fg("toolTitle", theme.bold("shepherd ")) +
					theme.fg("accent", action) +
					theme.fg("dim", action === "delegate" ? extra : `${target}${extra}`),
			);
			return component;
		},

		renderResult(result, { expanded }, theme, context) {
			const text = result.content[0];
			const body = text?.type === "text" ? (text.text ?? "") : "";
			let rendered: string;
			if (!expanded && body.includes("\n")) {
				const firstLine = body.split("\n")[0];
				rendered =
					theme.fg("accent", firstLine) +
						`\n${theme.fg("muted", `… +${body.split("\n").length - 1} more lines (Ctrl+O to expand)`)}`;
			} else {
				rendered = theme.fg("toolOutput", body || "(no output)");
			}
			const component = reusableText(context.lastComponent);
			component.setText(rendered);
			return component;
		},
	});
}
