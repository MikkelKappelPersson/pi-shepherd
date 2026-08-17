/**
 * Phase 2 — Subagent tool (Herdr-native).
 *
 * Delegates tasks to specialized agents, each running in its own **Herdr tab**:
 * a visible pi session with the delegated system prompt and per-agent
 * tool/model config that works live in the tab and reports back on
 * completion. When pi was started from a plain terminal (not inside Herdr),
 * the referenced headless Herdr server is started/attached automatically.
 *
 * Modes:
 *   - Single:   { agent, task }
 *   - Parallel: { tasks: [{ agent, task }, ...] }  (max 8, 4 concurrent)
 *   - Chain:    { chain: [{ agent, task }, ...] }  ({previous} pipes output)
 *
 * Agent files are re-read from disk on every invocation (see discovery.ts).
 */

import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	CONFIG_DIR_NAME,
	type ExtensionAPI,
	getAgentDir,
	getMarkdownTheme,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { type AgentConfig, type AgentScope, discoverAgents } from "./discovery.ts";
import { loadSettings } from "./settings.ts";
import { runAgentInHerdr } from "./herdr.ts";
import {
	type ArtifactReservation,
	type ShepherdSession,
	createOrResumeSession,
	finalizeArtifact,
	markArtifactStarted,
	reserveArtifacts,
	updateSessionMoc,
} from "./sessions.ts";
import { TaskItem, ChainItem, AgentScopeSchema, SubagentParams } from "./types.ts";
export { TaskItem, ChainItem, AgentScopeSchema, SubagentParams };

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
const COLLAPSED_ITEM_COUNT = 10;
const PER_TASK_OUTPUT_CAP = 50 * 1024;

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

function formatUsageStats(
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number;
		contextTokens?: number;
		turns?: number;
	},
	model?: string,
): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens && usage.contextTokens > 0) {
		parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	}
	if (model) parts.push(model);
	return parts.join(" ");
}

function formatToolCall(
	toolName: string,
	args: Record<string, unknown>,
	themeFg: (color: any, text: string) => string,
): string {
	const shortenPath = (p: string) => {
		const home = os.homedir();
		return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
	};

	switch (toolName) {
		case "bash": {
			const command = (args.command as string) || "...";
			const preview = command.length > 60 ? `${command.slice(0, 60)}...` : command;
			return themeFg("muted", "$ ") + themeFg("toolOutput", preview);
		}
		case "read": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const offset = args.offset as number | undefined;
			const limit = args.limit as number | undefined;
			let text = themeFg("accent", filePath);
			if (offset !== undefined || limit !== undefined) {
				const startLine = offset ?? 1;
				const endLine = limit !== undefined ? startLine + limit - 1 : "";
				text += themeFg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
			}
			return themeFg("muted", "read ") + text;
		}
		case "write": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const content = (args.content || "") as string;
			const lines = content.split("\n").length;
			let text = themeFg("muted", "write ") + themeFg("accent", filePath);
			if (lines > 1) text += themeFg("dim", ` (${lines} lines)`);
			return text;
		}
		case "edit": {
			const rawPath = (args.file_path || args.path || "...") as string;
			return themeFg("muted", "edit ") + themeFg("accent", shortenPath(rawPath));
		}
		case "ls": {
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "ls ") + themeFg("accent", shortenPath(rawPath));
		}
		case "find": {
			const pattern = (args.pattern || "*") as string;
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "find ") + themeFg("accent", pattern) + themeFg("dim", ` in ${shortenPath(rawPath)}`);
		}
		case "grep": {
			const pattern = (args.pattern || "") as string;
			const rawPath = (args.path || ".") as string;
			return (
				themeFg("muted", "grep ") +
				themeFg("accent", `/${pattern}/`) +
				themeFg("dim", ` in ${shortenPath(rawPath)}`)
			);
		}
		default: {
			const argsStr = JSON.stringify(args);
			const preview = argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
			return themeFg("accent", toolName) + themeFg("dim", ` ${preview}`);
		}
	}
}

interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

interface SingleResult {
	agent: string;
	agentSource: "user" | "project" | "bundled" | "unknown";
	task: string;
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	step?: number;
	/** Set when the agent ran in a Herdr tab (pi-shepherd runtime). */
	herdrNote?: string;
	artifact?: { id: string; filePath: string; relativePath: string; status: string };
}

interface SubagentDetails {
	mode: "single" | "parallel" | "chain";
	agentScope: AgentScope;
	session?: ShepherdSession;
	projectAgentsDir: string | null;
	results: SingleResult[];
}

function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") return part.text;
			}
		}
	}
	return "";
}

function isFailedResult(result: SingleResult): boolean {
	return result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
}

function getResultOutput(result: SingleResult): string {
	if (isFailedResult(result)) {
		return result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
	}
	return getFinalOutput(result.messages) || "(no output)";
}

function truncateParallelOutput(output: string): string {
	const byteLength = Buffer.byteLength(output, "utf8");
	if (byteLength <= PER_TASK_OUTPUT_CAP) return output;

	let truncated = output.slice(0, PER_TASK_OUTPUT_CAP);
	while (Buffer.byteLength(truncated, "utf8") > PER_TASK_OUTPUT_CAP) {
		truncated = truncated.slice(0, -1);
	}
	return `${truncated}\n\n[Output truncated: ${byteLength - Buffer.byteLength(truncated, "utf8")} bytes omitted. Full output preserved in tool details.]`;
}

type DisplayItem = { type: "text"; text: string } | { type: "toolCall"; name: string; args: Record<string, any> };

function getDisplayItems(messages: Message[]): DisplayItem[] {
	const items: DisplayItem[] = [];
	for (const msg of messages) {
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") items.push({ type: "text", text: part.text });
				else if (part.type === "toolCall") items.push({ type: "toolCall", name: part.name, args: part.arguments });
			}
		}
	}
	return items;
}

async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			const current = nextIndex++;
			if (current >= items.length) return;
			results[current] = await fn(items[current], current);
		}
	});
	await Promise.all(workers);
	return results;
}

type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

