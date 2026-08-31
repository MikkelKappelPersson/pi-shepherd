# Implementation Plan: Asynchronous Shepherd Tasks and Agent Messaging

## Status

Proposed implementation plan for
`docs/specs/001-agent-messaging-and-task-lifecycle/spec.md`.

No implementation is included in this plan. The plan is intentionally staged so
that task lifecycle correctness is established before peer messaging and UI
conveniences are added.

## 1. Implementation decisions

The following decisions are normative for the implementation unless the
specification is amended first.

### 1.1 Public operations

The new canonical operations are:

```text
shepherd_delegate  parent -> child, tracked task, returns taskId
shepherd_message   Shepherd/child -> Shepherd/child, asynchronous message
shepherd_done      child -> parent, explicit task terminal signal
shepherd_watch    parent -> task completion subscription
```

Existing operations remain available where they are still meaningful:

```text
shepherd_spawn
shepherd_status
shepherd_close
shepherd_read
```

`shepherd_wait` is not used by the new workflow. It may remain as a
compatibility adapter, but no new message or task path may depend on it.

`shepherd_prompt` becomes a deprecated compatibility name for the old
parent-to-child task submission path. It must not retain a separate completion
model after the new task registry is active. Compatibility calls should map to
a task record and return an identifier that can be observed through the task
watcher. The migration behavior must be documented and tested explicitly.

### 1.2 Task completion

A child Pi turn is not a task. The following are non-terminal runtime events:

- `agent_end`;
- `agent_settled`;
- Herdr `idle`;
- a child becoming quiet while waiting for another agent; and
- an intermediate assistant response.

The normal successful terminal event is an explicit child `shepherd_done` call.
The parent may also settle a task as failed, cancelled, or timed out when an
external lifecycle event requires it.

This is the central correctness rule. No implementation may restore the old
behavior of treating a successful `agent_end` sidecar as task completion.

### 1.3 Message delivery

Messages are accepted asynchronously. The initial delivery mode is:

- `followUp` by default;
- `steer` only when explicitly requested; and
- no synchronous parent wait.

The child-side extension calls Pi's local API, equivalent to:

```ts
pi.sendUserMessage(renderedMessage, { deliverAs: "followUp" });
```

The implementation must not try to access a child `AgentSession` object from
the parent process. Parent and child processes communicate through the
Shepherd broker.

### 1.4 Transport

Use a parent-owned, session-scoped filesystem mailbox for the first
implementation rather than a Unix socket. A mailbox is easier to inspect,
works from separate Herdr panes, and does not require a long-lived socket
server or reconnect protocol.

The mailbox must use:

- a directory created with owner-only permissions;
- one immutable JSON envelope per message or control event;
- temporary-file-plus-rename writes for atomic publication;
- polling with bounded intervals on both parent and child sides;
- sender and target identity validation; and
- bounded queue, message-size, and retention limits.

The transport boundary must be replaceable later by a socket without changing
the task or message records.

### 1.5 Task concurrency

An agent has at most one active delegated task in the first version. This
restriction applies only to delegated tasks. An agent may send and receive
ordinary messages while its task is running or waiting.

Messages do not create an active-task slot and do not settle a task.

### 1.6 Waiting semantics

A message with `expectsReply: true` creates a pending request. If it is linked
to the sender's active task, the task enters `waiting`.

A task can therefore be represented as:

```text
Pi process: idle
Task: waiting
Pending request: request-123
```

A reply clears the pending request and returns the task to `running`. A task
remains open until `shepherd_done`, cancellation, failure, or timeout.

### 1.7 Explicit completion tool

`shepherd_done` is a child-facing lifecycle tool, not a conversational
message. It is the reliable semantic completion signal. The child prompt and
runtime context must instruct the model to call it only when the delegated
task is actually complete.

The child runtime may report turn-settled events for observability, but those
events must never substitute for `shepherd_done`.

## 2. Target architecture

