# Handoff: Asynchronous Shepherd Tasks and Agent Messaging

## Session state

- Branch: `feature/001-agent-messaging-and-task-lifecycle`
- Repository: `MikkelKappelPersson/pi-shepherd`
- Current HEAD: tip of the feature branch — `b2c3b59` plus the Phase 5 failure-test commit and this handoff update (hashes shift when this doc changes; use `git log --oneline`)
- Working tree: contains the Phase 11 launch-tool fix, verification updates, and documentation/checklist edits
- Last full verification: `npm test` passed with zero failures

This handoff is for continuing implementation on another computer. Start by
checking out the branch and reading this file, `spec.md`, `plan.md`, and
`tasks.md` in this directory.

## Completed work

### Phase 0 — Baseline and guardrails

Completed and committed in `a0dab9f`.

Added:

- `baseline.md`
- Reusable temporary-directory and fake-identity helpers
- Manual/scoped clock helpers
- Centralized future tool/surface/task-state contracts
- Explicit-settlement guardrail tests
- Phase 0 test command in `package.json`

The baseline confirms that the current legacy prompt path uses sidecars and
Herdr state observations, while the new task path must not infer completion
from those events.

### Phase 1 — Task registry and task state

Completed and committed in `ae68588`.

Implemented in `src/core/orchestration.ts`:

- Session-scoped opaque task IDs
- `TaskRecord`, `TaskResult`, and settlement types
- `created`, `running`, `waiting`, `completed`, `blocked`, `failed`,
  `cancelled`, and `timed_out` states
- One active tracked task per agent
- Pending request tracking
- Waiting timestamps
- Task deadlines and timeout timers
- Stale-notification metadata
- Artifact association fields and settlement callbacks
- Ownership validation
- Idempotent terminal settlement
- Cancellation and task snapshots

Tests are in `test/verify-task-registry.mjs`.

### Phase 2 — Parent-owned mailbox transport

Completed and committed in `e48666d`.

Implemented in `src/core/messaging.ts`:

- Protected session mailbox directories
- Parent and per-child inboxes
- Atomic JSON envelope publication
- Envelope validation
- Parent/child/peer routing
- Child capabilities
- Session, broker, sender, and target validation
- Duplicate acknowledgement markers
- Malformed-envelope quarantine
- Queue-depth, byte-size, and content-length limits
- Processed/rejected message retention
- Cleanup protection until children are gone

Tests are in `test/verify-messaging.mjs`.

### Phase 3 — Child-side Shepherd surface

Completed and committed in `44b5ae8`.

Extended `src/extension/shepherd-done.ts` with:

- Child `shepherd_message` tool
- Child `shepherd_done` tool
- Broker capability loading from environment
- Child inbox polling
- `followUp` and `steer` delivery through `pi.sendUserMessage`
- Correlated sender/message/task/thread/reply metadata
- Runtime diagnostics for failed local delivery
- Explicit task-done envelopes
- Tracked-task protection against normal `agent_end` completion

Extended `src/core/herdr.ts` with launch-time broker and task environment
wiring plus task instructions explaining explicit completion and replies.

Tests are in `test/verify-child-surface.mjs`; launch coverage is in
`test/verify-launch.mjs`.

### Phase 4 — Tracked delegation

Implemented and committed in `b2c3b59`.

Implemented:

- Parent `shepherd_delegate` tool
- `LifecycleDelegateParams`
- Parent broker creation and lazy monitor lifecycle
- Pre-launch opaque agent ID reservation
- Child capability registration during agent startup
- `delegateAgent()` in `src/core/lifecycle.ts`
- Non-blocking task-envelope submission
- Task artifact reservation/start/finalization callback
- Publication failure rollback
- Closed-agent and active-task checks
- Updated parent tool schema/surface tests

The delegation path is:

```text
shepherd_spawn
  -> parent broker registers child capability
  -> child starts with broker/task environment
shepherd_delegate
  -> task record is reserved
  -> task envelope is queued to the child inbox
  -> task transitions to running
  -> delegate returns taskId without waiting
```

The old `shepherd_prompt` path remains separate and is still legacy behavior.
Its compatibility mapping to task IDs is deliberately deferred.

### Phase 5 — Explicit completion and failures

Complete.

Implemented in `b2c3b59` and the task-failure tests:

- Parent broker polling via `processParentBrokerMessages()`
- `task_done` envelope consumption
- Child ownership validation
- Unknown/foreign task rejection
- Rejection of successful completion while required requests are pending
- Explicit completion summary/timestamp persistence
- Idempotent task settlement
- Task artifact finalization callback
- Task deadline timeout settlement
- Pane disappearance failure detection
- Provider-error detection from pane output
- Close-to-task-cancellation behavior
- Normal tracked-task `agent_end` no longer claims success
- Task ID inclusion in retained sidecars

