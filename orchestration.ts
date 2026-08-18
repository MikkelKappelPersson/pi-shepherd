/** Low-level agent lifecycle handles and session-scoped registries. */
import { randomUUID } from "node:crypto";

export type AgentLifecycleState =
	| "idle"
	| "working"
	| "blocked"
	| "done"
	| "unknown"
	| "failed"
	| "closed";

export type PromptResultStatus =
	| "idle"
	| "done"
	| "blocked"
	| "failed"
	| "timeout"
	| "cancelled";

export interface AgentHandle {
	id: string;
	agent: string;
	paneId?: string;
	tabId?: string;
	workspaceId?: string;
}

export interface PromptHandle {
	id: string;
	agentId: string;
	createdAt: number;
}

export interface AgentStatus {
	handle: AgentHandle;
	state: AgentLifecycleState;
	paneId?: string;
	tabId?: string;
	workspaceId?: string;
	error?: string;
}

export interface PromptResult {
	promptId: string;
	agentId: string;
	status: PromptResultStatus;
	ok: boolean;
	text?: string;
	error?: string;
}

export class LifecycleError extends Error {
	readonly code: "unknown_handle" | "closed_handle" | "active_prompt" | "invalid_handle";
	constructor(code: LifecycleError["code"], message: string) {
		super(message);
		this.name = "LifecycleError";
		this.code = code;
	}
}

interface AgentRecord {
	handle: AgentHandle;
	state: AgentLifecycleState;
	activePromptId?: string;
	error?: string;
}

interface PromptRecord {
	handle: PromptHandle;
	/** Herdr state sequence before submission; prevents matching pre-submit idle. */
	baselineStateChangeSeq?: number;
	observedWorking: boolean;
	result?: PromptResult;
	settled: boolean;
	resolve: (result: PromptResult) => void;
	promise: Promise<PromptResult>;
}

/**
 * In-memory registry for one extension process. IDs are opaque and include a
 * random component, so callers never need to know Herdr pane identifiers.
 */
export class LifecycleRegistry {
	private readonly sessionId = randomUUID().slice(0, 8);
	private readonly agents = new Map<string, AgentRecord>();
	private readonly prompts = new Map<string, PromptRecord>();

	private id(kind: "agent" | "prompt"): string {
		return `shepherd-${kind}-${this.sessionId}-${randomUUID()}`;
	}

	registerAgent(input: Omit<AgentHandle, "id">): AgentHandle {
		const handle = { ...input, id: this.id("agent") };
		this.agents.set(handle.id, { handle, state: "idle" });
		return { ...handle };
	}

	getAgent(handle: AgentHandle): AgentRecord {
		if (!handle || typeof handle.id !== "string") {
			throw new LifecycleError("invalid_handle", "A serialized AgentHandle is required.");
		}
		const record = this.agents.get(handle.id);
		if (!record) throw new LifecycleError("unknown_handle", `Unknown agent handle "${handle.id}".`);
		return record;
	}

	status(handle: AgentHandle, state?: AgentLifecycleState, error?: string): AgentStatus {
		const record = this.getAgent(handle);
		if (state) record.state = state;
		if (error) record.error = error;
		return {
			handle: { ...record.handle },
			state: record.state,
			...(record.error ? { error: record.error } : {}),
		};
	}

	setAgentState(handle: AgentHandle, state: AgentLifecycleState, error?: string): void {
		const record = this.getAgent(handle);
		record.state = state;
		record.error = error;
	}

	createPrompt(handle: AgentHandle, timeoutMs?: number, baselineStateChangeSeq?: number): PromptHandle {
		const agent = this.getAgent(handle);
		if (agent.state === "closed") throw new LifecycleError("closed_handle", `Agent "${handle.id}" is closed.`);
		if (agent.activePromptId) {
			throw new LifecycleError("active_prompt", `Agent "${handle.id}" already has an unresolved prompt.`);
		}
		let resolve!: (result: PromptResult) => void;
		const promise = new Promise<PromptResult>((r) => (resolve = r));
		const prompt: PromptHandle = { id: this.id("prompt"), agentId: handle.id, createdAt: Date.now() };
		this.prompts.set(prompt.id, { handle: prompt, baselineStateChangeSeq, observedWorking: false, settled: false, resolve, promise });
		agent.activePromptId = prompt.id;
		agent.state = "working";
		if (timeoutMs !== undefined && timeoutMs >= 0) {
			setTimeout(() => this.settlePrompt(prompt, {
				promptId: prompt.id, agentId: prompt.agentId, status: "timeout", ok: false,
				error: `Prompt timed out after ${timeoutMs}ms.`,
			}), timeoutMs);
		}
		return { ...prompt };
	}

	getPrompt(handle: PromptHandle): PromptRecord {
		if (!handle || typeof handle.id !== "string") throw new LifecycleError("invalid_handle", "A serialized PromptHandle is required.");
		const record = this.prompts.get(handle.id);
		if (!record) throw new LifecycleError("unknown_handle", `Unknown prompt handle "${handle.id}".`);
		return record;
	}

	wait(handle: PromptHandle): Promise<PromptResult> {
		return this.getPrompt(handle).promise;
	}

	promptTracking(handle: PromptHandle): { baselineStateChangeSeq?: number; observedWorking: boolean } {
		const record = this.getPrompt(handle);
		return { baselineStateChangeSeq: record.baselineStateChangeSeq, observedWorking: record.observedWorking };
	}

	observeWorking(handle: PromptHandle): void {
		this.getPrompt(handle).observedWorking = true;
	}

	settlePrompt(handle: PromptHandle, result: PromptResult): PromptResult {
		const prompt = this.getPrompt(handle);
		if (prompt.settled) return { ...prompt.result! };
		prompt.result = { ...result, promptId: prompt.handle.id, agentId: prompt.handle.agentId };
		prompt.settled = true;
		const agent = this.agents.get(prompt.handle.agentId);
		if (agent?.activePromptId === prompt.handle.id) {
			agent.activePromptId = undefined;
			if (agent.state !== "closed") agent.state = result.ok ? "done" : "failed";
		}
		prompt.resolve({ ...prompt.result });
		return { ...prompt.result };
	}

	cancelPrompts(handle: AgentHandle, reason = "Agent was closed."): void {
		const agent = this.getAgent(handle);
		if (agent.activePromptId) {
			const prompt = this.prompts.get(agent.activePromptId);
			if (prompt) this.settlePrompt(prompt.handle, {
				promptId: prompt.handle.id, agentId: handle.id, status: "cancelled", ok: false, error: reason,
			});
		}
		agent.state = "closed";
	}

	close(handle: AgentHandle): void {
		const agent = this.getAgent(handle);
		if (agent.state === "closed") return;
		this.cancelPrompts(handle);
	}

	allAgents(): AgentHandle[] { return [...this.agents.values()].map((r) => ({ ...r.handle })); }
}

export const lifecycleRegistry = new LifecycleRegistry();
