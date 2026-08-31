# Tasks: Asynchronous Shepherd Tasks and Agent Messaging

This checklist tracks implementation of:

- `docs/specs/001-agent-messaging-and-task-lifecycle/spec.md`
- `docs/specs/001-agent-messaging-and-task-lifecycle/plan.md`

## How to use this checklist

- Complete tasks in phase order unless a task explicitly says it can run in
  parallel.
- Check an item only when the implementation and its focused tests are done.
- Keep compatibility behavior explicit; do not silently mix prompt and task
  completion semantics.
- Every phase has an exit gate. Do not begin dependent phases until its gate is
  satisfied.

## Overall status

- [ ] Feature implementation complete
- [ ] Focused tests written and passing
- [ ] Existing regression tests updated and passing
- [ ] Live Herdr verification complete
- [ ] README and user documentation updated
- [ ] Documentation and migration notes complete
- [ ] `npm test` passes

---

## Phase 0 — Baseline and guardrails

### Repository baseline

- [x] Read and confirm the requirements in `spec.md`.
- [x] Read and confirm the sequencing and decisions in `plan.md`.
- [x] Run the existing `npm test` suite and record the baseline result.
- [x] Record the current public tool list and schemas.
- [x] Record the current parent/child extension registration behavior.
- [x] Confirm the current completion path uses `agent_end` and sidecar signals.
- [x] Confirm the current registry enforces one unresolved prompt per agent.
- [x] Confirm current fieldnote finalization is attached to prompt settlement.
- [x] Capture the findings in `docs/specs/001-agent-messaging-and-task-lifecycle/baseline.md`.

### Test scaffolding

- [x] Add a reusable temporary-directory helper for mailbox tests.
- [x] Add deterministic clock/timer helpers for stale-wait tests.
- [x] Add a test helper for creating fake parent and child identities.
- [x] Add schema-test placeholders for `shepherd_delegate`.
- [x] Add schema-test placeholders for `shepherd_message`.
- [x] Add schema-test placeholders for `shepherd_done`.
- [x] Add schema-test placeholders for task-aware `shepherd_watch`.
- [x] Add parent/child surface test placeholders.
- [x] Add the Phase 0 task-state boundary test in `test/verify-phase0.mjs`.
- [x] Centralize the Phase 0 contracts in `test/helpers/feature-contracts.mjs` for later phase tests.

### Exit gate

- [x] Baseline `npm test` result is recorded.
- [x] New tests can create isolated parent/child identities without Herdr.
- [x] No runtime behavior has changed yet; only test scaffolding and guardrail documentation were added.

---

## Phase 1 — Task registry and task state

### Task identifiers and types

- [x] Define an opaque task ID format scoped to the parent Shepherd session.
- [x] Add task ID validation and canonicalization.
- [x] Add `TaskRecord` internal type.
- [x] Add `TaskResult` internal type.
- [x] Add task state union:
      `created`, `running`, `waiting`, `completed`, `blocked`, `failed`,
      `cancelled`, `timed_out`.
- [x] Add pending request tracking to task records.
- [x] Add `waitingSince` tracking.
- [x] Add task deadline tracking.
- [x] Add stale-notification tracking.
- [x] Add task-to-artifact association fields.

### Task registry operations

- [x] Implement task creation.
- [x] Implement task lookup by opaque task ID.
- [x] Implement task canonicalization.
- [x] Implement transition to `running`.
- [x] Implement transition to `waiting`.
- [x] Implement transition from `waiting` to `running`.
- [x] Implement terminal task settlement.
- [x] Implement task cancellation.
- [x] Implement task timeout settlement.
- [x] Implement task listing for status projection.
- [x] Make terminal settlement idempotent.
- [x] Reject invalid task IDs with the standard lifecycle error shape.
- [x] Reject completion of a task owned by another agent.
- [x] Reject mutation of a terminal task.
- [x] Ensure waiting does not clear active task ownership.
- [x] Ensure task settlement clears pending request associations.

