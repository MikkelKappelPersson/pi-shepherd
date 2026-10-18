# Implementation Plan: Dual-runtime Shepherd (Herdr + Durable)

This plan implements `spec.md` + `intent.md` by refactoring pi-shepherd into
**2 runtimes, 1 core**: one pure orchestration core with two executors
(Herdr panes today, durable conversations/tasks tomorrow) behind the
unchanged `shepherd_*` surface.

## Target surface

No model-facing change. Same tools, same opaque IDs, same agent Markdown:

```text
shepherd_spawn(agent, {cwd, label, placement}) -> agent ID
shepherd_delegate(agentID, task, {requestId}) -> task ID
shepherd_message(target, message, {taskId, expectsReply, replyTo}) -> message ID
shepherd_watch({id: taskID | taskIDs}) -> completion notification(s)
shepherd_status(agentID) -> {proc, task, waitingOn, stale}
shepherd_close({id: agentID})
shepherd_read(agent, {lines}) -> tail
child: shepherd_message(parent|peer) + shepherd_done (only normal success)
```

Backend selects inside, never as `durable_*` tools:

```text
backend: "herdr" (default) | "durable" | "auto"
```

`auto` = execute on durable, mirror read-only tail panes in Herdr when
reachable. Panes never write in `auto`.

## Design decisions

- One behavioral contract, two implementations: `delegate = submit +
  watch`, `expectsReply -> waiting`, `staleWait` info-only + `timeout ->
  blocked`, 1-turn `done-nudge` budget, and the close-ownership rule are
  specified once and implemented per runtime — Herdr keeps today's code,
  durable reimplements the contract. Shared pure helpers (`discovery.ts`,
  `ids.ts`, fieldnotes paths, settings store, tool-schema types) live in
  `src/core/`, which imports neither the `herdr` CLI nor `pi-durable`.
- Runtimes are thin executors of one interface (`src/runtimes/runtime.ts`):
  `spawn / delegate / message / watch / status / close / read`.
  Herdr-runtime is moved current code; durable-runtime is new over
  `Harness / createConversation / submit(requestId) / wait / abort /
  viewState / watchEvents / taskGraph`.
- Layout: `src/core/` keeps shared domain only (`discovery.ts`,
  `artifact-sessions.ts`, `types.ts`, new `ids.ts`, settings store moved
  from `extension/config.ts` to `core/config.ts`). `src/runtimes/herdr/`
  receives `herdr.ts + orchestration.ts + lifecycle.ts` plus `messaging.ts`
  as support, rename-only; `src/runtimes/durable/` is new;
  `src/extension/` remains the pi adapter. Temporary re-export shims at
  the old `src/core/*` and `src/extension/config.ts` paths keep the Phase 0
  suite untouched; the Phase 1 import-path task drops them.
- Two adapters, one core: `src/extension/*` stays on
  `ExtensionAPI from '@earendil-works/pi-coding-agent'`; new
  `src/runtimes/durable/extension.ts` exposes `defineExtension({name:"shepherd"})`
  with `(args, api, chordCtx)` signatures. Shared agent frontmatter
  (`name/description/tools/model/thinking/omit-*`) maps to
  `configure({model, thinkingLevel, tools, cwd})` on durable.
- One sheep = one owned durable conversation
  (`ownership:{kind:"task", taskId}`, fresh `pi.provider` identity,
  `background:true` anchors for `stayOpen` persistent workers). Mirrors
  pi-durable `22-subagent-foreground / 23-subagent-background`.
- `shepherd.md` + per-agent notes are **agent memory, not human report**:
  shepherd/sheep working memory surviving compaction, waiting, close,
  restart. Durable `ShepherdNotes` doc mirrors them in the same `commit()`;
  files remain `tail -f`-able via `env`. Morning human handoff is a
  separate app-owned templated HTML file rendered from the job report doc —
  never `shepherd.md`, never a doc dump, never `/export`. Out of shepherd
  scope except to guarantee the memory it was built from survived.
- Replay: app-driving tools are NOT `replay:"safe"`. Crash-interrupt yields
  `interrupted` + partial output, never silent rerun. Only idempotent
  readers may opt in with keyed `executeTool` reattach.
