# Orchestrator-bound Shepherd Artifact Sessions

## Status

Proposed specification.

## Summary

Restore durable Shepherd artifacts as a concern of the **parent pi session**.
The parent pi process is the orchestrator. Every agent started, prompted, and
waited on through that parent must use one artifact session directory for the
same project root. Starting a second subagent must reserve another artifact in
the existing directory; it must never create a second
`.shepherd/sessions/NNNN-slug/` directory merely because it is a different
agent or a different `start` call.

The durable artifact session is distinct from:

- a child pi session or child JSONL session file;
- a Herdr pane, tab, or agent handle; and
- the in-memory `LifecycleRegistry.sessionId` used to namespace lifecycle
  handles inside one extension process.

The parent pi session is the authoritative owner and lifetime boundary for the
artifact context. Artifacts must survive multiple Shepherd tool calls during
that parent session and must remain on disk after the parent session ends.

This specification builds on `specs/001-artifacts/spec.md` and preserves its
MOC, per-invocation artifacts, provenance, collision handling, atomic updates,
and no-auto-cleanup requirements. It adapts those requirements to the current
low-level API from `specs/002-simplify-agent-orchestration/spec.md`.

## Problem

The previous artifact design created or resumed a durable session only when a
caller supplied a workflow-level `sessionName`. The low-level `start` API has
no such workflow identity, and separate subagent starts can therefore be
interpreted as separate sessions. This breaks the intended shared artifact
store: a scout, planner, worker, and reviewer launched by one parent pi
conversation can receive unrelated artifact folders.

The artifact allocator must instead resolve its session from the parent
orchestrator pi session before the first child is launched, cache that binding
for subsequent calls, and pass the resulting context to each child.

## Goals

- Bind artifact storage to the parent/orchestrator pi session.
- Reuse one durable session directory for all child agents delegated by that
  parent in the same project.
- Preserve artifacts across multiple Shepherd tool calls, including calls made
  after earlier agents complete.
- Support sequential, parallel, and caller-composed workflows without making
  those workflows special lifecycle primitives.
- Reserve one unique artifact per delegated invocation before that invocation
  starts, including parallel fan-outs.
- Keep the session MOC readable, durable, and updated atomically.
- Preserve provenance, final output, errors, lifecycle status, and relative
  navigation links.
- Remain safe when multiple tool calls race or when a parent session is
  resumed after a restart.
- Make the binding observable in tool results and child context so an
  orchestrator can verify which session is being used.

## Non-goals

- Do not create one artifact session per child agent, pane, tab, prompt, or
  `start` call.
- Do not use `LifecycleRegistry.sessionId` as the durable artifact-session ID.
- Do not use a child pi JSONL path or child process environment as the parent
  session identity.
- Do not create a global `.shepherd/shepherd.md` index.
- Do not require agents to edit the MOC or another agent's artifact.
- Do not add a generic shared writable scratch file for parallel agents.
- Do not automatically commit, checkout, delete, or clean up artifacts.
- Do not make artifact persistence depend on an agent remaining open after its
  prompt completes.
- Do not reintroduce workflow-specific `single`, `parallel`, or `chain` modes
  into the low-level `start`, `prompt`, and `wait` API.

## Terminology

### Parent pi session

The pi session in which the Shepherd extension is registered and whose model
invokes the `shepherd` tool. This is the orchestrator session. It owns the
artifact-session binding.

### Child pi session

The pi process launched in a Herdr pane by `start`. A child may have its own
JSONL session file, but that file is execution state and is not an artifact
session identity.

### Persistent artifact session

The durable project-local directory under
`.shepherd/sessions/NNNN-<slug>/`. It contains one `shepherd.md` MOC,
`session.json`, and one artifact file per child invocation.

### Invocation

One unit of work submitted to a child and represented by one artifact. In the
current API this is the successful `prompt` operation associated with a child;
the implementation may reserve the artifact at `start` time when the initial
work plan is known, or at prompt time before submitting the message. A bare
idle `start` must not create an artifact for work that has not been submitted.

## Binding model

### Required identity

At the beginning of the parent pi session, or lazily before the first
artifact-producing Shepherd operation, the extension must obtain a stable
parent-session identity from the pi runtime. The identity must be available to
all subsequent tool calls in that parent session and must remain stable across
extension callbacks and asynchronous lifecycle operations.