### Separation from current prompts

- [x] Decide the exact compatibility mapping between prompt IDs and task IDs:
      Phase 1 keeps prompt IDs and task IDs separate; compatibility mapping is
      deferred until the delegation adapter is implemented.
- [ ] Add an explicit prompt-to-task mapping if compatibility is retained.
- [ ] Ensure ordinary messages do not create task records.
- [ ] Ensure ordinary messages do not consume the active task slot.
- [x] Keep existing prompt tests passing during the transition.

### Tests

- [x] Add `test/verify-task-registry.mjs`.
- [x] Test opaque task ID validation.
- [x] Test valid state transitions.
- [x] Test invalid state transitions.
- [x] Test one active task per agent.
- [ ] Test multiple ordinary messages while one task is active; messaging is
      introduced in Phase 6.
- [x] Test idle process plus waiting task remains non-terminal.
- [x] Test idempotent completion.
- [x] Test idempotent cancellation.
- [x] Test idempotent timeout.
- [x] Test pending request association and clearing.

### Exit gate

- [x] Task state is independent of Pi/Herdr process state.
- [x] A task remains open when its owner is idle and waiting.
- [x] Registry tests pass.
- [x] Existing tests still pass.

---

## Phase 2 — Parent-owned mailbox transport

### Mailbox layout

- [ ] Choose and document the runtime root for session mailboxes.
- [ ] Create one mailbox per parent Shepherd session.
- [ ] Create the mailbox with owner-only permissions.
- [ ] Create a parent inbox.
- [ ] Create a per-agent inbox for each registered child.
- [ ] Define outgoing, pending, acknowledged, and failed file locations if
      separate directories are needed.
- [ ] Define mailbox cleanup ownership and lifetime.

### Envelope format

- [ ] Define the JSON-safe message envelope type.
- [ ] Define envelope `kind` values.
- [ ] Define task-done envelope fields.
- [ ] Define runtime-observation envelope fields.
- [ ] Define sender and target identity fields.
- [ ] Define `messageId`, `threadId`, `replyTo`, and `taskId` fields.
- [ ] Define delivery mode fields.
- [ ] Define creation and deadline timestamps.
- [ ] Define maximum envelope size.
- [ ] Define maximum content length.

### Publication and consumption

- [ ] Implement atomic temporary-file-plus-rename publication.
- [ ] Implement complete-envelope reads.
- [ ] Ignore incomplete or malformed files without crashing the monitor.
- [ ] Implement parent inbox polling.
- [ ] Implement child inbox polling.
- [ ] Implement message acknowledgement.
- [ ] Implement duplicate message detection.
- [ ] Implement bounded queue depth.
- [ ] Implement message retention or safe post-ack deletion.
- [ ] Implement transport errors with message correlation.
- [ ] Ensure polling timers do not keep the host process alive unnecessarily.

### Identity and authorization

- [ ] Bind the mailbox to the parent session owner identity.
- [ ] Generate child capabilities for publishing as a specific agent.
- [ ] Validate the sender identity on every child envelope.
- [ ] Validate that the target is registered in the same parent session.
- [ ] Reject foreign session identities.
- [ ] Reject attempts to publish as another agent.
- [ ] Reject raw pane IDs as public message or task IDs.

### Tests

- [ ] Add `test/verify-messaging.mjs`.
- [ ] Test mailbox creation and permissions where supported.
- [ ] Test atomic publication.
- [ ] Test partial-file handling.
- [ ] Test parent-to-child publication.
- [ ] Test child-to-parent publication.
- [ ] Test duplicate envelope handling.
- [ ] Test malformed envelope handling.
- [ ] Test invalid sender handling.
- [ ] Test invalid target handling.
- [ ] Test queue depth limits.
- [ ] Test message size limits.
- [ ] Test mailbox cleanup after all children are gone.

### Exit gate

