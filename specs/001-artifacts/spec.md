# Note-backed Shepherd Sessions

## Status

Proposed specification.

## Summary

A Shepherd delegation workflow is backed by a durable, human-readable session
folder under the project being worked on. The session contains a `shepherd.md`
file acting as a map of content (fieldnotes) and one note per delegated agent
invocation. A session may span multiple `shepherd` tool calls. Reusing the same
session name continues the existing session rather than creating a new one.

There is intentionally **no global or project-level `shepherd.md` index file**.
The session's own `shepherd.md` is the only Shepherd fieldnotes index.

## Goals

- Create a durable session automatically for delegated work.
- Use meaningful, stable session names and monotonically allocated numbers.
- Allow a session to span multiple single, parallel, and chain delegation calls.
- Let a later delegation call consume and extend notes from earlier calls.
- Give every agent a unique note path and enough session context to navigate
  the work.
- Keep the session fieldnotes readable and useful to both agents and humans.
- Support Markdown links between notes and to files, URLs, and other project
  resources.
- Preserve safe behavior when multiple agents run in parallel or multiple
  Shepherd calls happen close together.
- Remain backwards compatible for callers that do not provide a session name.

## Non-goals

- No global `.shepherd/shepherd.md` index.
- No requirement that agents edit the session fieldnotes directly.
- No generic shared writable scratch file for parallel agents.
- No second LLM call solely to generate a session name.
- No attempt to make Markdown itself a transactional database.
- No automatic commit, checkout, or cleanup of session notes.

## Directory layout

For a project rooted at `<project>`:

```text
<project>/.shepherd/
└── sessions/
    └── 0001-fix-oauth-login/
        ├── shepherd.md
        ├── session.json
        ├── scout-01.md
        ├── scout-02.md
        ├── planner-01.md
        ├── worker-01.md
        └── reviewer-01.md
```

Only the session directory is created automatically. `.shepherd/` must not
contain a top-level `shepherd.md` index.

The numbered directory name consists of:

```text
NNNN-<slug>
```

`NNNN` is a zero-padded decimal sequence scoped to the project's
`.shepherd/sessions/` directory. `<slug>` is a deterministic, filesystem-safe
lowercase name.

## Session identity and continuation

### Session name

Delegation accepts an optional session name, exposed as `sessionName` in the
Shepherd tool API. The name is both:

1. the human-facing identity used to find or create a session; and
2. the source for the directory slug when a new session is created.

The caller should use a stable, descriptive name such as
`fix-oauth-login`, not a transient task description.

### Create or continue

For a given project root and session name:

- If a matching session exists, continue that session.
- If no matching session exists, create a new numbered session directory.
- A new `shepherd` tool call with the same `sessionName` appends new work to the
  existing session, regardless of whether the previous call was single,
  parallel, or chain mode.
- The session remains usable after completion, failure, timeout, cancellation,
  or a pi restart.

The implementation must not identify a session by slug alone if that could
permit an unsafe path. It should resolve the requested name through validated
metadata (`session.json`) and/or an exact safe directory match under the
current project's sessions directory.

