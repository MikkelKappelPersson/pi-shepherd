# Tasks: Orchestrator-bound Artifact Sessions

Implement in order. Mark a task complete only after its code and focused
verification pass.

## Phase 1 — Parent identity and foundations

- [ ] **1.1 Confirm pi identity contract**
  - Verify `ctx.sessionManager.getSessionId()` is stable for a resumed parent
    pi session.
  - Verify `getSessionFile()` is available when the session is persisted.
  - Document the fallback for non-persisted/in-memory sessions.

- [ ] **1.2 Define artifact types**
  - Add parent binding, artifact session, artifact reference, and lifecycle
    metadata types.
  - Keep the parent identity opaque.
  - Keep artifact filesystem types separate from public handle schemas.

- [ ] **1.3 Add binding resolver/cache**
  - Key by parent pi session ID plus canonical parent project root.
  - Make cache reuse independent of context object identity.
  - Ensure cache misses reload from disk rather than creating duplicates.
  - Do not use `LifecycleRegistry.sessionId`.

## Phase 2 — Filesystem persistence

- [ ] **2.1 Add artifact session module**
  - Create `artifact-sessions.ts` or restore/adapt `sessions.ts`.
  - Keep it independent of pi, Herdr, and TUI imports.

- [ ] **2.2 Implement exact parent-bound lookup**
  - Persist a versioned parent binding in `session.json`.
  - Match exact parent identity and project root.
  - Ignore unbound legacy sessions during normal lookup.
  - Preserve malformed/legacy directories without deletion.

- [ ] **2.3 Implement safe allocation**
  - Add exclusive root allocation locking.
  - Allocate unique numbered directories under `.shepherd/sessions/`.
  - Handle slug collisions deterministically.
  - Validate all generated paths as descendants of the project/session root.

- [ ] **2.4 Implement session metadata and MOC**
  - Create `session.json` and `shepherd.md` atomically.
  - Record parent binding, status, modes, timestamps, and artifacts.
  - Serialize updates from parallel callers.

- [ ] **2.5 Implement artifact lifecycle**
  - Reserve per-agent ordinals and collision-safe filenames.
  - Initialize artifacts before prompt submission.
  - Mark running/status transitions.
  - Finalize output/errors without overwriting agent-authored content.

## Phase 3 — Lifecycle integration

- [ ] **3.1 Associate sessions with agents**
  - Extend internal `AgentRecord` metadata with the parent artifact session.
  - Do not alter public handle identity or lifecycle UUID semantics.

- [ ] **3.2 Resolve/reuse on `start`**
  - Resolve the parent binding before child launch.
  - Return the shared session details.
  - Ensure a bare idle start creates no per-agent artifact.
  - Ensure a second start reuses the first session directory.

- [ ] **3.3 Reserve/inject on `prompt`**
  - Reserve one artifact before submission.
  - Associate it with the prompt record.
  - Append shared MOC/artifact context without replacing the task.
  - Finalize failed submission and return no prompt handle.

- [ ] **3.4 Finalize on `wait`**
  - Persist successful output and terminal lifecycle state.
  - Persist blocked, timeout, failed, and cancelled outcomes.
  - Avoid reading live child session files.
  - Make finalization idempotent.

- [ ] **3.5 Preserve close/cleanup safety**
  - Cancel unresolved prompt artifacts during close.
  - Retain shared session files after close, reload, timeout, and shutdown.
  - Delete only safe temporary child launch resources under existing rules.

## Phase 4 — Tool integration

- [ ] **4.1 Expose artifact details**
  - Include shared session path in `start` details.
  - Include artifact path in `prompt` details.
  - Include artifact references in `wait` results.
  - Preserve complete-native-handle requirements.

- [ ] **4.2 Update model guidance**
  - Explain one shared artifact session per parent pi session.
  - Explain MOC/artifact ownership and retention.
  - Do not expose a per-child force-new-session option.

- [ ] **4.3 Verify completion signaling**
  - Ensure `shepherd_done` updates parent-owned prompt/artifact state.
  - Ensure child environment cannot allocate a new artifact session.

## Phase 5 — Tests

- [ ] **5.1 Add filesystem tests**
  - Shared parent/project lookup.
  - Repeated tool-call retention.
  - Different parent and project isolation.
  - Legacy unbound session handling.
  - Slug/path safety and collision handling.
  - Atomic/concurrent allocation and updates.
  - Lifecycle metadata and finalization.

- [ ] **5.2 Add registry tests**
  - Agent-to-session and prompt-to-artifact association.
  - Lifecycle UUID independence.
  - Idempotent finalization.
  - Close cancellation and retention.

- [ ] **5.3 Add orchestration regression test**
  - Two child invocations from one parent context produce one session path,
    two artifact paths, and one MOC.
  - Test calls separated by a simulated tool-call boundary.

- [ ] **5.4 Run verification**
  - Run `git diff --check`.
  - Run the new artifact tests.
  - Run `npm test`.
  - Perform live Herdr verification with two agents sharing one directory.

## Phase 6 — Documentation

- [ ] **6.1 Update README**
  - Document parent-session binding, layout, retention, and child context.

- [ ] **6.2 Update PLAN.md**
  - Document the artifact module and its integration boundaries.

- [ ] **6.3 Review implementation against spec**
  - Confirm no per-child session allocation remains.
  - Confirm no automatic cleanup/commit/checkout was introduced.
  - Confirm `LifecycleRegistry.sessionId` is not persisted or used for folder
    allocation.