```text
                         Parent Shepherd process
  ┌──────────────────────────────────────────────────────────────────────┐
  │ parent tools: delegate/message/watch/status/close/read                │
  │                                                                      │
  │ TaskRegistry       MessageBroker       TaskWatcher/StaleWaitMonitor   │
  │      │                    │                         │                 │
  │      └──────────────┬─────┴─────────────────────────┘                 │
  │                     │                                                   │
  │              session mailbox directory                                  │
  └─────────────────────┼───────────────────────────────────────────────────┘
                        │ atomic JSON envelopes
       ┌────────────────┴───────────────────┐
       │                                    │
  Child scout process                   Child planner process
  ┌─────────────────────────┐           ┌─────────────────────────┐
  │ shepherd-agent.ts       │           │ shepherd-agent.ts       │
  │ shepherd_message tool   │           │ shepherd_message tool   │
  │ shepherd_done tool      │           │ shepherd_done tool      │
  │ Pi sendUserMessage()    │           │ Pi sendUserMessage()    │
  └─────────────────────────┘           └─────────────────────────┘
```

The existing `LifecycleRegistry` remains the parent-session authority for
opaque identifiers, but task and message records should be separated from the
old prompt-specific assumptions. The likely split is:

```text
src/core/orchestration.ts  opaque ids, task records, message/request records
src/core/messaging.ts      envelopes, mailbox transport, routing and polling
src/core/lifecycle.ts      delegate, done, watch, status, close adapters
```

A separate `task-registry.ts` may be used if `orchestration.ts` becomes too
large. It must still use the same parent-session identity and opaque-ID rules.

## 3. Data model and contracts

### 3.1 Task record

Add an internal task record with at least:

```ts
interface TaskRecord {
  taskId: string;
  agentId: string;
  description: string;
  state: 'created' | 'running' | 'waiting' | 'completed' |
    'blocked' | 'failed' | 'cancelled' | 'timed_out';
  createdAt: number;
  startedAt?: number;
  waitingSince?: number;
  deadlineAt?: number;
  pendingRequestIds: Set<string>;
  staleNotifiedAt?: number;
  result?: TaskResult;
  artifactSession?: ShepherdSession;
  artifact?: ArtifactReservation;
}
```

`Set` is an internal representation only. Any data crossing the tool or
mailbox boundary must use arrays and JSON-safe values.

The task registry must provide methods equivalent to:

```text
createTask(agent, description, options)
getTask(taskId)
canonicalTaskId(input)
setRunning(taskId)
addPendingRequest(taskId, requestId)
resolvePendingRequest(taskId, requestId)
setWaiting(taskId)
settleTask(taskId, result)
cancelTask(taskId, reason)
listTasks()
```

All terminal settlement must be idempotent. A second `done`, timeout, failure,
or cancellation event must return the existing terminal result without
modifying it.

### 3.2 Task result

Use a task-oriented result shape:

```ts
interface TaskResult {
  taskId: string;
  agentId: string;
  status: 'completed' | 'blocked' | 'failed' |
    'cancelled' | 'timed_out';
  ok: boolean;
  returnCode: number;
  text?: string;
  error?: string;
  completedAt: number;
}
```

`text` should contain the explicit `shepherd_done` summary when present, with
the child's latest assistant text as a fallback for diagnostic results. A
fallback must not turn an otherwise idle child into a successful task.

### 3.3 Message envelope

Create a JSON-safe envelope shared by parent and child:

```ts
interface ShepherdMessageEnvelope {
  kind: 'message' | 'task' | 'reply' | 'task_done' | 'runtime';
  messageId: string;
  senderId: string;
  targetId: string;
  taskId?: string;
  threadId?: string;
  replyTo?: string;
  expectsReply?: boolean;
  delivery: 'followUp' | 'steer';
  content?: string;
  status?: 'completed' | 'blocked' | 'failed';
  summary?: string;
  error?: string;
  createdAt: number;
}
```

Use a dedicated `task_done` envelope for `shepherd_done` rather than
pretending that completion is an ordinary chat message. `runtime` envelopes
may be used for non-terminal turn status and diagnostics, but they must never
settle a task.