The project root is the effective delegation `cwd` (normally the parent
session's `ctx.cwd`). A session name is not allowed to escape that root.

### Missing name

For backwards compatibility, a call without `sessionName` still works. It
creates a new session using a deterministic slug derived from the first task,
for example `fix-oauth-login` or `delegation`. The returned result must include
the resolved session path and name so a later call can explicitly continue it.

If a workflow needs to span calls, the shepherd should pass the same
`sessionName` on every call. An optional future `sessionId` can be added if a
stable opaque identifier becomes necessary, but it is not required for this
specification.

### Name collision and numbering

Two different names may produce the same slug. Slug collisions must not merge
sessions. The allocator must resolve this deterministically, for example by
adding a short safe suffix, while preserving exact continuation for the
original name through `session.json`.

Number allocation must be safe under concurrent callers. A scan-for-highest
followed by mkdir is not sufficient. Use an exclusive filesystem operation
(or an equivalent retry loop) so two processes cannot claim the same number.
A failed or abandoned allocation must not be reused within the normal
allocation sequence.

## Session fieldnotes: `shepherd.md`

Each session has one fieldnotes collection at:

```text
.shepherd/sessions/NNNN-name/shepherd.md
```

The shepherd owns this file. Agents may read it but should not update it.
fieldnotes writes must be serialized and performed atomically (write a temporary file
in the same directory, then rename it).

Minimum content:

```markdown
# Session 0001 — Fix OAuth Login

- **Status:** running
- **Session name:** `fix-oauth-login`
- **Started:** 2025-08-14T09:30:00Z
- **Updated:** 2025-08-14T09:32:00Z
- **Project:** `.`
- **Mode(s):** chain, parallel

## Notes

1. [Scout 01](./scout-01.md) — completed
2. [Planner 01](./planner-01.md) — running
3. [Worker 01](./worker-01.md) — pending

## Flow

```text
[scout-01](./scout-01.md) → [planner-01](./planner-01.md) → [worker-01](./worker-01.md)
```

## Related files

- [Authentication service](../../src/auth/service.ts)
- [Issue](https://example.com/issues/123)
```

The exact presentation may evolve, but links should be relative whenever the
link target is inside the session or project. External URLs remain ordinary
Markdown links.

The fieldnotes should be updated when:

- the session is created;
- a delegation invocation is registered;
- a note is reserved;
- an agent starts, completes, fails, times out, or is cancelled; and
- the session reaches a terminal state, when that can be determined.

A session spanning multiple tool calls should retain previous notes and
append new entries rather than rewriting history away.

## Notes

Every delegated agent invocation receives one unique note file in the
session root:

```text
<agent-name>-NN.md
```

Examples:

```text
scout-01.md
scout-02.md
planner-01.md
```

The ordinal is per agent name within the session and is never reused. If an
agent name contains unsafe or awkward characters, derive a safe slug for the
filename. If two note names still collide, add a deterministic suffix.

Notes should be reserved before their agent starts, especially in
parallel and chain workflows, so the path is stable regardless of completion
order.

Each note should contain enough metadata to identify its provenance:

```markdown
---
session: 0001-fix-oauth-login
sessionName: fix-oauth-login
agent: scout
ordinal: 1
mode: chain
status: completed
started: 2025-08-14T09:30:00Z
completed: 2025-08-14T09:32:00Z
pane: w8:pY
---

# Scout 01

<!-- Agent output or agent-maintained report follows. -->

...
```

The final output, failure details, and relevant lifecycle information must be
preserved in the note even if an agent does not write its own report.

## Agent context and ownership

The child task must include a session context block containing:

- absolute session directory;
- relative session directory from the project root;
- absolute path to `shepherd.md`;
- absolute path to the child's note;
- relative path to the child's note;
- instruction to read the fieldnotes before working;
- instruction to write detailed findings to the child's note when its role
  permits writing; and
- instruction not to edit the fieldnotes or another agent's note.

Example:

```text
Shepherd session context:
- Session: 0001-fix-oauth-login
- Session directory: /repo/.shepherd/sessions/0001-fix-oauth-login
- Session fieldnotes: /repo/.shepherd/sessions/0001-fix-oauth-login/shepherd.md
- Your note: /repo/.shepherd/sessions/0001-fix-oauth-login/scout-01.md

Read shepherd.md first. Keep your work in your assigned note. Do not edit
shepherd.md or another agent's note. Use relative Markdown links for files
inside the project or session.
```

The context must be added without accidentally replacing the delegated task or
agent system prompt.

### Note writing strategy

The first implementation should guarantee note persistence from the
shepherd:

1. reserve and initialize the note before launch;
2. run the agent;
3. after a safe terminal result, write the final assistant output and lifecycle
   metadata to the note;
4. update the fieldnotes.

Read-only agents such as the bundled scout and planner therefore still produce
notes. They do not need generic write access merely to satisfy the
note contract.

A later implementation may add a restricted child-side note tool, but
prompt-level instructions are not a security boundary. If introduced, it must
only permit writes to the assigned note path.

If an agent writes its own note, the shepherd must define whether that
content is authoritative. The recommended rule is: preserve agent-authored
content, then add/update a clearly marked shepherd metadata and output
section rather than silently overwriting it.

## Cross-call orchestration

A later call using the same session name should receive a concise context block
and be instructed to inspect the existing fieldnotes and relevant notes. The
shepherd may also include selected prior output in `{previous}` for chain
compatibility, but notes are the durable source of truth and should be
preferred for large reports.

Example sequence:

```text
Call 1:
  sessionName: fix-oauth-login
  chain: scout → planner

Call 2:
  sessionName: fix-oauth-login
  agent: worker
  task: Read the session fieldnotes and implement the approved plan.

Call 3:
  sessionName: fix-oauth-login
  agent: reviewer
  task: Review the implementation using the session notes and current diff.
```

The fieldnotes after these calls links all five notes in one session.

## Lifecycle and Herdr safety

Note-backed delegation uses `stayOpen: false` by default. This is the
simplest and safest lifecycle: the child exits after completion, the Herdr
sentinel confirms that it has stopped writing, and only then does the parent
parse the child session and finalize the note.

`keepOpen` remains independent. With the default combination
`stayOpen: false, keepOpen: true`, the pi process exits but the Herdr tab remains
available for inspection. A caller may explicitly request `stayOpen: true` when
interactive follow-up is more important than immediate note finalization.

The current Herdr runner may keep child pi alive when `stayOpen` is enabled.
Note finalization must not read or delete a child session JSONL file while
that child can still write it.

Therefore:

- durable note metadata may be updated while the child is running, but
  final child output must be captured only after a safe completion boundary;
- with the default `stayOpen: false`, wait for the process-exit sentinel before
  parsing the child session and finalizing output;
- with explicit `stayOpen: true`, either use a completion snapshot guaranteed to
  be immutable after signaling, or defer finalization until the child exits;
- timeout and abort paths must leave the session and note marked as such,
  without deleting files still owned by a live child;
- a later call may continue a session containing timed-out or abandoned
  notes.

This preserves the invariant that nothing reads a child session before the
child has exited.

## API proposal

Add an optional parameter to delegation:

```ts
sessionName?: string
```

The parameter is available on:

- `shepherd` action `delegate`;
- single delegation;
- parallel delegation; and
- chain delegation.

For note-backed delegation, `stayOpen` defaults to `false`. The public
`keepOpen` option still defaults to `true`, so completed tabs remain visible
without leaving child pi processes alive. Explicit caller options continue to
win over defaults.

The result should report at least:

```ts
{
  sessionName: string;
  sessionPath: string;
  sessionRelativePath: string;
}
```

The internal session context should be passed through `executeDelegation` and
`runSingleAgent` without exposing filesystem implementation details to the
agent discovery module.

A future extension may add:

```ts
sessionId?: string
```

but same-name continuation is the required behavior for the initial version.

## Implementation outline

1. Add a pure filesystem-oriented `sessions.ts` module.
2. Implement safe name normalization, exact session lookup, atomic numbered
   allocation, note reservation, and atomic fieldnotes/metadata writes.
3. Make `stayOpen: false` the default for note-backed delegation while
   keeping `keepOpen: true` as the default tab-inspection behavior.
4. Add `sessionName` to `types.ts` and the public `shepherd` schema.
5. Create or resolve the session at the beginning of `executeDelegation`, after
   parameter validation and project-agent confirmation where appropriate.
6. Reserve one note per planned invocation and add session context to each
   child task.
7. Update `runSingleAgent` and all single/parallel/chain paths to finalize
   notes and fieldnotes entries.
8. Preserve `{previous}` behavior for compatibility, while directing agents to
   use session notes for durable context.
9. Add filesystem-only verification covering:
   - safe slugging and traversal rejection;
   - same-name continuation;
   - different-name collision handling;
   - concurrent numbering;
   - per-agent ordinals and duplicate agent names;
   - relative links in the fieldnotes;
   - chain and parallel registration;
   - success, failure, timeout, and cancellation metadata; and
   - atomic write behavior.
10. Document the layout, continuation rule, no-global-index decision, and
    lifecycle defaults in `README.md` and `PLAN.md`.

## Risks and decisions to revisit

- If two independent callers intentionally use the same session name in one
  project, they will share a session by design. Users should choose names that
  represent one workstream.
- A session name reused for unrelated future work will append to old history.
  The UI/result should show that an existing session was resumed.
- Agent-authored Markdown and shepherd metadata need a clear merge policy.
- `.shepherd/` version-control policy should remain an explicit project choice;
  the extension should not silently add it to `.gitignore`.
- Absolute paths in `session.json` are useful locally but should be minimized or
  accompanied by project-relative paths if notes are committed.
- Session fieldnotes updates from parallel completions require serialization to avoid
  lost updates.