The implementation should use the pi-provided session identity or canonical
parent session path when available. It must not invent a new durable identity
for each child. If the pi runtime exposes no stable public identity, the
extension must establish one at parent-session initialization and retain it in
an in-memory parent-session binding for the lifetime of the orchestrator. The
fallback must be documented and must not be `LifecycleRegistry.sessionId`.

The binding key is:

```text
(parentPiSessionIdentity, effectiveProjectRoot)
```

The project root is the effective `cwd` used for the operation, normally the
parent tool context's `ctx.cwd`. A child `cwd` override does not silently move
an artifact session to another project: the artifact session remains owned by
the parent project root unless the API explicitly defines a separate,
validated parent project context. Implementations must reject or clearly
separate cross-project operations rather than merging artifacts from unrelated
roots.

### Allocation and reuse

On the first artifact-producing operation for a binding:

1. Resolve the effective project root.
2. Resolve the parent pi session identity.
3. Look up an existing binding for that pair.
4. If found, load and validate its `session.json`.
5. If not found, allocate exactly one numbered session directory under
   `<projectRoot>/.shepherd/sessions/`, persist the parent binding metadata,
   and initialize `shepherd.md` and `session.json`.
6. Cache the resolved session context for later Shepherd calls.

Every later artifact-producing operation for the same parent binding must reuse
the same `sessionPath`, even if it starts a different agent, uses a different
Herdr pane, or occurs in a later tool call. In particular:

```text
parent pi session P:
  start scout   -> .shepherd/sessions/0007-task/
  prompt scout  -> .shepherd/sessions/0007-task/scout-01.md
  start planner -> .shepherd/sessions/0007-task/
  prompt planner -> .shepherd/sessions/0007-task/planner-01.md
  start worker  -> .shepherd/sessions/0007-task/
  prompt worker -> .shepherd/sessions/0007-task/worker-01.md
```

The second `start` must not allocate `0008-*` solely because the agent differs
from the first one. A new numbered directory is allowed only when the parent
pi session identity or effective project root is different, or when the
existing binding is invalid and recovery follows the rules below.

### Parent-session binding metadata

`session.json` must record enough information to distinguish a parent-bound
session from an unrelated durable session. In addition to the fields retained
from `001-artifacts`, it must contain a versioned binding object or equivalent
fields:

```json
{
  "artifactSessionVersion": 2,
  "parentPiSession": {
    "identity": "<opaque pi-provided identity>",
    "projectRoot": "/repo",
    "boundAt": "2025-08-14T09:30:00.000Z"
  }
}
```

The identity is opaque and must not be derived from an agent name, task text,
Herdr pane ID, tab ID, lifecycle handle ID, or child JSONL file. It may be
stored as a hash or other safe representation if the raw pi identity is not
appropriate to persist, provided equality can still be checked for resumed
parent sessions.

Absolute paths may be retained for local diagnostics, but project-relative
paths must remain available for portable artifact links. Metadata parsing must
never trust arbitrary paths from disk without resolving and validating them
under the current project/session root.

### Restart and resumed parent sessions

A new pi process that resumes the same pi session must resolve the existing
parent-bound artifact directory rather than create another one. The lookup
must use the pi session identity and validated metadata, not only a slug or
most-recent directory.

If the pi runtime creates a new identity after a true new parent session, the
new parent is allowed to receive a new artifact directory, even when the task
text and slug are identical. Slug equality alone must never merge two parent
sessions.

If binding metadata is missing or corrupt:

- do not silently attach the parent to an unrelated session;
- report a clear recoverable error, or allocate a new session with an explicit
  recovery marker according to the implementation's documented policy; and
- preserve the old directory and artifacts without deleting them.

If a legacy `001-artifacts` session has no parent binding metadata, it may be
continued only through an explicit migration or compatibility operation. It
must not be selected merely because its `sessionName` or slug resembles the
current task.

## Artifact layout and MOC

For a parent-bound session rooted at `<project>`:

```text
<project>/.shepherd/
└── sessions/
    └── 0007-fix-oauth-login/
        ├── shepherd.md
        ├── session.json
        ├── scout-01.md
        ├── planner-01.md
        └── worker-01.md
```

