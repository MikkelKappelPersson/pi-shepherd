# Asynchronous Shepherd Tasks and Agent Messaging

## Status

Proposed specification.

## Summary

Add asynchronous task coordination and conversational messaging to
pi-shepherd. A delegated task and an agent conversation are separate concerns:

a delegated task is tracked until it explicitly completes, while messages can
be sent between the Shepherd and agents, or between agents, without blocking
the sender or consuming the recipient's task slot.

The design must not infer task completion from a Pi turn ending, an `agent_end`
event, an `agent_settled` event, or the child process becoming idle. An agent
may finish a turn because it is waiting for another agent's response and may
resume the same delegated task later.

The intended workflow is:

```text
shepherd_delegate
  -> tracked task starts
  -> child sends shepherd_message to another participant
  -> child task enters waiting state
  -> child's current Pi turn settles
  -> recipient eventually replies with shepherd_message
  -> child receives a queued follow-up and resumes
  -> child calls shepherd_done
  -> shepherd_watch reports task completion
```

The preferred coordination model is asynchronous. `shepherd_wait` is not
required for the new workflow. If retained for compatibility, it must observe
task completion and must not be required for message delivery or task
settlement.

## Problem

The current lifecycle associates a `shepherd_prompt` with one child turn and
uses completion signals derived from the child Pi process. This creates an
incorrect result when a child asks another participant a question:

```text
scout task starts
scout asks planner a question
scout's current turn ends while planner is busy
scout becomes idle
Shepherd incorrectly treats scout's task as complete
```

Pi's queueing APIs provide the correct local delivery primitive:
`sendUserMessage(..., { deliverAs: "followUp" })` can queue a regular message
until an agent is ready. However, queue delivery does not by itself provide:

- a cross-process route between child pi sessions and the parent;
- a distinction between a task and an ordinary message;
- request/reply correlation;
- task-level completion semantics; or
- stale-wait notifications.

Those concerns must be represented explicitly by Shepherd.

## Goals

- Add a tracked, non-blocking delegation operation.
- Add asynchronous messaging between the Shepherd and agents.
- Add asynchronous messaging between agents through a parent-owned broker.
- Deliver messages into a child using Pi's normal user-message queueing
  semantics.
- Allow an agent to wait for a reply while its current Pi turn is over without
  completing its delegated task.
- Make task completion explicit and independent of Pi turn completion.
- Preserve `shepherd_watch` as the preferred non-blocking completion mechanism.
- Notify the Shepherd when a task has been waiting for a reply for too long.
- Expose waiting task state and elapsed wait time through status and the TUI
  status widget.
- Keep task messages and conversational messages distinguishable.
- Preserve opaque lifecycle identifiers and pane ownership protections.
- Keep fieldnote/artifact allocation associated with delegated tasks rather
  than casual messages.

## Non-goals

- Do not make ordinary messages block the parent Shepherd turn.
- Do not infer task completion from textual phrases such as "done" in an
  assistant response.
- Do not infer task completion from Pi's `agent_end`, `agent_settled`, idle, or
  Herdr state alone.
- Do not require agents to remain actively streaming while waiting for a
  response.
- Do not expose Herdr pane IDs as message, request, or task identifiers.
- Do not allow child processes to access the parent's in-memory registry
  directly.
- Do not introduce automatic unrestricted peer-to-peer execution without a
  parent-owned routing and permission boundary.
- Do not require a workflow-specific `parallel`, `chain`, or `fan-in` mode.
- Do not make a message create a fieldnote unless explicitly designated as a
  delegated task.

## Terminology

### Shepherd

The parent pi session and its extension. It owns task records, routing policy,
message delivery to the parent session, and the parent side of the IPC broker.

### Agent

A persistent child pi session launched in a Herdr pane. An agent has a stable
opaque Shepherd agent ID for the lifetime of the parent Shepherd session.

### Task

A tracked unit of work started by `shepherd_delegate`. A task may span many Pi
turns and may be paused while waiting for one or more replies. A task has one
owner agent and one terminal outcome.

### Message

An asynchronous piece of conversational information. A message can be sent to
the Shepherd or to another agent. It is accepted or rejected independently of
task completion.

### Request

A message that expects a reply. Requests have a message ID and may be linked to
a task. A request remains pending until a matching reply, cancellation, or
timeout is recorded.

### Turn

