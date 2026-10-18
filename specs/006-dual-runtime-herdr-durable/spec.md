# Dual-runtime Shepherd: Herdr + Durable

## Status

Proposed specification. No behavior change yet.

## Summary

Add a `durable` execution backend to pi-shepherd alongside the existing
`herdr` backend, behind one stable Shepherd surface.

Today pi-shepherd is Herdr-native: `shepherd_spawn` creates a real Herdr
pane with a full `pi` process, tracked in `created-panes.json`, with shared
context in `.shepherd/sessions/` fieldnotes. That stays the default and the
hero.

The new backend runs the same orchestrator pattern — orchestrator launches a
specialist per task, crash-reviewer follows test-driver on failure — as
durable owned conversations + tasks in `@earendil-works/pi-durable`
(`Harness`, `Conversation`, `Submission`, SQLite/Memory storage) instead of
OS processes. Same tool names, same opaque IDs, same agent Markdown
definitions, same agent-facing `shepherd.md` shared memory.

Motivation is a concrete existing workflow plus a concrete new requirement:

1. Existing: orchestrator launches one agent per task to drive the program
   under test; if the app crashes, a different-context agent reviews the
   crash. This must keep working unchanged in Herdr.
2. New: company AI test agent, multi-user, per-user models (free local vs.
   company Copilot subscription), test plans run overnight, report in the
   morning. Herdr panes alone cannot do crash-resume, single-owner
   persistence, usage accounting, or headless operation. Durable can.

## Concept guardrail: no washout

Shepherd's name comes from herding in Herdr, and that concept must not
dilute. To prevent it:

- Shepherd = orchestration pattern (`spawn -> delegate -> watch -> done`,
  visible sheep, shared fieldnotes), not an execution substrate. Herdr is
  today's pasture, durable is the night pen. Same flock.
- Herdr remains default and documented first. `backend: "herdr"` default.
  `/shepherd herd/spawn/read`, 🐑 widget, pane visibility unchanged.
- Durable is opt-in (`backend: "durable" | "auto"`), experimental.
- No durable vocabulary leaks: users see `agent ID / task ID / message ID`,
  never `conversationId / submissionId / pi.live`. `shepherd_read` tails a
  pane *or* a view; caller does not care.
- Files stay agent-facing: `.shepherd/sessions/.../shepherd.md` + per-agent
  notes are the shepherd/sheep shared working memory. They survive
  compaction, waiting, close, timeout, and restart, and are the agents'
  source of truth — never the human handoff. Durable docs mirror them
  transactionally. The morning human report is a separate templated HTML
  file owned by the calling app (e.g. test-report renderer), built from job
  state — it has nothing to do with shepherd internals.
- If the existing test-driver -> crash-reviewer prompt runs unchanged on
  both backends, this spec succeeded. If users must rewrite prompts per
  backend, it failed.

## Goals

- Keep 100% of current Herdr behavior unchanged when `backend: herdr`.
- Run the same orchestrator/specialist workflows headless on durable with
  crash `resume()`, `requestId` dedup, queued steers/follow-ups, and
  usage accounting.
- Reuse agent Markdown definitions (`name/description/tools/model/thinking`)
  on both backends. `model: null/default` inherits Shepherd model on both.
- Map per-user models: Shepherd session per user carries that user's
  default model; children inherit unless pinned (e.g. cheap local triage
  vs. Copilot deep review).
- Bridge fieldnotes to durable docs: single commit writes entry + doc,
  file mirror for inspection.
- Support foreground (return answer) and background (persistent worker,
  survives parent abort) subagents on both backends.
- Keep safety invariants: only close panes shepherd created; raw pane IDs
  never bypass ownership; project agents stay trust-gated with
  `confirmProjectAgents` user-owned.
- Keep `timeout` + `staleWaitThreshold` semantics on both backends
  (durable has no native timeout; shepherd implements via abort).

## Non-goals

- No replacement of Herdr execution. No removal of panes, widgets, or
  `created-panes.json`.
- No requirement to run SQLite to use shepherd. Herdr-only installs keep
  working with no new dependencies.
- No second tool surface. No `durable_spawn` / `herdr_spawn` split in the
  model-facing API. Backend selects inside `shepherd_*`.
- No automatic migration of in-flight Herdr tasks to durable or vice versa.
- No multi-writer SQLite. One process owns durable storage at a time;
  federated multi-host is out of scope (document headless-single-owner
  + optional Herdr tail viewer instead).
- No change to `confirmProjectAgents` security boundary.

