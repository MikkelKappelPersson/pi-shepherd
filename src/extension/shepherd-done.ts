/**
 * Extension loaded into pi agents that pi-shepherd launches in Herdr tabs.
 *
 * Responsibilities:
 *   1. Preserve the existing completion sidecar behavior for legacy prompt
 *      runs. The sidecar remains a process/turn observation until the parent
 *      task lifecycle is migrated to explicit shepherd_done handling.
 *   2. Provide child-side shepherd_message and shepherd_done tools.
 *   3. Poll the parent-owned mailbox and queue incoming messages into this Pi
 *      session using followUp or steer delivery.
 *
 * The parent passes the mailbox capability through launch-time environment
 * variables. Without those variables the child surface still loads, but its
 * messaging tools return a structured broker-unavailable error.
 */

import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { Type } from "typebox";
import {
	createChildBroker,
	createEnvelope,
	pollChildInbox,
	publishFromChild,
	type ChildBroker,
	type ShepherdDelivery,
	type ShepherdMessageEnvelope,
} from "../core/messaging.ts";
import { omitPiDocumentation, replacePiIdentity } from "./system-prompt.ts";

function writeSidecar(payload: Record<string, unknown>): void {
	const sessionFile = process.env.PI_SHEPHERD_SESSION;
	if (!sessionFile) return;
	try {
		// A unique signal makes repeated `done` payloads distinguishable across
		// prompts. Rename is atomic, so the parent never parses a partial JSON file.
		const target = `${sessionFile}.exit`;
		const temporary = `${target}.${randomUUID()}.tmp`;
		const taskId = process.env.PI_SHEPHERD_TASK_ID;
		writeFileSync(
			temporary,
			JSON.stringify({ ...payload, ...(taskId ? { taskId } : {}), signalId: randomUUID() }),
		);
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
			const raw = typeof m.errorMessage === "string" ? m.errorMessage.trim() : "";
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

const DeliverySchema = Type.Union(
	[Type.Literal("followUp"), Type.Literal("steer")],
	{ description: "Delivery mode; followUp waits for the current turn, steer is for urgent input." },
);
const StatusSchema = Type.Union(
	[Type.Literal("completed"), Type.Literal("blocked"), Type.Literal("failed")],
	{ description: "Terminal status for the delegated task." },
);

function stringifyArguments(args: unknown): string {
	return JSON.stringify(args ?? {});
}

function childResult(
	toolName: string,
	args: unknown,
	service: string,
	returnValue: unknown,
	details: Record<string, unknown> = {},
	returnCode = 0,
): AgentToolResult<Record<string, unknown>> {
	const visibleDetails = Object.entries(details).map(([key, value]) => {
		const rendered = typeof value === "string" ? value : JSON.stringify(value);
		return `   ${key.replace(/[A-Z]/g, letter => ` ${letter.toLowerCase()}`)}: ${rendered ?? "null"}`;
	});
	const text = [
		service,
		"",
		"call:",
		`    ${toolName} ${stringifyArguments(args)}`,
		"",
		"return:",
		`    ${JSON.stringify(returnValue)}`,
		...(visibleDetails.length ? ["", "details:", ...visibleDetails] : []),
	].join("\n");
	return {
		content: [{ type: "text", text }],
		details: { returnValue, returnCode, ...details },
	};
}

function unavailableToolResult(toolName: string, args: unknown, error: string) {
	return childResult(
		toolName,
		args,
		"Shepherd child messaging is unavailable.",
		{ accepted: false, error },
		{ code: "broker_unavailable", error },
		1,
	);
}

function brokerFromEnvironment(): { broker?: ChildBroker; error?: string } {
	const rootDir = process.env.PI_SHEPHERD_BROKER_DIR;
	const sessionId = process.env.PI_SHEPHERD_BROKER_SESSION_ID;
	const brokerId = process.env.PI_SHEPHERD_BROKER_ID;
	const agentId = process.env.PI_SHEPHERD_AGENT_ID;
	const token = process.env.PI_SHEPHERD_BROKER_TOKEN;
	const inboxPath = process.env.PI_SHEPHERD_AGENT_INBOX;
	if (!rootDir || !sessionId || !brokerId || !agentId || !token || !inboxPath) {
		return { error: "No Shepherd broker capability was provided for this child." };
	}
	try {
		return {
			broker: createChildBroker({ rootDir, sessionId, brokerId, agentId, token, inboxPath }),
		};
	} catch (error) {
		return { error: String((error as any)?.message ?? error) };
	}
}

function incomingMessageText(message: ShepherdMessageEnvelope): string {
	// For parent-relayed replies the authenticated sender is the parent broker;
	// originSenderId carries the true author so the recipient sees who wrote it.
	const author = message.originSenderId ?? message.senderId;
	const sender = author === "shepherd" ? "Shepherd" : author;
	const title = message.kind === "task" ? "Shepherd delegated task" : "Shepherd message";
	const metadata = [
		`Message ID: ${message.messageId}`,
		message.taskId ? `Task ID: ${message.taskId}` : undefined,
		message.threadId ? `Thread ID: ${message.threadId}` : undefined,
		message.replyTo ? `Reply to: ${message.replyTo}` : undefined,
	].filter(Boolean).join("\n");
	return `[${title} from ${sender}]\n${metadata}\n\n${message.content ?? message.summary ?? ""}`;
}

function deliveryMode(value: unknown): ShepherdDelivery {
	return value === "steer" ? "steer" : "followUp";
}

function deliveryOptions(message: ShepherdMessageEnvelope): { deliverAs: ShepherdDelivery; triggerTurn: boolean } {
	return {
		deliverAs: deliveryMode(message.delivery),
		// Passive messages wait for the child's next turn. Requests, replies,
		// and delegated tasks must wake the child so waiting workflows can proceed.
		triggerTurn: message.kind === "reply" || message.kind === "task" || message.expectsReply === true,
	};
}

export default function (pi: ExtensionAPI) {
	const autoExit = process.env.PI_SHEPHERD_AUTO_EXIT === "1";
	const stayOpen = process.env.PI_SHEPHERD_STAY_OPEN === "1";
	const agentSystemPromptFile = process.env.PI_SHEPHERD_AGENT_SYSTEM_PROMPT_FILE;
	const shouldOmitPiDocumentation = process.env.PI_SHEPHERD_OMIT_PI_DOCUMENTATION === "1";
	const configuredTaskId = process.env.PI_SHEPHERD_TASK_ID;
	let agentSystemPrompt = "";
	let broker: ChildBroker | undefined;
	let brokerError: string | undefined;
	let pollTimer: ReturnType<typeof setInterval> | undefined;
	const receivedMessageTaskIds = new Map<string, string | undefined>();

	if (agentSystemPromptFile) {
		try {
			agentSystemPrompt = readFileSync(agentSystemPromptFile, "utf8").trim();
		} catch {
			// The launch directory is retained for the lifetime of the child, but
			// a missing file should not prevent the agent from starting.
		}
	}

	const ensureBroker = (): ChildBroker | undefined => {
		if (broker || brokerError) return broker;
		const loaded = brokerFromEnvironment();
		broker = loaded.broker;
		brokerError = loaded.error;
		return broker;
	};

	const sendDeliveryFailure = (message: ShepherdMessageEnvelope, error: unknown): void => {
		const active = ensureBroker();
		if (!active) return;
		try {
			const diagnostic = createEnvelope(
				{ sessionId: active.sessionId, brokerId: active.brokerId, senderId: active.agentId },
				{
					kind: "runtime",
					targetId: active.parentId,
					taskId: message.taskId,
					threadId: message.threadId,
					delivery: "followUp",
					content: `Could not deliver Shepherd message ${message.messageId}: ${String((error as any)?.message ?? error)}`,
					error: String((error as any)?.message ?? error),
				},
			);
			publishFromChild(active, diagnostic);
		} catch {
			// Delivery diagnostics are best effort and must not crash the child.
		}
	};

	const poll = (): void => {
		const active = ensureBroker();
		if (!active) return;
		let messages: ShepherdMessageEnvelope[];
		try {
			messages = pollChildInbox(active);
		} catch {
			return;
		}
		for (const message of messages) {
			receivedMessageTaskIds.set(message.messageId, message.taskId);
			// Parent relays use a fresh envelope id while preserving the original
			// request in replyTo; replies from this child correlate to that original
			// request id.
			if (message.replyTo) receivedMessageTaskIds.set(message.replyTo, message.taskId);
			try {
				pi.sendUserMessage(incomingMessageText(message), deliveryOptions(message));
			} catch (error) {
				sendDeliveryFailure(message, error);
			}
		}
	};

	if (agentSystemPrompt || shouldOmitPiDocumentation) {
		pi.on("before_agent_start", (event: any) => {
			let systemPrompt = event.systemPrompt;
			if (shouldOmitPiDocumentation) systemPrompt = omitPiDocumentation(systemPrompt);
			if (agentSystemPrompt) systemPrompt = replacePiIdentity(systemPrompt, agentSystemPrompt);
			return systemPrompt === event.systemPrompt ? undefined : { systemPrompt };
		});
	}

	pi.registerTool({
		name: "shepherd_message",
		label: "Shepherd message",
		description: "Send an asynchronous message to the Shepherd or another registered agent without waiting for a reply.",
		promptSnippet: "send an asynchronous message to Shepherd or another agent",
		promptGuidelines: [
			"When replying with replyTo, use the task ID from the incoming request, not your own task ID. If the incoming message is in context, omit taskId and the child surface will infer it.",
			"A reply must set replyTo to the exact incoming Message ID. Do not call shepherd_done while your task's required request remains unresolved.",
			"Requests and replies wake waiting agents automatically; after sending a request, end the turn and wait for the queued response rather than polling or sending acknowledgments.",
		],
		parameters: Type.Object({
			target: Type.String({ description: "Shepherd, parent, or an opaque registered Shepherd agent id." }),
			message: Type.String({ description: "Non-empty message content." }),
			taskId: Type.Optional(Type.String({ description: "Active delegated task id, when this message belongs to a task." })),
			threadId: Type.Optional(Type.String({ description: "Conversation/thread correlation id." })),
			replyTo: Type.Optional(Type.String({ description: "Message id of the request being answered." })),
			expectsReply: Type.Optional(Type.Boolean({ description: "Track this message as a request that expects a reply." })),
			delivery: Type.Optional(DeliverySchema),
		}),
		async execute(_toolCallId, args) {
			const active = ensureBroker();
			if (!active) return unavailableToolResult("shepherd_message", args, brokerError ?? "Broker unavailable.");
			const referencedTaskId = args.replyTo ? receivedMessageTaskIds.get(args.replyTo) : undefined;
			if (args.replyTo && receivedMessageTaskIds.has(args.replyTo) && args.taskId !== undefined && args.taskId !== referencedTaskId) {
				return childResult(
					"shepherd_message",
					args,
					"Shepherd reply rejected: task mismatch.",
					{ accepted: false, error: `Reply ${args.replyTo} belongs to task ${referencedTaskId ?? "none"}; use that task id, not ${args.taskId}.` },
					{ code: "reply_task_mismatch", replyTo: args.replyTo, expectedTaskId: referencedTaskId ?? null, providedTaskId: args.taskId },
					1,
				);
			}
			const taskId = args.replyTo && receivedMessageTaskIds.has(args.replyTo)
				? referencedTaskId
				: args.taskId ?? configuredTaskId;
			try {
				const message = createEnvelope(
					{ sessionId: active.sessionId, brokerId: active.brokerId, senderId: active.agentId },
					{
						kind: args.replyTo ? "reply" : "message",
						targetId: args.target,
						taskId,
						threadId: args.threadId,
						replyTo: args.replyTo,
						expectsReply: args.expectsReply,
						delivery: deliveryMode(args.delivery),
						content: args.message,
					},
				);
				const accepted = publishFromChild(active, message);
				if (accepted.delivery === 'queued' && args.expectsReply === true) {
					// Mirror the tracked request into the parent inbox so the parent
					// can open the request on the task (running -> waiting). The
					// question itself was published to the target; the mirror only
					// carries correlation state, never a second copy of the content
					// for delivery.
					const mirrored = createEnvelope(
						{ sessionId: active.sessionId, brokerId: active.brokerId, senderId: active.agentId },
						{
							kind: "runtime",
							targetId: active.parentId,
							taskId,
							threadId: args.threadId,
							replyTo: message.messageId,
							requestOpen: true,
							requestTargetId: ['shepherd', 'parent'].includes(args.target) ? active.parentId : args.target,
							summary: args.message,
							delivery: "followUp",
						},
					);
					try {
						publishFromChild(active, mirrored);
					} catch {
						// The question is already queued; a lost mirror only delays
						// the task entering the waiting state and cannot corrupt it.
						return childResult(
							"shepherd_message",
							args,
							"Shepherd message accepted; reply tracking degraded (request mirror failed).",
							{ accepted: true, messageId: message.messageId, delivery: accepted.delivery, requestTracking: "degraded" },
							{ messageId: message.messageId, taskId: taskId ?? null, delivery: accepted.delivery },
						);
					}
				}
				return childResult(
					"shepherd_message",
					args,
					"Shepherd message accepted for asynchronous delivery.",
					accepted,
					{ messageId: message.messageId, taskId: taskId ?? null, delivery: accepted.delivery },
				);
			} catch (error) {
				return childResult(
					"shepherd_message",
					args,
					"Shepherd message was rejected.",
					{ accepted: false, error: String((error as any)?.message ?? error) },
					{ code: (error as any)?.code ?? "message_rejected", error: String((error as any)?.message ?? error) },
					1,
				);
			}
		},
	});

	pi.registerTool({
		name: "shepherd_done",
		label: "Shepherd task done",
		description: "Explicitly complete, block, or fail the current delegated Shepherd task.",
		promptSnippet: "explicitly complete the delegated Shepherd task",
		parameters: Type.Object({
			taskId: Type.String({ description: "Opaque task id supplied in the delegated task context." }),
			status: StatusSchema,
			summary: Type.Optional(Type.String({ description: "Concise completion, blocked, or failure summary." })),
		}),
		async execute(_toolCallId, args) {
			const active = ensureBroker();
			if (!active) return unavailableToolResult("shepherd_done", args, brokerError ?? "Broker unavailable.");
			if (configuredTaskId && args.taskId !== configuredTaskId) {
				const error = `Task id does not match this child context (${configuredTaskId}).`;
				return childResult("shepherd_done", args, "Shepherd task completion was rejected.", { accepted: false, error }, { code: "task_mismatch", error }, 1);
			}
			try {
				const completion = createEnvelope(
					{ sessionId: active.sessionId, brokerId: active.brokerId, senderId: active.agentId },
					{
						kind: "task_done",
						targetId: active.parentId,
						taskId: args.taskId,
						status: args.status,
						summary: args.summary,
						content: args.summary,
						delivery: "followUp",
					},
				);
				const accepted = publishFromChild(active, completion);
				return childResult(
					"shepherd_done",
					args,
					"Shepherd task completion accepted.",
					accepted,
					{ taskId: args.taskId, status: args.status, delivery: accepted.delivery },
				);
			} catch (error) {
				return childResult(
					"shepherd_done",
					args,
					"Shepherd task completion was rejected.",
					{ accepted: false, error: String((error as any)?.message ?? error) },
					{ code: (error as any)?.code ?? "completion_rejected", error: String((error as any)?.message ?? error) },
					1,
				);
			}
		},
	});

	pi.on("session_start", () => {
		if (pollTimer) return;
		ensureBroker();
		poll();
		pollTimer = setInterval(poll, 250);
		(pollTimer as any).unref?.();
	});

	pi.on("session_shutdown", () => {
		if (pollTimer) clearInterval(pollTimer);
		pollTimer = undefined;
		broker = undefined;
	});

	pi.on("agent_end", (event: any, ctx: { shutdown: () => void }) => {
		// Persistent shepherd agents stay alive, but must still publish a
		// completion signal for the legacy prompt path. One-shot agents publish
		// it and exit. A tracked task is different: a normal agent_end is only a
		// turn observation, so it must not claim task success or shut down a child
		// that may need to resume after a peer reply.
		if (!autoExit && !stayOpen) return;
		const outcome = latestAssistantOutcome(event?.messages);
		if (!outcome.exit) return; // aborted / no assistant turn — leave open.
		if (outcome.error) {
			// Provider errors are still useful process-failure diagnostics for the
			// parent, even when a tracked task is active.
			writeSidecar({ type: "error", errorMessage: outcome.error.errorMessage });
			if (!stayOpen) ctx.shutdown();
			return;
		}
		if (configuredTaskId) return;
		writeSidecar({ type: "done" });
		// Stay open: report completion to the parent via the sidecar, but keep
		// this pi session alive in the tab so the user can keep driving it.
		if (stayOpen) return;
		ctx.shutdown();
	});
}
