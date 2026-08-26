/**
 * pi-shepherd — no-fuss pi extension: subagents + herding pi agents in Herdr.
 *
 * Agent discovery (discovery.ts), lifecycle primitives (lifecycle.ts), built-in
 * agents (.pi/agents), and Herdr herding (herdr.ts).
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { discoverAgents } from "./discovery.ts";
import { fieldnotesEnabled, initializeSessionSettings, loadSettings } from "./settings.ts";
import { openSettings, registerSettingsCommand } from "./settings-ui.ts";
import { doAction, registerShepherdTool, type ShepherdArgs } from "./shepherd.ts";
import { resolveOrCreateParentArtifactSession } from "./artifact-sessions.ts";
import {
	isHerdrAvailable,
	workingSubagents,
	loadCreatedPanes,
	type HerdrAgentSummary,
} from "./herdr.ts";

/**
 * Persistent "below the editor" status box listing the subagents currently
 * working (see tui.md Pattern 5 / widget-placement.ts). Polls the live herd
 * into a snapshot every ~1s, then renders a bordered box at the real
 * viewport width: one row per agent with a color-coded state icon and an
 * mm:ss elapsed timer — shaped after the pi-interactive-subagents "Subagents"
 * widget, but theme-driven rather than hard-coded ANSI hues. No-op when
 * Herdr isn't reachable or there is nothing working.
 */
interface WorkingSnapshotItem extends HerdrAgentSummary {
	/** Recorded pane creation time (registry), or undefined for untracked panes. */
	createdAt?: number;
}

function registerSubagentStatusWidget(pi: ExtensionAPI): void {
	const POLL_MS = 1_000;

	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;
		let snapshot: WorkingSnapshotItem[] = [];

		const tick = (tui: { requestRender(): void }): void => {
			// Poll Herdr + the registry once per tick, not per render frame.
			const panes = loadCreatedPanes();
			const createdAtById = new Map(panes.map((p) => [p.paneId, p.createdAt]));
			snapshot = workingSubagents().map((s) => ({
				...s,
				createdAt: createdAtById.get(s.paneId),
			}));
			tui.requestRender();
		};

		ctx.ui.setWidget(
			"pi-shepherd-working",
			(tui, theme) => {
				let sheepFrame = 0;
				tick(tui);
				const timer = setInterval(() => tick(tui), POLL_MS);
				const animationTimer = setInterval(() => {
					if (!snapshot.some((agent) => agent.state === "working")) return;
					// Keep this counter unbounded: the spinner wraps its ten frames,
					// while the sheep uses it to traverse the full available track.
					sheepFrame += 1;
					tui.requestRender();
				}, 250);
				return {
					render: (width: number) =>
						snapshot.length > 0
							? renderWorkingAgents(snapshot, theme, width, sheepFrame, loadSettings().emojiSheep)
							: [],
					invalidate: () => {
						// Theme changed: rows are re-derived from the live snapshot,
						// which the poll timer keeps fresh.
						tui.requestRender();
					},
					dispose: () => {
						clearInterval(timer);
						clearInterval(animationTimer);
					},
				};
			},
			{ placement: "belowEditor" },
		);
	});
}