- [ ] Parent and child can exchange JSON envelopes without Herdr.
- [ ] Invalid and duplicate envelopes are safe.
- [ ] Mailbox tests pass.
- [ ] Transport APIs do not expose raw pane IDs.

---

## Phase 3 — Child-side Shepherd extension

### Extension structure

- [ ] Create `src/extension/shepherd-agent.ts`, or document the decision to
      extend `shepherd-done.ts` instead.
- [ ] Keep parent-only Shepherd tools out of child sessions.
- [ ] Preserve the existing child system-prompt behavior.
- [ ] Preserve the existing child process lifecycle behavior.
- [ ] Make the child extension load from the Herdr launch path.
- [ ] Pass broker location through the launch environment.
- [ ] Pass parent session identity through the launch environment.
- [ ] Pass child agent ID through the launch environment.
- [ ] Pass active task ID through task context/environment.

### Child `shepherd_message`

- [ ] Register the child-side `shepherd_message` tool.
- [ ] Use a flat root object schema.
- [ ] Declare `name`, `label`, `description`, `promptSnippet`, and
      `parameters` directly in the registration.
- [ ] Validate non-empty message content.
- [ ] Validate target syntax.
- [ ] Validate delivery mode.
- [ ] Validate optional task and reply references.
- [ ] Publish the message envelope to the parent broker.
- [ ] Return acceptance without waiting for a response.
- [ ] Return the generated message ID.
- [ ] Return structured delivery acceptance details.

### Child `shepherd_done`

- [ ] Register the child-side `shepherd_done` tool.
- [ ] Use a flat root object schema.
- [ ] Require a task ID.
- [ ] Require a terminal status.
- [ ] Accept an optional summary.
- [ ] Validate that the task ID belongs to the child context.
- [ ] Publish a `task_done` envelope.
- [ ] Return acceptance without shutting down a persistent child.
- [ ] Make repeated completion calls idempotent.

### Incoming delivery

- [ ] Poll the child inbox.
- [ ] Validate incoming envelope identity and target.
- [ ] Render sender and message ID in the child context.
- [ ] Preserve `taskId`, `threadId`, and `replyTo` metadata.
- [ ] Deliver normal messages with `pi.sendUserMessage`.
- [ ] Implement default `followUp` delivery.
- [ ] Implement explicit `steer` delivery.
- [ ] Ensure steering never interrupts a tool call unsafely.
- [ ] Trigger an idle child when a follow-up reply is delivered.
- [ ] Acknowledge successful child delivery.
- [ ] Record failed child delivery.

### Child task instructions

- [ ] Add task ID to delegated task context.
- [ ] Tell the child that ending a Pi turn does not complete the task.
- [ ] Tell the child to use `shepherd_message` for questions.
- [ ] Tell the child to use `shepherd_done` only for actual task completion.
- [ ] Tell the child how to reply to another agent's request.
- [ ] Tell the child what to do when a task is blocked.
- [ ] Ensure task instructions do not create duplicate system context.

### Tests

- [ ] Add `test/verify-child-surface.mjs`.
- [ ] Verify child tools are registered.
- [ ] Verify parent-only tools are absent from child sessions.
- [ ] Verify child messages return immediately.
- [ ] Verify child done envelopes are published.
- [ ] Verify incoming messages call the correct Pi queue API.
- [ ] Verify follow-up and steer delivery modes.
- [ ] Verify task context contains the task ID.
- [ ] Update `test/verify-launch.mjs` for child extension wiring.

### Exit gate

- [ ] A child can send an asynchronous message.
- [ ] A child can explicitly complete a task.
- [ ] A child can receive a queued message while idle.
- [ ] Child and parent tool surfaces remain isolated.

---

## Phase 4 — Tracked delegation

### Core delegation

