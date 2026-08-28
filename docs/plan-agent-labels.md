# pi-shepherd — Task-Specific Agent Labels Plan

## Goal

Give each spawned agent an optional, human-facing task label while retaining the
opaque lifecycle ID as the authoritative identifier used by code and lifecycle
calls.

Example:

```text
shepherd_spawn({ agent: "reviewer", label: "code review" })
→ reviewer: code review
```

## Proposed semantics

- `agent` remains the discovered agent definition name, such as `reviewer`.
- `label` is a short, task-specific instance label selected by the calling
  agent.
- `id` remains the unique lifecycle handle used by `prompt`, `wait`, `status`,
  and `close`.
- No automatic numbering scheme is introduced.
- An unlabeled spawn has an empty label and is displayed using its agent type
  alone everywhere, including the Herdr tab, pane, or workspace name:

```text
/shepherd spawn reviewer
→ reviewer
```

The display-name rule is intentionally simple: use `<agent>: <label>` when a
non-empty label is present; otherwise use `<agent>` unchanged. In other words,
an unlabeled user-created reviewer should produce a Herdr name of `reviewer`,
not `reviewer:`, `reviewer-`, or an automatically numbered variant.

- A labeled spawn combines the agent name and label for human-facing output:

```text
reviewer + code review → reviewer: code review
```

The model-facing `shepherd_spawn` input requires a label so every spawned
instance has a short, task-specific human identifier. Tool guidance should make
providing that label explicit. The label is separate from the discovered agent
name and is validated for safe display. The human `/shepherd spawn reviewer`
command remains valid without a label and passes an empty label through
unchanged. A human can provide one explicitly with:

```text
/shepherd spawn reviewer --label "code review"
```

## Handle shape

The resolved handle may represent an empty label explicitly:

```ts
{
  id: "shepherd-agent-...",
  agent: "reviewer",
  label: ""
}
```

The friendly display name is derived rather than stored separately:

```text
label present → reviewer: code review
label empty   → reviewer
```

This can be implemented conceptually as a presence check: if `label` is null,
undefined, or empty after trimming, return the agent type; otherwise return the
agent type, separator, and label.

Use the same representation for the user-visible tool call/result, the herd
widget, and the Herdr pane, tab, or workspace label. The recommended format is
`<agent>: <label>` because the colon clearly separates the role from the
human-readable task description. A hyphenated form such as
`reviewer-code-review` is more compact but looks like a machine slug and makes
the boundary less obvious.

This avoids storing redundant `displayName` state and keeps the definition name,
instance label, and lifecycle identity distinct.

## Identity and lookup

The label is for recognition and presentation in the user-facing tool call and
result, the herd widget, Herdr labels, status, and diagnostics. The TUI should
show the derived representation instead of exposing the long opaque ID in those
places.

This is a presentation change, not a protocol change. The underlying tool
arguments and lifecycle registry continue to use the opaque ID so `prompt`,
`wait`, `status`, and `close` remain unambiguous. Tool results may retain the ID
for the parent model while `renderCall`/`renderResult` hide it from the user.
Changing the actual tool protocol to accept only labels is out of scope.

Duplicate labels do not change lifecycle identity. Empty labels may be
repeated, so multiple unlabeled agents can exist as `reviewer`. Non-empty labels
must be unique for the complete display name within the parent session; reject a
duplicate rather than silently suffixing it. A label shared by different agent
types is valid because the complete display names differ:

```text
reviewer: code review  ✅
reviewer: api review   ✅
reviewer: code review  ❌ duplicate
scout: code review     ✅
```

Labels are not accepted as lifecycle IDs. Lifecycle operations continue to
resolve agents exclusively by opaque ID.

## Validation

Because `label` is a human-facing label rather than a machine slug, preserve
readable spaces instead of forcing a hyphenated form. Apply these rules:

- trim leading and trailing whitespace;
- treat an empty-after-trimming value as no label;
- reject control characters and newlines;
- allow letters, numbers, spaces, `_`, `-`, and `.`;
- reject `:` because it is the role/label separator;
- preserve the user's casing; and
- limit the label to 64 characters.

The label must not be confused with the discovered agent name or a Herdr pane
ID. Any machine-safe value needed for temporary files or launch arguments should
be derived separately and should not become the user-facing label.

## Implementation areas

- Extend spawn arguments and `AgentHandle` with `label`, keeping it separate
  from the discovered agent name.
- Resolve the optional input to an empty label when omitted; do not maintain a
  per-agent counter or generate labels such as `reviewer-01`.
- Propagate the label to the user-facing tool call/result, herd widget, and
  Herdr tab/pane/workspace presentation without changing agent discovery or
  launch semantics.
