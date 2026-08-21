/**
 * pi-shepherd — no-fuss pi extension: subagents + herding pi agents in Herdr.
 *
 * Agent discovery (discovery.ts), lifecycle primitives (lifecycle.ts), built-in
 * agents (.pi/agents), and Herdr herding (herdr.ts).
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { discoverAgents } from "./discovery.ts";
import { loadSettings } from "./settings.ts";
import { openSettings, registerSettingsCommand } from "./settings-ui.ts";
import { registerShepherdTool } from "./shepherd.ts";
import { startAgent } from "./lifecycle.ts";
import { resolveOrCreateParentArtifactSession } from "./artifact-sessions.ts";
import {
	isHerdrAvailable,
	listHerdrAgents,
	formatSummary,
	workingSubagents,
	type HerdrAgentSummary,
} from "./herdr.ts";

/**
 * Persistent "below the editor" status line listing the subagents currently
 * working (see tui.md Pattern 5 / widget-placement.ts). Polls the live herd
 * every ~1s and re-renders on change. Safe no-op when Herdr isn't reachable.
 */
function registerSubagentStatusWidget(pi: ExtensionAPI): void {
	const POLL_MS = 1_000;
	let last = "";

	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;
		ctx.ui.setWidget(
			"pi-shepherd-working",
			(tui, theme) => {
				const tick = (): void => {
					const line = renderWorkingLine(workingSubagents(), theme);
					if (line !== last) {
						last = line;
						tui.requestRender();
					}
				};
				tick();
				const timer = setInterval(tick, POLL_MS);
				return {
					render: () => (last ? [last] : []),
					invalidate: () => {
						// Theme changed → re-render from the current snapshot, keep polling.
						tick();
					},
					dispose: () => clearInterval(timer),
				};
			},
			{ placement: "belowEditor" },
		);
	});
}

function renderWorkingLine(
	agents: HerdrAgentSummary[],
	theme: {
		fg(color: string, text: string): string;
		dim(text: string): string;
	},
): string {
	if (agents.length === 0) return "";
	const parts = agents.map((a) => {
		const name = theme.fg("accent", a.name);
		const state = theme.fg("muted", a.state);
		return `● ${name} [${state}]`;
	});
	return (
		theme.fg("dim", "working: ") + parts.join(theme.fg("dim", "  "))
	);
}

type StartCommandOptions = {
	agentScope?: "user" | "project" | "both";
	placement?: "pane" | "tab" | "workspace";
	direction?: "right" | "down";
	cwd?: string;
	model?: string;
	omitSystemPrompt?: boolean;
};

/**
 * Parse the small, human-facing subset of StartParams used by `/shepherd`.
 * The canonical model-facing API remains the structured `shepherd` tool; this
 * adapter keeps the common interactive form (`start worker`) convenient while
 * still exposing the useful placement/scope options.
 */
function parseStartCommand(tokens: string[]):
	| { agent: string; options: StartCommandOptions }
	| { error: string } {
	const agent = tokens[1];
	if (!agent || agent.startsWith("--")) {
		return { error: "Usage: /shepherd start <agent> [--scope user|project|both] [--placement pane|tab|workspace]" };
	}

	const options: StartCommandOptions = {};
	const values = new Map<string, keyof StartCommandOptions>([
		["--scope", "agentScope"],
		["--agent-scope", "agentScope"],
		["--placement", "placement"],
		["--direction", "direction"],
		["--cwd", "cwd"],
		["--model", "model"],
	]);
	for (let i = 2; i < tokens.length; i++) {
		const token = tokens[i];
		if (token === "--omit-system-prompt") {
			options.omitSystemPrompt = true;
			continue;
		}
		const equals = token.indexOf("=");
		const flag = equals >= 0 ? token.slice(0, equals) : token;
		const key = values.get(flag);
		if (!key) return { error: `Unknown start option "${token}".` };
		const value = equals >= 0 ? token.slice(equals + 1) : tokens[++i];
		if (!value || value.startsWith("--")) return { error: `Missing value for ${flag}.` };
		(options as Record<string, string>)[key] = value;
	}

	if (options.agentScope && !["user", "project", "both"].includes(options.agentScope)) {
		return { error: `Invalid scope "${options.agentScope}"; use user, project, or both.` };
	}
	if (options.placement && !["pane", "tab", "workspace"].includes(options.placement)) {
		return { error: `Invalid placement "${options.placement}"; use pane, tab, or workspace.` };
	}
	if (options.direction && !["right", "down"].includes(options.direction)) {
		return { error: `Invalid direction "${options.direction}"; use right or down.` };
	}
	return { agent, options };
}

function parentArtifactSessionForCommand(ctx: ExtensionCommandContext) {
	const parentPiSessionId = ctx.sessionManager?.getSessionId?.();
	if (!parentPiSessionId) return undefined;
	return resolveOrCreateParentArtifactSession({
		parentPiSessionId,
		parentSessionFile: ctx.sessionManager?.getSessionFile?.(),
		projectRoot: ctx.cwd,
	});
}

