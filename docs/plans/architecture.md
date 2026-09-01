# pi-shepherd — Implementation Plan

pi-shepherd is a Herdr-native pi extension for explicit agent lifecycle
orchestration **and asynchronous tracked-task delegation**. There is no
subprocess fallback; coordination between agents happens over a parent-
mediated message broker.

## Architecture

```
index.ts                 extension entry and /shepherd command
 src/core/discovery.ts    fresh agent discovery and frontmatter parsing
 src/core/orchestration.ts opaque serializable handles and in-memory registries
 src/core/lifecycle.ts    spawn, prompt, wait, status, and close primitives
 src/core/herdr.ts        Herdr CLI, launch, pane, and ownership helpers
 src/core/artifact-sessions.ts durable parent-bound session, note, and fieldnotes persistence
 src/extension/shepherd.ts umbrella control tool plus separate lifecycle tools
 src/extension/shepherd-done.ts in-tab completion extension
 .agents/agents/  bundled pi-format and shared-format agents
```

## Public lifecycle API

- `shepherd_spawn({ agent, ...options })` creates an idle persistent agent and
  submits no task.
- `shepherd_delegate({ target, task, timeout? })` starts a **tracked task** on
  an agent and returns a task id without waiting. Delegation is the preferred
  way to assign work that may need to survive peer replies.
- `shepherd_message({ target, message, ... })` sends an asynchronous,
  parent-mediated message to the parent or to an owned agent. With
  `expectsReply` it opens a tracked reply request: the sender's task enters
  `waiting` (its pi process may go idle) until a matching reply, a
  `shepherd_done`, or the reply deadline.
- `shepherd_done` (child-side) is the only normal successful completion
  signal for a tracked task; idle/`agent_end`/`agent_settled` never settle a
  task.
- `shepherd_watch({ id })` compatibility wait: task ids (preferred) or legacy
  prompt ids; a wait timeout bounds the wait only.
- `shepherd_watch({ id })` non-blocking task-watcher; completions arrive as
  follow-ups.
- `shepherd_status({ id })` performs non-mutating inspection; reports
  process state and task state independently.
- `shepherd_close({ id })` explicitly terminates an owned agent, cancels its
  active tracked task (and unresolved prompt), and clears pending requests.
- `shepherd_read({ name, lines?, source? })` reads recent terminal output.
- `shepherd_prompt({ id, message })` is a **deprecated** one-turn
  compatibility path (see docs/guides/tool-reference.md).

The umbrella `shepherd` control tool handles `agents`, `herd`, and `prune` and
contains the shared lifecycle and fieldnotes guidance. The `/shepherd` command
supports the human-facing `agents`, `herd`, `spawn`, `status`, `read`, and
`settings` actions.

Parallel work and chains are caller composition, not first-class workflow
modes. A one-shot tracked operation is
`shepherd_spawn + shepherd_delegate + shepherd_watch + shepherd_close`.

## Completed implementation

- Agent, task, prompt, and message references are opaque session-scoped ids exposed in tool arguments and result text. Full handle objects remain internal registry state.
- Tracked tasks are independent of Herdr process state: `running`,
  `waiting`, and the terminal states (`completed`, `blocked`, `failed`,
  `cancelled`, `timed_out`) live in the lifecycle registry. Only
  `shepherd_done` (or explicit failure/cancellation/timeout) settles a task;
  a child's idle or `agent_end` never does.
- Cross-agent communication is parent-mediated: the parent broker routes
  envelopes between owned agents with provenance (sender, thread, replyTo)
  and delivers them as queued follow-ups (`followUp`) or urgent input
  (`steer`). Request/reply correlation uses `replyTo` == pending reply
  `messageId`; one outstanding request per task is the initial policy.
- Stale-wait reminders are informational only: at most one per waiting
  episode, `triggerTurn: false`, and the reply deadline remains the only
  mechanism that settles a stale wait to `blocked`.
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