The public tool result should expose only the relevant opaque identifier and
structured acceptance status. Internal sender/session capabilities must not be
returned as public handles.

### 3.4 Pending requests

Maintain a request record or request fields on the message record:

```ts
interface RequestRecord {
  requestId: string;
  messageId: string;
  senderId: string;
  targetId: string;
  taskId?: string;
  state: 'pending' | 'replied' | 'cancelled' | 'timed_out';
  createdAt: number;
  deadlineAt?: number;
  repliedAt?: number;
}
```

The first implementation may allow only one unresolved required request per
task. The data model should use a collection so multiple-request support can
be added without changing the task state representation.

## 4. Implementation phases

### Phase 0 — Baseline and specification guardrails

Before changing runtime behavior:

1. Run `npm test` and record the current baseline.
2. Add a small test helper for deterministic clock control where stale-wait
   behavior needs time advancement.
3. Add schema placeholders for the new tools to
   `test/verify-tool-schemas.mjs`.
4. Add comments or assertions documenting that Pi idle/settled state is not
   task completion.
5. Keep the existing prompt/watcher tests green until the compatibility
   adapter is introduced.

Files:

```text
test/verify-tool-schemas.mjs
package.json
```

Acceptance:

- Existing tests pass.
- The new test harness can inspect parent and child tool registrations.

### Phase 1 — Add task records and task-state transitions

Implement the task registry before adding mailbox traffic.

1. Add task IDs with the same parent-session-scoped opaque-ID strategy used by
   agent and prompt IDs.
2. Add `TaskRecord` and `TaskResult` types.
3. Implement the task state transition methods.
4. Reject invalid transitions with structured lifecycle errors.
5. Ensure `waiting` does not clear the task's active ownership.
6. Ensure task settlement clears any pending request associations and runs
   artifact finalization exactly once.
7. Keep the existing prompt registry intact temporarily, but introduce an
   explicit mapping type for compatibility prompt IDs to task IDs.

Files:

```text
src/core/orchestration.ts
src/core/lifecycle.ts
possibly src/core/task-registry.ts

test/verify-task-registry.mjs
```

Required unit cases:

```text
created -> running
running -> waiting
waiting -> running
running -> completed
waiting -> completed only after requests are resolved/cancelled
running/waiting -> failed
running/waiting -> cancelled
running/waiting -> timed_out
idle process + waiting task remains non-terminal
repeated terminal events are idempotent
```

Acceptance:

- No task can settle from a synthetic idle or turn-ended event.
- A task can remain waiting while its child process is idle.

### Phase 2 — Implement the parent-owned mailbox

Create the transport independently of Pi and Herdr behavior.

1. Add a parent-session mailbox directory under the Shepherd runtime area.
2. Create the directory with mode `0700`.
3. Create per-agent inboxes and a parent inbox.
4. Publish each envelope by writing a random temporary file and atomically
   renaming it to a filename containing the message ID.
5. Read only complete JSON files.
6. Move processed files to an archive or delete them after an acknowledgement,
   while retaining enough state to deduplicate repeated delivery.
7. Enforce maximum message size and queue depth.
8. Validate the envelope schema before routing.
9. Add sender capability validation so a child can only publish as its own
   agent ID.
10. Add parent-session and broker identity fields so a child cannot submit to
    another Shepherd session's mailbox by guessing a path.

Files:

```text
src/core/messaging.ts
src/core/messaging-types.ts (if useful)
src/core/herdr.ts           mailbox creation and launch environment

test/verify-messaging.mjs
```

The initial polling API should support:

```text
createParentBroker(sessionOwner)
registerChild(agentId)
publishFromParent(envelope)
publishFromChild(capability, envelope)
pollParentInbox()
pollAgentInbox(agentId)
acknowledge(messageId)
closeBrokerWhenChildrenGone()
```

Acceptance:

- Parent-to-child and child-to-parent envelopes survive partial writes.
- Duplicate files do not result in duplicate task settlement or duplicate
  message delivery.
