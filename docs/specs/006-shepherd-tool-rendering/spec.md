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

When expanded, the success result uses the final spaced, human-readable
layout:

```text
✓ success

call
agent: worker
label: minimal headers verification
placement: tab

return
status: spawned
agent id: shepherd-agent-...
model: github-copilot/gpt-5.6-luna
```

Optional call arguments remain visible in the expanded call when they were
provided. For example, `placement: tab` is shown when that placement was part
of the invocation; absent optional arguments are omitted.

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
retains the status, call, and curated error return:

```text
✗ failed · Unknown agent "worker" in user scope. No agents are available.

call
agent: worker
label: code review
placement: tab

return
status: failed
error: Unknown agent "worker" in user scope. No agents are available.
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

Expanded output is the human inspection path. It should be semantic and
copy-friendly rather than a dump of JSON. The expanded renderer should retain the call and return concepts, but format
each as labeled fields. It should not render a separate details section:

```text
call
target: worker
expects reply: yes
delivery: followUp
message:
First line
Second line
Third line

return
status: queued
message id: shepherd-message-...
delivery: queued
```

Message values always start on the line after the `message:` label. Top-level
call arguments and return fields are rendered without indentation so labels and
raw message content share the same visual edge. Multiline text is rendered as a raw text
block without Markdown fences or per-line prefixes. Long single-line messages
use the same layout and wrap naturally in the terminal. Nested objects and
arrays may still use indentation. Section headers and argument/return labels
should use bold styling without accent color while argument and return labels
use accent styling. Values remain normal output styling. The message content
itself should remain unstyled normal text. This keeps the
message content easy to select and paste while avoiding visual fence characters
that Pi does not render as a special text block.

Common scalar values should be rendered as labeled fields rather than JSON:

```text
agent: worker
label: code review
placement: pane_right
return code: 0
```

Nested objects should become nested labeled sections, and arrays should use one
item per line. Ordinary strings should not receive JSON quotes or escaped
newline sequences. Opaque lifecycle IDs, model names, fieldnote/artifact paths,
return codes, and structured error information remain available in expanded
output because this is the inspection path.

The return section is curated for human use. It should include the primary
operation result, useful identifiers, state, delivery information, and errors.
It should omit duplicate call arguments, successful `returnCode: 0`, recursive
artifact/session metadata, and internal parent-session paths. The complete
`details` object remains available to the model/API; it is not rendered as a
separate human-facing section.

A dedicated copy-message interaction is out of scope for this iteration. The
raw message block is intentionally not prefixed or fenced so selecting its
content preserves the message text as closely as possible.

The expanded section labels are intentionally minimal:

```text
call
return
```
The operation name is already present in the outer call row, and the result
status is rendered as a `status:` field under `return`.

The expanded renderer must not change the underlying result content merely to
make the collapsed view shorter. The model/API-facing result and structured
`details` remain the source of truth; this is a TUI-only presentation layer.
Expanded non-spawn results begin with one blank line so the `call` section is
visually separated from the outer invocation row.
The final spawn presentation is:

```text
shepherd_spawn worker · minimal headers verification · tab
✓ success

call
agent: worker
label: minimal headers verification
placement: tab

return
status: spawned
agent id: shepherd-agent-...
model: github-copilot/gpt-5.6-luna
```

## Formatting function names

The existing `formatUserFacingText()` and `withUserFacingContent()` names are
misleading because their output is also delivered to the model/API surface.
Before adding the human-readable expanded formatter, rename them to neutral
names:

```text
formatUserFacingText()   → formatToolResultText()
withUserFacingContent()  → withToolResultText()
```

The new TUI-only functions should have clearly separate names, for example:

```text
formatExpandedToolResult()
formatHumanValue()
formatMultilineValue()
```

`formatToolResultText()` remains responsible for shared protocol-oriented text;
`formatExpandedToolResult()` is responsible only for the human-readable TUI
view. The latter renders only `call` and a curated `return`; it does not emit a
separate `details` section.

## Custom notification rendering

Incoming replies, child messages, task completions, prompt completions, and
stale-wait notices are delivered through `pi.sendMessage()`, so they do not
use a registered tool's `renderResult()` callback. Their message `content`
remains protocol-oriented for the model/API, while the custom message renderer
uses the structured `details` payload for the human-facing view.

A reply is rendered as a compact metadata block followed by a raw message
block:

```text
Shepherd reply from worker: code review
message id: shepherd-message-...
task id: shepherd-task-...
thread id: shepherd-message-...
reply to: shepherd-message-...
message:
The reply remains plain and copyable.
```

Watcher and stale-wait notifications use the same flat labels and raw blocks.
They must not render a separate `call`, `return`, or `details` dump, and prose
inside notification fields must not be mistaken for field labels.

## Generalization to other lifecycle tools

The same two-row pattern should be applied to the remaining lifecycle tools.
The umbrella `shepherd herd` result is a special compact count. Its collapsed
result is only `Active agents: <count>`. Agent identities and states belong in
the expanded view, not the routine collapsed row.

In expanded output, lifecycle-owned entries use their opaque ID, with their
state fields indented beneath the identity and no list-dash noise:

```text
agents:
  agent id: shepherd-agent-...
    agent: worker
    label: code review
    state: idle

  agent id: shepherd
    state: working
    focused: yes
```

The parent Shepherd process has no spawned-agent ID, so it uses the stable
`agent id: shepherd` alias. Herdr pane IDs, workspace IDs, and working
directories remain hidden.

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
- Expanded output retains semantic call and curated return sections without a
  separate details dump.
- Multiline values are rendered inside copy-friendly fences without per-line
  prefixes.
- The model still receives the opaque agent ID after a successful spawn.
- A failed tool execution is signaled by throwing, not only by a non-zero
  `returnCode` in returned details.
- The renderer does not expose Herdr pane IDs.
- Future lifecycle renderers can follow the same call/result/status contract
  without changing `doAction()` semantics.