## Architecture

### Layout

`src/core/` holds shared domain only. Runtime implementations live under
`src/runtimes/`; the pi-coding-agent surface stays in `src/extension/`:

```text
src/core/            discovery, artifact-sessions, types, ID codec
src/runtimes/
  runtime.ts         ShepherdRuntime interface (opaque types only)
  herdr/             current herdr.ts, orchestration.ts, lifecycle.ts, messaging.ts
  durable/           new runtime.ts + extension.ts
src/extension/       pi-coding-agent tools/commands; calls runtime.ts
```

### Runtime interface

Extract what `src/core/{herdr,orchestration,lifecycle,messaging}.ts` do
today behind a pure interface. Existing Herdr code moves, behavior does
not.

```ts
// src/runtimes/runtime.ts (new, no herdr or pi-durable import)
interface ShepherdRuntime {
  spawn(def: AgentDef, opts: { cwd?: string; label?: string; placement?: "pane_right"|"pane_down"|"tab"|"workspace" }): Promise<AgentHandle>
  delegate(agentId: string, task: string, opts: { requestId?: string; timeoutMin?: number }): Promise<TaskId>
  message(target: AgentId | "parent", msg: string, opts: { taskId?: string; expectsReply?: boolean; replyTo?: string; delivery?: "followUp"|"steer" }): Promise<MessageId>
  watch(taskIds: string[]): Promise<Completion[]>
  status(agentId: string): Promise<{ proc: "idle"|"working"|"unknown"; task: "running"|"waiting"|"done"|"blocked"|"failed"; waitingOn?: string; stale?: boolean }>
  close(agentId: string): Promise<void>
  read(agentId: string, opts?: { lines?: number }): Promise<string>
}
```

- `src/runtimes/herdr/` (new): `herdr.ts`, `orchestration.ts`,
  `lifecycle.ts`, and `messaging.ts` move here rename-only and jointly
  implement the interface. `src/core/` keeps only shared domain modules.
- `src/runtimes/durable/runtime.ts` (new): implements the same interface
  over pi-durable.
- `src/extension/shepherd.ts`: unchanged tool schemas; calls the runtime
  interface instead of Herdr internals.

Phase 0 leaves temporary re-export shims at the old `src/core/*` paths so
the existing `verify-*.mjs` suite passes untouched. Shims and import paths
are cleaned up together in Phase 1.

IDs stay opaque session-scoped strings as today (`shepherd_spawn -> agent
ID`, `shepherd_delegate -> task ID`, `shepherd_message -> message ID`,
reply via `replyTo`). Internally map to `paneId` OR
`{ conversationId, submissionId, taskId }`. Never expose Herdr pane IDs or
durable conversation IDs. Pane IDs remain diagnostic-only for
`shepherd_read`.

### Durable mapping

One sheep = one owned conversation (mirrors pi-durable examples
`22-subagent-foreground`, `23-subagent-background`):

- `spawn` -> `tx.createConversation({ ownership: { kind: "task", taskId: parentTask } })`
  + `configure({ model, thinkingLevel, tools, cwd, instructions })` from
  agent frontmatter. Fresh `pi.provider` identity per sheep (no cache leak
  across users). `placement` ignored; `cwd` honored.
- `delegate` -> `conversation.submit({ type: "input", content: task, requestId })`.
  `requestId` defaults to shepherd task ID. Retried overnight submits dedup
  instead of double-running tests.
- child `shepherd_done` -> completes owner task. Parent `shepherd_watch` ->
  `submission.wait() / harness.waitForTask()`.
- `message` without model impact -> `submit({ type: "write", entry: { kind, data } })`,
  appended immediately even mid-run. With model impact -> steer/follow-up
  (`whenBusy: "steer" | "follow-up"`), queued in `docs["pi.inbox"]`.
- `expectsReply: true` -> durable `waiting` on another task. Reuse
  `staleWaitThreshold` reminder (informational only) + `timeout` as
  authoritative abort -> `blocked`, same as Herdr today.
- `close/abort` -> `conversation.abort()` bottom-up (owned work first),
  queued inputs withdrawn, queued writes stay. `background: true` anchor
  tasks implement today's `stayOpen` persistent workers: survive parent
  abort, reporter task posts answer back as follow-up.
- `status` -> `viewState()` (`entries`, `docs[pi.live, pi.inbox]`) +
  `taskGraph()`. `proc: working` iff live generation/tools running;
  `task: waiting` iff parked on reply.