- Invalid sender, target, session, and envelope data are rejected.
- Transport tests do not require a running Herdr instance.

### Phase 3 — Add the child-side Shepherd extension

Create the child extension that bridges the mailbox to the local Pi session.

1. Add `src/extension/shepherd-agent.ts` as the child-only extension, or
   refactor `shepherd-done.ts` into a shared child extension while preserving
   its default entrypoint behavior.
2. Register `shepherd_message` with a flat TypeBox object schema.
3. Register `shepherd_done` with a flat TypeBox object schema.
4. Obtain the child identity, broker path, parent identity, and current task ID
   from launch environment/context.
5. Publish outgoing messages and task-done envelopes to the mailbox.
6. Poll the child inbox at a bounded interval.
7. Deliver incoming messages through `pi.sendUserMessage` using the requested
   `followUp` or `steer` behavior.
8. Include sender, message ID, task ID, thread ID, and reply metadata in the
   rendered message text.
9. Return an acknowledgement from the child tool once the envelope has been
   accepted by the broker; do not wait for the recipient to answer.
10. Make child polling timers `unref`-safe and clean them up on shutdown.

The child message presentation should be explicit, for example:

```text
[Shepherd message from planner]
Message ID: shepherd-message-...
Reply to: shepherd-message-...

<message content>
```

The child task context should be explicit, for example:

```text
[Shepherd delegated task]
Task ID: shepherd-task-...

<task description>

Do not consider the task complete merely because this Pi turn ends. If you
need information, use shepherd_message. Call shepherd_done only when the
whole delegated task is complete.
```

Files:

```text
src/extension/shepherd-agent.ts
src/extension/shepherd-done.ts
src/core/herdr.ts
index.ts

test/verify-child-surface.mjs
test/verify-launch.mjs
```

Acceptance:

- Child sessions receive only child messaging/completion tools, never the
  parent-only lifecycle surface.
- A child can send a message without blocking its current model workflow.
- A child can call `shepherd_done` and publish a task terminal event.
- Incoming follow-up messages are delivered through Pi's supported queue API.

### Phase 4 — Replace prompt submission with tracked delegation

Implement the parent-side delegation path.

1. Add `delegateAgent()` in `src/core/lifecycle.ts`.
2. Resolve the target agent using the existing opaque agent registry.
3. Enforce one active delegated task per agent.
4. Create the task record before publishing the task envelope.
5. Reserve and attach the fieldnote artifact to the task, not to an ordinary
   message.
6. Add the task context to the delegated child message.
7. Publish the task envelope through the broker.
8. Return as soon as the broker accepts the task.
9. If publication fails, settle the task as failed and finalize its artifact.
10. Do not use Herdr's current `agent_end` completion sidecar as the task
    success signal.

Add the `shepherd_delegate` registration in `src/extension/shepherd.ts`:

```text
required: target, task
optional: timeout
returns: taskId, agentId, accepted
```

The tool must follow the repository convention that `name`, `label`,
`description`, `promptSnippet`, and `parameters` are written directly in the
registration.

Files:

```text
src/core/lifecycle.ts
src/core/orchestration.ts
src/extension/shepherd.ts
src/core/types.ts
src/core/herdr.ts

test/verify-delegate.mjs
```

Acceptance:

- Delegation is non-blocking.
- A second delegated task to the same agent is rejected clearly while the
  first task remains active.
- Messages to that agent are still accepted while the task is active.
- Fieldnotes are created for tasks only.

### Phase 5 — Consume `shepherd_done` and external terminal events

Connect child task-done events to the parent task registry.

1. Add a parent broker handler for `task_done` envelopes.
2. Validate child identity and task ownership.
3. Reject completion of unknown, closed, or foreign tasks.
4. Reject successful completion when unresolved required requests remain,
   unless the task explicitly cancels those requests.
5. Settle the task once and record its final summary/status.
6. Finalize the task's artifact through the existing artifact callback path.
7. Preserve the child session and pane according to existing `keepOpen` and
   `stayOpen` settings.
8. Map child provider errors, unexpected process exit, close, and timeout to
   task failure/cancellation/timeout.