- [ ] Add `delegateAgent()` to `src/core/lifecycle.ts`.
- [ ] Resolve the target through the opaque agent registry.
- [ ] Enforce one active delegated task per agent.
- [ ] Create the task record before publishing the task envelope.
- [ ] Set the task to `running` after acceptance.
- [ ] Reserve a task artifact when fieldnotes are enabled.
- [ ] Attach the artifact to the task record.
- [ ] Include task ID and task instructions in the child envelope.
- [ ] Publish the task through the mailbox.
- [ ] Return once the broker accepts the task.
- [ ] Settle publication failures as task failures.
- [ ] Finalize task artifacts on publication failure.

### Parent tool

- [ ] Register `shepherd_delegate` in `src/extension/shepherd.ts`.
- [ ] Add the flat tool schema.
- [ ] Require target and task fields.
- [ ] Add optional task timeout.
- [ ] Return task ID and agent ID.
- [ ] Use the standard Shepherd call/return/details result format.
- [ ] Add concise tool description and prompt guidance.
- [ ] Add call preview rendering.
- [ ] Add tool schema coverage.

### Busy-agent behavior

- [ ] Reject a second active delegated task clearly.
- [ ] Ensure ordinary messages remain accepted while a task is active.
- [ ] Define behavior when the target agent is not detected.
- [ ] Define behavior when the target agent is closed.
- [ ] Ensure task creation is rolled back if delivery cannot start.

### Tests

- [ ] Add `test/verify-delegate.mjs`.
- [ ] Test non-blocking delegation.
- [ ] Test task ID creation.
- [ ] Test one active task per agent.
- [ ] Test task artifact association.
- [ ] Test publication failure.
- [ ] Test delegation to a closed agent.
- [ ] Test ordinary messages during an active task.
- [ ] Update schema tests for `shepherd_delegate`.

### Exit gate

- [ ] Delegation creates a tracked task.
- [ ] Delegation does not require `shepherd_wait`.
- [ ] The task remains open independently of the child turn.
- [ ] Delegation tests pass.

---

## Phase 5 — Explicit task completion and failures

### Parent task-done handling

- [ ] Add parent handling for `task_done` envelopes.
- [ ] Validate task ownership.
- [ ] Validate task status.
- [ ] Reject unknown task IDs.
- [ ] Reject task completion from a foreign child.
- [ ] Reject completion of a cancelled task.
- [ ] Reject successful completion with unresolved required requests, unless
      they are explicitly cancelled or overridden by policy.
- [ ] Record completion summary.
- [ ] Record completion timestamp.
- [ ] Settle the task exactly once.
- [ ] Finalize the associated artifact exactly once.

### Runtime and process failures

- [ ] Treat `agent_end` as a non-terminal runtime event.
- [ ] Treat `agent_settled` as a non-terminal runtime event.
- [ ] Treat Herdr idle state as a non-terminal runtime observation.
- [ ] Preserve runtime observations for status output.
- [ ] Map unexpected child exit to task failure.
- [ ] Map provider errors to task failure.
- [ ] Map close to task cancellation.
- [ ] Map deadline expiry to task timeout.
- [ ] Preserve useful child output in failure results.
- [ ] Ensure persistent children remain open after successful task completion.

### Completion extension changes

- [ ] Refactor `shepherd-done.ts` so normal `agent_end` does not claim task
      success.
- [ ] Add task ID to any retained completion sidecar.
- [ ] Distinguish process completion from task completion.
- [ ] Emit explicit task completion only for `shepherd_done`.
- [ ] Preserve provider-error reporting.
- [ ] Preserve aborted-turn behavior.
- [ ] Ensure queued follow-ups cannot cause premature task completion.

### Tests

- [ ] Add `test/verify-task-completion.mjs`.
- [ ] Test completion from the owning child.
- [ ] Test completion from the wrong child.
- [ ] Test duplicate completion.
- [ ] Test completion with pending requests.
- [ ] Test blocked task completion.
- [ ] Test provider failure.
- [ ] Test unexpected child exit.
- [ ] Test close cancellation.
- [ ] Test timeout.
- [ ] Test no completion from `agent_end`.
- [ ] Test no completion from `agent_settled`.
- [ ] Test no completion from idle state.

### Exit gate

