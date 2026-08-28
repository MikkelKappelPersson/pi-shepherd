/** Low-level agent lifecycle handles and session-scoped registries. */
import { randomUUID } from 'node:crypto';
import type { ArtifactReservation, ShepherdSession } from './artifact-sessions.ts';

export type AgentLifecycleState =
  | 'idle'
  | 'working'
  | 'blocked'
  | 'done'
  | 'unknown'
  | 'failed'
  | 'closed';

export type PromptResultStatus = 'idle' | 'done' | 'blocked' | 'failed' | 'timeout' | 'cancelled';

export interface AgentHandle {
  id: string;
  agent: string;
  label: string;
  paneId?: string;
  tabId?: string;
  workspaceId?: string;
}

/**
 * The model-facing tools use opaque ids. The registry still accepts full
 * internal handles for implementation callers and maintains the complete
 * object behind each id.
 */
/** Public lifecycle calls use the opaque id; internal callers may still hold the full handle. */
export type AgentHandleInput = AgentHandle | string;

export function formatAgentName(agent: string, label?: string): string {
  const trimmed = label?.trim() ?? '';
  return trimmed ? `${agent}: ${trimmed}` : agent;
}

export function validateAgentLabel(value: unknown): string {
  if (value == null) return '';
  if (typeof value !== 'string') throw new Error('Agent label must be a string.');
  const label = value.trim();
  if (!label) return '';
  if (label.length > 64) throw new Error('Agent label must be at most 64 characters.');
  if (!/^[\p{L}\p{N} _.-]+$/u.test(label) || label.includes(':'))
    throw new Error('Agent label may contain only letters, numbers, spaces, _, -, and .; colons and control characters are not allowed.');
  return label;
}

export interface PromptHandle {
  id: string;
  agentId: string;
  createdAt: number;
}

/** Public lifecycle calls use the opaque id; internal callers may still hold the full handle. */
export type PromptHandleInput = PromptHandle | string;

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
  artifact?: ArtifactReservation;
  artifactSession?: ShepherdSession;
}

export class LifecycleError extends Error {
  readonly code: 'unknown_handle' | 'closed_handle' | 'active_prompt' | 'invalid_handle';
  constructor(code: LifecycleError['code'], message: string) {
    super(message);
    this.name = 'LifecycleError';
    this.code = code;
  }
}

interface AgentRecord {
  handle: AgentHandle;
  /** Completion sidecar emitted by the child for each completed prompt. */
  completionSignalPath?: string;
  /** Child JSONL session file; the full last answer is read from it on completion. */
  completionResultPath?: string;
  /** Durable fieldnotes session owned by the parent pi session. */
  artifactSession?: ShepherdSession;
  state: AgentLifecycleState;
  activePromptId?: string;
  error?: string;
}

interface PromptRecord {
  handle: PromptHandle;
  artifactSession?: ShepherdSession;
  artifact?: ArtifactReservation;
  onSettled?: (result: PromptResult) => void;
  /** Herdr state sequence before submission; prevents matching pre-submit idle. */
  baselineStateChangeSeq?: number;
  /** Completion sidecar signal before submission; detects fast completions. */
  baselineCompletionSignalId?: string;
  observedWorking: boolean;
  result?: PromptResult;
  settled: boolean;
  resolve: (result: PromptResult) => void;
  promise: Promise<PromptResult>;
  /** Active timeout handle from waitPrompts; cleared on settle. */
  timeoutId?: ReturnType<typeof setTimeout>;
}

/**
 * In-memory registry for one extension process. Public ids are opaque and
 * include a random component, so callers never need to know Herdr pane ids.
 */
function handleId(input: unknown, kind: 'AgentHandle' | 'PromptHandle'): string {
  if (
    (typeof input !== 'string' &&
      (!input || typeof input !== 'object' || Array.isArray(input) || typeof (input as { id?: unknown }).id !== 'string')) ||
    (typeof input === 'string' && input.trim().length === 0)
  ) {
    const syntax =
      kind === 'PromptHandle'
        ? `Correct syntax: { id: "shepherd-prompt-..." } (or { id: ["prompt-a", "prompt-b"] } for parallel wait).`
        : `Correct syntax: { id: "shepherd-agent-..." }.`;
    throw new LifecycleError(
      'invalid_handle',
      `Expected the opaque ${kind === 'PromptHandle' ? 'prompt' : 'agent'} id as a string. Do not pass a quoted JSON object, array, or Herdr pane id. ${syntax}`
    );
  }
  return typeof input === 'string' ? input : (input as { id: string }).id;
}