9. Remove any logic that interprets a normal `agent_end` sidecar as successful
   completion for a delegated task.
10. If the child extension reports `agent_settled`, treat it as an observation
    only. Do not settle the task.

Refactor `shepherd-done.ts` so its completion responsibilities are task-aware.
The launch script and sidecar may remain as a process-health fallback, but the
sidecar must include an explicit task ID and must not claim task success for a
turn that ended while the task is waiting.

Files:

```text
src/extension/shepherd-done.ts
src/core/lifecycle.ts
src/core/orchestration.ts
src/core/herdr.ts

test/verify-task-completion.mjs
```

Acceptance scenario:

```text
delegate scout task
scout sends question
scout turn settles
no task completion is emitted
scout calls shepherd_done later
watcher receives exactly one completed result
```

### Phase 6 — Implement asynchronous message routing

Add parent and child `shepherd_message` behavior.

1. Register the parent-side `shepherd_message` tool.
2. Register the child-side tool with the same conceptual name but a
   child-specific adapter.
3. Permit child targets of `shepherd` and validated peer agent IDs.
4. Permit parent targets of owned child IDs.
5. Resolve `replyTo` and `threadId` without exposing pane IDs.
6. When `expectsReply` is true and a task ID is supplied, add the request to
   the task's pending set and transition the task to `waiting`.
7. Queue incoming child messages into the parent with `pi.sendMessage` as a
   custom Shepherd message using follow-up delivery.
8. Queue incoming child messages into child Pi sessions with
   `pi.sendUserMessage`.
9. On a valid reply, clear the request and transition the owner task from
   `waiting` to `running`.
10. Trigger a waiting child when a reply is delivered and the child is idle.
11. Keep ordinary messages independent of task completion and artifact
    finalization.
12. Add a reply deadline and settle unresolved requests as blocked or timed out
    according to task policy.

The initial implementation should keep routing parent-mediated. Do not add
automatic final-answer forwarding from one child to another; a recipient
should send its answer explicitly with `shepherd_message` and `replyTo`.

Files:

```text
src/core/messaging.ts
src/core/lifecycle.ts
src/extension/shepherd.ts
src/extension/shepherd-agent.ts
src/extension/types.ts or src/core/types.ts

test/verify-message-routing.mjs
```

Acceptance:

- Worker can ask planner while planner is busy.
- Planner receives the question as a queued follow-up.
- Worker remains waiting rather than completed.
- Planner can reply to worker.
- Worker resumes from the reply and can complete its task.
- A regular message with no `expectsReply` does not alter task state.

### Phase 7 — Generalize watching from prompts to tasks

Adapt the watcher implementation while preserving non-blocking delivery.

1. Add task watcher registration keyed by task IDs.
2. Accept one task ID or an array of task IDs.
3. Report only terminal task states.
4. Preserve one-shot, idempotent delivery.
5. Keep completion order deterministic for arrays while allowing individual
   notifications as tasks settle.
6. Include task ID, agent ID, task status, summary, error, and return code.
7. Deliver completion notifications as custom parent messages with follow-up
   semantics.
8. Do not trigger a parent turn for every intermediate message or waiting
   transition.
9. Decide whether to preserve the current public prompt-ID spelling through a
   compatibility adapter; document the decision in the migration section.
10. Remove any watcher path that reads child idle state as task success.

The new watcher flow is:

```text
shepherd_delegate -> taskId
shepherd_watch(taskId) -> immediate registration
child sends messages / waits / resumes
child shepherd_done -> task settlement
watcher -> parent custom completion notification
```

Files:

```text
src/core/lifecycle.ts
src/core/orchestration.ts
src/extension/shepherd.ts
src/core/types.ts

test/verify-task-watchers.mjs
```

Acceptance:

- Watching a waiting task remains pending.
- Watching a completed task returns its result immediately.
- Multiple watchers receive independent, idempotent notifications.
- Parent shutdown stops polling without corrupting settled task records.

### Phase 8 — Add stale-wait monitoring