function zeroUsage(): UsageStats {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

function sessionContext(session: ShepherdSession, artifact: ArtifactReservation): string {
	return `\n\n[Shepherd artifact session]\n` +
		`Session: ${session.directoryName}\n` +
		`Session directory: ${session.sessionPath}\n` +
		`Session MOC: ${session.mocPath}\n` +
		`Project-relative session directory: ${session.sessionRelativePath}\n` +
		`Your assigned artifact: ${artifact.filePath}\n` +
		`Project-relative artifact: ${artifact.relativePath}\n\n` +
		`Read the session MOC before working. Keep detailed findings in your assigned artifact when your tools permit writing. ` +
		`Do not edit shepherd.md or another agent's artifact. Use relative Markdown links for files in the project or session.\n`;
}

function terminalArtifactStatus(message?: string): "failed" | "timed-out" | "cancelled" {
	if (message && /timed out/i.test(message)) return "timed-out";
	if (message && /aborted|cancelled/i.test(message)) return "cancelled";
	return "failed";
}

/**
 * Run one delegated agent to completion in the Herdr runtime.
 *
 * pi-shepherd is Herdr-native: every subagent runs in a real Herdr tab (its own
 * workspace surface) so you can watch it work, and the result is picked back up
 * by the caller when the tab's pi instance signals completion. When the parent
 * pi was started from a plain terminal (not inside Herdr), the referenced
 * headless Herdr server is started/attached automatically and a workspace is
 * resolved for the new tab.
 */
async function runSingleAgent(
	defaultCwd: string,
	agents: AgentConfig[],
	agentName: string,
	task: string,
	cwd: string | undefined,
	step: number | undefined,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	makeDetails: (results: SingleResult[]) => SubagentDetails,
	opts: {
		keepOpen?: boolean;
		stayOpen?: boolean;
		timeout?: number;
		label?: string;
		session?: ShepherdSession;
		artifact?: ArtifactReservation;
		omitSystemPrompt?: boolean;
	} = {},
): Promise<SingleResult> {
	const agent = agents.find((a) => a.name === agentName);

	if (!agent) {
		const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
		if (opts.artifact && opts.session) {
			finalizeArtifact(opts.session, opts.artifact, {
				status: "failed",
				error: `Unknown agent: "${agentName}". Available agents: ${available}.`,
			});
		}
		return {
			agent: agentName,
			agentSource: "unknown",
			task,
			exitCode: 1,
			messages: [],
			stderr: `Unknown agent: "${agentName}". Available agents: ${available}.`,
			usage: zeroUsage(),
			step,
		};
	}

	const keepOpen = opts.keepOpen ?? loadSettings().keepOpen;
	const stayOpen = opts.stayOpen ?? loadSettings().stayOpen;
	const timeout = opts.timeout ?? loadSettings().timeout;
	// Preserve undefined so precedence is explicit option > frontmatter > false.
	const omitSystemPrompt = opts.omitSystemPrompt ?? agent.omitSystemPrompt ?? false;
	const label = opts.label ?? agentName;

	if (opts.artifact && opts.session) markArtifactStarted(opts.session, opts.artifact, { paneLabel: label });
	const progress: SingleResult = {
		agent: agentName,
		agentSource: agent.source,
		task,
		exitCode: 0,
		...(opts.artifact ? { artifact: { id: opts.artifact.id, filePath: opts.artifact.filePath, relativePath: opts.artifact.relativePath, status: "running" } } : {}),
		messages: [{ role: "assistant", content: [{ type: "text", text: "(starting…)" }] }],
		stderr: "",
		usage: zeroUsage(),
		model: agent.model,
		step,
	};

	const emitProgress = (text: string) => {
		if (!onUpdate) return;
		const shown = text || "(running…)";
		progress.messages = [{ role: "assistant", content: [{ type: "text", text: shown }] }];
		onUpdate({
			content: [{ type: "text", text: shown }],
			details: makeDetails([{ ...progress }]),
		});
	};

	let run: Awaited<ReturnType<typeof runAgentInHerdr>>;
	try {
		run = await runAgentInHerdr({
			agentName,
			systemPrompt: agent.systemPrompt,
			omitSystemPrompt,
			task,
			cwd: cwd ?? defaultCwd,
			model: agent.model,
			tools: agent.tools,
			label,
			keepOpen,
			stayOpen,
			timeout,
			signal,
			onProgress: emitProgress,
		});
	} catch (error: any) {
		const message = String(error?.message ?? error);
		if (opts.artifact && opts.session) finalizeArtifact(opts.session, opts.artifact, { status: terminalArtifactStatus(message), error: message });
		return {
			agent: agentName,
			agentSource: agent.source,
			task,
			exitCode: 1,
			messages: [],
			stderr: message,
			usage: zeroUsage(),
			errorMessage: message,
			step,
		};
	}

	const assistantCount = run.messages.filter((m) => m.role === "assistant").length;
	const ltLive = stayOpen
		? `[herd: ${agentName}] ran in Herdr tab "${label}" (pane ${run.paneId}). ` +
			`The subagent is still running there — ` +
			`drive it further or close it with shepherd close ${run.paneId}.`
		: keepOpen
			? `[herd: ${agentName}] ran in Herdr tab "${label}" (pane ${run.paneId}). ` +
				`The tab is left open for inspection — close it with shepherd close ${run.paneId}.`
			: `[herd: ${agentName}] ran in Herdr tab "${label}" (pane ${run.paneId}) and was closed after pickup.`;

	const finalOutput = getFinalOutput(run.messages) || run.finalText;
	if (opts.artifact && opts.session) finalizeArtifact(opts.session, opts.artifact, {
		status: run.exitCode === 0 ? "completed" : terminalArtifactStatus(run.errorMessage),
		output: finalOutput,
		error: run.errorMessage,
		metadata: { paneId: run.paneId, tabId: run.tabId },
	});
	return {
		agent: agentName,
		agentSource: agent.source,
		task,
		exitCode: run.exitCode,
		messages: run.messages,
		stderr: run.errorMessage ?? "",
		usage: { ...zeroUsage(), turns: assistantCount },
		...(opts.artifact ? {
			artifact: {
				id: opts.artifact.id,
				filePath: opts.artifact.filePath,
				relativePath: opts.artifact.relativePath,
				status: run.exitCode === 0 ? "completed" : terminalArtifactStatus(run.errorMessage),
			},
		} : {}),
		model: run.model ?? agent.model,
		errorMessage: run.errorMessage,
		step,
		herdrNote: ltLive,
	};
}



export async function executeDelegation(
	params: Static<typeof SubagentParams>,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	ctx: { cwd: string; hasUI?: boolean; ui?: any },
): Promise<AgentToolResult<Record<string, unknown>>> {
	const settings = loadSettings();
	const agentScope: AgentScope = params.agentScope ?? settings.agentScope;
	const discovery = discoverAgents(ctx.cwd, agentScope);
	const agents = discovery.agents;
	const confirmProjectAgents = params.confirmProjectAgents ?? settings.confirmProjectAgents;

	const hasChain = (params.chain?.length ?? 0) > 0;
	const hasTasks = (params.tasks?.length ?? 0) > 0;
	const hasSingle = Boolean(params.agent && params.task);
	const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);
	const keepOpen = params.keepOpen ?? settings.keepOpen;
	const stayOpen = params.stayOpen ?? settings.stayOpen;
	const timeout = params.timeout ?? settings.timeout;
	// Preserve undefined: runSingleAgent resolves explicit > frontmatter > false.

	let session: ShepherdSession | undefined;
	const makeDetails =
		(mode: "single" | "parallel" | "chain") =>
		(results: SingleResult[]): SubagentDetails => ({
			mode,
			agentScope,
			session,
			projectAgentsDir: discovery.projectDirs[0] ?? null,
			results,
		});

	if (modeCount !== 1) {
		const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
		return {
			content: [
				{
					type: "text",
					text: `Invalid parameters. Provide exactly one mode.\nAvailable agents: ${available}`,
				},
			],
			details: makeDetails("single")([]),
		};
	}

	if ((agentScope === "project" || agentScope === "both") && confirmProjectAgents && ctx.hasUI) {
		const requestedAgentNames = new Set<string>();
		if (params.chain) for (const step of params.chain) requestedAgentNames.add(step.agent);
		if (params.tasks) for (const t of params.tasks) requestedAgentNames.add(t.agent);
		if (params.agent) requestedAgentNames.add(params.agent);

		const projectAgentsRequested = Array.from(requestedAgentNames)
			.map((name) => agents.find((a) => a.name === name))
			.filter((a): a is AgentConfig => a?.source === "project");

		if (projectAgentsRequested.length > 0) {
			const names = projectAgentsRequested.map((a) => a.name).join(", ");
			const dir = discovery.projectDirs[0] ?? "(unknown)";
			const ok = await ctx.ui.confirm(
				"Run project-local agents?",
				`Agents: ${names}\nSource: ${dir}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
			);
			if (!ok)
				return {
					content: [{ type: "text", text: "Canceled: project-local agents not approved." }],
					details: makeDetails(hasChain ? "chain" : hasTasks ? "parallel" : "single")([]),
				};
		}
	}

	if (params.tasks && params.tasks.length > MAX_PARALLEL_TASKS) {
		return {
			content: [{ type: "text", text: `Too many parallel tasks (${params.tasks.length}). Max is ${MAX_PARALLEL_TASKS}.` }],
			details: makeDetails("parallel")([]),
		};
	}

	const mode: "single" | "parallel" | "chain" = hasChain ? "chain" : hasTasks ? "parallel" : "single";
	const firstTask = params.task ?? params.chain?.[0]?.task ?? params.tasks?.[0]?.task;
	session = createOrResumeSession({ projectRoot: ctx.cwd, sessionName: params.sessionName, fallbackTask: firstTask, mode });

	if (params.chain && params.chain.length > 0) {
		const results: SingleResult[] = [];
		const artifacts = reserveArtifacts(session, params.chain.map((step) => ({ agent: step.agent, mode: "chain" as const, task: step.task })));
		let previousOutput = "";

		for (let i = 0; i < params.chain.length; i++) {
			const step = params.chain[i];
			const taskWithContext = step.task.replace(/\{previous\}/g, previousOutput) + sessionContext(session, artifacts[i]);

			const chainUpdate: OnUpdateCallback | undefined = onUpdate
				? (partial) => {
						const currentResult = partial.details?.results[0];
						if (currentResult) {
							const allResults = [...results, currentResult];
							onUpdate({
								content: partial.content,
								details: makeDetails("chain")(allResults),
							});
						}
					}
				: undefined;

			const result = await runSingleAgent(
				ctx.cwd,
				agents,
				step.agent,
				taskWithContext,
				step.cwd,
				i + 1,
				signal,
				chainUpdate,
				makeDetails("chain"),
				{ keepOpen, stayOpen, timeout, session, artifact: artifacts[i], omitSystemPrompt: params.omitSystemPrompt, label: `${step.agent}-${i + 1}` },
			);
			results.push(result);

			const isError = isFailedResult(result);
			if (isError) {
				const errorMsg = getResultOutput(result);
				updateSessionMoc(session, { status: "failed" });
				return {
					content: [
						{
							type: "text",
							text: `Chain stopped at step ${i + 1} (${step.agent}): ${errorMsg}${result.herdrNote ? `\n${result.herdrNote}` : ""}`,
						},
					],
					details: makeDetails("chain")(results),
					isError: true,
				};
			}
			previousOutput = getFinalOutput(result.messages);
		}
		updateSessionMoc(session, { status: "completed" });
		const last = results[results.length - 1];
		return {
			content: [
				{
					type: "text",
					text:
						(getFinalOutput(last.messages) || "(no output)") +
						(last.herdrNote ? `\n${last.herdrNote}` : "") +
						`\n[session: ${session.sessionRelativePath}]`,
				},
			],
			details: makeDetails("chain")(results),
		};
	}

	if (params.tasks && params.tasks.length > 0) {
		if (params.tasks.length > MAX_PARALLEL_TASKS)
			return {
				content: [
					{
						type: "text",
						text: `Too many parallel tasks (${params.tasks.length}). Max is ${MAX_PARALLEL_TASKS}.`,
					},
				],
				details: makeDetails("parallel")([]),
			};

		const artifacts = reserveArtifacts(session!, params.tasks.map((task) => ({ agent: task.agent, mode: "parallel" as const, task: task.task })));
		const allResults: SingleResult[] = new Array(params.tasks.length);

		for (let i = 0; i < params.tasks.length; i++) {
			allResults[i] = {
				agent: params.tasks[i].agent,
				agentSource: "unknown",
				task: params.tasks[i].task,
				exitCode: -1,
				messages: [],
				stderr: "",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
			};
		}

		const emitParallelUpdate = () => {
			if (onUpdate) {
				const running = allResults.filter((r) => r.exitCode === -1).length;
				const done = allResults.filter((r) => r.exitCode !== -1).length;
				onUpdate({
					content: [
						{ type: "text", text: `Parallel: ${done}/${allResults.length} done, ${running} running...` },
					],
					details: makeDetails("parallel")([...allResults]),
				});
			}
		};

		const results = await mapWithConcurrencyLimit(params.tasks, MAX_CONCURRENCY, async (t, index) => {
			const result = await runSingleAgent(
				ctx.cwd,
				agents,
				t.agent,
				t.task + sessionContext(session!, artifacts[index]),
				t.cwd,
				undefined,
				signal,
				(partial) => {
					if (partial.details?.results[0]) {
						allResults[index] = partial.details.results[0];
						emitParallelUpdate();
					}
				},
				makeDetails("parallel"),
				{ keepOpen, stayOpen, timeout, session, artifact: artifacts[index], omitSystemPrompt: params.omitSystemPrompt, label: `${t.agent}-${index + 1}` },
			);
			allResults[index] = result;
			emitParallelUpdate();
			return result;
		});

		const successCount = results.filter((r) => !isFailedResult(r)).length;
		updateSessionMoc(session!, { status: successCount === results.length ? "completed" : "failed" });
		const summaries = results.map((r) => {
			const output = truncateParallelOutput(getResultOutput(r));
			const status = isFailedResult(r)
				? `failed${r.stopReason && r.stopReason !== "end" ? ` (${r.stopReason})` : ""}`
				: "completed";
			return `### [${r.agent}] ${status}\n\n${output}${r.herdrNote ? `\n\n${r.herdrNote}` : ""}`;
		});
		return {
			content: [
				{
					type: "text",
					text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n---\n\n")}\n\n[session: ${session!.sessionRelativePath}]`,
				},
			],
			details: makeDetails("parallel")(results),
		};
	}

	if (params.agent && params.task) {
		const artifact = reserveArtifacts(session!, [{ agent: params.agent, mode: "single", task: params.task }])[0];
		const result = await runSingleAgent(
			ctx.cwd,
			agents,
			params.agent,
			params.task + sessionContext(session!, artifact),
			params.cwd,
			undefined,
			signal,
			onUpdate,
			makeDetails("single"),
			{ keepOpen, stayOpen, timeout, session, artifact, omitSystemPrompt: params.omitSystemPrompt, label: params.agent },
		);
		const isError = isFailedResult(result);
		if (isError) {
			updateSessionMoc(session!, { status: terminalArtifactStatus(result.errorMessage ?? result.stderr) });
			const errorMsg = getResultOutput(result);
			return {
				content: [
					{
						type: "text",
						text: `Agent ${result.stopReason || "failed"}: ${errorMsg}${result.herdrNote ? `\n${result.herdrNote}` : ""}`,
					},
				],
				details: makeDetails("single")([result]),
				isError: true,
			};
		}
		updateSessionMoc(session!, { status: "completed" });
		return {
			content: [
				{
					type: "text",
					text:
						(getFinalOutput(result.messages) || "(no output)") +
						(result.herdrNote ? `\n${result.herdrNote}` : "") +
						`\n[session: ${session.sessionRelativePath}]`,
				},
			],
			details: makeDetails("single")([result]),
		};
	}

	const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
	return {
		content: [{ type: "text", text: `Invalid parameters. Available agents: ${available}` }],
		details: makeDetails("single")([]),
	};
}



/**
 * Lightweight programmatic entry: run a single subagent to completion and
 * return the final text (used by the `/pi-shepherd <agent> <task>` command).
 * Herdr-native: runs in a Herdr tab; no TUI rendering, no confirmation prompt.
 */
export async function subagentOnce(params: {
	agent: string;
	task: string;
	cwd: string;
	scope?: AgentScope;
}): Promise<{ ok: boolean; text: string; stderr: string }> {
	const scope = params.scope ?? loadSettings().agentScope;
	const { agents } = discoverAgents(params.cwd, scope);
	const makeSingle = (results: SingleResult[]): SubagentDetails => ({
		mode: "single",
		agentScope: scope,
		projectAgentsDir: params.cwd,
		results,
	});
	const result = await runSingleAgent(
		params.cwd,
		agents,
		params.agent,
		params.task,
		params.cwd,
		undefined,
		undefined,
		undefined,
		makeSingle,
	);
	const failed = isFailedResult(result);
	return {
		ok: !failed,
		text: (failed ? getResultOutput(result) : getFinalOutput(result.messages) || "(no output)") +
			(result.herdrNote ? `\n${result.herdrNote}` : ""),
		stderr: result.stderr,
	};
}