- [ ] `shepherd_done` is the only normal successful completion path.
- [ ] The canonical idle-while-waiting scenario does not complete early.
- [ ] Failure and cancellation paths produce terminal task results.
- [ ] Completion tests pass.

---

## Phase 6 — Asynchronous message routing

### Parent-side message tool

- [ ] Register the parent-side `shepherd_message` tool.
- [ ] Use a flat root object schema.
- [ ] Require target and non-empty message.
- [ ] Add optional task ID.
- [ ] Add optional thread ID.
- [ ] Add optional reply-to ID.
- [ ] Add optional expects-reply flag.
- [ ] Add optional delivery mode.
- [ ] Return message ID and acceptance state.
- [ ] Use standard Shepherd result formatting.
- [ ] Add tool description and prompt guidance.
- [ ] Add call preview rendering.

### Routing

- [ ] Route parent-to-child messages through the mailbox.
- [ ] Route child-to-parent messages into the parent session.
- [ ] Route child-to-child messages through the parent broker.
- [ ] Permit a child to target the Shepherd.
- [ ] Permit a child to target validated peer agent IDs.
- [ ] Reject targets outside the current parent session.
- [ ] Preserve sender provenance.
- [ ] Preserve message and task correlation metadata.
- [ ] Ensure accepted means broker accepted, not recipient replied.

### Request/reply behavior

- [ ] Create a pending request when `expectsReply` is true.
- [ ] Associate the request with the sender task when a task ID is supplied.
- [ ] Transition the task to `waiting` for a required reply.
- [ ] Preserve the task's active ownership while waiting.
- [ ] Accept replies with `replyTo`.
- [ ] Clear the matching pending request on a valid reply.
- [ ] Transition the task back to `running` after required reply delivery.
- [ ] Reject duplicate replies or make them idempotent.
- [ ] Add request deadlines.
- [ ] Define request timeout behavior.

### Pi queue integration

- [ ] Deliver child messages with `pi.sendUserMessage`.
- [ ] Use `followUp` as the default.
- [ ] Support explicit `steer`.
- [ ] Ensure an idle child is triggered after reply delivery.
- [ ] Ensure a busy child receives the message at the correct queue point.
- [ ] Ensure message delivery does not create a second delegated task.
- [ ] Queue parent notifications with custom Shepherd messages.

### Tests

- [ ] Add `test/verify-message-routing.mjs`.
- [ ] Test parent-to-child messages.
- [ ] Test child-to-parent messages.
- [ ] Test child-to-child messages.
- [ ] Test messages to a busy recipient.
- [ ] Test messages to an idle recipient.
- [ ] Test `expectsReply` request creation.
- [ ] Test valid replies.
- [ ] Test invalid replies.
- [ ] Test reply timeout.
- [ ] Test no-reply messages leave task state unchanged.
- [ ] Test message delivery failures.
- [ ] Test message provenance.

### Exit gate

- [ ] Worker can ask planner a question while planner is busy.
- [ ] Planner receives the question as a queued follow-up.
- [ ] Worker task remains waiting rather than completed.
- [ ] Planner can reply to worker.
- [ ] Worker receives the reply and returns to running.

---

## Phase 7 — Task-aware watchers

### Watcher core

- [ ] Generalize or extend the watcher registry to accept task IDs.
- [ ] Support one task ID.
- [ ] Support an array of task IDs.
- [ ] Return already-completed task results on registration.
- [ ] Keep watcher registration non-blocking.
- [ ] Preserve one-shot watcher behavior.
- [ ] Make watcher delivery idempotent.
- [ ] Preserve deterministic ordering for coalesced arrays.
- [ ] Release watcher state after all tasks settle.
- [ ] Release watcher timers at parent shutdown.

### Completion behavior