The session contains exactly one MOC. The MOC is owned by the orchestrator and
must link every artifact in this parent session. It must show at least the
session status, parent binding status or redacted identity, start/update times,
project, modes observed, artifact statuses, and flow/order links.

MOC writes and `session.json` writes must be serialized and atomic. Parallel
reservations and completions must not lose entries written by another caller.
A session spanning multiple tool calls appends new artifacts and retains all
previous entries.

The implementation may retain the numbered `NNNN-<slug>` layout and safe slug
normalization from `001-artifacts`. Number allocation must use an exclusive
lock or equivalent retry-safe filesystem operation. Slug collisions must not
merge different parent bindings; a deterministic suffix is required when
needed.

## Artifact lifecycle

Every submitted child invocation receives one artifact in the shared parent
session:

```text
<safe-agent-slug>-NN.md
```

The per-agent ordinal is scoped to the parent-bound artifact session and is
never reused. Different labels that normalize to the same filename must be
collision-safe. Reservations happen before the corresponding child work is
submitted, especially for parallel operations.

An artifact must preserve provenance such as:

```yaml
---
artifactSessionVersion: 2
session: 0007-fix-oauth-login
sessionName: fix-oauth-login
parentPiSession: <opaque-or-redacted-identity>
agent: scout
ordinal: 1
mode: lifecycle
status: running
reservedAt: 2025-08-14T09:30:00.000Z
started: 2025-08-14T09:30:01.000Z
pane: w8:pY
handle: shepherd-agent-...
---
```

The exact metadata representation may evolve, but it must identify the parent
artifact session, child agent, invocation, and lifecycle status.

The orchestrator must initialize the artifact before submission, update it as
lifecycle state changes, and finalize it after a safe completion boundary with:

- the child’s final text/output when available;
- failure, timeout, cancellation, or blocked details when applicable;
- start/completion timestamps; and
- Herdr and lifecycle identifiers useful for provenance.

If a child wrote report content to its assigned artifact, finalization must
preserve that content and add a clearly marked orchestration section rather
than overwrite it. Child instructions must include absolute and relative
artifact paths, tell the child to read the MOC first, and prohibit editing the
MOC or another child’s artifact.

A bare `start` creates or reuses the parent artifact-session binding but does
not create a per-agent artifact until work is actually reserved/submitted. If
the implementation chooses to reserve at `start`, it must document that the
reservation represents a planned invocation and must finalize abandoned starts
as cancelled without allocating another session directory.

## API and integration requirements

The low-level public lifecycle shapes remain:

```text
start(agent, options) -> AgentHandle
prompt(handle, message, options) -> PromptHandle
wait(handle | handles, options) -> Result | Result[]
status(handle) -> Status
close(handle) -> AgentHandle
```

Artifact context is internal to the parent `shepherd` tool and is not a child
supplied option. The public result details for artifact-producing operations
must expose enough context for the orchestrator and tests to identify the
shared session, for example:

```ts
{
  sessionName: "fix-oauth-login",
  sessionPath: "/repo/.shepherd/sessions/0007-fix-oauth-login",
  sessionRelativePath: ".shepherd/sessions/0007-fix-oauth-login",
  artifactPath: "/repo/.shepherd/sessions/0007-fix-oauth-login/scout-01.md"
}
```

The exact result shape may differ, but `sessionPath` and the artifact path
must be available without requiring the child to infer them. `start` may return
the current shared `sessionPath` if binding is initialized there; it must not
return a new session path per agent.

The session context passed to a child must be constructed by the parent
orchestrator and appended to the task/message without replacing it:

```text
Shepherd artifact session context:
- Session directory: /repo/.shepherd/sessions/0007-fix-oauth-login
- Session MOC: /repo/.shepherd/sessions/0007-fix-oauth-login/shepherd.md
- Your artifact: /repo/.shepherd/sessions/0007-fix-oauth-login/scout-01.md
- Relative artifact: .shepherd/sessions/0007-fix-oauth-login/scout-01.md

Read the MOC first. Write detailed findings to your assigned artifact when
appropriate. Do not edit shepherd.md or another agent's artifact.
```

