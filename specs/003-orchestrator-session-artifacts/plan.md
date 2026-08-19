# Implementation Plan: Orchestrator-bound Artifact Sessions

This plan implements `spec.md` by restoring the durable artifact layer as a
parent-pi-session concern while preserving the low-level lifecycle API from
`specs/002-simplify-agent-orchestration/`.

The central invariant is:

```text
same parent pi session + same project root
    => one persistent artifact session directory
    => one artifact per submitted child invocation
```

A child pane, child JSONL file, agent handle, prompt handle, or
`LifecycleRegistry.sessionId` must never allocate a new persistent artifact
session.

## Target architecture

```text
pi parent context
  ctx.sessionManager.getSessionId()
  ctx.cwd
          │
          ▼
parent-session binding
  { parentPiSessionId, projectRoot, artifactSession }
          │
          ├── startAgent(...)
          │     └── starts idle child; reuses binding; no artifact yet
          │
          └── promptAgent(...)
                ├── reserve artifact in binding.sessionPath
                ├── append artifact context to child message
                ├── submit message
                └── finalize artifact from wait result

artifact-sessions.ts
  filesystem allocation, lookup, locking, MOC, metadata, artifacts

orchestration.ts
  in-memory handles/prompts plus internal artifact association
```

## Design decisions

1. **Parent identity source** — use the pi-provided
   `ctx.sessionManager.getSessionId()` as the opaque parent identity. Use
   `getSessionFile()` as diagnostic/resume metadata, not as the child artifact
   file. Do not derive identity from a task, agent name, pane ID, or lifecycle
   UUID.
2. **Binding root** — use the parent tool context's effective `ctx.cwd` as the
   artifact project root. A child `start` `cwd` override affects child launch
   only; it does not move the shared artifact session to another project.
3. **Lazy shared allocation** — the first `start` resolves and creates the
   parent-bound artifact session so its result can expose the shared path.
   `start` itself reserves no per-agent artifact. Later starts in the same
   parent/project binding reuse the existing directory.
4. **Per-invocation reservation** — `prompt` reserves one artifact immediately
   before message submission. This represents actual work and gives each
   prompt a stable artifact path. Parallel prompt calls reserve under the
   session lock.
5. **Internal association** — attach the resolved artifact session to each
   registered agent record and the reserved artifact to each prompt record.
   Public handles remain lifecycle handles; artifact paths are returned in tool
   details and are not caller-supplied handle identity.
6. **No implicit legacy continuation** — old sessions lacking parent binding
   metadata are not selected by slug/name alone. Any migration must be
   explicit and separate from normal allocation.
7. **Durability boundary** — artifact writes are finalized after the existing
   completion signal/state boundary. Closing a child never removes the shared
   artifact session.

## Phase 1 — Establish the parent-session contract

### 1.1 Add parent context types

Add an internal type, for example `ParentArtifactContext`, containing:

- opaque `parentPiSessionId`;
- optional `parentSessionFile` for diagnostics;
- canonical `projectRoot`;
- resolved persistent artifact-session metadata/path.

Add an `ArtifactSessionRef` and `ArtifactRef` type for the data needed by
lifecycle records and tool result details. Keep filesystem implementation
objects out of public TypeBox schemas where possible.

### 1.2 Resolve identity from pi

Add a helper at the Shepherd tool boundary that receives the real extension
context and obtains:

```ts
const parentPiSessionId = ctx.sessionManager.getSessionId();
const parentSessionFile = ctx.sessionManager.getSessionFile();
const projectRoot = path.resolve(ctx.cwd);
```

Validate that the identity is non-empty and that the project root is usable.
Do not use `lifecycleRegistry.sessionId` for this purpose.

Confirm the session manager behavior for a resumed session: the same pi
session must return an identity that finds the existing artifact directory.
Document the fallback policy if a non-persisted/in-memory pi context has no
session file.

### 1.3 Add parent-binding cache

Create a small parent binding registry, either in a new `parent-session.ts` or
inside the artifact session module. It should:

- key entries by `(parentPiSessionId, projectRoot)`;
- return the same binding for repeated tool calls;
- be safe if the extension receives an equivalent context object each call;
- never key by child handle, agent, or prompt;
- allow reloading the binding from disk after an extension restart.

The cache is an optimization, not the source of truth. `session.json` remains
the durable authority.