- `@earendil-works/pi-durable` + `@earendil-works/chord` are optional
  peerDeps. Herdr-only installs load no durable code, grow no size,
  require no SQLite.
- `placement` ignored for durable execution, honored for `auto` viewer
  panes (viewers are `stayOpen:false`, input-refusing).
- `confirmProjectAgents` stays user-owned; backend choice follows the same
  rule (project file cannot force durable on).

## Phase 0 — Extract runtime boundary (no behavior change)

### 0.1 Define `src/runtimes/runtime.ts`

Opaque types only: `AgentHandle / TaskId / MessageId / Completion /
RuntimeStatus`. No Herdr identifiers, no durable identifiers in the public
contract. Document mapping: Herdr `paneId` OR durable
`{conversationId, submissionId, taskId}` internally.

### 0.2 Extract `src/core/ids.ts`

Move ID minting (`shepherd-<kind>-<session>-<uuid>`) and handle
parse/validation out of `LifecycleRegistry` into a pure codec both
runtimes call. `orchestration.ts` keeps handles and registries only.
Formats and `invalid_handle` messages stay identical.

### 0.3 Move Herdr code

Move current `src/core/herdr.ts + orchestration.ts + lifecycle.ts +
messaging.ts` rename-only into `src/runtimes/herdr/` (messaging is support,
not an interface implementer), and the settings store
`src/extension/config.ts` → `src/core/config.ts`. `src/extension/shepherd.ts`
and `index.ts` route lifecycle calls through the interface; discovery stays
shared and herd/prune/widget keep runtime introspection accessors. No
schema change, no prompt change. Leave re-export shims at the old
`src/core/*` and `src/extension/config.ts` paths so existing `verify-*.mjs`
passes untouched — that is the proof the boundary is right.

Keep: `created-panes.json` ownership source, `--no-focus` backgrounds,
temp-file lifetime (delete only after pane gone), session-scoped registries
with clear invalid-handle errors, `shepherd_done` 1-nudge rule
(`PI_SHEPHERD_DONE_NUDGES`, `0` disables).

### 0.4 Verify boundary

Existing `verify-*.mjs` suite passes untouched, live Herdr checks pass
(idle spawn, non-blocking prompt, single + multi-wait, status, close,
ownership refusal, project-agent gate), Herdr-only install evaluates no
new dependency.

## Phase 1 — Durable spawn/delegate/watch/done (foreground)

### 1.1 Scaffold `src/runtimes/durable/`

Add `@earendil-works/pi-durable` + `@earendil-works/chord` as optional
peerDeps (Herdr-only installs never import them). Create
`src/runtimes/durable/runtime.ts` (interface over `Harness`) and
`src/runtimes/durable/extension.ts` (`defineExtension` with the same tool
surface + docs).

### 1.2 Sheep-as-conversation

`spawn`: `tx.createConversation({ownership:{kind:"task",taskId}})` +
`configure()` from agent def. `model:null/default` inherits Shepherd session
model (per-user default: free local vs. Copilot); pinned `model` overrides
(e.g. triage local, deep review Copilot). `thinking` clamped per model.

`delegate`: `conversation.submit({type:"input", content, requestId})`,
`requestId` defaults to shepherd task ID for overnight dedup.

Child `shepherd_done` completes owner task; parent `watch` =
`submission.wait() / harness.waitForTask()`. Steered delivery preserved:
mid-turn inject between tool rounds, idle triggers new turn.

Harness wiring: `Harness.open(storage)` with `MemoryStorage` (tests) or
`openNodeSqliteStorage(path)` / `openNodeJsonlStorage(dir)` (service).
`harness.resume()` on boot, `harness.closed.then(reopen if failed)`.
`settings.compaction/progress/retry/toolExecution` pass-through, no shepherd
opinions except defaults that keep 8h logs alive.

### 1.3 Replay policy

App-driving tools stay non-`replay:"safe"`: crash-interrupted calls yield
`interrupted` + partial output, never silent rerun. Only idempotent
readers opt in with keyed `executeTool` reattach.

### 1.4 Matrix fixture