export default function (pi: ExtensionAPI) {
	// Command autocomplete callbacks receive only the typed argument prefix,
	// not ExtensionCommandContext. Keep the active session cwd available for
	// discovered sheep completion instead of falling back to the extension's
	// process cwd.
	let shepherdCommandCwd = process.cwd();
	pi.on("session_start", (_event, ctx) => {
		shepherdCommandCwd = ctx.cwd;
	});

	// Tools for natural-language use.
	registerShepherdTool(pi);
	registerSettingsCommand(pi);
	registerSubagentStatusWidget(pi);

	pi.registerCommand("shepherd", {
		description: "pi-shepherd: sheep | herd | start | settings",
		// Keep completion aligned with the action names in the model-facing
		// `shepherd` tool. Agent names are discovered fresh so user-defined sheep
		// are available here too.
		getArgumentCompletions: (prefix) => {
			const parts = prefix.split(/\s+/);
			const action = parts[0] ?? "";
			if (parts.length <= 1 && !prefix.endsWith(" ")) {
				// Pi does not automatically invoke the completion provider again
				// after applying an argument completion. When the user types
				// `/shepherd sta`, show full `start <sheep>` entries immediately
				// instead of requiring a second completion cycle after `start`.
				const wantsStartCandidates =
					action === "start" || (action.length >= 3 && "start".startsWith(action));
				if (wantsStartCandidates) {
					const { agents } = discoverAgents(shepherdCommandCwd, loadSettings().agentScope);
					const candidates = agents.filter((agent) => agent.name.length > 0);
					if (candidates.length > 0) {
						return candidates.map((agent) => ({
							value: `start ${agent.name}`,
							label: `start ${agent.name}`,
							description: agent.description,
						}));
					}
				}
				const actions = ["sheep", "herd", "start", "settings"];
				const filtered = actions.filter((s) => s.startsWith(action));
				return filtered.length > 0
					? filtered.map((value) => ({ value, label: value }))
					: null;
			}
			if (action === "start") {
				const agentPrefix = prefix.slice("start".length).trim();
				const { agents } = discoverAgents(shepherdCommandCwd, loadSettings().agentScope);
				const filtered = agents
					.map((agent) => agent.name)
					.filter((name) => name.startsWith(agentPrefix));
				// Command completion replaces the complete argument string, not just
				// the final token. Preserve the action or Enter turns `start scout`
				// into only `scout`.
				return filtered.length > 0
					? filtered.map((value) => ({ value: `start ${value}`, label: value }))
					: null;
			}
			return null;
		},
		handler: async (args, ctx: ExtensionCommandContext) => {
			const arg = (args ?? "").trim();
			const tokens = arg ? arg.split(/\s+/) : [];
			const action = tokens[0] ?? "";

			if (action === "settings") {
				await openSettings(ctx);
				return;
			}

			if (action === "sheep" || action === "list" || action === "agents") {
				// `list` and `agents` remain accepted as compatibility aliases, but
				// `sheep` is the canonical action (and the only completion shown).
				const scopeArg = tokens[1];
				const scope = ["user", "project", "both"].includes(scopeArg ?? "")
					? (scopeArg as "user" | "project" | "both")
					: loadSettings().agentScope;
				const { agents } = discoverAgents(ctx.cwd, scope);
				const shown = agents.slice(0, 20);
				const remaining = agents.length - shown.length;
				const listing = shown.length > 0
					? shown.map((agent) => `- ${agent.name} (${agent.source}): ${agent.description}`).join("\n")
					: "- none";
				ctx.ui?.notify(
					`pi-shepherd sheep (${scope} scope, ${agents.length}):\n${listing}${
						remaining > 0 ? `\n(+${remaining} more)` : ""
						}${action !== "sheep" ? "\nUse `/shepherd sheep` next time." : ""}`,
					"info",
				);
				return;
			}

			if (action === "herd") {
				if (!isHerdrAvailable()) {
					ctx.ui?.notify(
						"pi-shepherd: Herdr runtime not reachable (the `herdr` CLI on PATH and a running server are required). Start Herdr with `herdr`, or run pi inside a Herdr pane.",
						"warning",
					);
					return;
				}
				const agents = listHerdrAgents();
				ctx.ui?.notify(
					agents.length > 0
						? agents.map(formatSummary).join("\n")
						: "No sheep detected in Herdr.",
					"info",
				);
				return;
			}

			if (action === "start") {
				if (!isHerdrAvailable()) {
					ctx.ui?.notify(
						"pi-shepherd: Herdr runtime not reachable. Start Herdr with `herdr`, or run pi inside a Herdr pane.",
						"warning",
					);
					return;
				}
				const parsed = parseStartCommand(tokens);
				if ("error" in parsed) {
					ctx.ui?.notify(`pi-shepherd: ${parsed.error}`, "warning");
					return;
				}
				ctx.ui?.setStatus?.("pi-shepherd", `Starting ${parsed.agent}…`);
				try {
					const handle = await startAgent(
						parsed.agent,
						{
							...parsed.options,
							agentScope: parsed.options.agentScope ?? loadSettings().agentScope,
							confirmProjectAgents: loadSettings().confirmProjectAgents,
							artifactSession: parentArtifactSessionForCommand(ctx),
						},
						ctx,
					);
					const location = handle.tabId ? `tab ${handle.tabId}` : `pane ${handle.paneId ?? "unknown"}`;
					ctx.ui?.notify(
						`Started idle sheep ${parsed.agent} (${location}). It is interactive and ready for you in Herdr; pi-shepherd will not send a task. Handle: ${handle.id}`,
						"info",
					);
				} catch (error: any) {
					ctx.ui?.notify(`pi-shepherd: could not start ${parsed.agent}: ${error?.message ?? error}`, "error");
				} finally {
					ctx.ui?.setStatus?.("pi-shepherd", undefined);
				}
				return;
			}

			ctx.ui?.notify(
				`pi-shepherd: try /shepherd sheep, /shepherd herd, /shepherd start <agent>, or /shepherd settings` +
					(action ? ` (unhandled action: ${action})` : ""),
				"info",
			);
		},
	});
}