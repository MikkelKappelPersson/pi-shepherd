# pi-shepherd — Implementation Plan

pi-shepherd is a Herdr-native pi extension for explicit agent lifecycle
orchestration. There is no workflow-oriented delegation API and no subprocess
fallback.

## Architecture

```
index.ts          extension entry and /shepherd command
 discovery.ts     fresh agent discovery and frontmatter parsing
 orchestration.ts opaque serializable handles and in-memory registries
 lifecycle.ts     spawn, prompt, wait, status, and close primitives
 shepherd.ts      umbrella control tool plus separate lifecycle tools
 herdr.ts         Herdr CLI, launch, pane, and ownership helpers
 artifact-sessions.ts durable parent-bound session, note, and fieldnotes persistence
 shepherd-done.ts in-tab completion extension
 .pi/agents/      bundled pi-format agents
 .agents/agents/  bundled shared-format agents
```

## Public lifecycle API

- `shepherd_spawn({ agent, ...options })` creates an idle persistent agent and
  submits no task.
- `shepherd_prompt({ handle, message, ...options })` submits one message and
  returns immediately.
- `shepherd_wait({ handle })` waits for one or all prompts; arrays are concurrent
  and preserve input order.
- `shepherd_status({ handle })` performs non-mutating inspection.
- `shepherd_close({ handle })` explicitly terminates an owned agent and cancels
  unresolved prompts.
- `shepherd_read({ name, lines?, source? })` reads recent terminal output.

The umbrella `shepherd` control tool handles `agents`, `herd`, and `prune` and
contains the shared lifecycle and fieldnotes guidance. The `/shepherd` command
supports the human-facing `agents`, `herd`, `spawn`, `status`, `read`, and
`settings` actions.

Parallel work and chains are caller composition, not first-class workflow
modes. A one-shot operation is explicitly `shepherd_spawn + shepherd_prompt +
shepherd_wait + shepherd_close`.

## Completed implementation

- Agent and prompt lifecycle references are opaque session-scoped ids exposed in tool arguments and result text. Full handle objects remain internal registry state; legacy nested handles are migrated at the model boundary during the transition.
- Registries enforce one unresolved prompt per agent, idempotent settlement, and
  deterministic cancellation.
- Persistent Herdr tabs launch pi with discovered system prompt, tools, model,
  cwd, and no initial user message.
- Prompt submission is non-blocking and requires Herdr detection.
- Wait ignores pre-submit idle state, tracks post-submit transitions, returns
  structured per-prompt results, and supports concurrent multi-wait.
- Status and close use lifecycle ids and retain the created-pane ownership invariant.
- Project agent scope remains opt-in and trust-gated.
- Legacy `delegate`, workflow modes, and `subagent.ts` have been removed.
- When enabled, durable notes are allocated once per parent pi session/project
  binding, with one fieldnotes collection and distinct per-prompt note files.
- Fieldnotes can be disabled in settings; the setting is snapshotted when a
  parent pi session starts.
- README and focused registry/multi-wait tests document and verify the API.

## Verification

Run:

```bash
npm test
```

Live Herdr checks cover idle spawn, non-blocking prompt, wait/result recovery,
parallel multi-wait, iterative prompting, cancellation on close, focus
preservation, and ownership protection.

## Security invariants

- User agent discovery is the default.
- Project-controlled agent definitions require explicit scope and confirmation.
- Agents have the host user's normal pi tool permissions.
- Background placement uses `--no-focus`.
- Only panes recorded in the pi-shepherd created-pane registry may be closed.
- Launch/session resources are removed only after the child pane is gone.
- Note sessions are retained and never automatically cleaned up.