- Derive the friendly display name at presentation boundaries instead of adding
  a stored `displayName` field.
- Keep the opaque ID in the underlying model-facing lifecycle protocol even when
  the TUI renders the label instead.
- Update tool descriptions and prompt guidance so calling agents normally
  provide a short task-specific label.
- Update `/shepherd` parsing and help text while preserving unlabeled human
  commands.
- Update README examples and documentation.

## Phased implementation plan

### Phase 1 — Lock down the contract

- Use `label` as the public field name; it is optional at the spawn boundary.
- Use the resolved representation where `agent` is the agent definition name,
  `label` is an empty or non-empty task label, and `id` remains the opaque
  lifecycle identifier.
- Define the display formatter once:

  ```text
  non-empty label → <agent>: <label>
  empty label     → <agent>
  ```

- Apply the decided validation rules: trim whitespace, reject control
  characters/newlines and `:`, allow letters, numbers, spaces, `_`, `-`, and `.`,
  preserve case, and limit labels to 64 characters.
- Permit repeated empty labels, but reject duplicate non-empty complete display
  names within the parent session. Do not add automatic numbering.
- Use `/shepherd spawn reviewer --label "code review"` as the documented human
  command syntax; the label remains optional.

### Phase 2 — Extend the lifecycle data model

- Add `label` to the spawn input and resolved `AgentHandle`.
- Resolve omitted, null, or whitespace-only input to an empty label.
- Preserve the existing opaque-ID registry and lookup behavior.
- Ensure labels are assigned consistently before the handle is returned and are
  available to status, prompt results, and close-related output.
- Add registry-level tests for labeled and unlabeled handles.

### Phase 3 — Add shared presentation formatting

- Add one shared formatter for the friendly agent name rather than duplicating
  string concatenation across adapters.
- Verify that an empty label returns exactly the agent type, with no separator,
  suffix, or generated number.
- Verify that a labeled instance returns the chosen `<agent>: <label>` form.
- Keep the formatter presentation-only; it must not become a lifecycle lookup
  key or replace the opaque ID.

### Phase 4 — Update spawn surfaces and Herdr presentation

- Extend model-facing `shepherd_spawn` schema, descriptions, and guidance so
  calling agents normally provide a short task-specific label.
- Keep `/shepherd spawn reviewer` valid without a label and pass the empty label
  through unchanged.
- Use the derived friendly name for Herdr tab, pane, and workspace labels.
- Use the agent type alone for an unlabeled user-created instance, such as a tab
  named `reviewer`.
- Preserve the discovered agent name for discovery and launch semantics; do not
  use the composite display name to resolve agent definitions.
- Ensure background placement and pane ownership behavior remain unchanged.

### Phase 5 — Update user-facing tool and widget rendering

- Render the friendly name instead of the long opaque ID in user-facing tool
  calls and results.
- Update the herd/status widget to show the same friendly name consistently.
- Retain the opaque ID in the underlying tool result data or model-facing text
  wherever it is needed for follow-up lifecycle calls.
- Verify that user-facing rendering does not make labels usable accidentally as
  lifecycle IDs.

### Phase 6 — Documentation and compatibility

- Update the README, lifecycle examples, command help, and tool guidance.
- Document labeled and unlabeled spawn behavior, including the exact Herdr name
  for an unlabeled spawn.
- Document that labels are for human recognition while IDs remain authoritative.
- Review diagnostics, fieldnotes, and persisted metadata for places where the
  friendly name should be shown without changing stored identity semantics.

### Phase 7 — Verification and live smoke testing

- Run all automated schema, CLI, registry, launch, widget, and lifecycle tests.
- Run a live Herdr check for a labeled spawn and verify the tab/pane/workspace
  name.
- Run a live Herdr check for `/shepherd spawn reviewer` and verify the name is
  exactly `reviewer`.
- Verify prompt, wait, status, and close still work using the opaque ID.
- Verify multiple labels, repeated empty labels, and rejection of duplicate
  non-empty complete display names.
- Verify no numbering state or generated labels exist.

## Verification

Add coverage for:

- schema acceptance of labeled and unlabeled spawns;
- `/shepherd spawn reviewer` producing an empty label;
- a supplied label producing the expected friendly name (`reviewer: code review`);
- no automatic numbering or counter state;
- label normalization and validation;
- repeated empty labels and duplicate non-empty display-name rejection;
- propagation to tool-call rendering, the herd widget, and Herdr presentation;
- user-facing rendering hiding the opaque ID while model-facing results retain
  whatever ID data is required for follow-up calls; and
- lifecycle calls continuing to use the opaque ID.

Run the existing test suite with:

```bash
npm test
```
