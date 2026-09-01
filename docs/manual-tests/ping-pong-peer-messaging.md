# Manual test: ping-pong peer messaging

Use this smoke test to verify that two live Shepherd children can exchange a
correlated request and reply, resume the requester, and complete through
`shepherd_done`.

## Preconditions

- Run inside a live Herdr-managed Shepherd session.
- Reload the extension after changing the implementation.
- Use visible child panes (`pane_right` and `pane_down`) when possible.
- Use generous task deadlines; provider startup can take more than a minute.
- Do **not** use the removed blocking `shepherd_wait` operation.

## Procedure

### 1. Spawn the children

Spawn a planner and a worker, recording the opaque agent IDs returned by each
call:

```json
{"agent":"planner","label":"manual planner","placement":"pane_right"}
{"agent":"worker","label":"manual worker","placement":"pane_down"}
```

Do not substitute display names, Herdr pane IDs, or agent-kind names for the
returned lifecycle IDs.

### 2. Delegate the planner task

Use the planner's returned agent ID and a deadline of at least 10 minutes:

> Watch for one incoming peer request. When you receive it, reply to the exact
> `replyTo` using `shepherd_message`, omit `taskId` so it is inferred, then call
> `shepherd_done` with text `planner replied`. Do not use `shepherd_wait`.

Record the returned planner task ID.

### 3. Delegate the worker task

Use the worker's returned agent ID and the planner's opaque agent ID:

> Send planner a peer request using `shepherd_message`: target `<planner agent
> ID>`, message `Reply with exactly pong`, `expectsReply: true`. Wait for the
> reply using normal turns (never `shepherd_wait`), then call `shepherd_done`
> with text containing the reply. Do not call `shepherd_wait`.

Record the returned worker task ID.

### 4. Register non-blocking watchers

Register a watcher for both task IDs:

```json
{"id":["<planner task ID>","<worker task ID>"]}
```

The call must return immediately with both tasks in `pending`. Use
`shepherd_status` periodically to inspect intermediate state; do not block the
Shepherd turn waiting for completion.

Expected intermediate behavior:

- Planner may become idle while its task remains active until it receives the
  request.
- Worker enters `waiting` after sending the request.
- Planner replies with `pong` using the request's exact `replyTo`; omitting
  `taskId` exercises child-side task-ID inference.
- Worker resumes and calls `shepherd_done`.

If a watcher was already consumed or completed, register a fresh watcher using
the task ID. A watcher ID itself is not a valid `shepherd_watch` target.

### 5. Verify terminal results

Watch each task ID again, or use the follow-up completion notification. Both
results must contain:

```text
status: completed
ok: true
returnCode: 0
```

The worker result text should contain:

```text
Planner reply: pong
```

The planner result should contain:

```text
planner replied
```

### 6. Clean up

Only after both tasks are terminal, close both agents using their opaque agent
IDs. Do not close an agent while its watcher is still pending.

## Pass criteria

The test passes when:

1. Both children launch in visible panes.
2. The worker request reaches the planner.
3. The planner's correlated reply reaches the worker.
4. The worker resumes without a redundant acknowledgment step.
5. Both tasks settle as `completed` with return code `0`.
6. `shepherd_watch` reports both terminal results.
7. Both agents close cleanly afterward.

## Failure notes

- `Agent pane disappeared before the task completed` means the live lifecycle
  test failed; do not count it as a pass even if a response later appears.
- A short deadline may expire during provider startup. Retry with 10 minutes or
  more before diagnosing messaging behavior.
- If the child appears idle, inspect `shepherd_status`: idle process state does
  not necessarily mean the tracked task is complete.
- If a reply is rejected, verify that `replyTo` is the exact incoming request
  message ID and that any explicit `taskId` is the requester's task ID, not the
  responder's task ID.
- The large `artifactSession` object in a watcher result includes historical
  session artifacts. Use the top-level task result for current status.

## Recorded successful run

The reloaded-extension run on 2026-09-01 succeeded with:

- Planner result: `completed`, `ok: true`, `returnCode: 0`, `planner replied`
- Worker result: `completed`, `ok: true`, `returnCode: 0`, `Planner reply: pong`
- Completion observation: `shepherd_watch`
- Cleanup: both agents closed after terminal completion