- `read` -> tail of committed entries + `pi.live` partials/output
  (or `watchEvents()` deltas), not pane scrollback.

Replay policy: test-driving tools that launch apps are NOT `replay: "safe"`.
Crash-interrupted calls yield `interrupted` error results with partial output,
never silent rerun. Only idempotent helpers (read-only git/log readers)
may opt into `replay: "safe"` with keyed `executeTool` reattach.

### Extension duality

pi-shepherd today is `ExtensionAPI from '@earendil-works/pi-coding-agent'`.
pi-durable has its own `defineExtension/defineTool` with
`(args, api, chordContext)` signatures. Keep one shared core, two adapters:

- Shared (no runtime import): `src/core/discovery.ts` (Markdown
  frontmatter: `name/description/tools/model/thinking/omit-*`), prompt
  assembly, fieldnotes path logic, ID codec.
- `src/extension/*`: the pi-coding-agent surface, unchanged behavior; it
  resolves the active runtime through `src/runtimes/runtime.ts`.
- `src/runtimes/durable/extension.ts` (new): `defineExtension({ name: "shepherd",
  tools: [shepherd_spawn, shepherd_delegate, shepherd_message,
  shepherd_watch, shepherd_status, shepherd_close, shepherd_read],
  docs: [ShepherdHerdDoc, ShepherdTasksDoc] })`.

`@earendil-works/pi-durable` + `@earendil-works/chord` become optional
peerDeps. Herdr-only installs must not grow install size or require new
storage.

### Agent definitions

No frontmatter change. Mapping:

| Shepherd md | Durable |
| --- | --- |
| `tools: read, bash` | `configure({ tools })` + `modelTools` narrowing |
| `model: null/default` | inherit Shepherd session model (per-user default) |
| `model: provider/id` | pin (e.g. crash triage on local, deep review on Copilot) |
| `thinking: high` | `thinkingLevel`, clamped per model |
| `omit-system-prompt/docs/context-files` | section resolution at request prep |

Bundled `scout/planner/worker/reviewer` keep working on both. Project
workflow adds e.g. `.agents/agents/test-driver.md` (full tools, captures
logs, never analyzes) and `.agents/agents/crash-reviewer.md` (read-only
bash, never launches app, `thinking: high`, `omit-context-files: true`).
Orchestrator prompt is backend-agnostic:

> Ask test-driver to run plan A. Watch it. On non-zero exit, give its
> fieldnote + log tail to crash-reviewer. Return both.

### Fieldnotes bridge (agent memory, not human report)

Today: `.shepherd/sessions/NNN-orchestrator-<id>/shepherd.md` index +
`<agent>-NN.md` notes. Audience is shepherd + sheep, not humans: shared
working memory so delegated work survives compaction, waiting, close,
timeout, and restart. That agent-truth role is what must be preserved on
durable.

Durable: introduce typed doc mirroring the same content:

```ts
ShepherdNotes = defineDoc<{ index: string; notes: Record<string,string> }>({
  kind: "shepherd.notes", scope: "conversation", history: "rewindable", fork: "asOf", initial: ...
})
```

Write note + entry in one `commit()` (atomic). Mirror to files via `env`
for agent continuity and debugging. Doc is truth for `resume()`; files
are the agents' view. `fieldnotes` setting stays session-scoped (new session after
toggle). Keep `.gitignore` pattern:

```gitignore
.shepherd/*
!.shepherd/config.json
```

### Settings

Extend `ShepherdSettings` with two fields, Herdr defaults preserved:

```jsonc
// ~/.pi/agent/pi-shepherd/config.json
{
  "agentScope": "user", "includeBundledAgents": true,
  "keepOpen": true, "stayOpen": false, "fieldnotes": true,
  "timeout": 20, "staleWaitThreshold": 5,
  "backend": "herdr" // | "durable" | "auto"
}
// .shepherd/config.json adds when active:
// { ..., "durableStorage": "sqlite:./.shepherd/durable.sqlite", "projectScope": true }
```

- `herdr` (default): current behavior, no durable code loaded.
- `durable`: all `shepherd_*` route to durable runtime backed by
  `MemoryStorage` (tests) or `openNodeSqliteStorage(path)` /
  `openNodeJsonlStorage(dir)` (service). WAL `synchronous=NORMAL` noted:
  survives process crash, newest commit may be lost on power failure.
- `auto`: execute on durable, and if Herdr reachable, open read-only tail
  panes fed by `watchEvents()` for visibility. Execution stays durable;
  panes never write.

