# Phase 8 — Stale-wait monitoring (design notes)

Phase 8 adds a *non-invasive* nudge for a tracked task that is sitting in the
`waiting` state — i.e. waiting on a required reply that has not yet arrived —
for longer than a configurable threshold. It never settles a task; it only
informs the parent that something has been waiting a long time.

## What counts as "stale"

A task is stale when **all** of these hold:

1. `task.state === 'waiting'` — the task has entered the `waiting` state.
2. `task.pendingReplyMessageId` is set — there is a specifically expected reply
   (an `expectsReply` question, or a child mirror of one). A task that is
   `waiting` for any other reason (a bare `agent_end`, a manual `setTaskWaiting`
   with no outstanding reply) is *not* stale by definition, because there is no
   reply to time out.
3. `now - task.waitingSince >= staleWaitThreshold` (minutes, from settings).
4. `task.staleNotifiedAt` is unset — the monitor has not yet nudged for this
   waiting episode.

`waitingSince` is the timestamp the task entered `waiting` (set in
`setTaskWaiting` / `openPendingRequest`). The stale condition is evaluated on
the *task* record, not on the raw Herdr agent state, so an agent that is merely
idle but owns no waiting task never triggers a stale reminder. A completed,
failed, cancelled, or blocked task has already left the set of `waiting`
records and therefore never produces one.

## One notification per episode

Stale delivery is idempotent per *episode* (a single contiguous wait), not per
poll. `markStaleNotified(taskId)` stamps `task.staleNotifiedAt` the moment the
monitor emits a reminder; the monitor skips a task whenever the flag is present.
The flag is cleared at every state transition that ends or re-opens a wait:

- `setTaskRunning` (a resume) — clears `staleNotifiedAt`.
- `resolvePendingRequest` / `resolveReplyForTask` (a reply arrived) — clears it.
- `settleTask` (any terminal outcome) — the task leaves the `waiting` set.

Because a *reply* is normally the event that ends a stale wait, the practical
effect is: one reminder, then a reply (or a manual resume / settle) resets the
state. If the same task re-enters `waiting` with a new reply later, it is a new
episode and is entitled to its own reminder. This is exactly the exit-gate
property: "a reply clears the stale condition."

## Setting: `staleWaitThreshold`

`src/extension/config.ts`:

- Stored in **minutes**, like `timeout`.
- Default `5`. `0` (and negative) is a valid way to *disable* reminders
  entirely; the UI exposes this as the `off (no reminders)` choice.
- `validField` treats `0` as a real value (unlike `timeout`, where `0`/invalid
  means "fall back to the default"), so a user can deliberately turn the
  feature off.
- In the monitor, a effective threshold `< 1` minute short-circuits the poll:
  no reminder is ever emitted and the monitor stops itself.

It lives in both the user layer and the project delta (it is an
`OverridableField`), appears in the `/shepherd settings` menu, and is
documented in the README settings table with a dedicated "Stale-wait
reminders" section.

## The monitor (`StaleWaitMonitor` in `lifecycle.ts`)

A self-managing timer that:

- **Starts** (`kick()`) only when a task opens a pending reply — the two call
  sites are `sendParentMessage` (`expectsReply` + task id) and the child
  `runtime` mirror in `applyMessageEnvelope`. Both mean the task just entered
  `waiting` on an expected reply.
- **Polls** at 1s (unref'd — it never keeps the process alive) and inspects
  *task* state.
- **Stops** itself (`maybeStop()`) as soon as no `waiting` task remains; that
  also covers shutdown via `stopParentBrokerMonitor` →
  `shutdownStaleWaitMonitor()`.
- Emits **at most one** `StaleWaitInfo` per episode through
  `configureStaleWaitNotifications`.

`StaleWaitInfo` carries the full context the parent needs to decide what to do:
`taskId`, `agentId`/display name, `description`, `waitingSince`, `elapsedMs`,
the `requestMessageId` being waited on, the `question`, the `recipientId` +
resolved `recipientName` and the recipient's own lifecycle `recipientState`, and
the applied `thresholdMinutes`.

## Parent delivery (`src/extension/shepherd.ts`)

A new `shepherd.stale.wait` custom message + renderer. It is delivered with
`deliverAs: 'followUp'` and **`triggerTurn: false`**.

That is the deliberate "no wake-up" policy: a stale wait is *information*, not a
decision point that needs an immediate parent turn. Forcing a turn here would
(i) wake the parent on every normal long wait and (ii) risk a notification
storm if several tasks went stale together or the parent were busy. The parent
sees the reminder in its next turn and can choose to nudge the recipient with
`shepherd_message`, or simply wait for the reply (or for the reply *deadline*
to settle the task as `blocked`). The body even lists those possible actions.

The reminder never mutates task state; the reply deadline (Phase 6) remains the
only authoritative mechanism that turns a stale wait into `blocked`.

## Compatibility / invariants preserved

- The Phase 5 invariant is untouched: only `shepherd_done` (or an explicit
  failure/cancellation/timeout) settles a tracked task. A stale reminder is a
  pure observation.
- Existing `setTaskRunning` / `resolve*` / `settleTask` behavior is unchanged
  except for clearing the new `staleNotifiedAt` flag.
- The `timeout` reply-deadline path is unchanged; stale-wait is additive.

## Test coverage

`test/verify-stale-wait.mjs` uses the fake-clock helper to drive time
deterministically and asserts:

- No notification below the threshold; exactly one once crossed.
- No second notification while the episode remains open (no storm).
- Full notification content (task, owner, description, question, request id,
  recipient id + state, elapsed time, threshold).
- A reply clears the episode; a *new* episode re-notifies.
- A completed task and an idle agent with no waiting task produce nothing.
- Stale-wait does **not** settle the task (it stays `waiting`); the reply
  deadline is what settles it to `blocked`.
- The monitor starts only while a waiting task exists and stops when none remain.
- A disabled (`0`) threshold produces no notification.
- Bridge delivery is a follow-up with `triggerTurn: false`, and is suppressed
  once the parent session goes inactive.