- [ ] Watch only terminal task states.
- [ ] Do not settle on child idle state.
- [ ] Do not settle on `agent_end`.
- [ ] Do not settle on `agent_settled`.
- [ ] Do not settle when a task enters `waiting`.
- [ ] Include task ID in every completion.
- [ ] Include agent ID in every completion.
- [ ] Include terminal status and return code.
- [ ] Include summary text where available.
- [ ] Include error data where available.

### Parent notification bridge

- [ ] Deliver watcher results through a custom Shepherd parent message.
- [ ] Use follow-up delivery for completion notifications.
- [ ] Trigger a parent turn only according to watcher policy.
- [ ] Suppress notifications after parent shutdown.
- [ ] Preserve standard call/return/details formatting.

### Compatibility

- [ ] Decide whether `shepherd_watch` accepts legacy prompt IDs.
- [ ] If accepted, map prompt IDs explicitly to task IDs.
- [ ] Reject agent IDs and pane IDs as watcher targets.
- [ ] Document the chosen compatibility behavior.
- [ ] Update the existing watcher tests or retain a compatibility test suite.

### Tests

- [ ] Add `test/verify-task-watchers.mjs`.
- [ ] Test a pending task.
- [ ] Test an already-completed task.
- [ ] Test multiple task IDs.
- [ ] Test independent watchers.
- [ ] Test completion ordering.
- [ ] Test blocked completion.
- [ ] Test failed completion.
- [ ] Test cancelled completion.
- [ ] Test timeout completion.
- [ ] Test no completion from waiting state.
- [ ] Test no duplicate completion notification.
- [ ] Test parent shutdown.

### Exit gate

- [ ] `shepherd_watch` tracks tasks rather than turns.
- [ ] The canonical scout/planner scenario remains pending during the wait.
- [ ] The watcher reports exactly one result after `shepherd_done`.

---

## Phase 8 — Stale-wait monitoring

### Configuration

- [ ] Add a `staleWaitThreshold` setting.
- [ ] Choose and document the default threshold.
- [ ] Add validation and fallback behavior.
- [ ] Add the setting to user-layer configuration.
- [ ] Add project-delta support where appropriate.
- [ ] Add the setting to the settings UI.
- [ ] Add the setting to user-facing documentation.

### Monitor

- [ ] Start the monitor only when waiting tasks exist.
- [ ] Inspect task state rather than raw agent state.
- [ ] Require an unresolved expected reply.
- [ ] Track `waitingSince`.
- [ ] Calculate elapsed wait time.
- [ ] Emit one notification per waiting episode.
- [ ] Record notification delivery time.
- [ ] Reset stale-notification state after a reply.
- [ ] Add request timeout handling.
- [ ] Stop the monitor when no waiting tasks remain.
- [ ] Ensure the timer does not keep the process alive.

### Notification content

- [ ] Include task ID.
- [ ] Include owning agent.
- [ ] Include task description.
- [ ] Include elapsed waiting time.
- [ ] Include pending request ID.
- [ ] Include question content.
- [ ] Include recipient identity.
- [ ] Include recipient process/task state.
- [ ] Include possible Shepherd actions.
- [ ] Preserve message/request correlation.

### Parent delivery

- [ ] Deliver stale-wait notifications as custom Shepherd messages.
- [ ] Queue notifications as follow-ups.
- [ ] Decide when stale notifications trigger an idle parent turn.
- [ ] Avoid waking the parent on every normal waiting transition.
- [ ] Avoid repeated notification storms.
- [ ] Add optional later escalation only if justified by usage.

### Tests

- [ ] Add `test/verify-stale-wait.mjs`.
- [ ] Test threshold crossing.
- [ ] Test one notification per waiting episode.
- [ ] Test notification content.
- [ ] Test reset after reply.
- [ ] Test completed task has no stale notification.
- [ ] Test idle agent without a waiting task has no stale notification.
- [ ] Test request timeout.
- [ ] Test parent shutdown.

### Exit gate

- [ ] A waiting scout produces one useful stale-wait notification.
- [ ] A reply clears the stale condition.
- [ ] Completed and ordinary idle agents do not generate stale notifications.

---