Implement notification for tasks waiting too long for replies.

1. Add a configurable `staleWaitThreshold` setting, defaulting to a conservative
   value such as two minutes.
2. Preserve the existing two-layer user/project settings model.
3. Add the setting to config validation, defaults, settings UI, and docs.
4. Start a parent-owned monitor only while there are waiting tasks.
5. Inspect task state, not raw Herdr idle state.
6. Require at least one unresolved `expectsReply` request.
7. Emit one stale notification per waiting episode.
8. Include task ID, agent, task description, waiting age, request ID, question,
   target recipient, and recipient status.
9. Mark the notification as delivered without changing the task's lifecycle
   state.
10. Clear the notification marker when a reply returns the task to `running`.
11. Add a separate long escalation interval only if real usage demonstrates a
    need; do not repeatedly notify by default.
12. Do not trigger a parent model turn for every normal waiting transition.
    A stale notification may use `pi.sendMessage` with follow-up delivery and
    `triggerTurn: true` when the parent is idle.

Files:

```text
src/extension/config.ts
src/extension/settings-ui.ts
src/core/lifecycle.ts or src/core/task-monitor.ts
src/extension/shepherd.ts

 test/verify-stale-wait.mjs
 test/verify-settings.mjs
```

Acceptance:

- A waiting scout produces one notification after the threshold.
- A reply prevents additional notifications for that waiting episode.
- A later waiting episode can produce a new notification.
- A completed task never produces a stale-wait notification.

### Phase 9 — Update status and the TUI widget

Expose process and task state separately.

1. Extend `shepherd_status` to include task ID, task state, waiting age, pending
   request, recipient, and stale flag when applicable.
2. Keep Herdr process state as a separate field.
3. Update `workingSubagents()` or add a task-aware status projection so an idle
   process with a waiting task remains visible.
4. Render waiting rows distinctly from completed or working rows.
5. Preserve the current pane ownership filtering.
6. Avoid making widget rendering depend on direct mailbox reads on every frame;
   poll into a snapshot at the existing widget interval.

Files:

```text
src/core/herdr.ts
src/core/lifecycle.ts
src/extension/shepherd.ts
index.ts

test/verify-status-widget.mjs
```

Acceptance example:

```text
○ 02:14 scout   idle / waiting for planner
```

The status widget must not display the scout as completed merely because its
Pi process is idle.

### Phase 10 — Artifacts, cleanup, and compatibility

Integrate the new lifecycle with existing persistence and ownership rules.

1. Allocate one artifact reservation for each delegated task when the task is
   created.
2. Do not allocate artifacts for ordinary messages or replies.
3. Keep the task artifact open during `waiting`.
4. Finalize it on completed, blocked, failed, cancelled, or timed-out task
   settlement.
5. Include message/request references in the task artifact only if they are
   useful task context; do not create one note per chat message.
6. Ensure broker cleanup happens only after all child panes are confirmed gone,
   following the existing temporary-resource invariant.
7. Ensure closing an agent cancels its active task and unresolved requests.
8. Ensure a parent restart cannot accidentally claim another session's tasks or
   panes.
9. Update the compatibility adapter for `shepherd_prompt` and
   `shepherd_wait`, or remove them with an explicit migration note. Do not
   silently expose two different meanings for the same prompt ID.
10. Update the shared Shepherd narrative and child instructions.

Files:

```text
src/core/artifact-sessions.ts
src/core/lifecycle.ts
src/core/herdr.ts
src/core/orchestration.ts
src/extension/shepherd.ts
src/extension/shepherd-agent.ts
index.ts
README.md
docs/guides/tool-reference.md
docs/reference/dictionary
docs/plans/architecture.md
```

Acceptance:

- Task artifacts remain open while a child waits.
- Message-only conversations do not create artifacts.
- Close, crash, timeout, and parent shutdown leave no unsafe temporary
  resources.
- Public documentation describes task IDs, message IDs, and their different
  lifetimes.

## 5. Tool schemas and model-facing surface

