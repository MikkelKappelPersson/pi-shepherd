# Shepherd Tool Rendering and TUI States

## Status

Draft specification — `shepherd_spawn` is the first implementation target.

## Summary

Define a consistent user-facing rendering approach for Shepherd tools without
changing the model-facing lifecycle protocol. Shepherd tool rows should present
compact, human-readable status in the normal TUI view, while preserving the
structured `call` / `return` / `details` representation for the model, API
consumers, and expanded/debug views.

The first implementation applies this approach to `shepherd_spawn`:

```text
shepherd_spawn worker · code review · pane_right
spawning…
```

On completion:

```text
shepherd_spawn worker · code review · pane_right
✓ success
```

On failure:

```text
shepherd_spawn worker · code review · tab
✗ failed · Unknown agent "worker" in user scope. No agents are available.
```

## Problem

The model and the human operator need different representations of a tool
result.

The model needs opaque lifecycle identifiers and structured return information
so it can make follow-up calls such as `shepherd_delegate`,
`shepherd_status`, and `shepherd_close`. A human normally does not need to see
those identifiers, serialized arguments, fieldnote paths, or return metadata in
the default TUI view.

Previously, Shepherd rendered the complete protocol result as the primary TUI
output. This caused several problems:

- the call row and result row repeated the same agent and label information;
- successful output was too verbose for routine use;
- errors could appear with success styling because Shepherd returned a normal
  result containing `returnCode: 1` instead of throwing;
- Pi's native error background was not activated;
- partial startup state was not visible while the child pane was being created.

## Goals

- Keep the normal TUI row compact and useful to a human operator.
- Make the call row identify the requested operation and its important inputs.
- Render explicit partial, success, and failure states.
- Use Pi's native error state and `toolErrorBg` for failed tool execution.
- Keep opaque IDs and protocol details available to the model.
- Keep full protocol details available when the human expands a tool row.
- Avoid duplicating call arguments in the normal result line.
- Establish a pattern that can be reused by all Shepherd lifecycle tools.

## Non-goals

- Do not remove opaque IDs from model-visible tool results.
- Do not change lifecycle semantics, result schemas, or ownership rules.
- Do not expose Herdr pane IDs in the human-facing summary.
- Do not make the TUI renderer the source of truth for lifecycle state.
- Do not replace Pi's default tool shell with a custom shell unless the default
  shell cannot represent the required state.

## Audience boundaries

Shepherd has two output audiences:

### Model/API-facing output

The tool result content and structured details must continue to contain the
information needed for orchestration. For a successful spawn this includes the
opaque agent ID, agent name, label, model, and fieldnote information where
applicable.

The protocol representation remains structured and may look like:

```text
shepherd_spawn spawned worker: code review

call:
    shepherd_spawn {"agent":"worker","label":"code review"}

return:
    {"id":"shepherd-agent-...","agent":"worker","label":"code review"}

details:
    agent id: shepherd-agent-...
    agent fieldnote: .shepherd/sessions/...
    return code: 0
```

### Human TUI output

The default view should show only the information needed to understand what
is happening:

- the operation name;
- the relevant invocation summary;
- a short status;
- an actionable error message when execution fails.

Opaque IDs, model names, fieldnotes, serialized arguments, and return metadata
belong in the model/API result and the expanded/debug view unless a future UX
requirement explicitly says otherwise.

## Rendering contract

Pi provides two renderer slots:

- `renderCall(args, theme, context)` renders the invocation row;
- `renderResult(result, { expanded, isPartial }, theme, context)` renders the
  result row.

The default Pi tool shell supplies the background. It derives the shell state
from the execution result:

- partial execution → `toolPendingBg`;
- successful execution → `toolSuccessBg`;
- thrown execution error → `toolErrorBg`.

Therefore, Shepherd must throw execution failures rather than return an
ordinary result with an error-looking `details` object. Returning
`returnCode: 1` alone does not set Pi's `isError` state.

## `shepherd_spawn` rendering

### `renderCall`

The call row is the concise invocation preview. It should render:

```text
shepherd_spawn <agent> · <label> · <placement>
```

Rules:

- always show `shepherd_spawn` and the agent name;
- show the label when present;
- show placement when explicitly provided;
- omit absent optional values rather than printing placeholders;
- use the operation/title theme for the tool name, accent styling for the
  agent, and dim styling for optional context;
