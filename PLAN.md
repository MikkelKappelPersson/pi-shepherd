# pi-shepherd — Implementation Plan

pi-shepherd is a Herdr-native pi extension for explicit agent lifecycle
orchestration. There is no workflow-oriented delegation API and no subprocess
fallback.

## Architecture

```
index.ts          extension entry and /shepherd command
 discovery.ts     fresh agent discovery and frontmatter parsing
 orchestration.ts opaque serializable handles and in-memory registries
 lifecycle.ts     start, prompt, wait, status, and close primitives
 shepherd.ts      model-facing action-discriminated shepherd tool
 herdr.ts         Herdr CLI, launch, pane, and ownership helpers
 shepherd-done.ts in-tab completion extension
 .pi/agents/      bundled pi-format agents
 .agents/agents/  bundled shared-format agents
```

## Public lifecycle API

- `start(agent, options)` creates an idle persistent agent and submits no task.
- `prompt(handle, message, options)` submits one message and returns immediately.
- `wait(promptHandle | promptHandles)` waits for one or all prompts; arrays are
  concurrent and preserve input order.
- `status(handle)` performs non-mutating inspection.
- `close(handle)` explicitly terminates an owned agent and cancels unresolved
  prompts.

Parallel work and chains are caller composition, not first-class workflow
modes. A one-shot operation is explicitly `start + prompt + wait + close`.

## Completed implementation

- Agent and prompt handles are stable session-scoped objects returned in tool details; the tool accepts only those complete objects (or a native array of complete prompt objects for multi-wait), never IDs or JSON strings.
- Registries enforce one unresolved prompt per agent, idempotent settlement, and
  deterministic cancellation.
- Persistent Herdr tabs launch pi with discovered system prompt, tools, model,
  cwd, and no initial user message.
- Prompt submission is non-blocking and requires Herdr detection.
- Wait ignores pre-submit idle state, tracks post-submit transitions, returns
  structured per-prompt results, and supports concurrent multi-wait.
- Status and close use handles and retain the created-pane ownership invariant.
- Project agent scope remains opt-in and trust-gated.
- Legacy `delegate`, workflow modes, `subagent.ts`, and artifact-backed
  one-shot orchestration have been removed.
- README and focused registry/multi-wait tests document and verify the API.

## Verification

Run:

```bash
npm test
```

Live Herdr checks cover idle start, non-blocking prompt, wait/result recovery,
parallel multi-wait, iterative prompting, cancellation on close, focus
preservation, and ownership protection.

## Security invariants

- User agent discovery is the default.
- Project-controlled agent definitions require explicit scope and confirmation.
- Agents have the host user's normal pi tool permissions.
- Background placement uses `--no-focus`.
- Only panes recorded in the pi-shepherd created-pane registry may be closed.
- Launch/session resources are removed only after the child pane is gone.
