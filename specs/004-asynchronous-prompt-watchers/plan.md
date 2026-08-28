# Implementation Plan: Non-blocking Shepherd Prompt Watchers

This plan implements `spec.md` by adding a background completion observer and a
parent notification bridge. The existing `shepherd_wait` implementation and
public behavior remain unchanged.

## Target architecture

```text
shepherd_prompt
      │
      ▼
existing PromptRecord
      │
      ├── shepherd_wait (existing blocking consumer)
      │
      └── shepherd_watch
             │
             ▼
      watcher registry + background monitor
             │
             ├── settle existing prompt result
             ├── buffer/deduplicate completion
             └── notify parent via callback
                              │
                              ▼
                         pi.sendMessage
                         followUp + triggerTurn
```

## Design decisions

1. **Prompt-level identity** — watchers accept prompt ids, not agent ids. A
   persistent agent can receive multiple prompts, so an agent-level watcher
   would be ambiguous.
2. **Immediate registration** — `shepherd_watch` returns an acknowledgment and
   never awaits child completion. The eventual completion is a custom parent
   message, not a delayed return from the original tool call.
3. **Result shape** — the registration response includes `watcherId`, the
   normalized prompt ids, pending ids, and already-completed structured results.
   Completion notifications include prompt id, agent id, status, return code,
   error, and the last assistant message.
4. **One-shot watchers** — each watched prompt is delivered once per watcher.
   A watcher automatically finishes when all its prompts settle. `unwatch`
   removes delivery interest but does not cancel prompt execution.
5. **Existing wait remains authoritative for its callers** — do not modify the
   `shepherd_wait` tool, its schemas, its public result format, or its current
   timeout/cancellation semantics. Watcher observation may settle the shared
   prompt record idempotently so a simultaneous wait sees the same result.
6. **Narrow notification boundary** — core code receives an injected callback
   for parent notifications. It does not import or access a global `pi` object.
7. **Follow-up delivery** — use a custom Shepherd message with follow-up
   delivery. Queue while the parent is active and trigger a new turn when the
   parent is idle.
8. **Burst coalescing** — report individual completions as they arrive, but
   coalesce completions observed in a short window into one parent message when
   possible.

## Phase 1 — Define watcher state and protocol

Add internal watcher types and registry operations without changing existing
wait types:

- watcher handle and watcher result types;
- watcher records with prompt ids, delivery state, and lifecycle state;
- prompt-to-watcher indexes;
- registration, lookup, completion, and unwatch operations;
- normalization and validation for one id or an array of ids.

The existing prompt result type should be reused for completed entries wherever
possible. No Herdr pane id should be part of the public watcher protocol.

## Phase 2 — Add background observation

Implement a monitor that starts only when a watcher is registered:

- inspect all active watched prompts from one parent session;
- use the existing completion sidecar, state sequence, result file, and
  provider-error detection rules;
- handle prompts already settled before registration;
- settle the existing prompt record exactly once;
- notify watcher records after settlement;
- deduplicate polling and completion delivery;
- stop the monitor when no active watched prompts remain.

The monitor must not leave the `shepherd_watch` tool execution pending. It may
share low-level read helpers with wait, but must not change wait's code path or
external semantics.

## Phase 3 — Add parent notification bridge

At tool registration time, provide the watcher service with a narrow callback
that sends a custom message through the current parent `ExtensionAPI`:

- create a structured Shepherd completion message;
- include the watcher id, prompt id(s), agent id(s), labels, statuses, return
  codes, errors, and final assistant text;
- use follow-up delivery so an active parent turn is not interrupted;
- trigger a parent turn when the parent is idle;
- coalesce close-together completions;
- suppress new turns during shutdown/reload.

The core service should continue buffering results even if message delivery is
unavailable or fails. Message delivery failure must not corrupt prompt
settlement or fieldnote finalization.

## Phase 4 — Register tools and integrate guidance

Add `shepherd_watch` and `shepherd_unwatch` to the extension surface:

- declare all tool metadata directly in each `pi.registerTool` call;
- use the existing public result formatting and opaque-id conventions;
- add watcher descriptions and guidance to the umbrella tool;
- keep the array input shape aligned with `shepherd_wait`;
- expose registration and completion details without exposing raw Herdr ids.

Update README/lifecycle examples to show both explicit blocking waits and
non-blocking watch-based workflows.

## Phase 5 — Resource and session boundaries

Ensure watcher state is bounded to the parent extension session:

- clean active monitors at `session_shutdown`;
- remove watcher registrations on reload/session replacement;
- do not close child panes as part of unwatch or watcher completion;
- retain existing child result files and fieldnotes;
- avoid duplicate monitors after reload or repeated registration;
- ensure completion after an unwatch is still available to `shepherd_wait`.

## Phase 6 — Verification and rollout

Add focused registry, notification, and tool-schema tests, then run the full
suite. Perform live Herdr checks with one and multiple prompts, including
completion while the parent is active and completion while it is idle.

After all checks pass, update the implementation status in the specification
and add a completed-watcher entry to the repository's documentation index if
one exists.