## Phase 9 — Status and TUI integration

### Status model

- [ ] Extend `shepherd_status` with process state.
- [ ] Extend `shepherd_status` with task state.
- [ ] Include task ID when a task is active.
- [ ] Include waiting age when applicable.
- [ ] Include pending request ID when applicable.
- [ ] Include waiting recipient when applicable.
- [ ] Include stale flag when applicable.
- [ ] Keep Herdr pane identity internal to diagnostics.
- [ ] Preserve opaque agent IDs in public lifecycle results.

### Status widget

- [ ] Include waiting tasks in the status projection.
- [ ] Do not filter waiting tasks out because the process is idle.
- [ ] Render waiting distinctly from working.
- [ ] Render waiting recipient where available.
- [ ] Render waiting elapsed time.
- [ ] Render stale state distinctly.
- [ ] Preserve current session ownership filtering.
- [ ] Avoid mailbox reads during every render frame.
- [ ] Reuse bounded polling/snapshot behavior.

### Tests

- [ ] Update `test/verify-status-widget.mjs`.
- [ ] Test idle process with waiting task.
- [ ] Test working process with running task.
- [ ] Test completed task removal.
- [ ] Test stale waiting display.
- [ ] Test session ownership filtering.
- [ ] Test parent/child status separation.

### Exit gate

- [ ] Status shows process state and task state independently.
- [ ] An idle waiting scout remains visible.
- [ ] Status/widget tests pass.

---

## Phase 10 — Artifacts, cleanup, compatibility, and documentation

### Artifacts

- [ ] Allocate artifacts for delegated tasks only.
- [ ] Do not allocate artifacts for ordinary messages.
- [ ] Keep task artifacts open while waiting.
- [ ] Finalize artifacts on task completion.
- [ ] Finalize artifacts on blocked state.
- [ ] Finalize artifacts on failure.
- [ ] Finalize artifacts on cancellation.
- [ ] Finalize artifacts on timeout.
- [ ] Preserve final summaries and errors.
- [ ] Avoid duplicate finalization from duplicate events.
- [ ] Add useful request/message references without creating one note per chat.

### Cleanup and shutdown

- [ ] Stop parent mailbox polling on parent shutdown.
- [ ] Stop child mailbox polling on child shutdown.
- [ ] Preserve already-persisted task outcomes.
- [ ] Cancel or fail tasks whose child disappears.
- [ ] Cancel unresolved requests when an agent closes.
- [ ] Close the broker only after child panes are confirmed gone.
- [ ] Preserve existing temporary launch-directory cleanup rules.
- [ ] Verify no foreign pane can be closed.
- [ ] Verify no foreign session can consume the mailbox.

### Compatibility

- [ ] Decide whether `shepherd_prompt` remains as an alias.
- [ ] Implement the chosen `shepherd_prompt` migration behavior.
- [ ] Decide whether `shepherd_wait` remains as a compatibility adapter.
- [ ] Implement the chosen `shepherd_wait` behavior.
- [ ] Ensure old prompt completion semantics are not silently active.
- [ ] Add compatibility tests for old calls where retained.
- [ ] Add migration guidance to documentation.
- [ ] Remove stale prompt-only assumptions from active descriptions.

### Documentation

- [ ] Update `README.md` with the new task/message workflow.
- [ ] Add a README example showing `shepherd_delegate` followed by
      `shepherd_watch`.
- [ ] Add a README example showing child-to-child `shepherd_message` usage.
- [ ] Document that an idle child may still own a waiting task.
- [ ] Document explicit `shepherd_done` completion.
- [ ] Update `docs/guides/tool-reference.md`.
- [ ] Update `docs/reference/dictionary`.
- [ ] Update `docs/plans/architecture.md`.
- [ ] Document task IDs versus message IDs.
- [ ] Document `shepherd_delegate`.
- [ ] Document `shepherd_message`.
- [ ] Document `shepherd_done`.
- [ ] Document `shepherd_watch`.
- [ ] Document waiting tasks with idle child processes.
- [ ] Document `followUp` versus `steer`.
- [ ] Document stale-wait notifications.
- [ ] Document compatibility status of `shepherd_prompt`.
- [ ] Document compatibility status of `shepherd_wait`.
- [ ] Document child messaging behavior and reply correlation.

