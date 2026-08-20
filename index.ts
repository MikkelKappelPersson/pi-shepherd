/**
 * pi-shepherd — no-fuss pi extension: subagents + herding pi agents in Herdr.
 *
 * Agent discovery (discovery.ts), lifecycle primitives (lifecycle.ts), built-in
 * agents (.pi/agents), and Herdr herding (herdr.ts).
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { discoverAgents, formatAgentList } from "./discovery.ts";
import { loadSettings } from "./settings.ts";
import { openSettings, registerSettingsCommand } from "./settings-ui.ts";
import { registerShepherdTool } from "./shepherd.ts";
import { isHerdrAvailable, workingSubagents, type HerdrAgentSummary } from "./herdr.ts";

/**
 * Persistent "below the editor" status line listing the subagents currently
 * working (see tui.md Pattern 5 / widget-placement.ts). Polls `shepherd list`
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

export default function (pi: ExtensionAPI) {
	// Tools for natural-language use.
	registerShepherdTool(pi);
	registerSettingsCommand(pi);
	registerSubagentStatusWidget(pi);

	pi.registerCommand("shepherd", {
		description: "pi-shepherd: list | herd | settings",
		// Native inline autocomplete for the subcommand slot — typing
		// `/shepherd ` shows list/herd/settings + the built-in agents in the
		// writing-field menu, arrow-selectable, like pi's own /model command.
		getArgumentCompletions: (prefix) => {
			const options = ["list", "herd", "settings", "scout", "planner", "reviewer", "worker"];
			const filtered = options.filter((s) => s.startsWith(prefix));
			return filtered.length > 0 ? filtered.map((s) => ({ value: s, label: s })) : null;
		},
		handler: async (args, ctx: ExtensionCommandContext) => {
			const arg = (args ?? "").trim();

			if (arg === "settings") {
				await openSettings(ctx);
				return;
			}

			if (arg === "list" || arg === "agents") {
				// Default scope from settings; pass an explicit scope to include
				// project agents (trust-gated) — see discovery.ts.
				const { agents, projectDirs } = discoverAgents(ctx.cwd, loadSettings().agentScope);
				const { text, remaining } = formatAgentList(agents, 20);
				ctx.ui?.notify(
					`pi-shepherd agents (${loadSettings().agentScope} scope, ${agents.length}): ${text}${
						remaining > 0 ? ` (+${remaining} more)` : ""
					}`,
					"info",
				);
				return;
			}

			if (arg === "herd") {
				if (!isHerdrAvailable()) {
					ctx.ui?.notify(
						"pi-shepherd: Herdr runtime not reachable (the `herdr` CLI on PATH and a running server are required). Start Herdr with `herdr`, or run pi inside a Herdr pane.",
						"warning",
					);
					return;
				}
				ctx.ui?.notify(
					"pi-shepherd herd: ask me to herd agents (e.g. \"list the agents in herdr\", \"start a reviewer agent\", \"prompt the worker\", \"close the scout tab\").",
					"info",
				);
				return;
			}

			ctx.ui?.notify(
				`pi-shepherd: try /shepherd list, /shepherd herd, or /shepherd settings` +
					(arg ? ` (unhandled arg: ${arg})` : ""),
				"info",
			);
		},
	});
}