/** Elapsed since pane creation, mm:ss (the created-panes registry is the time source). */
function formatElapsedMMSS(createdAt: number, now = Date.now()): string {
	const seconds = Math.max(0, Math.floor((now - createdAt) / 1000));
	const m = Math.floor(seconds / 60);
	const s = seconds % 60;
	return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/** Nature-inspired semantic color for a Herdr state. */
function stateColor(state: string): string {
	switch (state) {
		case "working":
		case "done":
		case "completed":
			return "success";
		case "waiting":
			return "warning";
		case "error":
			return "error";
		default:
			return "dim";
	}
}

// Teal accent (#2aa198) for the box border and working spinner. The pi theme
// has no teal semantic color, so this is a fixed truecolor ANSI hue.
const TEAL_ANSI = "\u001b[38;2;42;161;152m";
const RESET_ANSI = "\u001b[0m";

function teal(text: string): string {
	return `${TEAL_ANSI}${text}${RESET_ANSI}`;
}

/** Colored status icon per Herdr agent state (green Braille spinner, … waiting, ✗ error). */
function stateIcon(
	state: string,
	theme: { fg(color: string, text: string): string },
	frame = 0,
): string {
	const color = stateColor(state);
	switch (state) {
		case "working":
			// Teal spinner; the rest of the row stays neutral.
			return teal(WORKING_SPINNER_FRAMES[frame % WORKING_SPINNER_FRAMES.length] ?? "⠋");
		case "waiting":
			return theme.fg(color, "…");
		case "error":
			return theme.fg(color, "✗");
		case "done":
		case "completed":
			return theme.fg(color, "✓");
		default:
			return theme.fg(color, "○");
	}
}

// The sheep walks right-to-left through the available gap after the active
// agent name. It jumps back to the right edge after reaching the left edge; it
// never walks back to the right. The glyph itself is not mirrored because
// Unicode/terminals do not provide a portable way to transform an emoji.
const SHEEP_SPEED = 3;
const WORKING_SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function animatedSheep(
	frame: number,
	useEmoji: boolean,
	theme: { fg(color: string, text: string): string },
	trackSpan: number,
): string {
	const glyph = useEmoji ? "🐑" : "o";
	const cycleWidth = trackSpan + 1;
	const position = trackSpan - ((frame * SHEEP_SPEED) % cycleWidth);
	return `${" ".repeat(position + 1)}${theme.fg("text", glyph)}`;
}

/**
 * Bordered "working" box, one line per agent, shaped after the pi-interactive-
 * subagents widget:
 *
 *   ╭─ shepherd ────────── 2 working ─╮
 *   │ ⠋ 01:23  planner  🐑      working │
 *   │ … 00:47  worker            waiting │
 *   ╰───────────────────────────────────╯
 *
 * Left text (icon + elapsed + name) truncates; the right status label is
 * preserved and right-aligned, padding the row to full terminal width.
 */
function renderWorkingAgents(
	agents: WorkingSnapshotItem[],
	theme: {
		fg(color: string, text: string): string;
	},
	width: number,
	sheepFrame = 0,
	useEmoji = true,
): string[] {
	const title = "shepherd";
	const info = `${agents.length} working`;

	const lines: string[] = [borderTop(title, info, width, theme)];

	for (const agent of agents) {
		const elapsed = agent.createdAt != null ? ` ${formatElapsedMMSS(agent.createdAt)}` : "";
		const icon = stateIcon(agent.state, theme, sheepFrame);
		const right = ` ${theme.fg("text", agent.state)} `;
		const name = theme.fg("text", agent.name);
		const prefix = ` ${icon}${elapsed}  ${name}`;
		const sheepGlyph = useEmoji ? "🐑" : "o";
		const sheepWidth = visibleWidth(theme.fg("text", sheepGlyph));
		const leftWidth = Math.max(0, width - 2 - visibleWidth(right));
		const trackSpan = leftWidth - visibleWidth(prefix) - sheepWidth - 1;
		const sheep = agent.state === "working" && trackSpan >= 0
			? animatedSheep(sheepFrame, useEmoji, theme, trackSpan)
			: "";
		const left = `${prefix}${sheep}`;
		lines.push(borderLine(left, right, width, theme));
	}

	lines.push(borderBottom(width, theme));
	return lines;
}

/** Bordered top line: ╭─ title ──── info ─╮ (all chars within `width`). */
function borderTop(
	title: string,
	info: string,
	width: number,
	theme: { fg(color: string, text: string): string },
): string {
	if (width <= 0) return "";
	if (width === 1) return teal("╭");
	const inner = Math.max(0, width - 2); // inside ╭ and ╮
	const titlePart = `─ ${title} `;
	const infoPart = ` ${info} ─`;
	const fillLen = Math.max(0, inner - titlePart.length - infoPart.length);
	const fill = "─".repeat(fillLen);
	const content = `${titlePart}${fill}${infoPart}`.slice(0, inner).padEnd(inner, "─");
	return `${teal("╭")}${teal(content)}${teal("╮")}`;
}

/** Bordered bottom line: ╰──────────────────╯ */
function borderBottom(width: number, theme: { fg(color: string, text: string): string }): string {
	if (width <= 0) return "";
	if (width === 1) return teal("╰");
	const inner = Math.max(0, width - 2);
	return `${teal("╰")}${teal("─".repeat(inner))}${teal("╯")}`;
}

/**
 * Bordered content line: │left          right│ — left truncates, right is
 * preserved and right-aligned, padded to fill `width` (both │ chars included).
 */
function borderLine(
	left: string,
	right: string,
	width: number,
	theme: { fg(color: string, text: string): string },
): string {
	if (width <= 0) return "";
	if (width === 1) return teal("│");
	const contentWidth = Math.max(0, width - 2); // space inside the two │ chars
	const rightVis = visibleWidth(right);

	// If the status label alone is too wide, keep it compact rather than
	// overflowing the terminal.
	if (rightVis >= contentWidth) {
		const truncRight = truncateToWidth(right, contentWidth);
		const rightPad = Math.max(0, contentWidth - visibleWidth(truncRight));
		return `${teal("│")}${theme.fg("muted", truncRight)}${" ".repeat(rightPad)}${teal("│")}`;
	}

	const maxLeft = Math.max(0, contentWidth - rightVis);
	const truncLeft = truncateToWidth(left, maxLeft);
	const leftVis = visibleWidth(truncLeft);
	const pad = Math.max(0, contentWidth - leftVis - rightVis);
	return `${teal("│")}${theme.fg("muted", truncLeft)}${" ".repeat(pad)}${theme.fg("muted", right)}${teal("│")}`;
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
	if (!fieldnotesEnabled()) return undefined;
	const parentPiSessionId = ctx.sessionManager?.getSessionId?.();
	if (!parentPiSessionId) return undefined;
	return resolveOrCreateParentArtifactSession({
		parentPiSessionId,
		parentSessionFile: ctx.sessionManager?.getSessionFile?.(),
		projectRoot: ctx.cwd,
	});
}

/**
 * Delegate a command invocation to doAction() — the shared core that also backs
 * the model-facing tools — and surface the result through notifications.
 * Error results map to error-level notifications; thrown errors are caught so
 * a failing action never escapes into an unhandled rejection.
 */
async function runCommandAction(args: ShepherdArgs, ctx: ExtensionCommandContext): Promise<void> {
	try {
		const result = await doAction(args, {
			cwd: ctx.cwd,
			sessionManager: ctx.sessionManager as any,
			ui: ctx.ui,
			hasUI: true,
		});
		const text = result.content.find((c) => c.type === "text")?.text ?? "(no output)";
		ctx.ui?.notify(text, result.isError ? "error" : "info");
	} catch (error: any) {
		ctx.ui?.notify(`pi-shepherd: ${error?.message ?? error}`, "error");
	}
}

export default function (pi: ExtensionAPI) {
	// Command autocomplete callbacks receive only the typed argument prefix,
	// not ExtensionCommandContext. Keep the active session cwd available for
	// discovered agent completion instead of falling back to the extension's
	// process cwd.
	let shepherdCommandCwd = process.cwd();
	pi.on("session_start", (_event, ctx) => {
		shepherdCommandCwd = ctx.cwd;
		// Fieldnotes are intentionally session-scoped. Persisted setting changes
		// are applied when the next parent pi session starts.
		initializeSessionSettings();
	});

	// Tools for natural-language use.
	registerShepherdTool(pi);
	registerSettingsCommand(pi);
	registerSubagentStatusWidget(pi);

	pi.registerCommand("shepherd", {
		description: "pi-shepherd: agents | herd | start | settings",
		// Keep completion aligned with the action names in the model-facing
		// `shepherd` tool. Agent names are discovered fresh so user-defined agents
		// are available here too.
		getArgumentCompletions: (prefix) => {
			const parts = prefix.split(/\s+/);
			const action = parts[0] ?? "";
			if (parts.length <= 1 && !prefix.endsWith(" ")) {
				// Pi does not automatically invoke the completion provider again
				// after applying an argument completion. When the user types
				// `/shepherd sta`, show full `start <agent>` entries immediately
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
				const actions = ["agents", "herd", "start", "settings"];
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

			if (action === "agents" || action === "list" || action === "sheep") {
				// `list` and `sheep` remain accepted as compatibility aliases, but
				// `agents` is the canonical action (and the only completion shown).
				const scopeArg = tokens[1];
				const scope = ["user", "project", "both"].includes(scopeArg ?? "")
					? (scopeArg as "user" | "project" | "both")
					: loadSettings().agentScope;
				await runCommandAction({ action: "agents", agentScope: scope }, ctx);
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
				await runCommandAction({ action: "herd" }, ctx);
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
					await runCommandAction(
						{
							action: "start",
							agent: parsed.agent,
							...parsed.options,
							// Pre-resolve tolerantly (undefined when fieldnotes are disabled
							// or no session identity exists); 'artifactSession' in args makes
							// doAction honor the explicit value instead of requiring one.
							artifactSession: parentArtifactSessionForCommand(ctx),
						},
						ctx,
					);
				} finally {
					ctx.ui?.setStatus?.("pi-shepherd", undefined);
				}
				return;
			}

			ctx.ui?.notify(
				`pi-shepherd: try /shepherd agents, /shepherd herd, /shepherd start <agent>, or /shepherd settings` +
					(action ? ` (unhandled action: ${action})` : ""),
				"info",
			);
		},
	});
}