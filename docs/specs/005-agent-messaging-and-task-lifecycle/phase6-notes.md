# Phase 6 — design notes (working decisions)

Canonical requirement: `worker asks planner while planner is busy → planner
receives the question as a queued follow-up → worker task stays waiting →
planner replies → worker returns to running.` The parent must own request and
task state because later phases (watchers, stale-wait, status) read the parent
`lifecycleRegistry`, which the child process cannot touch.

## How the pieces fit

1. **Transport.** `messaging.ts` already routes child↔child *through the
   parent-owned broker* and child→parent into the parent inbox (Phase 2). No
   routing change needed. One fix: acknowledgement/dedup is keyed by
   `(participant, messageId)`, so the parent can consume an envelope and later
   relay a **fresh**-`messageId` copy to a child without the old ack blocking.

2. **Request tracking (child-originated).** A child cannot put its task into
   `waiting` by itself (the registry lives in the parent). So when the child
   sends `shepherd_message` with `expectsReply` + a task, the child extension
   also mirrors a `runtime` envelope (`requestOpen: true`) to the **parent**
   inbox alongside the question. The parent opens a pending request on the
   sender task and transitions it `running → waiting`.

3. **Reply (child-originated).** A child answers a question by sending
   `shepherd_message` with `replyTo` to `shepherd`. The parent resolves the
   matching pending request (clears it + `waiting → running`) and **relays**
   the reply to the original sender's child inbox with a fresh `messageId`
   (provenance preserved: `senderId` stays the replier's agent id). If no
   matching request exists the reply is surfaced to the parent as a notification.

4. **Parent-originated.** `shepherd_message` tool → `publishFromParent` to the
   target child inbox. If `expectsReply` + `taskId`, the parent also opens a
   pending request on that task (parent can expect a reply from a delegated
   agent the same way).

5. **Reply deadline.** Each pending request stores `deadlineAt` (settings
   `timeout` minutes). The existing parent monitor settles expired request
   owners as `blocked` (initial task policy).

6. **Parent notifications.** Child→parent `message`/`reply` are delivered to
   the parent pi session as custom messages (`shepherd.message.incoming` /
   `.reply`) with followUp delivery, reusing the prompt-completion
   renderer/bridge pattern. No fieldnote is created.

7. **Delivered vs accepted.** `accepted` = the broker accepted the envelope
   into the target inbox. It never means the recipient read it or replied.

## Envelope contract (Phase 6 usage)

- `message` → normal conversational content to a target.
- `reply` → `replyTo` set; answers a tracked question.
- `task` / `task_done` → existing (Phase 4/5).
- `runtime` with `taskId` + `expectsReply: true` + `requestOpen: true` →
  child mirrors that it opened a tracked request (parent sets task to waiting).
  `requestOpen` is a boolean field (envelope-validated).

## Explicit Phase-6 scope (initial)

- Parent `shepherd_message` tool + request/task integration.
- Parent inbox routing: message/reply → parent session; runtime request-open →
  task waiting; reply → resolve + relay.
- Child mirrors request-open; child already delivers incoming to its inbox.
- Reply deadline + blocked settlement.
- `test/verify-message-routing.mjs` + schema/contract updates.

Deferred to later phases: child-side `replyTo` UX polish, thread id routing,
stale-wait (Phase 8), task-aware watchers (Phase 7), direct child-to-child
"question to a busy peer" as first-class (transport already supports the
relay; the request-tracking path targets the parent as the hub).
