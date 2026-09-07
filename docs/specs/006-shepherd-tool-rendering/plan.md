# Plan: Shepherd Tool Rendering and TUI States

Related specification: [spec.md](spec.md)

## Status

Implementation complete. The renderer, lifecycle tool previews, custom
notification presenters, focused rendering tests, and documentation are in
place. The full suite reaches the pre-existing stale-wait assertion failure.

## Design decisions

- Keep model/API-facing `content` and `details` complete and structured.
- Treat the TUI as a separate presentation layer.
- Use Pi's native `isError` state by throwing execution failures.
- Keep the collapsed spawn view compact:
  `shepherd_spawn worker · label · placement` followed by a status.
- Use minimal expanded section headers: `call` and `return`.
- Keep top-level call and return fields flat rather than indented.
- Show optional call arguments when they were provided; omit absent optional
  arguments.
- Put prose values such as `message`, `task`, `question`, `description`, and
  `output` on the line after their label.
- Do not use Markdown fences or per-line prefixes for raw prose blocks. Pi's
  `Text` component does not render fences as special blocks, and raw content is
  easier to copy.
- Style section headers with bold only. Style field labels with accent color;
  leave values and prose content in normal output styling.
- Omit a separate human-facing `details` section. Keep the complete underlying
  `details` object available to the model/API.
- Curate the human-facing return fields: show useful IDs, state, delivery,
  model, and errors; hide duplicate call arguments and recursive session
  metadata.

## Phase 1 — Establish the renderer boundary

- [x] Separate collapsed TUI output from model/API protocol output.
- [x] Rename `formatUserFacingText()` to `formatToolResultText()`.
- [x] Rename `withUserFacingContent()` to `withToolResultText()`.
- [x] Keep `details.call`, `details.returnValue`, and raw metadata available in
      tool results.
- [x] Document that `call`, `return`, and `details` are Shepherd presentation
      conventions, not separate Pi result channels.

## Phase 2 — Implement spawn status rendering

- [x] Render the invocation preview with agent, label, and placement.
- [x] Emit a partial update while the child pane is starting.
- [x] Render the collapsed states:
      - `spawning…`
      - `✓ success`
      - `✗ failed · <error>`
- [x] Use `context.isError` and thrown execution errors for native Pi error
      styling.
- [x] Preserve structured failure text for the model/API.

## Phase 3 — Implement human-readable expanded results

- [x] Add `formatExpandedToolResult()` and human-value helpers.
- [x] Render minimal `call` and `return` headers.
- [x] Render top-level call arguments without indentation.
- [x] Render optional arguments only when present.
- [x] Render curated return fields without a separate details dump.
- [x] Suppress duplicate spawn fields where appropriate.
- [x] Suppress recursive `artifactSession`, fieldnote, and parent-session
      metadata from the normal human view.
- [x] Render prose values as raw blocks below their labels.
- [x] Preserve natural terminal wrapping for long single-line prose values.
- [x] Add blank lines between status, call, and return sections.
- [x] Style headers and field labels independently from their values.
- [x] Prevent colon-containing prose from being mistaken for field labels.

## Phase 4 — Apply the presentation to custom notifications

The current worker reply and completion notifications are delivered through
`pi.sendMessage()` and do not pass through a tool's `renderResult()` renderer.
They still expose the old protocol-shaped `call` / `return` / `details` text to
the renderer input, while the human-facing renderer now presents structured
notification details instead.

- [x] Add a notification-specific human formatter using the same flat layout.
- [x] Render incoming messages and replies as:

      Shepherd reply from worker: <label>
      message id: ...
      thread id: ...
      reply to: ...

      message:
      <raw message content>

- [x] Apply the same treatment to task completion, prompt completion, and
      stale-wait notifications.
- [x] Keep notification `details` available internally for model/API use.
- [x] Confirm that notification prose is not accidentally field-styled.

## Phase 5 — Extend lifecycle tool renderers

Apply the same collapsed/expanded contract to the remaining tool family:

- [x] `shepherd_delegate`
  - call fields: target and task;
  - return fields: task ID, agent ID, and state.
- [x] `shepherd_message`
  - call fields: target, delivery options, reply options, and raw message;
  - return fields: message ID, delivery, request ID, and target state.
- [x] `shepherd_prompt`
  - call fields: agent ID, timeout, and raw prompt;
  - return fields: prompt ID and completion state.
- [x] `shepherd_watch`
  - call fields: watched IDs and timeout;
  - return fields: completion state and task/prompt IDs.
- [x] `shepherd_status`
  - call fields: target;
  - return fields: state, task state, waiting information, and errors.
- [x] `shepherd_close`
  - call fields: agent ID;
  - return fields: closed agent ID and state.
- [x] `shepherd_read`
  - call fields: target, source, and line count;
  - return fields: terminal output and read metadata.

The umbrella `shepherd herd` view also has a curated collapsed renderer:
show only an `Active agents: <count>` summary. Expanded entries use opaque
agent IDs (the parent uses the stable `shepherd` alias), indent state fields
beneath the identity without list markers, and hide pane IDs, workspace IDs,
and working directories. The collapsed `shepherd agents` result is reduced to
an `Available agents:` list of names.

Each tool should preserve `expanded` and `isPartial` behavior and must not
change `doAction()` lifecycle semantics.

## Phase 6 — Verification

- [x] Add renderer-focused tests for:
  - flat call fields;
  - optional arguments present/absent;
  - raw multiline message content;
  - long single-line wrapping input;
  - colon-containing prose;
  - blank section spacing;
  - bold unaccented section headers;
  - accent field labels and normal values;
  - curated return fields;
  - hidden recursive session metadata.
- [x] Verify native red tool-shell rendering for thrown failures.
- [x] Verify partial spawn rendering while Herdr starts.
- [x] Live-test spawn, message, delegate, watch, status, read, and close.
- [x] Verify incoming notifications separately from tool results.
- [x] Run `git diff --check` and the full test suite.
- [x] Record the existing unrelated stale-wait test failure: the suite still
      fails at `verify-stale-wait.mjs` with `one notification after crossing the
      threshold`.

## Phase 7 — Completion

- [ ] Review the final expanded output at narrow and wide terminal widths.
- [x] Confirm copy/paste behavior for multiline and wrapped single-line values.
- [x] Update the stable specification and implementation plan.
- [ ] Commit the implementation and specification updates together.

## Acceptance criteria

- The normal spawn view is compact and does not duplicate invocation data.
- Spawn failures use Pi's native error background and show an actionable error.
- Expanded output has only `call` and `return` sections.
- Section headers are bold but not accent-colored.
- Field labels are accent-colored; values are normal output text.
- Optional arguments appear when supplied and disappear when absent.
- Message content starts on the line after `message:` and contains no visual
  fence or per-line prefix.
- Long single-line messages wrap naturally without changing their content.
- Recursive artifact/session metadata is not shown in the normal human view.
- Full structured result data remains available to the model/API.
- Custom notifications eventually follow the same human-readable contract.
