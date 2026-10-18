# Tasks: Dual-runtime Shepherd (Herdr + Durable)

Work in order. Phase 0 must stay green before Phase 1 starts. A task is done
only when its implementation + verification are complete. This spec is
`006-dual-runtime-herdr-durable` (`spec.md` contract, `intent.md` vision,
`plan.md` design).

## Phase 0 — Extract 2-runtimes-1-core boundary (no behavior change)

- [ ] **0.1 Add `src/runtimes/runtime.ts` interface**
  - Define opaque `AgentHandle / TaskId / MessageId / Completion /
    RuntimeStatus` shapes; no Herdr pane IDs, no durable conversation IDs
    in the public contract.
  - Document internal mapping (Herdr `paneId` OR durable
    `{conversationId, submissionId, taskId}`) and diagnostic-only pane-ID
    rule for `shepherd_read`.
  - Interface file imports neither `herdr` CLI nor `pi-durable`; `src/core/`
    keeps only shared domain modules (`discovery.ts`, `artifact-sessions.ts`,
    `types.ts`, ID codec).

- [ ] **0.2 Move Herdr implementation behind it**
  - Move current `herdr.ts + orchestration.ts + lifecycle.ts +
    messaging.ts` rename-only into `src/runtimes/herdr/`, jointly
    implementing the interface.
  - Route `src/extension/shepherd.ts` through it with zero tool-schema,
    prompt, settings, widget, or fieldnotes-path change.
  - Leave temporary re-export shims at the old `src/core/*` paths so the
    Phase 0 suite passes untouched; 1.5 removes them.
  - Preserve: `created-panes.json` ownership, `--no-focus`, temp-file
    lifetime, session registries, `shepherd_done` 1-nudge
    (`PI_SHEPHERD_DONE_NUDGES`), `confirmProjectAgents` user-owned.

- [ ] **0.3 Verify boundary**
  - Full existing `verify-*.mjs` suite passes untouched; old `src/core/*`
    shims are the only stale-path survivors.
  - Live: idle spawn, non-blocking prompt, single + multi-wait, status,
    close, ownership refusal, project-agent gate.
  - Herdr-only install unchanged (no new dep evaluated).

## Phase 1 — Durable spawn/delegate/watch/done

- [ ] **1.1 Scaffold `src/runtimes/durable/` adapter**
  - Add `@earendil-works/pi-durable` + `@earendil-works/chord` as optional
    peerDeps; Herdr-only path never imports them.
  - Add `src/runtimes/durable/runtime.ts` implementing `runtime.ts` over
    `Harness`.
  - Add `src/runtimes/durable/extension.ts`:
    `defineExtension({name:"shepherd"})` with shepherd tools + docs
    (`ShepherdHerdDoc, ShepherdTasksDoc`).

- [ ] **1.2 Implement sheep-as-conversation**
  - `spawn` -> `tx.createConversation({ownership:{kind:"task",taskId}})` +
    `configure({model, thinkingLevel, tools, modelTools, cwd,
    instructions})` from agent frontmatter; fresh `pi.provider` identity.
  - `model:null/default` inherits Shepherd session model (per-user default);
    pinned model + clamped `thinking` honored; `placement` ignored for
    execution; `cwd` honored with per-user `env.id` isolation.
  - `delegate` -> `submit({type:"input", content, requestId})`, defaulting
    `requestId` to shepherd task ID; retries dedup, never double-run.
  - `done` (child) completes owner task; `watch` (parent) =
    `submission.wait() / waitForTask()` with steered delivery (mid-turn
    inject, idle new turn).
  - Wire `Harness.open(MemoryStorage | sqlite | jsonl)`, `resume()` on boot,
    `closed.then(reopen if failed)`; pass through
    `compaction/progress/retry/toolExecution`.

- [ ] **1.3 Replay policy**
  - App-driving tools default unsafe: crash -> `interrupted` + partials,
    never silent rerun.
  - Only idempotent readers may use `replay:"safe"` with keyed
    `executeTool` reattach; add fixture proving no double side effect for
    same `requestId`.

- [ ] **1.4 Verify foreground loop**
  - New `test/verify-durable-matrix.mjs` runs test-driver ->
    crash-reviewer fixture on herdr AND durable (`MemoryStorage +
    fauxProvider`) with identical orchestrator prompts.
  - Asserts same handoff, opaque-ID rejection (pane + conversation IDs
    refused), `MemoryStorage` resume after restart.

- [ ] **1.5 Update import paths + drop compat shims**
  - Rewrite `test/verify-*.mjs` and remaining `src/` imports from
    `../src/core/{herdr,orchestration,lifecycle,messaging}.ts` to the
    `src/runtimes/herdr/*` paths; assertions stay unchanged.
  - Delete the Phase 0 re-export shims; no old-path survivors remain.
  - Refresh `AGENTS.md` layout and semantic-center references to the new
    tree.
  - `npm test` green with shims gone and Herdr-only install still clean.