Add `test/verify-durable-matrix.mjs`: same test-driver -> crash-reviewer
fixture on both backends (`MemoryStorage + fauxProvider` for durable).
Asserts identical orchestrator prompts produce identical handoffs, opaque-ID
contract holds (pane IDs and conversation IDs both rejected as tool IDs),
same `requestId` never double-runs.

### 1.5 Update import/path references + drop shims

Rewrite imports in `test/verify-*.mjs` and root `index.ts` from
`src/core/{herdr,orchestration,lifecycle,messaging}.ts` and
`src/extension/config.ts` to `src/runtimes/herdr/*` and `src/core/config.ts`;
update non-import path strings (e.g. `test/verify-status-widget.mjs`
module-path assertions) and the `index.ts` header comment. Assertions stay
unchanged. Delete the Phase 0 shims and refresh layout references in
`AGENTS.md` and `docs/plans/architecture.md`. `npm test` green with no
old-path survivors.

## Phase 2 — Message/status/read/close/timeouts

`message` without model impact -> `submit({type:"write"})` (immediate even
mid-run, except behind queued reset). With impact -> steer/follow-up queued
in `docs[pi.inbox]`. `expectsReply:true` -> durable `waiting` + existing
`staleWaitThreshold` single reminder + `timeout` abort -> `blocked`.

`status` from `viewState() (entries, pi.live, pi.inbox)` + `taskGraph()`:
`working` iff live generation/tools running, `waiting` iff parked on reply,
with `waitingOn + stale`. Preserve idle-process-but-waiting-task visibility
the widget already handles.

`read` = committed entries + `pi.live` partials/output tail (cap like
`watch()` 100-frame collapse). `close/abort` bottom-up, queued inputs
withdrawn, queued writes stay. `background:true` anchors = `stayOpen`.

`done-nudge` maps to durable `onYield` on `GenerationTask`, same 1-turn
budget, then stall escalates as ordinary message.

## Phase 3 — Fieldnotes bridge + settings + auto viewer

`ShepherdNotes = defineDoc({kind:"shepherd.notes", scope:"conversation",
history:"rewindable", fork:"asOf"})`. Note + entry in one `commit()`.
File mirror via `env` for agent continuity/debugging. `fieldnotes`
session-scoped (new session after toggle). Keep gitignore:

```gitignore
.shepherd/*
!.shepherd/config.json
```

Settings: `backend` + `durableStorage` (`sqlite:path` / `jsonl:dir` /
`memory`) in user file + active project file
(`projectScope:true` pattern from spec 005). `/shepherd settings` gains two
rows. `auto` viewer: read-only Herdr panes fed by `watchEvents()`
snapshot + deltas, never accepting input (avoids dual-write).

Reporter contract (app-owned, documented not implemented): HTML renderer
reads job report doc (e.g. `app.test-report`) + logs, not shepherd internals.
Shepherd guarantees agent memory; app guarantees human template.

## Phase 4 — Tests, docs, live verification

Pure tests where possible (ID codec, registries, `requestId` dedup,
waiting/stale/timeout matrix, notes-doc mirror + `fork:asOf`, nudge
budget). `npm test` + Herdr-only install pulls no durable dep.

Docs: README gains one backend section (Herdr-first, durable experimental),
agent-definition guide notes dual mapping, diagnostics guide covers
`extract:system-prompt` for both adapters.

Live: `/shepherd herd/spawn/read/settings` on herdr; overnight dry-run on
durable (submit evening, kill service mid-bash, `reopen+resume` morning,
unsafe -> `interrupted`, safe-keyed -> reattached, report renders).

## Completion checklist

- [ ] `runtime.ts` + `ids.ts` extracted, Herdr moved with zero behavior
      change; Phase 0 shims dropped and import paths updated in Phase 1.
- [ ] Durable `spawn/delegate/watch/done` foreground works on memory+sqlite.
- [ ] `message/expectsReply/status/read/close/timeout/staleWait` parity.
- [ ] Notes doc <-> file mirror + `fork:asOf` handoff.
- [ ] `backend/durableStorage` settings + `auto` read-only viewer.
- [ ] Reporter contract documented; shepherd never emits human HTML.
- [ ] Matrix tests + crash-resume + `npm test` green, Herdr-only clean.
- [ ] README/docs updated, Herdr still hero and default.
