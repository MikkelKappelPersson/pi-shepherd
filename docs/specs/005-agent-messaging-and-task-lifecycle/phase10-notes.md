# Phase 10 — Artifacts, cleanup, compatibility, and documentation (design notes)

Phase 10 closes the feature by (a) confirming the artifact lifecycle follows
task settlement, (b) confirming shutdown/cleanup behavior, (c) making the
explicit compatibility decisions for `shepherd_prompt` and `shepherd_wait`,
and (d) updating the active documentation.

## Artifacts

Delegate-time allocation was already in place from Phase 4: `delegateAgent`
reserves exactly one artifact per delegated task (mode `single`, task text
attached), marks it `running` with the taskId, and attaches a finalizer via
`attachTaskArtifact`. Ordinary messages never allocate artifacts — only
`delegateAgent` calls `reserveArtifacts`, so a `shepherd_message` cannot
create a note. "Open while waiting" is free because the note stays
`running` (only the frontmatter status changes; agents append freely) and
`settleTask` is the single authoritative finalization point:

- completed -> `completed`
- blocked (reply deadline, parent failure, ...) -> `failed`
- failed -> `failed`
- cancelled (close/cancel) -> `cancelled`
- timed_out -> `timed-out`

`settleTask` guards duplicate settlement (`if (record.settled) return
record.result!`), so repeated `shepherd_done`/reply/timeout/cancellation
events cannot double-finalize; `onSettled` runs exactly once and is wrapped
so an artifact failure never breaks task settlement. Final summaries
(`result.text`) and errors (`result.error`) are preserved in the note's
"## Shepherd orchestration" section, so "preserve final summaries and
errors" holds. Useful request/message references: the finalizer metadata
carries only the taskId (one note per task, not per chat — messages that
are correlated with a task use the task's artifact, not a new one).

Verified by `verify-delegate.mjs` (allocation + start + cancel finalization)
and `verify-artifact-sessions.mjs` (all four terminal artifact statuses +
final output/error sections + in-memory mirroring).

## Cleanup and shutdown

All of the following were already implemented in Phases 4–8:

- parent shutdown: `shutdownParentBroker` stops the parent mailbox poll and,
  via `stopParentBrokerMonitor`, the stale-wait monitor;
- child shutdown: the child surface (`shepherd-done.ts`) closes its own
  broker channel on session end;
- persisted task outcomes survive parent shutdown because they are on-disk
  (session.json + note files);
- a closing agent cancels its active task (`registry.close()` ->
  `cancelTask()`, rc 130) and the task settlement clears its pending
  requests; duplicate events are idempotent (settleTask guard);
- created-pane ownership protects foreign panes (existing invariant,
  verified by the launch suite); mailbox consumption is parent-only
  (broker capability is parent-scoped; children get a child capability).

No new cleanup code was required in Phase 10; these behaviors are pinned by
existing tests plus the compat suite's "timeout never touches the task"
check.

## Compatibility decisions

`shepherd_prompt`
  RETAINED, DEPRECATED. Fire-and-forget one-turn submission stays available so
  existing transcripts/templates keep working, but every model-facing field
  (label, description, promptSnippet, message parameter) now states it is a
  deprecated compatibility path and names the migration target
  (`shepherd_delegate` + `shepherd_watch`). Its one-turn completion semantics
  are unchanged and documented, so they are not "silently active": the docs
  say exactly what it does and what to use instead.

`shepherd_wait`
  RETAINED, UPGRADED to be task-aware. It now accepts task ids (preferred) or
  legacy prompt ids (unchanged path); mixing them in one call is rejected,
  mirroring shepherd_watch. Task waits:
    - resolve via the task-watcher registry hook (no polling), in input order
      including for tasks that settle out of order;
    - resolve instantly for already-settled tasks;
    - a wait timeout is a wait-level timeout: it rejects with
      LifecycleError('timeout', ...) and removes the watcher. The underlying
      tasks keep running (their own deadlines remain authoritative) and the
      error message points the model at shepherd_watch.
  No task or message depends on the parent calling shepherd_wait; the tool
  description says shepherd_watch is preferred for new orchestration.

Implementation: `LifecycleRegistry.waitForTasks(handles, timeoutMs)` plus a
public `removeWatcher(watcherId)`; `watchTasks` additionally delivers
already-settled tasks synchronously in input order (Set-callback form, used by
waitForTasks) while keeping the legacy single-callback contract intact.

Verification: `test/verify-compat.mjs` (descriptions/pointers, schema
accepts both id kinds with flat-object root, in-order resolution, instant
already-settled, timeout leaves the task untouched, unknown-id rejection,
doAction public task mapping with returnCode).

## Documentation

- README: new "Task delegation workflow" section (delegate ->
  message/watch -> done, with a delegate+watch example and a child-to-child
  message example), the task/message id explanation, idle-child-with-waiting-
  task behavior, followUp vs steer, stale-wait reminders, and explicit
  compatibility status for shepherd_prompt/shepherd_wait.
- docs/guides/tool-reference.md: delegate/message/done tools added;
  prompt/wait/watch rows updated to reflect deprecation, task ids, and
  mixing rules.
- docs/reference/dictionary: entries for task, task id, message, message id,
  request/reply correlation, waiting tasks (idle child), and the deprecated
  tools.
- docs/plans/architecture.md: task/message surface and broker added; the
  "completed implementation" list now lists the tracked-task primitives.
