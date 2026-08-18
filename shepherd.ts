/**
 * Shepherd tool — the model-facing `shepherd` tool for the parent pi session.
 *
 * One tool surface:
 *   - start/prompt/wait/status/read/close/gc — manage pi agents living in
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
import { AgentScopeSchema, StartParams, LifecyclePromptParams, WaitParams, LifecycleStatusParams, LifecycleCloseParams } from "./types.ts";
import { startAgent, promptAgent, waitPrompts, statusAgent, closeAgent } from "./lifecycle.ts";
import type { DelegatorModel } from "./discovery.ts";
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

const ListParams = Type.Object({
	action: Type.Literal("list", { description: "List Herdr panes and detected agents." }),
});
const AgentsParams = Type.Object({
	action: Type.Literal("agents", { description: "List available discovered agent definitions and their source metadata.",}),
	agentScope: Type.Optional(AgentScopeSchema),
});
const ReadParams = Type.Object({
	action: Type.Literal("read", { description: "Read recent terminal output from a pane or agent." }),
	name: Type.String({ description: "Name or pane id of the target agent." }),
	lines: Type.Optional(Type.Integer({ description: "Number of recent lines for read (default 40)", default: 40 })),
	source: Type.Optional(SourceSchema),
});
const GcParams = Type.Object({
	action: Type.Literal("gc", { description: "Prune stale pi-shepherd pane registrations." }),
});

export const ShepherdParams = Type.Union(
	[
	ListParams,
	AgentsParams,
	StartParams,
	LifecyclePromptParams,
	WaitParams,
	LifecycleStatusParams,
	LifecycleCloseParams,
	ReadParams,
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
		case "start": {
			const a: any = args;
			const handle = await startAgent(a.agent, a, ctx);
			return textResult(`Started idle agent ${a.agent} (${handle.id}). Use details.handle for prompt, status, and close; pass it as an object, JSON text, or its id.`, { handle });
		}
		case "prompt": {
			const a: any = args;
			const handle = await promptAgent(a.handle, a.message, { timeout: a.timeout });
			return textResult(`Prompt submitted (${handle.id}); call wait with this handle. Pass the complete details.handle object (or its JSON form/id) to the next action.`, { handle });
		}
		case "wait": {
			const a: any = args;
			const result = await waitPrompts(a.handle, { timeout: a.timeout });
			return textResult(JSON.stringify(result), { result });
		}
		case "status": {
			const a: any = args;
			const result = statusAgent(a.handle);
			return textResult(JSON.stringify(result), { status: result });
		}
		case "close": {
			const a: any = args;
			const handle = closeAgent(a.handle);
			return textResult(`Closed agent ${handle.id}.`, { handle });
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

		case "read": {
			const target = args.name?.trim();
			if (!target) return textResult("Provide a name/pane target (action=read).", {});
			const lines = args.lines ?? 40;
			const source = args.source ?? "recent-unwrapped";
			// Resolve a shepherd pane by its recorded paneId or label (same as
			// prompt/close) so `read scout` works after a lifecycle start.
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
	"Use shepherd action=agents to retrieve available agent definitions.",
	"Start an idle agent, then prompt it and wait on the returned prompt handle; wait accepts an array for parallel work.",
	"Agents remain alive after wait and must be explicitly closed.",
];

export function registerShepherdTool(pi: ExtensionAPI) {
	pi.registerTool({
		name: "shepherd",
		label: "Shepherd (manage Herdr agents)",
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
			const target = args.agent || args.name || args.handle ? ` ${previewText(args.agent || args.name || args.handle)}` : "";
			const extra = action === "prompt" ? (previewText(args.message) ? ` "${previewText(args.message)}"` : "") : "";
			const component = reusableText(context.lastComponent);
			component.setText(
				theme.fg("toolTitle", theme.bold("shepherd ")) +
					theme.fg("accent", action) +
					theme.fg("dim", `${target}${extra}`),
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