One Pi model execution cycle, including its tool calls. A turn ending is a
runtime event, not a task lifecycle event.

### Waiting task

A task with at least one unresolved request that the task has declared it needs
before proceeding. Its owner agent may be idle while the task remains open.

## Public API

### `shepherd_delegate`

`shepherd_delegate` is the parent-facing operation for starting tracked work.
It returns immediately after the task has been accepted or queued.

Representative request:

```json
{
  "target": "shepherd-agent-scout",
  "task": "Investigate how authentication is currently implemented.",
  "timeout": 20
}
```

Representative result:

```json
{
  "taskId": "shepherd-task-...",
  "agentId": "shepherd-agent-...",
  "accepted": true
}
```

The delegated task message is delivered to the child as a task-designated
regular user message. The child receives the task ID in its task context and
must use it when explicitly completing the task.

An agent has at most one active delegated task by default. This restriction
applies to tasks only. It does not prevent the agent from receiving or sending
ordinary queued messages while its task is active or waiting.

A later version may support multiple tasks per agent, but that requires an
explicit task execution context and must not be inferred from multiple
messages.

### `shepherd_message`

`shepherd_message` is the asynchronous communication operation. It may be
used by the Shepherd or by a child agent, subject to routing permissions.

Representative request:

```json
{
  "target": "shepherd-agent-planner",
  "message": "What have you found about the authentication flow?",
  "expectsReply": true,
  "taskId": "shepherd-task-scout-...",
  "delivery": "followUp"
}
```

The operation returns immediately:

```json
{
  "messageId": "shepherd-message-...",
  "accepted": true,
  "delivery": "queued"
}
```

Required semantics:

- `followUp` is the default delivery mode and waits until the recipient's
  current work is finished before starting the next model call.
- `steer` may be requested for an urgent message and is delivered at the next
  safe steering point. It must not silently interrupt a tool call.
- An accepted message means the broker accepted it for delivery. It does not
  mean the recipient has read it or replied.
- A message may target the Shepherd, an agent, or a reply destination encoded
  by `replyTo`.
- A message does not create a task, settle a task, or consume the recipient's
  active-task slot.
- A message that expects a reply creates a tracked pending request. If it is
  associated with the sender's active task, that task enters `waiting`.

Incoming child-to-Shepherd messages must be injected into the parent as a
Shepherd custom message. They must use the parent pi session's message
queueing policy and must not be presented as an unsolicited ordinary user
message without provenance.

Incoming messages to children should use the child-side pi API equivalent to:

```ts
pi.sendUserMessage(renderedMessage, {
  deliverAs: "followUp"
});
```

The rendered message must preserve sender identity, message ID, task ID when
present, and reply metadata.

### `shepherd_done`

`shepherd_done` is a child-facing task lifecycle operation. It is not an
ordinary message and is not used for casual conversations.

Representative request:

```json
{
  "taskId": "shepherd-task-...",
  "status": "completed",
  "summary": "Authentication is implemented in src/auth/session.ts."
}
```

Supported terminal statuses are:

```text
completed
blocked
failed
```

The broker must validate that the caller owns the task. Completion should be
idempotent. A task with unresolved required requests must not be marked
`completed` unless those requests are explicitly cancelled or the caller
provides an override reason accepted by the task policy.

`shepherd_done` must not shut down a persistent agent. It only completes the
current delegated task; the agent remains available for later messages or new
tasks.

Normal completion should be explicit. The child runtime may report turn and
process state to Shepherd, but those events must not substitute for
`shepherd_done`.

### `shepherd_watch`

`shepherd_watch` observes task IDs and returns immediately. It should retain the
current one-shot watcher behavior, but its primary subject becomes a task
rather than an individual Pi turn.

A watcher reports only terminal task outcomes:

```json
{
  "taskId": "shepherd-task-...",
  "agentId": "shepherd-agent-...",
  "status": "completed",
  "ok": true,
  "returnCode": 0,
  "text": "The task summary."
}
```

The watcher must not settle when the child emits `agent_end`, becomes idle, or
enters the `waiting` task state. Failed, cancelled, blocked, and timed-out
tasks are terminal watcher results.

`shepherd_wait` may remain as a compatibility operation, but new orchestration
flows should use `shepherd_watch`. No task or message may depend on the parent
calling `shepherd_wait` in order to make progress.

## Task state machine

Task state is independent of Herdr and Pi process state.

