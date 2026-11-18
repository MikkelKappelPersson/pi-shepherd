/**
 * OpenCode parent artifact-session resolution (spec 013, Phase 4).
 *
 * The OpenCode adapter resolves the parent fieldnotes session on the same
 * durable layout Pi uses: `<projectRoot>/.shepherd/sessions/NNNN-<slug>/`.
 * The OpenCode session id is the opaque parent identity and the session's
 * cwd is the project root, mirroring Pi's
 * `(parent session identity, effective project root)` binding key. The
 * shared engine resolver is imported directly — no layout is duplicated and
 * no Pi adapter code is involved (FR-006, FR-008).
 */

import { resolveOrCreateParentArtifactSession, type ArtifactSession } from '../core/artifact-sessions.ts';
import { loadSettings } from '../core/config.ts';

/** Minimal shape needed to resolve a parent session; avoids an adapter cycle. */
export interface FieldnotesActionContext {
  cwd: string;
  sessionId?: string;
}

/**
 * Fieldnotes are snapshotted for one parent session, like Pi's session-scoped
 * setting. A persisted change takes effect in the next session; it never
 * silently changes the contract of agents already running here.
 */
const sessionFieldnotes = new Map<string, boolean>();

function fieldnotesEnabledFor(ctx: FieldnotesActionContext): boolean {
  const key = `${ctx.sessionId ?? ''}\u0000${ctx.cwd}`;
  let enabled = sessionFieldnotes.get(key);
  if (enabled === undefined) {
    enabled = loadSettings(ctx.cwd).fieldnotes;
    sessionFieldnotes.set(key, enabled);
  }
  return enabled;
}

/** Test-only: drop per-session setting snapshots. */
export function resetOpencodeFieldnotesCache(): void {
  sessionFieldnotes.clear();
}

/**
 * Resolve (or lazily allocate) the one durable fieldnotes session owned by
 * this OpenCode parent session and project. Returns undefined when fieldnotes
 * are disabled; throws when the parent identity is unavailable for a tool
 * call that needs one.
 */
export function parentArtifactSession(ctx: FieldnotesActionContext): ArtifactSession | undefined {
  if (!fieldnotesEnabledFor(ctx)) return undefined;
  const parentSessionId = ctx.sessionId;
  if (!parentSessionId) {
    throw new Error('Unable to resolve the parent OpenCode session identity.');
  }
  return resolveOrCreateParentArtifactSession({
    parentPiSessionId: parentSessionId,
    projectRoot: ctx.cwd,
  });
}
