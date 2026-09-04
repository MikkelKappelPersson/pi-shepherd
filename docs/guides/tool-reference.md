# Tool reference

pi-shepherd exposes these structured tools to the Shepherd. Lifecycle IDs are opaque, session-scoped handles; do not substitute Herdr pane IDs.

## Discovery and inspection

| Tool | Arguments | Purpose |
| --- | --- | --- |
| `shepherd` | `action`: `agents`, `herd`, or `prune`; optional `agentScope`: `user`, `project`, or `both` | Discover definitions, list active agents, or remove stale registrations. |
| `shepherd_status` | `id`: agent ID | Inspect an agent without focusing its pane. For an open task the result carries the task ID, state, waiting age, pending request, recipient, and stale flag. |
| `shepherd_read` | `name`: agent name, agent ID, or pane ID; optional `lines`, `source` | Read recent terminal output for diagnostics. |

## Lifecycle

| Tool | Arguments | Purpose |
| --- | --- | --- |
| `shepherd_spawn` | `agent`, `label`; optional `placement`, `cwd` | Create an idle persistent agent. Placement is `pane_right`, `pane_down`, `tab`, or `workspace`; the default is a background tab. The model comes only from the agent definition Markdown frontmatter. |
| `shepherd_delegate` | `target`: agent ID, `task`: description; optional `timeout` | Start a tracked task and return a task ID without waiting. One active task per agent. |
| `shepherd_message` | `target`: agent ID, `message`; optional `taskId`, `threadId`, `replyTo`, `expectsReply`, `delivery` | Send an asynchronous message (parent or peer). `expectsReply` opens a tracked reply request; the sender's task enters `waiting` until the reply. |
| `shepherd_prompt` | `id`: agent ID, `message`: one-turn message | **Deprecated** compatibility path. Ties completion to one child turn; prefer `shepherd_delegate` for tracked work. |
| `shepherd_watch` | `id`: task ID(s) (preferred) or legacy prompt ID(s) | Register a non-blocking completion watcher; completions arrive as follow-ups. |
| `shepherd_close` | `id`: agent ID | Close an owned agent, cancel its active task (and unresolved prompt), and clear pending requests. |

Example:

```text
shepherd_spawn({
  agent: "worker",
  label: "implementation",
  placement: "pane_right",
  cwd: "/path/to/project"
})
```

`cwd` defaults to the Shepherd session. The model comes only from the discovered agent definition; omission, `null`, or `default` inherits the Shepherd session model. Agent scope, project approval, and prompt-shaping options come from settings and the discovered definition rather than spawn arguments. Only panes created and recorded by pi-shepherd can be closed by the extension.

## Child-side tools

| Tool | Arguments | Purpose |
| --- | --- | --- |
| `shepherd_message` | `target`: `parent` or an owned agent ID, `message`; optional `taskId`, `threadId`, `replyTo`, `expectsReply`, `delivery` | A child sends an asynchronous message to the parent or a peer. `expectsReply` (to a parent task) opens the tracked reply request. |
| `shepherd_done` | `taskId`, `summary`; optional `ok`, `returnCode`, `error` | The only normal successful completion for a tracked task. Repeated calls are idempotent. |

## IDs at a glance

- **Agent id** – from `shepherd_spawn`; accepted by `delegate`, `message`, `status`, `close`.
- **Task id** – from `shepherd_delegate`; the tracked unit of work; accepted by `wait`, `watch`, `message` (`taskId`), and `shepherd_done`.
- **Prompt id** – from the deprecated `shepherd_prompt`; accepted by `wait` and `watch` (legacy path).
- **Message id** – returned by `shepherd_message`; used as `replyTo` by the agent answering the request.

None of these can be substituted with a Herdr pane ID; pane IDs are diagnostic targets for `shepherd_read` only.
