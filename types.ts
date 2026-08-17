import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

export const TaskItem = Type.Object({
	agent: Type.String({
		description:
			"Exact discovered agent name to invoke (case-sensitive). Run /shepherd agents first and copy a name exactly; do not invent aliases.",
	}),
	task: Type.String({ description: "Task to delegate to the selected agent" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

export const ChainItem = Type.Object({
	agent: Type.String({
		description:
			"Exact discovered agent name to invoke (case-sensitive). Run /shepherd agents first and copy a name exactly; do not invent aliases.",
	}),
	task: Type.String({ description: "Task with optional {previous} placeholder for prior output" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

export const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
	description: 'Which agent directories to use. Default: "user". Use "both" to include project-local agents.',
	default: "user",
});

export const SubagentParams = Type.Object({
	sessionName: Type.Optional(
		Type.String({ description: "Optional human-facing name for the artifact-backed delegation session." }),
	),
	agent: Type.Optional(
		Type.String({
			description:
				"Exact discovered agent name for single mode (case-sensitive). Run /shepherd agents first and copy a name exactly; do not use aliases.",
		}),
	),
	task: Type.Optional(
		Type.Union([
			Type.String({ description: "Task to delegate to the selected agent (for single mode)" }),
			Type.Null({ description: "Null for bare mode." }),
		]),
	),
	mode: Type.Optional(
		StringEnum(["single", "parallel", "chain", "bare"] as const, {
			description: "Delegation mode (default: inferred from supplied fields). Bare starts an interactive agent with no initial task.",
		}),
	),
	tasks: Type.Optional(
		Type.Array(TaskItem, {
			description:
				"Parallel delegation items. Every agent must be an exact name from /shepherd agents; validate all names before starting.",
		}),
	),
	chain: Type.Optional(
		Type.Array(ChainItem, {
			description:
				"Sequential delegation items. Every agent must be an exact name from /shepherd agents; validate all names before starting.",
		}),
	),
	agentScope: Type.Optional(AgentScopeSchema),
	confirmProjectAgents: Type.Optional(
		Type.Boolean({ description: "Prompt before running project-local agents. Default: true.", default: true }),
	),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process (single mode)" })),
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
	timeout: Type.Optional(
		Type.Integer({
			description: "Time limit (ms) for the Herdr run before it is reported timed-out. Default: 600000 (10 min).",
			default: 600_000,
		}),
	),
	omitSystemPrompt: Type.Optional(
		Type.Boolean({
			description:
				"Override the selected agent's omit-system-prompt frontmatter. When omitted, use the agent setting; otherwise false.",
		}),
	),
});