export class LifecycleRegistry {
  private readonly sessionId = randomUUID().slice(0, 8);
  private readonly agents = new Map<string, AgentRecord>();
  private readonly prompts = new Map<string, PromptRecord>();

  private id(kind: 'agent' | 'prompt'): string {
    return `shepherd-${kind}-${this.sessionId}-${randomUUID()}`;
  }

  registerAgent(
    input: Omit<AgentHandle, 'id'>,
    metadata: { completionSignalPath?: string; completionResultPath?: string; artifactSession?: ShepherdSession } = {}
  ): AgentHandle {
    const label = validateAgentLabel(input.label);
    const display = formatAgentName(input.agent, label);
    if (label && [...this.agents.values()].some(a => formatAgentName(a.handle.agent, a.handle.label) === display))
      throw new Error(`Duplicate agent label "${display}".`);
    const handle = { ...input, label, id: this.id('agent') };
    this.agents.set(handle.id, {
      handle,
      completionSignalPath: metadata.completionSignalPath,
      completionResultPath: metadata.completionResultPath,
      artifactSession: metadata.artifactSession,
      state: 'idle',
    });
    return { ...handle };
  }

  getAgent(input: AgentHandleInput | unknown): AgentRecord {
    const id = handleId(input, 'AgentHandle');
    const record = this.agents.get(id);
    if (!record)
      throw new LifecycleError(
        'unknown_handle',
        `Unknown agent id "${id}". Lifecycle ids are scoped to this parent session; use the id from the latest spawn result. A Herdr pane id is not an agent id.`
      );
    return record;
  }

  canonicalAgentHandle(input: AgentHandleInput | unknown): AgentHandle {
    return { ...this.getAgent(input).handle };
  }

  status(handle: AgentHandleInput, state?: AgentLifecycleState, error?: string): AgentStatus {
    const record = this.getAgent(handle);
    if (state) record.state = state;
    if (error) record.error = error;
    return {
      handle: { ...record.handle },
      state: record.state,
      ...(record.error ? { error: record.error } : {}),
    };
  }

  setAgentState(handle: AgentHandleInput, state: AgentLifecycleState, error?: string): void {
    const record = this.getAgent(handle);
    record.state = state;
    record.error = error;
  }

  createPrompt(
    handle: AgentHandleInput,
    timeoutMs?: number,
    baselineStateChangeSeq?: number,
    baselineCompletionSignalId?: string
  ): PromptHandle {
    const agent = this.getAgent(handle);
    const agentId = agent.handle.id;
    if (agent.state === 'closed')
      throw new LifecycleError('closed_handle', `Agent "${agentId}" is closed.`);
    if (agent.activePromptId) {
      throw new LifecycleError(
        'active_prompt',
        `Agent "${agentId}" already has an unresolved prompt.`
      );
    }
    let resolve!: (result: PromptResult) => void;
    const promise = new Promise<PromptResult>(r => (resolve = r));
    const prompt: PromptHandle = { id: this.id('prompt'), agentId, createdAt: Date.now() };
    this.prompts.set(prompt.id, {
      handle: prompt,
      baselineStateChangeSeq,
      baselineCompletionSignalId,
      observedWorking: false,
      settled: false,
      resolve,
      promise,
    });
    agent.activePromptId = prompt.id;
    agent.state = 'working';
    // Do not arm a timeout here; waitPrompts owns the timeout and will set/extend it.
    // A very long safety net (1h) is set only if wait is never called.
    const safetyTimeoutId = setTimeout(
      () =>
        this.settlePrompt(prompt, {
          promptId: prompt.id,
          agentId: prompt.agentId,
          status: 'timeout',
          ok: false,
          error: 'Prompt timed out (safety net: wait never called).',
        }),
      3_600_000
    );
    this.prompts.get(prompt.id)!.timeoutId = safetyTimeoutId;
    return { ...prompt };
  }

  getPrompt(input: PromptHandleInput | unknown): PromptRecord {
    const id = handleId(input, 'PromptHandle');
    const record = this.prompts.get(id);
    if (!record)
      throw new LifecycleError(
        'unknown_handle',
        `Unknown prompt id "${id}". Lifecycle ids are scoped to this parent session; use the id from the latest prompt result, not an agent id or Herdr pane id.`
      );
    return record;
  }

  canonicalPromptHandle(input: PromptHandleInput | unknown): PromptHandle {
    return { ...this.getPrompt(input).handle };
  }

  wait(handle: PromptHandleInput | unknown): Promise<PromptResult> {
    return this.getPrompt(handle).promise;
  }

