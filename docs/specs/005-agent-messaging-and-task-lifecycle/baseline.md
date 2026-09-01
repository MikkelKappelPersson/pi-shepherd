# Phase 0 Baseline

This baseline was captured before implementing the tracked-task and messaging
runtime. It records the current behavior that Phase 1+ work must preserve or
replace explicitly.

## Repository and test baseline

- Branch: `feat/005-agent-messaging-and-task-lifecycle`
- Package version: `0.1.7`
- Runtime: TypeScript executed directly by Node; no build step.
- Full baseline command: `npm test`
- Baseline result: all existing test commands passed.

The baseline suite currently covers:

```text
schemas
CLI behavior
parent surface
status widget
command UX
discovery
launch argument construction
effective prompts
registry behavior
multi-wait behavior
prompt watchers
artifact sessions
settings
```

Phase 0 adds `phase0:test` to this suite for reusable fixtures and lifecycle
boundary assertions.

## Current parent tool surface

`registerShepherdTools()` currently registers eight parent tools, in this order:

```text
shepherd
shepherd_spawn
shepherd_prompt
shepherd_wait
shepherd_watch
shepherd_status
shepherd_close
shepherd_read
```

The parent also registers the `/shepherd` command. Parent registration is
skipped when `PI_SHEPHERD_SESSION` is present, so launched children do not
inherit the parent Shepherd tools or command.

## Current child surface

Launched children receive `src/extension/shepherd-done.ts` as their Shepherd
extension. The current child extension:

- applies the delegated system-prompt replacement and Pi-documentation
  filtering;
- observes `agent_end`;
- writes a `<session>.exit` completion sidecar for normal assistant turns;
- reports provider errors through that sidecar; and
- shuts down one-shot children after a normal turn unless stay-open behavior is
  enabled.

It does not currently expose `shepherd_message` or `shepherd_done`.

## Current lifecycle behavior

The current registry contains opaque session-scoped agent and prompt IDs. It
supports one unresolved prompt per agent and prompt watchers.

The current prompt watcher polls Herdr and may settle a prompt from:

- a new completion sidecar;
- a detected provider error; or
- a post-submission Herdr state transition to `idle`, `done`, or `blocked`.

That behavior is retained as legacy prompt behavior during Phase 0. It must not
be copied into the future tracked-task path. In particular:

```text
agent process becomes idle != delegated task completed
agent_end != delegated task completed
agent_settled != delegated task completed
```

The new task path will require `shepherd_done` or an explicit failure,
cancellation, or timeout event.

## Current artifact behavior

When fieldnotes are enabled, a prompt can reserve an artifact from the parent
Shepherd session. The artifact is started before prompt submission and
finalized when the prompt settles. The future implementation must move this
association to delegated task records and keep task artifacts open while a task
is waiting.

## Phase 0 guardrails added

- `test/helpers/test-utils.mjs` provides isolated temporary directories,
  stable fake parent/child identities, and microtask flushing.
- `test/helpers/fake-clock.mjs` provides a manual clock and a scoped
  `Date.now()` override for legacy code that cannot yet receive an injected
  clock.
- `test/helpers/feature-contracts.mjs` centralizes planned tool, surface, and
  task-state contracts for later phase tests without registering future tools.
- `test/verify-phase0.mjs` verifies fixture behavior and that changing an
  agent's observed state to idle does not settle an open registry record.
- `src/core/orchestration.ts` documents that observed agent state and explicit
  lifecycle settlement are separate concerns.
- `src/core/lifecycle.ts` documents that idle/done inference is legacy prompt
  behavior and is not valid for tracked tasks.