## Phase 2 — Message/status/read/close parity

- [ ] **2.1 Implement durable messaging**
  - Passive -> `submit({type:"write"})` (immediate even mid-run, except
    behind queued reset); active -> steer/follow-up into `pi.inbox`.
  - `expectsReply:true` -> durable `waiting`; `staleWaitThreshold` single
    info reminder; `timeout` abort -> `blocked`; reply/`resume`/complete
    clears episode. Cover cwd-differing agents.

- [ ] **2.2 Implement durable status/read/close**
  - `status` from `viewState() + taskGraph()` with
    `proc {idle|working|unknown} x task {running|waiting|done|blocked|
    failed}` + `waitingOn + stale`; keep idle-but-waiting visible.
  - `read` tails committed entries + `pi.live` partials/output (100-frame
    collapse rule); never leaks native IDs.
  - `close/abort` bottom-up, withdraw queued inputs (keep queued writes);
    `background:true` anchors implement `stayOpen` persistent workers +
    reporter follow-up pattern.

- [ ] **2.3 Map done-nudge**
  - Implement 1-turn reminder as durable `onYield` on `GenerationTask`
    (`0` disables); exhausted budget escalates as ordinary message, never
    invents terminal status. Verify on both backends.

- [ ] **2.4 Verify parity**
  - Extend matrix: `message-routing / task-failures / multi-wait /
    watchers / stale-wait` green on both; kill-mid-bash test yields
    `interrupted` (unsafe) or reattached (safe-keyed).

## Phase 3 — Agent memory bridge + settings + viewer

- [ ] **3.1 Fieldnotes <-> doc mirror (agent memory)**
  - Add `ShepherdNotes = defineDoc({kind:"shepherd.notes",
    scope:"conversation", history:"rewindable", fork:"asOf"})`.
  - Note + entry committed atomically; file mirror via `env` for agent
    continuity/debugging; `fieldnotes` stays session-scoped.
  - Document explicitly: `shepherd.md` is shepherd/sheep working memory
    surviving compaction — never the human morning report.
  - Test: file tail == doc snapshot after restart; `fork:asOf` handoff.

- [ ] **3.2 Settings + backend switch**
  - Add `backend: "herdr"|"durable"|"auto"` (default `herdr`) +
    `durableStorage` (`sqlite:path | jsonl:dir | memory`) to user +
    active-project (`.shepherd/config.json`, `projectScope:true`) layers.
  - `/shepherd settings` two new rows; project file cannot disable
    `confirmProjectAgents` nor force backend for others.
  - Keep `.gitignore` (` .shepherd/* + !config.json`) — sessions ignored,
    config committable.

- [ ] **3.3 Auto read-only viewer (optional but spec'd)**
  - In `auto`, execution stays durable; if Herdr reachable, open
    input-refusing tail panes fed by `watchEvents()` snapshot + deltas.
  - `placement` honored for viewer only; viewers are `stayOpen:false`.
  - Test no dual-write: viewer input rejected, kill-viewer never aborts job.

- [ ] **3.4 Reporter contract (docs only)**
  - Document app-owned HTML path: reporter reads job report doc
    (e.g. `app.test-report`) + logs, renders template. Shepherd implements
    no HTML, dumps no doc snapshot as report, claims no `/export` as
    report. Guarantee is only that agent memory survived.

## Phase 4 — Docs, tests, live proof

- [ ] **4.1 Update docs**
  - README: Herdr hero first, one backend section (durable experimental,
    `requestId`, single-owner SQLite, no multi-writer).
  - Agent-definition guide: frontmatter dual-mapping table.
  - Diagnostics: `extract:system-prompt` for both adapters.

- [ ] **4.2 Full test gate**
  - `npm test` green; Herdr-only install pulls no durable dep.
  - Matrix + mirror + nudge + timeout/stale tests green on memory.
  - SQLite crash-resume + `prefix:"pi_"` sharing note covered.

- [ ] **4.3 Live verification**
  - Herdr: `/shepherd herd/spawn/read/settings`, widget, ownership refusal.
  - Durable dry-run: submit evening -> kill service mid-run -> reopen +
    `resume()` morning -> agent memory intact -> app HTML renders from job
    doc (proving shepherd/report separation).

## Completion checklist

- [ ] Phases 0-3 implemented with 1 core + 2 runtimes, no surface fork.
- [ ] Herdr default behavior bit-identical; durable opt-in experimental.
- [ ] `shepherd.md` role preserved as agent memory; human HTML separate.
- [ ] Per-user models, `requestId` dedup, usage accounting work overnight.
- [ ] No pane-ID / conversation-ID leaks; ownership + trust intact.
- [ ] Docs, settings UI, tests, live proofs all green.