Tests:

- `test/verify-task-completion.mjs`: owning-child completion, foreign-child
  rejection, duplicate completion, pending-request rejection, blocked
  completion, idle-child + explicit completion, and no-premature-completion
  from `agent_end`/`agent_settled`/idle state.
- `test/verify-task-failures.mjs`: provider-error failure, unexpected pane
  exit failure, close-to-cancellation, and deadline timeout. Uses a
  Node-script fake `herdr` on PATH backed by a JSON state file so `pane
  list`, `pane close`, and `agent read` observations are deterministic.

Deferred (tracked in `tasks.md`):

- Preserve useful child output in failure results (completion-diagnostics
  follow-up).
- Preserve runtime observations for status output (Phase 9).

### Phase 6 — Asynchronous message routing

Complete.

Implemented:

- Parent `shepherd_message` tool (`src/extension/shepherd.ts`, schema in
  `src/core/types.ts`) with flat root object: `target` + `message` required;
  `taskId`, `threadId`, `replyTo`, `expectsReply`, `delivery` optional.
- `sendParentMessage()` and the parent message notifier/bridge in
  `src/core/lifecycle.ts`; child message delivery via
  `configureParentMessageNotifications()` and `sendUserMessage` delivery in
  `src/extension/shepherd.ts` / `shepherd-done.ts`.
- Task registry request/reply correlation in `src/core/orchestration.ts`
  (`openPendingRequest`, `resolveReplyForTask`, `clearPendingReply`) with a
  single outstanding request per task.
- Child-side `runtime` request-open mirror and reply routing through the
  parent broker, so a busy peer's queued question keeps the sender task in
  the `waiting` state and a matching reply returns it to `running`.
- Reply deadline tracking and `blocked` settlement on timeout.
- Provenance preserved via `originSenderId` on the relayed reply.
- Delivery failure diagnostic surfaced to the parent for failed local
  `sendUserMessage`.

Tests: `test/verify-message-routing.mjs` (parent/child, busy/idle recipient,
request creation and timeout, valid/invalid/duplicate/origin-preserving
replies, delivery failures, unknown/closed targets, task ownership check).

See `phase6-notes.md` in this directory for the routing and correlation
decisions.

### Phase 7 — Task-aware `shepherd_watch`

Complete.

Implemented:

- `LifecycleRegistry.watchTasks()` (plus the task side of `settleTask`
  settlement) in `src/core/orchestration.ts`: one-shot, synchronous,
  exactly-once per task, driven directly from settlement — no polling.
  `settleTask` is the single authoritative hook, so `waiting`, `idle`,
  `agent_end`, and `agent_settled` can never fire a task watcher.
- `TaskWatcherService` in `src/core/lifecycle.ts`: coalescing, ordered
  delivery with `unref()`'d flush timers and `shutdown()`.
- `shepherd_watch` now accepts task ids (primary) and legacy prompt ids
  (compat, routed to the existing prompt watcher); agent ids and pane ids
  are rejected with a clear error; a call cannot mix both kinds.
- Parent `shepherd.task.completion` message + bridge that sends a
  follow-up with `triggerTurn: true` keyed by task id.

Tests: `test/verify-task-watchers.mjs` (non-blocking registration, no
completion from `waiting`, terminal-only settlement across completed/failed/
blocked/cancelled/timed_out, coalesced input order, independent watchers,
rejections, bridge delivery and shutdown suppression).

See `phase7-notes.md` in this directory for the design decisions.

### Phase 8 — Stale-wait monitoring

Complete.

Implemented:

- `staleWaitThreshold` setting in `src/extension/config.ts` (minutes, default
  `5`; `0` disables reminders; invalid values fall back to the default).
  Wired into `OVERRIDABLE_FIELDS` so it participates in user + project layer
  resolution, the `/shepherd settings` menu (`src/extension/settings-ui.ts`
  adds a `Stale wait reminder` row with an `off` option), and the README
  settings table plus a short stale-wait explanation.
- `LifecycleRegistry.markStaleNotified(taskId)` (orchestration) stamps the
  episode with a wall-clock time so the monitor issues at most one reminder
  per episode. `staleNotifiedAt` is cleared by `setTaskRunning`,
  `resolvePendingRequest`, `resolveReplyForTask`, and `settleTask` — a reply
  (or any terminal event) resets the state, a re-entry into `waiting` later
  can produce a new reminder.