```text
                 +----------------+
                 |                v
created -> running -> waiting -> running
   |          |          |          |
   |          |          |          +--> completed
   |          |          +--------------> blocked
   |          +-------------------------> failed
   +------------------------------------> cancelled
   +------------------------------------> timed_out
```

Required transitions:

- `created -> running`: delegated task is accepted and delivered.
- `running -> waiting`: the task sends one or more messages marked as
  expecting replies.
- `waiting -> running`: a required reply is received and delivered to the
  owner agent.
- `running -> completed`: the owner calls `shepherd_done` with `completed`.
- `running|waiting -> blocked`: the owner reports that it cannot continue.
- `running|waiting -> failed`: the child process or provider fails.
- `running|waiting -> cancelled`: Shepherd closes or cancels the task.
- `running|waiting -> timed_out`: the task exceeds its configured deadline.

A task may have an owner agent in Herdr state `idle` while its task state is
`waiting`. This is expected and must be represented in status output.

## Request and reply correlation

Every message has a unique opaque `messageId`. Requests additionally have a
`threadId` or can be addressed by their `messageId`. Replies carry `replyTo`.

A message envelope must contain at least:

```ts
interface ShepherdMessage {
  messageId: string;
  senderId: string;
  targetId: string;
  message: string;
  taskId?: string;
  threadId?: string;
  replyTo?: string;
  expectsReply?: boolean;
  delivery: "followUp" | "steer";
  createdAt: number;
}
```

The broker clears a pending request only when a valid reply is accepted for
that request. Delivery of a question to a busy recipient is not a reply and
must not clear the sender's waiting state.

If multiple required requests are outstanding, the task remains `waiting`
until the task policy considers the required set satisfied. The initial
implementation may restrict a task to one outstanding request at a time.

## Stale-wait notifications

A waiting task must record `waitingSince`. After a configurable threshold, the
parent receives one stale-wait notification for that waiting episode.

The notification should include:

- task ID and owning agent;
- task description;
- elapsed waiting time;
- pending request ID and question;
- target recipient;
- recipient process/task state; and
- suggested actions such as answer, remind, reroute, cancel, or inspect.

Example:

```text
Scout has been waiting for 2m 14s for planner.
Task: Investigate authentication flow
Question: What have you found about the authentication flow?
Planner state: working
Request: shepherd-message-...
```

A stale notification must not complete, fail, or cancel the task. It is an
escalation signal only.

The notification should be delivered to the parent using a Shepherd custom
message with follow-up semantics. It may trigger a parent turn when the parent
is idle, but it must not wake the parent on every normal message or polling
interval. Repeated notifications require a separate escalation threshold and
must be rate limited.

Generic agent idleness must not produce this notification unless there is an
associated waiting task or an explicitly configured stale-running policy.

## Runtime and completion interception

The child completion extension must distinguish runtime events from task
completion:

- `agent_end` indicates that a low-level Pi run ended.
- `agent_settled` indicates that Pi has no immediate queued continuation.
- neither event indicates that a delegated task completed;
- `shepherd_done` is the normal task completion signal;
- process exit, provider errors, cancellation, and deadline expiry remain
  external terminal signals.

The existing completion sidecar must therefore become task-aware. It must not
write a successful task completion sidecar merely because an agent turn ended
while a request is pending. A task completion event must include the task ID
and terminal status.

The child may report a `turn_settled` event so the parent can update live
status, but the task watcher must remain pending until a terminal task event is
received.

If the child forgets to call `shepherd_done`, the task remains open until its
deadline or external cancellation. The delegated task prompt and child system
context must clearly instruct the child to call `shepherd_done`; Shepherd must
not silently convert an idle task into success based on a heuristic.

## Transport and ownership

The parent owns a session-scoped message broker. Children communicate with it
through an authenticated, parent-created IPC endpoint or equivalent
session-scoped mailbox.

The launch context must provide the child with:

- its opaque agent ID;
- its current task ID when a task is active;
- the parent Shepherd session identity; and
- the scoped broker endpoint and capability necessary to send messages.

The broker must validate sender identity and target availability. A child must
not be able to claim another child's agent ID, close another session's pane, or
write directly to the parent's in-memory lifecycle registry.

The transport must provide:

- atomic message writes or equivalent framing;
- request/reply correlation;
- bounded queue size and message size;
- cleanup after the parent session ends; and
- safe behavior when a child or parent disappears.