Every registration must use a flat root `Type.Object` schema and spell out
`name`, `label`, `description`, `promptSnippet`, and `parameters` directly in
the registration.

### `shepherd_delegate`

Parent-only:

```text
target: required opaque agent ID
task: required non-empty string
timeout: optional integer task deadline in minutes
```

Returns `taskId`, `agentId`, and acceptance state.

### `shepherd_message`

Parent and child adapters:

```text
target: required Shepherd, parent, or opaque agent ID
message: required non-empty string
taskId: optional active task ID
threadId: optional conversation ID
replyTo: optional request/message ID
expectsReply: optional boolean, default false
delivery: optional followUp|steer, default followUp
```

The child adapter may restrict `target` based on the child capability, but it
must use the same conceptual envelope.

### `shepherd_done`

Child-only:

```text
taskId: required opaque task ID
status: required completed|blocked|failed
summary: optional completion or failure summary
```

### `shepherd_watch`

Parent-only:

```text
id: required task ID or non-empty task ID array
```

If compatibility prompt IDs remain accepted, the adapter must explicitly state
that they resolve to associated task IDs and must not guess from agent IDs or
pane IDs.

## 6. Compatibility and migration strategy

The existing implementation has prompt records, prompt watchers, completion
sidecars, fieldnote callbacks, and tests built around one unresolved prompt per
agent. The migration must avoid a period where a single child can be governed
by two contradictory completion mechanisms.

Recommended migration sequence:

1. Introduce task records and task IDs without changing existing public calls.
2. Add the mailbox and child extension behind new `shepherd_delegate` and
   `shepherd_message` tools.
3. Route new delegated tasks exclusively through task records.
4. Make `shepherd_watch` task-aware.
5. Add a compatibility mapping from old prompt IDs to task IDs.
6. Update `shepherd_prompt` to call the compatibility delegation adapter.
7. Update `shepherd_wait` to wait on the mapped task only if it is retained.
8. Remove prompt-specific successful completion detection from the child
   sidecar.
9. Update all active documentation and tests.
10. Retain historical prompt terminology only in migration notes or archived
    plans.

Do not support both of these simultaneously for the same delegated task:

```text
agent_end sidecar means success
shepherd_done means success
```

The explicit task protocol must be authoritative.

## 7. Test plan

### 7.1 Registry and state tests

Add `test/verify-task-registry.mjs` covering:

- opaque task IDs are session-scoped;
- one active task per agent;
- messages do not consume the task slot;
- waiting tasks remain non-terminal;
- all valid state transitions;
- invalid transitions;
- idempotent terminal settlement;
- request resolution and cancellation;
- task timeout and close cancellation.

### 7.2 Mailbox tests

Add `test/verify-messaging.mjs` covering:

- atomic publication and complete-file reads;
- parent-to-child delivery;
- child-to-parent delivery;
- duplicate envelope handling;
- malformed envelope rejection;
- invalid sender capability rejection;
- unknown target rejection;
- queue depth and message-size limits;
- broker cleanup after child disappearance.

### 7.3 Child surface tests

Add `test/verify-child-surface.mjs` covering:

- child sessions receive `shepherd_message` and `shepherd_done` only;
- parent sessions receive parent lifecycle tools;
- child message tools return acceptance without waiting for replies;
- `shepherd_done` publishes a task-done control envelope;
- incoming messages invoke Pi queue APIs with the requested delivery mode.

Update `test/verify-launch.mjs` to verify:

- broker environment wiring;
- child identity wiring;
- task identity wiring;
- child extension wiring; and
- no parent-only surface in the child.

### 7.4 Conversation and task tests

Add `test/verify-task-messaging.mjs` covering the canonical scenario:

```text
1. delegate task to scout
2. scout sends expectsReply question to busy planner
3. scout turn settles
4. scout process is idle
5. scout task remains waiting
6. no watcher completion is delivered
7. planner receives the queued question
8. planner replies with replyTo
9. scout receives the reply as followUp
10. scout task returns to running
11. scout calls shepherd_done
12. watcher receives exactly one completed result
```