- `StaleWaitMonitor` (lifecycle.ts) + the `staleWaitMonitor` singleton and
  `configureStaleWaitNotifications()` / `shutdownStaleWaitMonitor()`. The
  monitor only starts when a task opens a pending reply
  (`sendParentMessage` and the child `runtime` mirror call
  `staleWaitMonitor.kick()`), polls at 1s (unref'd), inspects *task* state
  (not raw agent state), and emits at most one notification per episode with
  full context (task, owner, description, question, pending request id,
  target, target state, elapsed wait, threshold).
- The parent bridge (`configureStaleWaitBridge` in
  `src/extension/shepherd.ts`) registers a `shepherd.stale.wait` custom
  message renderer and delivers via `sendMessage` with
  `deliverAs: 'followUp'` and **no** turn trigger, so the idle parent sees
  the nudge without being forced to act; the parent only wakes on a real
  `shepherd_watch` completion or on a user interaction.
- `index.ts` toggles `setStaleWaitSessionActive` on session
  start/shutdown and calls `shutdownStaleWaitMonitor()` on shutdown so the
  timer is released with the session.
- Reply deadline (already present, Phase 6) settles a task as `blocked` if
  the reply never arrives; the stale reminder is strictly informational and
  never changes task state.

Tests: `test/verify-stale-wait.mjs` (threshold crossing, one notification per
episode, content coverage, reset after a reply, completed + idle (no task)
agents stay quiet, stale-wait does not settle a task, monitor starts/stops
with the waiting set, disabled threshold, and bridge delivery + shutdown
suppression).

See `phase8-notes.md` in this directory for the design decisions.

### Phase 9 — Status and TUI integration

Complete.

Implemented:

- `AgentStatus` in `src/core/orchestration.ts` now carries a `task` view
  (`id`, `state`, `waitingSince`/`waitingMs`, `pendingRequestMessageId`,
  `waitingRecipient`, `stale`) computed by a new
  `LifecycleRegistry.taskStatusForAgent()`; process state and task state stay
  independent (an idle process owns the waiting task; a completed task leaves
  the process `done` with no `task` field).
- `src/extension/shepherd.ts` `status` action exposes a compact public task
  view (`waitingMs`, `pendingRequest` (renamed from the long field),
  `waitingOn`, `stale`) and names both process and task state in the summary
  text. Herdr pane ids remain internal diagnostics (not part of the public
  `status` result).
- `src/core/herdr.ts` adds `activeTasksByPane()` (in-memory registry only,
  safe for every snapshot tick) and `workingOrWaitingSubagents()`: an owned
  pane is listed when the process is not idle **or** it still owns an open
  tracked task, so an idle child parked on a required reply is never filtered
  out as "done". `workingSubagents()` remains as a working-only projection.
- The status widget in `index.ts` now renders task state distinctly: the
  header counts `N working · N waiting`, rows show the **task** state while a
  task is open (a working process with a waiting task renders `waiting`),
  and waiting rows append ` ⏳<m>m ←<recipient>` (elapsed wait + who is
  expected to answer). A stale episode renders as `waiting (stale)`. Pane and
  task ids are not painted into rows.
- README: "Reading status" section documents independent process/task state,
  the task fields, and the widget's idle-but-waiting projection.

Tests: `test/verify-status.mjs` (process/task independence for idle+waiting,
working+running, and no-task agents; reply clears waiting/stale; completion
removes the task view; doAction public mapping keeps opaque ids and never
leaks pane data). `test/verify-status-widget.mjs` now covers the idle process
with a waiting (stale) task, working process with a running task, completed
task removal, session ownership filtering, and phase-1/2 glyph/width checks
across three snapshot phases.

See `phase9-notes.md` in this directory for the design decisions.

"
### Phase 10 — Compatibility decisions

Decisions (spec "Compatibility" section):

- `shepherd_prompt`: **retained as a deprecated compatibility path**, not
  removed. Rationale: removing it would break every transcript and prompt
  template that still references it during migration, and its one-prompt-per-
  turn semantics remain correct for fire-and-forget one-turn messages. The tool
  label, description, promptSnippet, and parameter descriptions now say it is
  deprecated and name the migration target (`shepherd_delegate` +
  `shepherd_watch`), so the model migrates instead of defaulting to it. Its
  completion semantics remain one-child-turn-completion; that is documented,
  not silently changed, so it cannot be mistaken for task tracking.
- `shepherd_wait`: **retained as a compatibility adapter, now task-aware.**
  Accepts task ids (preferred, from `shepherd_delegate`) and legacy prompt
  ids (from `shepherd_prompt`); a single call cannot mix the two. Task waits
  resolve via the task-watcher registry hook (no polling), in input order, and
  a wait timeout rejects with `timeout` (code `timeout`, returnCode 124)
  WITHOUT touching the tasks — they keep running and can be watched later with
  `shepherd_watch`. Nothing in the new protocol depends on the parent calling
  `shepherd_wait` to make progress; descriptions say `shepherd_watch` is the
  preferred async alternative. The legacy prompt path is unchanged.
- `shepherd_watch`, `shepherd_delegate`, `shepherd_message`, `shepherd_done`:
  unchanged (already documented in phases 6–8).

## Important current architecture

### Parent task completion

`ensureParentBroker()` in `src/core/lifecycle.ts` lazily creates a parent broker
and starts a 250ms unref'd monitor. The monitor calls
`processParentBrokerMessages()`.

The parent currently handles these inbox events:

- `task_done`: validates and settles the task
- `message` / `reply`: routed to the parent Pi session as a custom Shepherd message (followUp); a `reply` also resolves the matching pending request on the sender's task and is relayed back to the asker's child inbox
- `runtime` with `requestOpen`: opens the task's pending request (task → waiting) so a busy recipient's queued question keeps the sender task open
- Pane disappearance, provider error, and reply-deadline expiry settle tasks as failed / failed / blocked

### Child task completion

The child extension receives `PI_SHEPHERD_TASK_ID`. A normal assistant turn
ending while this variable is present does not write a successful completion
sidecar and does not shut down the child. The child must call `shepherd_done`.

Provider errors still write a sidecar and may be detected by the parent runtime
monitor.

### Task state invariant

Do not weaken this invariant:

```text
Pi turn ends       -> runtime observation only
agent_end          -> runtime observation only
agent_settled      -> runtime observation only
Herdr idle         -> runtime observation only
shepherd_done      -> normal task completion
```

An idle child may own a `waiting` task.

### Transport behavior

The filesystem broker uses:

```text
<broker>/broker.json
<broker>/parent/inbox/*.json
<broker>/agents/<hashed-agent-id>/manifest.json
<broker>/agents/<hashed-agent-id>/inbox/*.json
<broker>/processed/*
<broker>/rejected/*
<broker>/acks/*
```

`pollParentInbox()` and `pollChildInbox()` move consumed files to processed
storage and create acknowledgement markers. Child and parent runtime adapters
are responsible for making handler operations idempotent.

## Remaining work

Consult `tasks.md` for the authoritative checkbox state. Phases 5, 6, 7, 8, 9, and 10
are complete. Phase 11 (full verification and release readiness) is in progress:

### Phase 11 status (as of this update)

- Automated verification: all 15 items done — `npm test` passes cleanly.
- Live Herdr matrix started. Verified live: Herdr session attach, persistent
  spawn, non-blocking delegation, status during `running`, close of an
  agent with an open task (task settles `cancelled`, artifact finalized,
  exactly one watcher notification), temporary launch-dir cleanup after pane
  confirmation.
- **Live bug found and fixed:** `writePiLaunchFiles` passed agent-defined
  `tools:` frontmatter straight to `--tools`, which is a full allowlist — so
  children of agents like bundled `scout` (`read,grep,find,ls`) lost the
  child-surface tools `shepherd_message` and `shepherd_done` and could not
  message peers or complete tasks. Fix: `CHILD_SURFACE_TOOLS` is always
  appended to the launch `--tools` list. `test/verify-launch.mjs` asserts the
  allowlist now contains `read,shepherd_message,shepherd_done`.
- The fix is on disk; a RUNNING Shepherd parent only picks it up on extension
  reload (sessions load TS at startup). Live spawns from a pre-reload parent
  still launch children without the child tools.
- Completed live matrix items: canonical wait/reply/done flow with stale-wait
  notification, status during `waiting` and after completion, busy-planner
  interleaving, both planner/scout closure directions, task timeout, provider
  model-error observation, pane ownership rejection, temporary-resource cleanup,
  and parent shutdown. After the parent was quit and resumed, the persistent
  survivor remained visible and idle; the previous opaque lifecycle handle was
  rejected by the resumed parent.

## Live-matrix findings (Phase 11)

1. **`--tools` allowlist stripped child tools (fixed).** See "Live bug found and
   fixed" above. `CHILD_SURFACE_TOOLS` is now always appended to the launch
   `--tools` list; live launch scripts confirmed to carry
   `read,grep,find,ls,shepherd_message,shepherd_done`.
2. **Child peer addressing requires the opaque agent id.** A child cannot
   address a sibling by display name (`target "planner"` →
   `invalid_target: Unknown child target "planner"`). Peer routing resolves
   only the hashed broker manifest directory for a registered agent id. The
   parent must supply the peer's opaque id in the task text. This is per the
   spec (parent-mediated peer delivery, opaque ids), but is a documentation/
   discovery gap — a child has no way to enumerate sibling ids. Candidate for
   a follow-up (e.g. a parent-injected roster or a peer listing for the child
   surface).
3. **`task_done` cannot succeed while a tracked reply is pending.** If a task
   is `waiting` on an outstanding request (`pendingReplyMessageId` set), a
   `shepherd_done` with `completed` is ignored (task stays waiting) until the
   matching reply arrives or the task is settled via `blocked`/`failed`.
   The reply's `replyTo` must equal the pending message id exactly.

Phase 11 live verification is complete. The canonical completion flow,
status-after-completion, planner/scout closure interleavings, busy-planner
interleaving, timeout, provider/model error observation, pane-ownership
rejection, temporary-resource cleanup, and parent shutdown were verified live.
After the parent was quit and resumed, the persistent survivor remained visible
and idle, while the previous opaque lifecycle handle was rejected by the
resumed parent. The invalid-model run exposed a readiness race:
`shepherd_spawn` can report success if Herdr briefly detects the child before pi
exits; the pane then becomes `unknown` with the model error and completion
sentinel visible. This is recorded as a follow-up hardening issue, not hidden as
a clean spawn pass.

The worker timeout also demonstrated that a late child message can be rejected
or accepted as an ordinary message after the task is terminal without changing
the timed-out result. Child parent aliases are exact lowercase values
(`shepherd`/`parent`); the live `Shepherd.` attempt was rejected with a structured
`invalid_target` response. Peer routing likewise requires the opaque registered
agent id, not a display name.

Note: a temporary `.shepherd/config.json` delta setting `staleWaitThreshold: 1`
was a no-op because the user config's `settingsScope` is `"user"` (project
deltas are only read when scope is `"project"`); the live stale-wait
notification fired at the 5-minute default, which validated the monitor anyway.
The scratch delta file has been removed; user config is untouched.

