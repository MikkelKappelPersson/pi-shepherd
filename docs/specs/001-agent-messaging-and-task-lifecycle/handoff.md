# Handoff: Asynchronous Shepherd Tasks and Agent Messaging

## Session state

- Branch: `feature/001-agent-messaging-and-task-lifecycle`
- Repository: `MikkelKappelPersson/pi-shepherd`
- Current HEAD: tip of the feature branch — `b2c3b59` plus the Phase 5 failure-test commit and this handoff update (hashes shift when this doc changes; use `git log --oneline`)
- Working tree: clean before adding this handoff
- Last full verification: `npm test` passed

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

## Important current architecture

### Parent task completion

`ensureParentBroker()` in `src/core/lifecycle.ts` lazily creates a parent broker
and starts a 250ms unref'd monitor. The monitor calls
`processParentBrokerMessages()`.

The parent currently handles these inbox events:

- `task_done`: validates and settles the task
- Other message kinds: consumed by the transport but not yet routed to the
  parent Pi session; this is Phase 6 work

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

Consult `tasks.md` for the authoritative checkbox state. Phase 5 is complete
(the remaining unchecked boxes are explicitly deferred to later phases). The
main remaining work is:

### Phase 6 — Asynchronous message routing

Implement next:

- Parent `shepherd_message` tool
- Parent inbox routing into Pi custom messages
- Child-to-child routing through the parent
- Request records and `expectsReply`
- `replyTo` correlation
- `running`/`waiting` transitions
- Reply delivery to idle children
- Parent and child message result formatting
- Busy/idle recipient tests
- Request timeout behavior

The child-side message tool and transport already exist, but the parent-facing
message tool and task/request integration are not complete.

### Later phases

After Phase 6:

- Phase 7: task-aware `shepherd_watch`
- Phase 8: stale-wait monitoring and configuration
- Phase 9: task-aware status and TUI widget
- Phase 10: final artifact/cleanup/compatibility integration and documentation
- Phase 11: complete live Herdr verification

README and active user-facing documentation have not yet been updated for the
new API. Do that during Phase 10 after compatibility behavior is settled.

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
- [ ] Implement Phase 6 parent message routing.
- [ ] Keep explicit `shepherd_done` completion authoritative.
- [ ] Update this handoff if architecture or compatibility decisions change.
