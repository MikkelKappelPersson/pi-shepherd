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
const ActionSchema = StringEnum(["delegate", "list", "start", "prompt", "status", "read", "close", "gc"] as const, {
	description: "Herd action to perform (delegate | list | start | prompt | status | read | close | gc)",
});
const DirectionSchema = StringEnum(["right", "down"] as const, {
	description: "Split direction for a new sibling pane (start)",
	default: "right",
});
const SourceSchema = StringEnum(["visible", "recent", "recent-unwrapped", "detection"] as const, {
	description: "Terminal snapshot source for read",
	default: "recent-unwrapped",
});

const ShepherdParams = Type.Object({
	action: ActionSchema,
	name: Type.Optional(
		Type.String({
			description:
				"Agent name or pane id target; also the label used for the new pane on start.",
		}),
	),
	agent: Type.Optional(
		Type.String({ description: "Agent name for action=delegate (e.g. scout, worker, reviewer)" }),
	),
	task: Type.Optional(Type.String({ description: "Task to delegate (action=delegate) or prompt to submit (action=prompt/start)." })),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "Array of {agent, task} for parallel delegation (action=delegate)" })),
	chain: Type.Optional(Type.Array(ChainItem, { description: "Array of {agent, task} for sequential delegation (action=delegate)" })),
	mode: Type.Optional(
		StringEnum(["single", "parallel", "chain"] as const, {
			description: "Delegation mode for action=delegate (default: single)",
		}),
	),
	sessionName: Type.Optional(Type.String({ description: "Optional artifact-backed session name for delegation." })),
	direction: Type.Optional(DirectionSchema),
	cwd: Type.Optional(Type.String({ description: "Working directory for a new pane or delegated task" })),
	agentScope: Type.Optional(AgentScopeSchema),
	confirmProjectAgents: Type.Optional(
		Type.Boolean({ description: "Prompt before running project-local agents. Default: true.", default: true }),
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
	lines: Type.Optional(Type.Integer({ description: "Number of recent lines for read (default 40)", default: 40 })),
	source: Type.Optional(SourceSchema),
});

type ShepherdArgs = Static<typeof ShepherdParams>;

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

async function doAction(
	action: string,
	args: ShepherdArgs,
	ctx: { cwd: string; model?: DelegatorModel; hasUI?: boolean; ui?: any },
	signal?: AbortSignal,
	onUpdate?: (partial: AgentToolResult<Record<string, unknown>>) => void,
): Promise<AgentToolResult<Record<string, unknown>>> {
	switch (action) {
		case "delegate": {
			const agentName = args.agent ?? args.name;
			const params = {
				sessionName: args.sessionName,
				agent: agentName,
				task: args.task,
				tasks: args.tasks,
				chain: args.chain,
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

		case "start": {
			const name = args.name?.trim();
			if (!name) return textResult("Provide a name for the new agent (action=start).", {});
			const cwd = args.cwd ?? ctx.cwd ?? process.cwd();
			const direction = args.direction ?? "right";
			const task = args.task?.trim() || undefined;

			let paneId: string;
			let tabId = "";
			const parentPane = process.env.HERDR_PANE_ID;
			if (parentPane) {
				// Split our own pane to create a sibling; reference target output.
				const splitOut = herdrExecSync([
					"pane", "split", parentPane,
					"--direction", direction,
					"--cwd", cwd,
					"--no-focus",
				]);
				paneId = paneIdOf(splitOut, "pane split");
			} else {
				// From a plain terminal there is no pane to split — fall back to a
				// fresh tab in the resolved workspace (reuses the delegation helpers).
				const created = createHerdrTab(name, cwd, getHerdrWorkspaceId());
				paneId = created.paneId;
				tabId = created.tabId;
			}

			// Track the pane as soon as it exists (BEFORE any await) so that even a
			// shell-ready timeout or failed launch leaves a pane `shepherd close` may
			// close — never a closable orphan. Idempotent, so the later launch path
			// is unaffected.
			recordCreatedPane({ paneId, tabId, name, cwd, createdAt: Date.now() });

			try {
				// The flaky `herdr agent start` lifecycle is intentionally skipped:
				// it injected no task and its keystroke prompt timing silently ate
				// tasks on never-focused panes. Instead wait for the shell, boot pi
				// via the trusted launch script (task baked in at launch), and let
				// Herdr auto-detect the session (same as delegation panes do).
				await waitForHerdrShellReady(paneId);

				try {
					herdrExecSync(["pane", "rename", paneId, name]);
				} catch {
					/* cosmetic — ignore */
				}

				const landing = launchPiInPane(paneId, { name, task, stayOpen: true });
				setCreatedPaneDir(paneId, landing.dir);

				// Advisory post-start readiness check (never errors — the pane is
				// visibly open and the launch script ran).
				const det = await waitForHerdrAgentDetected(paneId, { timeoutMs: 20_000 });
				const delivered = task !== undefined ? "task delivered" : "no task";
				const advisory = det.detected
					? ` (agent state: ${det.state ?? "unknown"})`
					: "\npi is booting — verify with shepherd status " + paneId + ".";
				return textResult(
					`Started pi agent "${name}" in pane ${paneId} [${delivered}].` +
						advisory +
						`\nDrive it with shepherd prompt ${paneId} ..., or close with shepherd close ${paneId}.`,
					{ paneId, name, taskDelivered: task !== undefined, agentState: det.state },
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

export function registerShepherdTool(pi: ExtensionAPI) {
	pi.registerTool({
		name: "shepherd",
		label: "Shepherd (delegate & manage Herdr agents)",
		description: [
			"Unifying tool to delegate tasks to subagents or manage agents in Herdr panes.",
			"Actions: delegate | list | start | prompt | status | read | close | gc.",
			"For delegation (action=delegate): pass agent and task (or tasks array for parallel, or chain array for sequential steps).",
			"For fleet management: list active agent panes, start sibling panes, prompt, status, read, or close panes.",
			"Requires a running Herdr session (HERDR_ENV=1 or headless server).",
		].join(" "),
		parameters: ShepherdParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			if (!isHerdrAvailable()) return unavailableResult();
			try {
				return await doAction(params.action, params as ShepherdArgs, ctx, signal, onUpdate);
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
			const target = args.agent || args.name ? ` ${args.agent || args.name}` : "";
			const extra =
				action === "prompt" || action === "delegate"
					? ` "…${((args.task ?? "").length > 40 ? (args.task ?? "").slice(0, 40) + "…" : args.task ?? "")}"`
					: "";
			return new Text(
				theme.fg("toolTitle", theme.bold("shepherd ")) +
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
