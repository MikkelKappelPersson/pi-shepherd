/**
 * Opaque id codec shared by every Shepherd runtime.
 *
 * Pure helpers only: no registry state, no runtime imports, and no
 * `LifecycleError` dependency. Callers own their error type and translate a
 * failed normalization into it. Public formats are part of the model-facing
 * contract and must stay stable:
 *
 *   mintId('agent', sessionId)  -> shepherd-agent-<session>-<uuid>
 *   mintId('prompt', sessionId) -> shepherd-prompt-<session>-<uuid>
 *   mintId('task', sessionId)   -> shepherd-task-<session>-<uuid>
 *   mintId('watch', sessionId)  -> shepherd-watch-<session>-<uuid>
 *   mintMessageId()             -> shepherd-message-<uuid>
 *
 * Handles are opaque: callers pass the id string itself or `{ id: "..." }`,
 * and the value is never parsed for pane/conversation identity.
 */

import { randomUUID } from 'node:crypto';

/** Kind segment of a registry-minted handle id. */
export type IdKind = 'agent' | 'prompt' | 'task' | 'watch';

/** Handle kinds accepted by `normalizeHandleId`. */
export type HandleKind = 'AgentHandle' | 'PromptHandle' | 'TaskHandle';

/** Normalization outcome: the id, or the byte-stable error message to expose. */
export type HandleNormalization =
  | { readonly ok: true; readonly id: string }
  | { readonly ok: false; readonly message: string };

/**
 * Invalid-handle messages are literal and byte-stable: public tools surface
 * them verbatim, so nothing may reword, trim, or re-punctuate them.
 */
const INVALID_HANDLE_MESSAGES: Record<HandleKind, string> = {
  AgentHandle:
    'Expected the opaque agent id as a string. Do not pass a quoted JSON object, array, or Herdr pane id. Correct syntax: { id: "shepherd-agent-..." }.',
  PromptHandle:
    'Expected the opaque prompt id as a string. Do not pass a quoted JSON object, array, or Herdr pane id. Correct syntax: { id: "shepherd-prompt-..." } (or { id: ["prompt-a", "prompt-b"] } for parallel wait).',
  TaskHandle:
    'Expected the opaque TaskHandle id as a string. Do not pass a quoted JSON object, array, agent id, or Herdr pane id. Correct syntax: { id: "shepherd-task-..." }. ',
};

/** Mint the opaque id format `shepherd-<kind>-<session>-<uuid>`. */
export function mintId(kind: IdKind, sessionId: string): string {
  return `shepherd-${kind}-${sessionId}-${randomUUID()}`;
}

/** Mint the broker envelope format `shepherd-message-<uuid>`. */
export function mintMessageId(): string {
  return `shepherd-message-${randomUUID()}`;
}

/**
 * Extract an opaque handle id from its two accepted inputs: a non-blank
 * string, or an object with a string `id` property. On rejection it returns
 * the exact per-kind error message instead of throwing.
 *
 * Behavior is intentionally identical to the historical inline
 * `handleId` / `taskHandleId` validators in `LifecycleRegistry`: strings are
 * returned unchanged (not trimmed), and object `id` values are accepted as-is.
 */
export function normalizeHandleId(input: unknown, kind: HandleKind): HandleNormalization {
  if (typeof input === 'string') {
    if (input.trim().length === 0) return { ok: false, message: INVALID_HANDLE_MESSAGES[kind] };
    return { ok: true, id: input };
  }
  if (
    input !== null &&
    typeof input === 'object' &&
    !Array.isArray(input) &&
    typeof (input as { id?: unknown }).id === 'string'
  ) {
    return { ok: true, id: (input as { id: string }).id };
  }
  return { ok: false, message: INVALID_HANDLE_MESSAGES[kind] };
}