- do not show opaque IDs in the call row.

Example:

```text
shepherd_spawn worker · code review · pane_right
```

### Partial result

While `startAgent()` is creating and preparing the child pane, the tool emits a
partial update. The result row is intentionally short:

```text
spawning…
```

The call row already identifies the agent, label, and placement, so the
partial row must not repeat them.

### Successful result

The collapsed result row is:

```text
✓ success
```

The call row supplies the operation context. The result row should not repeat
`worker`, the label, placement, or the opaque agent ID.

When expanded, the success result retains the protocol details below the
status line:

```text
✓ success

call:
    shepherd_spawn {...}

return:
    {...}

details:
    ...
```

### Failed result

The collapsed result row is:

```text
✗ failed · <actionable error message>
```

For example:

```text
✗ failed · Unknown agent "worker" in user scope. No agents are available. Call shepherd with action "agents" to list exact names.
```

The complete tool shell must use Pi's native error background. Expanded output
retains the status and protocol details:

```text
✗ failed · Unknown agent "worker" in user scope. No agents are available.

call:
    shepherd_spawn {...}

return:
    {"code":"shepherd_error", ...}

details:
    return code: 1
```

The error message should come from structured error details when available.
When Pi has converted a thrown error into a result with empty details, the
renderer may derive the first-line error message from the formatted content.

## Result and error flow

The execution adapter must preserve the structured protocol text while
allowing Pi to observe the failure:

1. Execute the Shepherd operation.
2. For success, return the normal `AgentToolResult` and add the public call
   metadata.
3. For failure, construct the same user/model-facing structured error text.
4. Throw an `Error` containing that text.
5. Pi catches the thrown error, marks the tool execution as `isError`, and uses
   `toolErrorBg` for the complete tool shell.
6. The renderer uses `context.isError` and renders `✗ failed · ...`.

This deliberately separates:

- the textual protocol preserved for the model;
- Pi's execution-level error flag used by the TUI shell; and
- the compact human-facing status line.

## Expanded output

Expanded output is the debugging and inspection path. It may include:

- the serialized public call;
- the returned value;
- opaque lifecycle IDs;
- model selection;
- fieldnote/artifact paths;
- return codes;
- structured error information.

The expanded renderer should preserve section labels (`call:`, `return:`, and
`details:`) and use the standard Shepherd theme treatment. It must not change
the underlying result content merely to make the collapsed view shorter.

## Generalization to other lifecycle tools

The same two-row pattern should be applied to the remaining lifecycle tools:

| Tool | Call row | Result row |
|---|---|---|
| `shepherd_spawn` | `shepherd_spawn worker · label · placement` | `spawning…`, `✓ success`, or `✗ failed · error` |
| `shepherd_delegate` | `shepherd_delegate <agent/task summary>` | `✓ delegated` or `✗ failed · error` |
| `shepherd_message` | `shepherd_message <recipient>` | `✓ queued`, `waiting…`, or `✗ failed · error` |
| `shepherd_watch` | `shepherd_watch <count> task(s)` | `watching…`, `✓ completed`, or `✗ failed · error` |
| `shepherd_status` | `shepherd_status <agent>` | compact state summary or `✗ failed · error` |
| `shepherd_close` | `shepherd_close <agent>` | `✓ closed` or `✗ failed · error` |
| `shepherd_read` | `shepherd_read <target>` | compact preview; expanded terminal output |

These summaries should be semantic rather than copies of the serialized tool
protocol. Each renderer should preserve `expanded` and `isPartial` behavior.

## Acceptance criteria

- `shepherd_spawn` displays agent, label, and explicit placement once in the
  call row.
- The normal success result is exactly a compact success state and does not
  repeat invocation arguments.
- The partial result is a compact `spawning…` state.
- Failed execution renders `✗ failed · <error>` and the complete Pi tool shell
  uses the error background.
- Expanded output retains the structured call, return, and details sections.
- The model still receives the opaque agent ID after a successful spawn.
- A failed tool execution is signaled by throwing, not only by a non-zero
  `returnCode` in returned details.
- The renderer does not expose Herdr pane IDs.
- Future lifecycle renderers can follow the same call/result/status contract
  without changing `doAction()` semantics.
