/**
 * pi-shepherd — no-fuss pi extension: subagents + herding pi agents in Herdr.
 *
 * Phases 1-4: agent discovery (discovery.ts), isolated subagents
 * (subagent.ts), built-in agents (.pi/agents), and Herdr herding (herd.ts).
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { discoverAgents, formatAgentList } from "./discovery.ts";
import { registerSubagentTool, subagentOnce } from "./subagent.ts";
import { registerHerdTool, isHerdrAvailable } from "./herd.ts";

export default function (pi: ExtensionAPI) {
	// Tools for natural-language use.
	registerSubagentTool(pi);
	registerHerdTool(pi);

	pi.registerCommand("pi-shepherd", {
		description: "pi-shepherd: list | herd | <agent> <task>",
		handler: async (args, ctx: ExtensionCommandContext) => {
			const arg = (args ?? "").trim();

			if (arg === "list" || arg === "agents") {
				// Default scope: user agents + bundled base. Pass an explicit scope to
				// include project agents (trust-gated) — see discovery.ts.
				const { agents, projectDirs } = discoverAgents(ctx.cwd, "user");
				const { text, remaining } = formatAgentList(agents, 20);
				ctx.ui?.notify(
					`pi-shepherd agents (user scope, ${agents.length}): ${text}${
						remaining > 0 ? ` (+${remaining} more)` : ""
					}`,
					"info",
				);
				return;
			}

			if (arg === "herd") {
				if (!isHerdrAvailable()) {
					ctx.ui?.notify(
						"pi-shepherd: not in a Herdr session (HERDR_ENV=1 + herdr on PATH required). The 'subagent' tool still works.",
						"warning",
					);
					return;
				}
				ctx.ui?.notify(
					"pi-shepherd herd: ask me to herd agents (e.g. \"list the agents in herdr\", \"start a reviewer agent\", \"prompt the worker\").",
					"info",
				);
				return;
			}

			// Fallback: <agent> <task> → run one subagent.
			const space = arg.indexOf(" ");
			if (space > 0) {
				const agent = arg.slice(0, space);
				const task = arg.slice(space + 1).trim();
				if (task) {
					ctx.ui?.setStatus?.(`pi-shepherd: running ${agent}…`);
					const result = await subagentOnce({ agent, task, cwd: ctx.cwd });
					ctx.ui?.setStatus?.(undefined);
					if (!result.ok) {
						ctx.ui?.notify(`pi-shepherd: ${agent} failed — ${result.text.slice(0, 400)}`, "error");
						return;
					}
					ctx.ui?.notify(`pi-shepherd ${agent}: ${result.text.slice(0, 2000)}`, "info");
					return;
				}
			}

			ctx.ui?.notify(
				`pi-shepherd: try /pi-shepherd list, /pi-shepherd herd, or /pi-shepherd <agent> <task>` +
					(arg ? ` (unhandled arg: ${arg})` : ""),
				"info",
			);
		},
	});
}