The only remaining live gate is parent shutdown. A fresh idle persistent child
labelled `p11 parent-shutdown survivor` is currently open for that check. End
this parent session, start a new Shepherd in the same project, confirm the
survivor remains visible/idle and that the new session cannot claim or close the
old session's pane, then update `tasks.md` and the specification status.

README and active user-facing documentation now describe the tracked task,
message, watch, status, compatibility, fieldnote, ownership, and stale-wait
behavior.

## Useful commands

Run focused tests:

```bash
npm run phase0:test
npm run task-registry:test
npm run messaging:test
npm run child-surface:test
npm run delegate:test
npm run task-completion:test
npm run task-failures:test
npm run message-routing:test
npm run task-watchers:test
npm run stale-wait:test
npm run compat:test
npm run status:test
npm run status-widget:test
npm run launch:test
```

Run everything:

```bash
npm test
```

Inspect state:

```bash
git status --short
git branch --show-current
git log --oneline --decorate -10
```

## Commit history for this feature

```text
(test: cover phase five task failure paths)  <- tip after the Phase 5 test work
b2c3b59 feat: wire tracked delegation and task completion
44b5ae8 feat: add child messaging and completion surface
e48666d feat: add parent-owned messaging mailbox
ae68588 feat: add tracked task registry
a0dab9f test: establish async task lifecycle phase zero
986d474 docs: specify agent messaging and task lifecycle
```

## Continuation checklist

- [x] Read this handoff.
- [x] Read `spec.md`.
- [x] Read `plan.md`.
- [x] Read the current checkbox state in `tasks.md`.
- [x] Confirm the feature branch is checked out.
- [x] Run `npm test` before making further changes.
- [x] Finish remaining Phase 5 tests.
- [x] Implement Phase 6 parent message routing.
- [x] Implement Phase 7 task-aware `shepherd_watch`.
- [x] Implement Phase 8 stale-wait monitoring + `staleWaitThreshold` setting.
- [x] Implement Phase 9 task-aware status and TUI projection.
- [x] Make the Phase 10 compatibility decisions (shepherd_prompt deprecated;
      shepherd_wait task-aware) and update active documentation.
- [x] Keep explicit `shepherd_done` completion authoritative.
- [x] Update this handoff if architecture or compatibility decisions change.