`LifecycleRegistry` may continue to own in-memory handles and prompt state,
but it must carry or reference the parent artifact-session binding when
needed. Its random internal `sessionId` must not be used as the persistent
session identity and must not cause artifact-folder allocation.

Child `shepherd_done` completion signaling remains an execution/lifecycle
mechanism. It must update the artifact belonging to the parent binding, not
create or resolve a child-owned artifact session.

## Concurrency and safety

- Resolve the parent binding once and serialize allocation with an exclusive
  lock.
- Serialize session metadata, MOC, and artifact metadata updates.
- Reserve all planned artifacts before launching parallel children.
- Use same-directory temporary files followed by rename for atomic writes.
- Validate every session/artifact path as a descendant of the current project
  and session root.
- Do not trust child-provided session paths or artifact paths.
- Do not let a child choose a different parent binding through prompt text or
  environment variables.
- A failed child start must finalize its already-reserved artifact as failed or
  cancelled and must not allocate a replacement session directory.
- Closing a child must not close or delete the shared artifact session.
- Parent shutdown, extension reload, timeout, and Herdr failure must leave
  artifacts and metadata on disk.
- No automatic cleanup, commit, checkout, or deletion is performed.

## Migration from the current low-level implementation

The current implementation has lifecycle state in `orchestration.ts` and
`lifecycle.ts`, while the historical artifact implementation lived in
`sessions.ts` and the old workflow-oriented `subagent.ts`. The implementation
should extract/reintroduce the filesystem behavior as a focused module (for
example `sessions.ts` or `artifact-sessions.ts`) and integrate it at the parent
`shepherd` tool boundary.

The implementation must not allocate artifacts inside `startAgent` merely
because it creates a Herdr pane. Instead, the parent orchestration layer must
resolve the shared binding and reserve artifacts around actual submitted work.
Child launch/session files in `herdr.ts` remain temporary execution state.

If compatibility with legacy `sessionName` is retained, it is an optional
human-readable label and lookup hint within the already-resolved parent
binding. It must not override the parent pi identity or permit two artifact
sessions for one parent/project pair. A caller cannot force a new artifact
folder for an individual child through an agent name, task, or lifecycle call.

## Verification plan

Add filesystem-only and orchestration tests covering at least:

1. **Shared folder regression:** start/prompt a scout, then start/prompt a
   planner in the same parent session; assert both artifacts and the MOC are in
   exactly the same `sessionPath` and only one numbered directory is created.
2. **Repeated calls:** perform the operations in separate tool calls and assert
   the second call reloads the original binding and retains the first artifact.
3. **Parallel fan-out:** reserve multiple artifacts before launches; assert
   unique paths, one MOC, and no lost metadata under concurrent completion.
4. **Different parent sessions:** same project and same task/slug but different
   parent pi identities must produce separate sessions.
5. **Resume after restart:** reopen the same parent identity and resolve the
   original directory; do not allocate a new one.
6. **Project isolation:** the same parent identity operating on different
   project roots must not merge artifacts.
7. **Lifecycle separation:** changing or recreating the in-memory
   `LifecycleRegistry.sessionId` must not change the persistent artifact path.
8. **Bare start:** an idle start does not create an unrelated artifact and does
   not allocate a second folder when later prompted.
9. **Failure paths:** failed start, prompt failure, timeout, cancellation, and
   close preserve artifact and MOC metadata without deleting the session.
10. **Security/concurrency:** traversal rejection, safe collision suffixes,
    atomic writes, exclusive numbering, and ownership validation.
11. **Child context:** every child receives the same absolute session directory
    and MOC path, plus its own unique artifact path.
12. **Legacy data:** unbound legacy sessions are not silently attached to a
    new parent session.

The primary acceptance assertion is:

```text
same parent pi session + same project root + N child invocations
=> exactly one persistent artifact session directory
=> N distinct artifact files in that directory
=> one MOC linking all N artifacts
```

## Retention and cleanup policy

Artifacts are durable project-local records. The extension must not remove
`.shepherd/sessions/` or any session/artifact file automatically when a child
closes, when all prompts settle, when the parent session ends, or when the
extension reloads. Cleanup, archival, commit, and checkout remain explicit
future/user operations.
