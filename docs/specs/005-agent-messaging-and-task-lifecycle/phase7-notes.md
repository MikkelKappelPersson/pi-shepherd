# Phase 7 — Task-aware `shepherd_watch` (design notes)

Phase 7 makes `shepherd_watch` observe **tracked tasks** rather than individual
Pi turns. `shepherd_wait` and the legacy prompt watcher remain for
prompt-based flows, but new orchestration uses tasks.

## Core idea

Tasks settle only from explicit lifecycle events (a child calling
`shepherd_done`, or an explicit failure / cancellation / timeout). Because that
settlement always flows through `LifecycleRegistry.settleTask()`, the registry
already has a single, authoritative settlement point. The task watcher hooks
into *that* point instead of polling:

- `LifecycleRegistry.watchTasks(handles, callback)` registers a one-shot
  observer for task ids. Synchronous, like `watchPrompts`: an already-settled
  task is returned in `completed` immediately, pending tasks are tracked.
- `LifecycleRegistry.settleTask()` now, after writing the durable result,
  notifies each registered task watcher **exactly once** for that task id
  (mirroring how `settlePrompt` notifies prompt watchers). The callback is
  wrapped in try/catch so a broken notifier can never affect settlement.
- A `TaskWatcherService` (in `lifecycle.ts`) wraps the registry: it coalesces
  up to `coalesceMs` (25 ms) of completions per watcher and delivers one
  `TaskWatcherNotification`, sorting coalesced completions into the caller's
  input order. The flush timer is `unref()`'d, and `shutdown()` clears timers
  + registry registrations.

There is **no polling and no interval**: unlike `PromptWatcherService`
(which shells out to Herdr every 500 ms to infer prompt completion from
pane/agent state), a task watcher is driven purely by registry settlement.
Idle, `agent_end`, `agent_settled`, and `waiting` never call `settleTask`, so
they can never fire the watcher — the invariant holds by construction.

## Watcher identity / idempotency

The registry stores a `watchers` map keyed by `watcherId`, now generalized
with a `kind: 'prompt' | 'task'` tag, a `taskIds: string[]`, a `pending:
Set<string>`, and a `delivered: Set<string>`. `settleTask` removes the task's
entry from `taskWatchers` immediately after reading its watcher ids, so a task
can never notify the same watcher twice. Per-watcher `pending.size === 0`
removes the watcher from the map. `clearWatchers()` (called on parent
shutdown) drops both prompt and task registrations and indices.

## Dispatch and compatibility

`doAction('watch')` in `src/extension/shepherd.ts`:

1. Collects the id(s) (single or array).
2. Any id that `lifecycleRegistry.isTaskId(id)` accepts is a task; every other
   id must resolve via `getPrompt(id)` or it is rejected with a
   `LifecycleError('invalid_handle')` that names the bad id. Agent ids and
   Herdr pane ids therefore fail with a clear error instead of being silently
   mis-targeted.
3. A call cannot **mix** task ids and prompt ids (ambiguous scope) — it throws.
4. Task ids -> `taskWatcherService.watch(...)`; prompt ids -> the existing
   `promptWatcherService.watch(...)`.

**Chosen compatibility behavior:** `shepherd_watch` **accepts** legacy prompt
ids (the pre-Phase-7 contract) and routes them to the prompt-watcher path.
Prompt ids are **not** re-interpreted as task ids; they continue to use the
prompt lifecycle and its pane/polling semantics. Task ids use the new
task path. This preserves `shepherd_wait`/prompt flows verbatim while adding
the task flow.

## Parent notification bridge

`configureTaskWatcherBridge(pi)` (extension) registers a
`shepherd.task.completion` message renderer and a
`configureTaskWatcherNotifications` handler that, when
`taskWatcherSessionActive` is true, formats the completion with the standard
`call:/return:/details:` layout (call name `shepherd_watch`, argument `id` =
task id or array) and sends a custom message with
`{ deliverAs: 'followUp', triggerTurn: true }`. A terminal task outcome always
triggers a parent turn (the child must then decide the next step), matching
the prompt bridge's policy.

`index.ts` toggles `setTaskWatcherSessionActive` on `session_start`/
`session_shutdown` and calls `shutdownTaskWatchers()` on shutdown so timers are
released and no notification is queued for a session that is gone.

## Test coverage

`test/verify-task-watchers.mjs` (added to the `npm test` chain after
`message-routing:test`):

- Non-blocking registration of a pending task.
- A task entering `waiting` does *not* complete the watcher (the canonical
  "scout waits on a busy planner" property).
- No delivery while running/waiting.
- Completion -> exactly one notification carrying taskId, agentId, status,
  returnCode, agent, label, and summary text.
- Already-settled task returns immediately and is not re-delivered.
- Array of task ids: independent settlement, coalesced in watch input order,
  with correct terminal statuses and return codes (completed 0, blocked 2,
  failed 1, cancelled 130, timed_out 124).
- Cancelled and timed-out tasks report their terminal status/return code.
- Two independent watchers on the same task each observe it exactly once.
- Unknown id and duplicate ids are rejected.
- Extension bridge: one turn-triggering custom follow-up keyed by task id
  (no `promptId`), and delivery is suppressed once the session is deactivated.