### Exit gate

- [ ] Artifacts follow task lifecycle correctly.
- [ ] Shutdown and cleanup are safe.
- [ ] Compatibility behavior is explicit.
- [ ] Active documentation is updated.

---

## Phase 11 — Full verification and release readiness

### Automated verification

- [ ] Run task registry tests.
- [ ] Run mailbox tests.
- [ ] Run child-surface tests.
- [ ] Run delegation tests.
- [ ] Run task-completion tests.
- [ ] Run message-routing tests.
- [ ] Run task-watcher tests.
- [ ] Run stale-wait tests.
- [ ] Run status-widget tests.
- [ ] Run schema tests.
- [ ] Run parent-surface tests.
- [ ] Run launch tests.
- [ ] Run artifact-session tests.
- [ ] Run the complete `npm test` suite.
- [ ] Resolve all regressions without weakening task completion invariants.

### Live Herdr matrix

- [ ] Start or attach to a Herdr session.
- [ ] Spawn persistent scout and planner agents.
- [ ] Delegate a tracked task to scout.
- [ ] Confirm delegation returns without blocking.
- [ ] Have scout send a question to planner.
- [ ] Keep planner busy while scout's turn settles.
- [ ] Confirm scout's Pi process becomes idle.
- [ ] Confirm scout's task remains `waiting`.
- [ ] Confirm no watcher completion is emitted.
- [ ] Confirm the stale-wait notification appears after the threshold.
- [ ] Have planner receive the queued question.
- [ ] Have planner reply with the correct `replyTo` value.
- [ ] Confirm scout receives the reply as a queued follow-up.
- [ ] Confirm scout's task returns to `running`.
- [ ] Have scout call `shepherd_done`.
- [ ] Confirm exactly one watcher completion notification.
- [ ] Confirm the completion contains the task summary.
- [ ] Verify status output during `running`.
- [ ] Verify status output during `waiting`.
- [ ] Verify status output after completion.
- [ ] Verify child-to-Shepherd messaging.
- [ ] Verify Shepherd-to-child messaging.
- [ ] Verify peer messaging through the parent broker.
- [ ] Verify planner closure while scout waits.
- [ ] Verify scout closure while planner has a queued question.
- [ ] Verify task timeout.
- [ ] Verify provider failure.
- [ ] Verify parent shutdown.
- [ ] Verify pane ownership protection.
- [ ] Verify temporary-resource cleanup.

### Final review

- [ ] Review all public tool schemas for flat object roots.
- [ ] Review all public results for standard call/return/details formatting.
- [ ] Review all child/parent identity checks.
- [ ] Review all task terminal transitions.
- [ ] Review all waiting-task transitions.
- [ ] Review stale-wait notification rate limiting.
- [ ] Review message queue limits and failure behavior.
- [ ] Review fieldnote finalization behavior.
- [ ] Review documentation against implemented behavior.
- [ ] Mark the specification status as implemented only after all gates pass.

## Definition of done

- [ ] A delegated task can span multiple Pi turns.
- [ ] A child can ask another participant a question and end its current turn.
- [ ] An idle child with an outstanding request remains a waiting task, not a
      completed task.
- [ ] A queued reply can resume the child later.
- [ ] Only explicit `shepherd_done` normally completes the task.
- [ ] `shepherd_watch` reports terminal task completion without requiring
      `shepherd_wait`.
- [ ] Long waits notify the Shepherd without producing notification storms.
- [ ] Parent and child messaging works through the owned broker.
- [ ] Existing pane ownership and fieldnote safety invariants remain intact.
- [ ] All focused tests, live Herdr checks, and `npm test` pass.