Also cover:

- a non-reply message while a task is running;
- a message to the Shepherd;
- multiple independent messages;
- a peer reply arriving while the child is idle;
- reply timeout;
- planner closure while scout waits;
- scout closure while planner has a queued question; and
- duplicate replies and duplicate done events.

### 7.5 Watcher and notification tests

Add `test/verify-task-watchers.mjs` covering:

- immediate registration;
- already-completed tasks;
- one and multiple task IDs;
- independent watcher delivery;
- completion ordering;
- failed, blocked, cancelled, and timed-out outcomes;
- no settlement on `agent_end`, `agent_settled`, or idle; and
- no parent turn after watcher shutdown.

Add `test/verify-stale-wait.mjs` covering:

- threshold crossing;
- one notification per waiting episode;
- notification content and correlation IDs;
- reset after a reply;
- no notification for completed tasks;
- no notification for ordinary idle agents; and
- request timeout/escalation behavior.

### 7.6 Schema and documentation tests

Update:

```text
test/verify-tool-schemas.mjs
test/verify-parent-surface.mjs
test/verify-status-widget.mjs
```

The schema test must verify that every new model-facing registration has a
flat object root and explicit required fields. The parent-surface test must
verify role-specific registration in parent and child processes.

### 7.7 Live Herdr verification

After focused tests pass, run the live matrix:

1. Start or attach to Herdr.
2. Spawn scout and planner as persistent agents.
3. Delegate a task to scout.
4. Prompt scout, through its task context, to ask planner a question.
5. Keep planner busy so scout's current turn settles first.
6. Confirm scout's Herdr state becomes idle while task state remains waiting.
7. Confirm no `shepherd_watch` completion occurs.
8. Confirm the stale-wait notification after the configured threshold.
9. Allow planner to answer.
10. Confirm scout receives the answer and resumes.
11. Confirm scout calls `shepherd_done`.
12. Confirm exactly one watcher completion notification.
13. Verify status and widget output during the waiting interval.
14. Repeat with close, timeout, provider failure, and parent shutdown.
15. Verify pane ownership and temporary-resource cleanup.

Finally run:

```bash
npm test
```

## 8. Documentation updates

Update active documentation only after the API and compatibility behavior are
settled.

Required updates:

```text
README.md
 docs/guides/tool-reference.md
 docs/reference/dictionary
 docs/plans/architecture.md
```

Document:

- task IDs versus message IDs;
- `shepherd_delegate` versus `shepherd_message`;
- explicit `shepherd_done` completion;
- `shepherd_watch` as the preferred non-blocking observer;
- waiting tasks whose agents may be idle;
- `followUp` versus `steer` delivery;
- stale-wait notifications; and
- the compatibility status of `shepherd_prompt` and `shepherd_wait`.

The umbrella Shepherd description should explain that a Pi turn ending does
not complete a delegated task and that agents should use `shepherd_message`
for questions and `shepherd_done` only for actual task completion.

## 9. Delivery order and review gates

Each phase should be implemented and reviewed before the next phase begins.

```text
Phase 0  baseline and guardrails
Phase 1  task registry
Phase 2  mailbox transport
Phase 3  child extension
Phase 4  delegation
Phase 5  explicit completion
Phase 6  message routing
Phase 7  task watchers
Phase 8  stale-wait monitor
Phase 9  status and widget
Phase 10 artifacts, cleanup, compatibility, docs
```

Review gates:

- After Phase 1: verify that idle is not completion.
- After Phase 3: verify child and parent surfaces are isolated.
- After Phase 5: verify explicit `shepherd_done` is authoritative.
- After Phase 6: verify the scout/planner waiting scenario manually.
- After Phase 8: verify stale notifications do not create message storms.
- After Phase 10: run the full test suite and live Herdr matrix.

The feature is complete only when the canonical waiting scenario is correct:

```text
scout's Pi turn ends
scout is idle
scout's task is waiting, not done
planner replies
scout resumes
scout explicitly calls shepherd_done
shepherd_watch reports completion
```