## Phase 2 — Restore the filesystem artifact module

### 2.1 Reintroduce the historical persistence code

Create `artifact-sessions.ts` (or restore `sessions.ts` with the new contract)
by extracting the useful filesystem behavior from the deleted historical
`sessions.ts`:

- safe session and agent slugging;
- numbered session allocation;
- exact metadata lookup;
- `.alloc`/exclusive allocation locking;
- artifact reservation and per-agent ordinals;
- atomic same-directory writes;
- serialized session updates;
- MOC rendering;
- artifact status transitions and finalization.

Keep this module independent of pi, Herdr, and TUI imports so it can be tested
with temporary directories.

### 2.2 Implement parent-bound lookup/allocation

Implement an API similar to:

```ts
resolveOrCreateParentArtifactSession({
  projectRoot,
  parentPiSessionId,
  parentSessionFile,
}): ArtifactSession
```

Under the project `.shepherd/sessions/` directory:

1. acquire the root allocation lock;
2. scan only validated numbered session directories;
3. parse and validate `session.json`;
4. find an exact binding match for both parent identity and project root;
5. return that directory if found;
6. otherwise allocate a unique ordinal and create one new directory;
7. write versioned `session.json` and `shepherd.md` atomically; and
8. release the lock.

The persisted metadata must include an artifact-session version and parent
binding fields. Do not trust persisted absolute paths; derive paths from the
current validated project/session root.

If metadata is malformed or an old session lacks the binding, skip it for
normal lookup and leave it untouched. Do not silently attach it to the current
parent.

### 2.3 Preserve collision and path safety

Retain and test the existing behavior for:

- traversal/control-character rejection;
- safe lowercase slugs;
- same-slug/different-identity suffixes;
- unique ordinals under concurrent allocation;
- artifact filename collisions;
- descendant checks for all generated paths.

No global `.shepherd/shepherd.md` file is introduced.

### 2.4 Add artifact lifecycle operations

Expose operations for:

```ts
reserveArtifacts(session, planned)
markArtifactStarted(session, artifact, metadata)
markArtifactStatus(session, artifact, status, metadata)
finalizeArtifact(session, artifact, result)
updateSessionMoc(session, update)
readSessionMetadata(sessionPath)
```

Every mutating operation must lock the session, reload current metadata,
update it, and atomically rewrite `session.json`, artifact content, and MOC as
needed. Preserve agent-authored artifact content while appending orchestration
metadata/output.

## Phase 3 — Integrate binding with lifecycle state

### 3.1 Extend internal records

Update `orchestration.ts` so `AgentRecord` can reference the parent artifact
session and `PromptRecord` can reference its reserved artifact. These fields
are internal and must not change handle validation semantics.

The record association must survive all operations in one parent extension
process:

```text
AgentRecord -> ArtifactSessionRef
PromptRecord -> ArtifactRef + ArtifactSessionRef
```

Do not replace or repurpose `LifecycleRegistry.sessionId`.

### 3.2 Resolve the binding on `start`

Update the model-facing `doAction` path in `shepherd.ts` and the lifecycle
boundary so `start`:

1. resolves the parent binding from the current `ctx`;
2. creates/reuses the single artifact session;
3. starts the idle Herdr child exactly as today;
4. registers the agent with the artifact-session reference; and
5. returns the handle plus shared session details.

A failed child launch may leave the already-created shared session directory,
but must not create a second session during cleanup and must not create an
agent artifact for an idle start.

### 3.3 Reserve and inject context on `prompt`

Before submitting a prompt:

1. resolve the canonical agent handle;
2. obtain its parent artifact-session reference;
3. reserve one artifact under the session lock;
4. mark it running or pending according to the chosen lifecycle boundary;
5. append the artifact context block to the original message;
6. create the prompt record with the artifact reference; and
7. submit the augmented message without waiting.

The original task must remain intact. The context block must include absolute
and project-relative session/MOC/artifact paths and the read/write ownership
instructions from the spec.

If submission fails, finalize the reserved artifact as `failed` or `cancelled`
and return no usable prompt handle. Do not allocate a replacement session or
artifact.

### 3.4 Finalize from `wait`

Update `waitOne` so every terminal path finalizes the prompt's artifact:

- completed/idle/done: preserve final text;
- blocked: preserve blocked state and available output;
- timeout: record timeout details without reading a still-live child file;
- cancellation/close: record cancellation;
- failure: record error and diagnostic output.

