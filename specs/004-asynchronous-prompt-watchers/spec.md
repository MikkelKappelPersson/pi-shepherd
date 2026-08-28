# Non-blocking Shepherd Prompt Watchers

## Status

Proposed specification.

## Summary

Add an asynchronous watcher to pi-shepherd for prompt completions. A watcher
registers interest in one or more existing prompt ids and returns immediately.
When a watched prompt settles, Shepherd stores the result and sends a custom
follow-up message to the parent pi session so the parent model can process the
completion in a later turn.

The watcher is an additional synchronization mechanism. It does not replace,
modify, or change the public behavior of `shepherd_wait`.

The intended workflow is:

```text
spawn
  → prompt
  → watcher registration returns immediately
  → parent turn continues or ends
  → child completes
  → watcher records the result
  → watcher sends a custom follow-up message to the parent
  → parent model processes the completion
```

## Goals

- Allow the parent model to continue while child prompts run.
- Watch one prompt or an array of prompt ids.
- Report each completion with the exact prompt id and persistent agent id.
- Include the child agent's final assistant message in completion notifications.
- Handle prompts that finish before watcher registration without losing results.
- Preserve the existing `shepherd_wait` API and semantics.
- Make watcher completion idempotent and safe when `wait` is also polling.
- Keep watcher lifetime and notification delivery bounded to the parent session.
- Preserve existing fieldnote/artifact finalization through the prompt registry.

## Non-goals

- Do not replace or change `shepherd_wait`.
- Do not add workflow-specific `parallel`, `chain`, or fan-in modes.
- Do not watch by Herdr pane id or infer a prompt from an agent id.
- Do not make watcher registration block until a child completes.
- Do not use a synthetic user message for a Shepherd-generated notification.
- Do not cancel a prompt or close an agent when a watcher is removed.
- Do not automatically close agents when watched prompts complete.
- Do not make watcher notifications depend on the parent calling another
  blocking tool.

## Terminology

### Prompt id

The opaque id returned by `shepherd_prompt`. A watcher observes a specific
prompt invocation, not all future work submitted to an agent.

### Watcher

A one-shot subscription associated with one or more prompt ids. It remains
active until all watched prompts settle, it is explicitly unwatched, or the
parent session shuts down.

### Completion notification

A custom message injected into the parent pi session after one or more watched
prompts settle. It is not the return value of the original watcher tool call.

## Public API

### `shepherd_watch({ id })`

`id` accepts either one opaque prompt id or an array of opaque prompt ids. The
array behavior is completion-oriented rather than wait-oriented: prompts are
reported as they finish, not only after every prompt has completed.

Examples:

```text
shepherd_watch({ id: "shepherd-prompt-a" })
shepherd_watch({ id: ["shepherd-prompt-a", "shepherd-prompt-b"] })
```

The tool returns immediately with a registration acknowledgment. Its result
contains:

- `watcherId`: opaque watcher id;
- `promptIds`: normalized watched prompt ids;
- `pending`: prompt ids not yet settled;
- `completed`: results already available at registration time.

An already-completed prompt must appear in `completed` so a fast completion
cannot be lost between `prompt` and `watch`.

A representative result is:

```json
{
  "watcherId": "shepherd-watch-...",
  "promptIds": ["shepherd-prompt-a", "shepherd-prompt-b"],
  "pending": ["shepherd-prompt-a"],
  "completed": [
    {
      "promptId": "shepherd-prompt-b",
      "agentId": "shepherd-agent-...",
      "status": "done",
      "ok": true,
      "returnCode": 0,
      "text": "The agent's last assistant message."
    }
  ]
}
```

The public Shepherd tool result must continue to use the standard service
message, `call:`, `return:`, and `details:` structure.

### `shepherd_unwatch({ id })`

`id` is an opaque watcher id. Unwatching stops future notifications for that
watcher and releases its monitoring resources. It does not settle, cancel, or
otherwise mutate the underlying prompt. The prompt remains available to
`shepherd_wait` and to any other watcher.

## Completion notifications

When a watched prompt settles, Shepherd sends a custom message through the
parent extension using the equivalent of:

```text
pi.sendMessage(custom Shepherd completion message, {
  deliverAs: "followUp",
  triggerTurn: true
})
```

The notification must be queued as a follow-up rather than interrupting an
active parent tool chain. If the parent is idle, it should trigger a new model
turn. The message should be a custom Shepherd message, not a normal user
message.

Each notification includes:

- `watcherId`;
- `promptId`;
- `agentId`;
- agent name and label when available;
- terminal status;
- `ok` and process-style `returnCode`;
- error information for failed, blocked, timed-out, or cancelled prompts; and
- `text`, containing the last assistant message when available.

The prompt id is the primary correlation key because one persistent agent may
receive several prompts over its lifetime. Herdr pane ids must not be exposed
as watcher correlation ids.

For an array watcher, completions should be delivered independently as they
arrive. Completions occurring close together may be coalesced into one custom
message containing an array of completion results to avoid triggering one
parent turn per child.

## Lifecycle and correctness

- A watcher is one-shot. Each watched prompt produces at most one notification
  per watcher.
- Registering a watcher for an already-settled prompt returns that result in
  the immediate `completed` collection and must not produce a duplicate event.
- Multiple watchers may observe the same prompt. Each watcher has independent
  delivery state, while prompt settlement remains globally idempotent.
- A watcher may settle the existing prompt record using the existing lifecycle
  settlement path. If `shepherd_wait` is also active, its promise resolves with
  the same result and duplicate settlement is ignored.
- The final result remains stored in the prompt registry. Notifications are a
  delivery mechanism, not the only copy of the result.
- Existing completion signals, state transitions, result files, and provider
  error handling should be reused. The watcher must apply the same safeguards
  against pre-submit idle state and stale completion signals.
- Successful, failed, blocked, timed-out, and close-cancelled prompts all
  produce terminal watcher results.
- Watchers and monitor timers are released after completion, unwatch, or parent
  session shutdown.
- The watcher must not delete child session files, fieldnotes, or other
  existing retained lifecycle resources.
- When the parent is shutting down or reloading, no new parent turn should be
  triggered. Active watcher resources must still be cleaned up safely.

## Integration boundaries

The watcher service may live in the core lifecycle/orchestration layer, but it
must not directly depend on a global pi singleton. The extension registration
layer should provide a narrow notification callback backed by `pi.sendMessage`.

The watcher may use the existing `LifecycleRegistry` prompt records and
settlement callbacks. It must not repurpose `LifecycleRegistry.sessionId` or
change public lifecycle id validation.

The parent extension owns message delivery policy. Core watcher state owns
prompt observation, result buffering, deduplication, and cleanup.

## Verification requirements

The implementation is complete only when focused unit tests and live Herdr
checks verify single and array watchers, fast completions, notification
queuing, completion ordering, failure states, duplicate observation, unwatch
semantics, and parent session cleanup. `npm test` must pass.