`/shepherd settings` gains one `backend` row + `durableStorage` row.
`confirmProjectAgents` handling unchanged (user-owned).

`done-nudge` (one reminder turn when child ends turn with open task,
`PI_SHEPHERD_DONE_NUDGES`) maps to durable `onYield` hook on
`GenerationTask`, same one-turn budget, then stall reported as normal
message, never invented status.

## Overnight test-agent profile

Concrete settings for the motivating use case:

- One service process owns `./.shepherd/durable.sqlite`. `harness.resume()`
  on boot. `harness.closed.then(reopen if failed)`.
- One conversation per overnight job, `requestId = jobId`,
  `configure({ model: modelFor(user), cwd: /workspaces/<user>/<job> })`.
  Free-local vs. Copilot resolved at configure time; tokens never land in
  shared docs. Spend via `harness.usage()` per `provider/model` + tool.
- `settings.compaction { reserveTokens, keepRecentTokens, backgroundTokens }`
  tuned for 8h logs; `progress { partialIntervalMs: 100 }` default, raise
  to 500 for remote storage.
- Morning human report is out of shepherd scope: a separate templated HTML
  file owned by the app, rendered by a reporter from the job's report doc
  (e.g. `app.test-report`) + logs via `watchEvents()` snapshot + deltas.
  It must never be `shepherd.md`, a doc snapshot dump, or `/export`.
  Shepherd only guarantees the agent memory it was built from survived.
- Outer job file `jobId -> plan` only as boot re-submitter; `requestId`
  dedup makes it safe.

## Security and safety

- Keep: user discovery default, project agents trust-gated,
  `close` only closes shepherd-created panes (durable: only aborts owned
  conversations/tasks), raw pane IDs rejected, host-user tool permissions
  documented.
- Durable additions: per-user `cwd`/`env` isolation (`env.id` per user or
  container), `modelTools` least-privilege per sheep, `beforeTool` guard
  keeping `crash-reviewer` bash read-only, secrets only in service process
  (never in entries/docs/fieldnotes files committed to git).
- Storage: single-owner SQLite, no NFS multi-writer. Document
  `prefix: "pi_"` namespacing if sharing a DB file with host tables.

## Verification requirements

Implementation is complete only when:

- existing `verify-*.mjs` suite passes unchanged on `backend: herdr`;
- new `verify-durable-matrix.mjs` runs `delegate/task-completion/
  task-failures/message-routing/multi-wait/watchers` against
  `MemoryStorage + fauxProvider` on both backends with identical
  orchestrator prompts (test-driver -> crash-reviewer fixture);
- opaque ID contract holds: Herdr pane IDs and durable conversation IDs
  never accepted as `shepherd_*` IDs; `prune/status/read` never leak them;
- crash-resume test: kill mid `bash` on durable, `reopen + resume()`
  yields `interrupted` (unsafe) or reattached result (safe-keyed), no
  double test-run for same `requestId`;
- `expectsReply` waiting + `staleWaitThreshold` reminder + `timeout`
  `blocked` verified on both backends, including cwd-differing agents;
- fieldnotes <-> doc mirror test: note written in same commit as entry,
  file tail matches doc snapshot after restart; `fork: asOf` preserves
  handoff;
- `done-nudge` budget (1 turn, `0` disables) verified via `onYield` on
  durable;
- `npm test` passes; Herdr-only install pulls no durable dependency;
- live checks: `/shepherd herd/spawn/read/settings` on herdr;
  overnight dry-run (submit evening, kill service, resume morning, report
  renders) on durable.

## Migration

No migration. Default `backend: herdr` is current behavior. Opt-in per
workspace via `/shepherd settings` or `.shepherd/config.json`
(`projectScope: true` for teams). Compatibility wrappers from spec 002
(`delegate = start+prompt+wait+close`) remain valid; they compose
primitives regardless of backend.

## Open questions

1. `placement` in durable: ignore vs. map to Herdr tail-viewer panes in
   `auto` mode? Proposal: ignore for execution, honor for viewer.
2. `read --lines` pagination over durable ops frames vs. full view?
   Proposal: tail rendered entries, cap 100 undelivered frames like
   `watch()` does.
3. Compaction of `shepherd.notes` doc on very long overnight runs:
   `rewindable` bounded history vs. summary entry? Needs bench
   (`bench:storage`) before fixing a limit.
4. Should `auto` tail panes be `stayOpen: false` viewers that never accept
   input? Likely yes to avoid dual-write.