  completionSignalPath(handle: AgentHandleInput): string | undefined {
    return this.getAgent(handle).completionSignalPath;
  }

  completionResultPath(handle: AgentHandleInput): string | undefined {
    return this.getAgent(handle).completionResultPath;
  }

  artifactSession(handle: AgentHandleInput): ShepherdSession | undefined {
    return this.getAgent(handle).artifactSession;
  }

  attachPromptArtifact(
    handle: PromptHandleInput,
    session: ShepherdSession,
    artifact: ArtifactReservation,
    onSettled?: (result: PromptResult) => void
  ): void {
    const prompt = this.getPrompt(handle);
    prompt.artifactSession = session;
    prompt.artifact = artifact;
    prompt.onSettled = onSettled;
  }

  promptArtifact(handle: PromptHandleInput): {
    session?: ShepherdSession;
    artifact?: ArtifactReservation;
  } {
    const prompt = this.getPrompt(handle);
    return { session: prompt.artifactSession, artifact: prompt.artifact };
  }

  promptTracking(handle: PromptHandle): {
    baselineStateChangeSeq?: number;
    baselineCompletionSignalId?: string;
    observedWorking: boolean;
  } {
    const record = this.getPrompt(handle);
    return {
      baselineStateChangeSeq: record.baselineStateChangeSeq,
      baselineCompletionSignalId: record.baselineCompletionSignalId,
      observedWorking: record.observedWorking,
    };
  }

  observeWorking(handle: PromptHandle): void {
    this.getPrompt(handle).observedWorking = true;
  }

  settlePrompt(handle: PromptHandle, result: PromptResult): PromptResult {
    const prompt = this.getPrompt(handle);
    if (prompt.settled) return { ...prompt.result! };
    prompt.result = {
      ...result,
      promptId: prompt.handle.id,
      agentId: prompt.handle.agentId,
      ...(prompt.artifact ? { artifact: prompt.artifact } : {}),
      ...(prompt.artifactSession ? { artifactSession: prompt.artifactSession } : {}),
    };
    prompt.settled = true;
    // Clear any active timeout (safety net from createPrompt or waitPrompts).
    if (prompt.timeoutId) {
      clearTimeout(prompt.timeoutId);
      prompt.timeoutId = undefined;
    }
    try {
      prompt.onSettled?.({ ...prompt.result });
    } catch {
      /* persistence must not break lifecycle settlement */
    }
    const agent = this.agents.get(prompt.handle.agentId);
    if (agent?.activePromptId === prompt.handle.id) {
      agent.activePromptId = undefined;
      if (agent.state !== 'closed') agent.state = result.ok ? 'done' : 'failed';
    }
    prompt.resolve({ ...prompt.result });
    return { ...prompt.result };
  }

  cancelPrompts(handle: AgentHandle, reason = 'Agent was closed.'): void {
    const agent = this.getAgent(handle);
    if (agent.activePromptId) {
      const prompt = this.prompts.get(agent.activePromptId);
      if (prompt)
        this.settlePrompt(prompt.handle, {
          promptId: prompt.handle.id,
          agentId: handle.id,
          status: 'cancelled',
          ok: false,
          error: reason,
        });
    }
    agent.state = 'closed';
  }

  close(handle: AgentHandle): void {
    const agent = this.getAgent(handle);
    if (agent.state === 'closed') return;
    this.cancelPrompts(handle);
  }

  allAgents(): AgentHandle[] {
    return [...this.agents.values()].map(r => ({ ...r.handle }));
  }
}

export const lifecycleRegistry = new LifecycleRegistry();

// ── Session owner identity ──────────────────────────────────────────────
// The created-panes registry is shared across all pi-shepherd processes (it
// lives in the user agent dir), so pane creation must be tagged with the
// owning parent session and session-facing views must filter by it. The owner
// id is the parent pi session's session id, bound once by the extension at
// session_start; a test/override env var wins when set.

let boundSessionOwner: string | undefined;

/**
 * Stable identity of this parent pi session for tagging owned panes.
 * Undefined when not yet bound (and no override is set).
 */
export function sessionOwner(): string | undefined {
  const override = process.env.PI_SHEPHERD_OWNER_SESSION?.trim();
  return override || boundSessionOwner;
}

/**
 * Bind (or clear) the parent session identity. Called from session_start /
 * session_shutdown; binding is idempotent so re-fire is safe.
 */
export function bindSessionOwner(id: string | undefined): void {
  if (id?.trim()) boundSessionOwner = id.trim();
  else boundSessionOwner = undefined;
}