Ensure finalization is idempotent when multiple callers wait on the same
settled prompt. Keep current prompt settlement and active-slot behavior.

### 3.5 Handle close and parent lifecycle

`closeAgent` must:

- cancel/finalize any unresolved artifact owned by the agent;
- close only the owned pane;
- remove only safe temporary child launch resources after pane exit; and
- retain the shared artifact session and all artifacts.

Add a parent-session shutdown/reload policy that flushes in-memory metadata if
needed but never deletes the persistent artifact directory.

## Phase 4 — Tool results and child guidance

### 4.1 Extend result details

Update `shepherd.ts` result details so artifact-producing actions expose the
shared session without making callers reconstruct paths:

- `start`: `handle` plus `artifactSession`/`sessionPath`;
- `prompt`: `handle` plus reserved `artifact` and shared session path;
- `wait`: result(s) including artifact reference where available.

Use relative paths for project-internal links and absolute paths where the
child needs to write. Keep public lifecycle handle schemas compatible with the
current complete-object contract.

### 4.2 Update tool descriptions and previews

Update the tool description, prompt snippet, guidelines, and call preview only
as needed to explain:

- all agents started by one parent share one artifact session;
- prompt artifacts are reserved before submission;
- children must read the shared MOC and write only their assigned artifact;
- handles still must be passed as complete native objects; and
- artifacts are retained and not automatically cleaned up.

Do not expose a user option that lets an individual child force a new
artifact-session directory.

### 4.3 Preserve child completion signaling

Keep `shepherd_done.ts` and the completion sidecar focused on child execution
completion. If completion signaling needs to identify an artifact, pass the
assigned artifact reference through the child launch/prompt context or retain
it in the parent prompt record. The child must not allocate a session from its
own environment.

## Phase 5 — Tests

### 5.1 Filesystem tests

Add `test/verify-artifact-sessions.mjs` covering:

- safe slugs and traversal rejection;
- first parent binding allocation;
- repeated lookup of the same parent/project pair;
- same task with different parent IDs producing separate sessions;
- same parent ID across repeated calls retaining artifacts;
- project-root isolation;
- artifact ordinals and collision-safe filenames;
- MOC and metadata updates;
- parallel reservation before execution;
- atomic writes and no temporary-file leftovers;
- failure/timeout/cancellation finalization;
- concurrent numbering and binding allocation; and
- legacy unbound sessions not being implicitly selected.

Use temporary project roots and fake opaque parent IDs. Never write tests into
the repository's real `.shepherd/sessions/` tree.

### 5.2 Registry/lifecycle tests

Extend `test/verify-registry.mjs` or add a focused test for:

- agent records retaining artifact-session references;
- prompts retaining artifact references;
- lifecycle UUID changes not changing artifact paths;
- duplicate finalization being harmless;
- close cancellation retaining artifact metadata; and
- handles from a different parent binding being rejected or clearly invalid.

### 5.3 Integration seam

If direct lifecycle tests would require a live Herdr server, add a narrow
injectable seam around the artifact resolver/reserver rather than mocking the
whole Herdr CLI. Verify that two `start` calls and two `prompt` calls made with
the same parent context receive one session path.

A live Herdr check should then cover one scout and one planner in the same
parent session, with both artifact paths reported under the same directory.

## Phase 6 — Documentation and migration

Update:

- `README.md` with the shared parent-session artifact behavior and layout;
- `PLAN.md` with the artifact binding architecture and lifecycle boundaries;
- relevant comments in `shepherd.ts`, `lifecycle.ts`, and
  `orchestration.ts`; and
- the spec's migration notes if implementation choices differ.

Keep `.shepherd/` ignored as runtime data. Do not add automatic cleanup or
silently migrate existing unbound sessions.

## Verification and completion order

Run in this order:

1. `git diff --check`.
2. Filesystem artifact-session tests.
3. Registry/lifecycle tests.
4. Full `npm test`.
5. Live Herdr verification of two agents sharing one directory.
6. Manual inspection of `session.json`, `shepherd.md`, and both artifacts.

Completion requires the regression assertion:

```text
one parent session, two child invocations
=> one .shepherd/sessions/NNNN-* directory
=> two distinct artifact files in that directory
=> one MOC linking both files
```
