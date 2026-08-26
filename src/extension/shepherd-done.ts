/**
 * Extension loaded into pi agents that pi-shepherd launches in Herdr tabs.
 *
 * Two responsibilities:
 *   1. Auto-terminate: on `agent_end`, if the latest assistant turn finished
 *      normally, write a completion sidecar (`<session>.exit`) and shut the
 *      process down so the parent (the main pi instance) can pick up the
 *      result. A user Escape/abort leaves the pane open for inspection.
 *   2. Explicit exit: register a `shepherd_done` tool the model can call when
 *      it considers the task complete.
 *
 * The parent sets `PI_SHEPHERD_SESSION` (the JSONL session file path) and
 * `PI_SHEPHERD_AUTO_EXIT=1` in the launch environment.
 *
 * When `PI_SHEPHERD_STAY_OPEN=1` is set, completion only writes the sidecar and
 * the pi process is NOT shut down — it stays open in the tab for the user to
 * keep driving. The parent picks up the result from the sidecar.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { omitPiDocumentation, replacePiIdentity } from "./system-prompt.ts";

function writeSidecar(payload: Record<string, unknown>): void {
	const sessionFile = process.env.PI_SHEPHERD_SESSION;
	if (!sessionFile) return;
	try {
		// A unique signal makes repeated `done` payloads distinguishable across
		// prompts. Rename is atomic, so the parent never parses a partial JSON file.
		const target = `${sessionFile}.exit`;
		const temporary = `${target}.${randomUUID()}.tmp`;
		writeFileSync(temporary, JSON.stringify({ ...payload, signalId: randomUUID() }));
		renameSync(temporary, target);
	} catch {
		// Best effort — the parent can still detect the terminal sentinel.
	}
}

interface AssistantOutcome {
	/** Whether the latest assistant turn permits auto-exit. */
	exit: boolean;
	error?: { errorMessage: string };
}

function latestAssistantOutcome(messages: any[] | undefined): AssistantOutcome {
	if (!messages) return { exit: false };
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m?.role !== "assistant") continue;
		// Manual interruption (Escape) keeps the pane open for the user to
		// further drive in the tab.
		if (m.stopReason === "aborted") return { exit: false };
		if (m.stopReason === "error") {
			const raw =
				typeof m.errorMessage === "string" ? m.errorMessage.trim() : "";
			return {
				exit: true,
				error: {
					errorMessage: raw || "Agent finished with stopReason=error (no error message).",
				},
			};
		}
		return { exit: true };
	}
	return { exit: false };
}

export default function (pi: ExtensionAPI) {
	const autoExit = process.env.PI_SHEPHERD_AUTO_EXIT === "1";
	const stayOpen = process.env.PI_SHEPHERD_STAY_OPEN === "1";
	const agentSystemPromptFile = process.env.PI_SHEPHERD_AGENT_SYSTEM_PROMPT_FILE;
	const shouldOmitPiDocumentation = process.env.PI_SHEPHERD_OMIT_PI_DOCUMENTATION === "1";
	let agentSystemPrompt = "";
	if (agentSystemPromptFile) {
		try {
			agentSystemPrompt = readFileSync(agentSystemPromptFile, "utf8").trim();
		} catch {
			// The launch directory is retained for the lifetime of the child, but
			// a missing file should not prevent the agent from starting.
		}
	}

	if (agentSystemPrompt || shouldOmitPiDocumentation) {
		pi.on("before_agent_start", (event: any) => {
			let systemPrompt = event.systemPrompt;
			if (shouldOmitPiDocumentation) systemPrompt = omitPiDocumentation(systemPrompt);
			if (agentSystemPrompt) systemPrompt = replacePiIdentity(systemPrompt, agentSystemPrompt);
			return systemPrompt === event.systemPrompt ? undefined : { systemPrompt };
		});
	}

	pi.on("agent_end", (event: any, ctx: { shutdown: () => void }) => {
		// Persistent shepherd agents stay alive, but must still publish a
		// completion signal for the parent. One-shot agents publish it and exit.
		if (!autoExit && !stayOpen) return;
		const outcome = latestAssistantOutcome(event?.messages);
		if (!outcome.exit) return; // aborted / no assistant turn — leave open.
		if (outcome.error) writeSidecar({ type: "error", errorMessage: outcome.error.errorMessage });
		else writeSidecar({ type: "done" });
		// Stay open: report completion to the parent via the sidecar, but keep
		// this pi session alive in the tab so the user can keep driving it.
		if (stayOpen) return;
		ctx.shutdown();
	});

	pi.registerTool({
		name: "shepherd_done",
		label: "Shepherd Done",
		description:
			"Call this tool when you have completed your assigned task. " +
			"It signals completion and returns your output to the caller. " +
			"Your LAST assistant message before calling it becomes the summary returned.",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			writeSidecar({ type: "done" });
			if (!stayOpen) ctx.shutdown();
			return {
				content: [
					{
						type: "text",
						text: stayOpen
							? "Done. Completion signaled; this session stays open for further work."
							: "Done. Signaling completion.",
					},
				],
				details: {},
			};
		},
	});
}