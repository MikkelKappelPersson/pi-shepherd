# Phase 9 — Status and TUI integration (design notes)

Phase 9 makes the *status surface* aware that a pi-shepherd agent now tracks
two independent dimensions: the **Herdr process state** (`working` /
`idle` / `done` / …) and the **tracked task state** (`created` / `running` /
`waiting` / terminal). The critical interaction: a child whose process is
`idle` may own a task that is `waiting` on a required reply — and vice versa.
Reporting only the process state (the pre-Phase 9 behavior) made in-flight
work invisible exactly when the child was parked.

## Status model

`AgentStatus` (`src/core/orchestration.ts`) gained an optional `task`
(`AgentTaskStatus`) alongside the process-level `state`. The view is produced
by a new `LifecycleRegistry.taskStatusForAgent(record)` which:

- returns `undefined` when the agent owns no open task (a settled task is not
  "active" and is dropped — an intentional status semantics, not an error);
- surfaces `id`, `state`, `description`, and only the *applicable* optional
  fields: `waitingSince` / `waitingMs` (age of the current `waiting` episode),
  `pendingRequestMessageId` (the expected reply), `waitingRecipient` (the
  display name of the agent the reply is expected from), and `stale` (true
  once the Phase 8 monitor has reminded for this episode).
- never touches Herdr; everything is in-memory registry state, so
  `shepherd_status` and the widget poll can both call it cheaply.

`registry.status()` now includes the task view; `statusAgent()` (lifecycle)
still resolves live process state from the pane when one exists, but the task
view comes from the registry in either path.

The `status` doAction case in `src/extension/shepherd.ts` maps that into a
compact **public** result:

```json
{
  "id": "shepherd-agent-…",
  "state": "idle",
  "task": {
    "id": "shepherd-task-…",
    "state": "waiting",
    "waitingMs": 423120,
    "pendingRequest": "shepherd-message-…",
    "waitingOn": "planner: rollout-planner",
    "stale": true
  }
}
```

and the summary text names both dimensions: `agent idle; task
shepherd-task-… waiting.` Opaque agent/task ids are passed through verbatim;
Herdr pane ids stay internal diagnostics (they are only present on the
`AgentStatus` shape, not on the public `status` result or the rendered
output).

## Status widget projection

`src/core/herdr.ts`:

- `activeTasksByPane()` maps paneId → active task (registry read only).
- `workingOrWaitingSubagents()` extends the old `workingSubagents()` filter:
  an owned pane is listed when `state !== "idle"` **or** the pane's agent
  owns an open task. This is the "do not filter waiting tasks out because the
  process is idle" rule. `workingSubagents()` is retained as a working-only
  projection; the widget uses the new query. Session-ownership filtering
  (`paneOwner === sessionOwner`) is unchanged, so foreign sessions' panes are
  still excluded.

`index.ts` (the widget):

- the per-second snapshot now attaches each row's `task` view;
- the header counts both dimensions: `N working · N waiting`;
- while a task is open the **task state** wins the right-hand label: a working
  process with a `waiting` task renders `waiting`, not `working` (the process
  is churning but the *work* is blocked);
- waiting rows append ` ⏳<minutes>m ←<recipient>` (elapsed wait + who still
  has to answer). `stateIcon` renders them with the existing waiting glyph,
  and a stale episode renders `waiting (stale)`.
- pane ids and opaque task ids are never painted into rows; only display
  names, state labels, and the wait marker appear. Polling cadence is
  unchanged (the 1s unref'd interval + sheep-animation interval); the task
  overlay adds no new I/O.

## Tests

- `test/verify-status.mjs` (new): process/task independence (idle+waiting,
  working+running, no-task), waiting fields (age, pending request,
  recipient, stale flag and its clearing on reply), completed-task removal
  from the view, and the public `doAction('status')` mapping (opaque ids
  only, no pane leakage, dual-state summary text).
- `test/verify-status-widget.mjs` (extended): three snapshot phases over a
  fake Herdr with one working pane (plain), one working pane with a running
  task, one idle pane with a waiting+stale task, and a foreign working pane.
  Phase 1/2 cover crash regression, cwd-driven emojiSheep (🐑 vs plain),
  session-ownership filtering, pane-id opacity, and row-width fit. Phase 3
  settles the waiting task and asserts the idle pane drops out of the widget.

## Invariants

- Phase 5 completion invariant untouched: status is a pure read; nothing here
  settles or mutates tasks.
- Idle ≠ done: an idle process with a waiting task remains visible in every
  status surface (exit gate: "an idle waiting scout remains visible").
- No new mailbox reads per render frame; the widget only ever reads the
  in-memory registry plus the existing Herdr `agent list` snapshot.