Raw Herdr pane IDs remain internal diagnostics and must not be used as public
message or task handles.

## Status and user interface

`shepherd_status` should report process state and task state separately:

```json
{
  "id": "shepherd-agent-...",
  "agentState": "idle",
  "taskState": "waiting",
  "taskId": "shepherd-task-...",
  "waitingSince": "...",
  "waitingFor": "shepherd-agent-planner",
  "stale": true
}
```

The working-agent widget must not hide a waiting task merely because its Pi
process is idle. It should display a waiting row with elapsed time and the
recipient when available.

## Fieldnotes and artifacts

`shepherd_delegate` may create one fieldnote reservation for the delegated
task, preserving the existing parent-bound fieldnotes contract.

`shepherd_message` must not create a fieldnote by default. Conversational
messages may be included in the delegated task's note only when the task
implementation explicitly records them as task context.

Task completion, failure, blocked state, and final summary should finalize the
delegated task's artifact. A waiting task must leave its artifact open rather
than marking it completed merely because a turn ended.

## Failure and timeout behavior

- Sending to a closed or unknown target is rejected with a structured error.
- A message accepted into a queue may later produce a delivery failure; that
  failure must be correlated with its message ID.
- A child process exit while a task is running or waiting fails the task unless
  the exit was an intentional task completion path.
- A pending request must have a deadline. On expiry, the task becomes blocked or
  timed out according to task policy, and the Shepherd receives a notification.
- Closing an agent cancels its active task and unresolved requests.
- Repeated `shepherd_done`, reply, timeout, or cancellation events must be
  idempotent.
- Queue limits and rate limits must prevent agents from creating unbounded
  message storms.

## Security and safety

- Only the parent Shepherd may create delegated tasks.
- Child messages may target only the parent or agents visible through the
  parent-owned routing registry.
- Agent definitions and project approval rules remain unchanged.
- Existing pane ownership checks remain unchanged.
- Messages must carry provenance so a child cannot impersonate the Shepherd or
  another agent through message text alone.
- Direct peer delivery should remain parent-mediated in the initial version.
- The implementation must prevent recursive notification loops and should
  enforce a maximum message hop count for any future automatic relay feature.

## Compatibility

The existing `shepherd_spawn`, `shepherd_status`, `shepherd_close`,
`shepherd_read`, and `shepherd_watch` concepts remain. `shepherd_prompt` should
be deprecated or retained as a compatibility alias during migration, but its
old one-active-prompt completion semantics must not be mixed silently with the
new message semantics.

Recommended migration:

```text
old shepherd_prompt task call  -> shepherd_delegate
old prompt completion tracking -> shepherd_watch(taskId)
new child/peer communication   -> shepherd_message
new child task completion       -> shepherd_done
```

If `shepherd_wait` remains available, it should wait on task IDs or provide a
clearly documented compatibility mapping. It must not be required by the new
asynchronous protocol.

## Verification requirements

Focused tests must verify:

- delegation returns without blocking;
- multiple messages can be queued without violating the one-active-task
  invariant;
- a child can send a question to a busy recipient;
- the sender becomes `waiting` while its Pi process becomes idle;
- the Shepherd does not settle the task on `agent_end`, `agent_settled`, or
  idle state;
- a matching reply returns the task to `running` and triggers child delivery;
- `shepherd_done` is the only normal successful completion path;
- task watchers report terminal outcomes exactly once;
- stale-wait notifications fire once per waiting episode and include useful
  correlation data;
- pending-request timeout, child failure, close cancellation, and duplicate
  events are handled idempotently;
- message routing rejects unknown targets and invalid sender capabilities;
- messages do not create fieldnotes unless explicitly associated with a task;
- status and the TUI widget show an idle process with a waiting task; and
- parent shutdown cleans up broker resources without losing already-persisted
  task outcomes.

Live Herdr verification must cover at least:

1. Shepherd delegates a task to scout.
2. Scout sends a question to a busy planner.
3. Scout's turn settles and its task remains waiting.
4. Planner eventually receives and answers the queued question.
5. Scout resumes and calls `shepherd_done`.
6. `shepherd_watch` receives the final task result.
7. A stale-wait notification is delivered when the planner does not answer
   within the configured threshold.
8. Closing or timing out either participant produces the correct terminal
   task state.

`npm test` must pass, and new schema tests must verify that all new model-facing
registrations use flat root object schemas with explicit required fields.
