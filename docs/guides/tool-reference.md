# Tool reference

pi-shepherd exposes these structured tools to the Shepherd. Lifecycle IDs are opaque, session-scoped handles; do not substitute Herdr pane IDs.

## Discovery and inspection

| Tool | Arguments | Purpose |
| --- | --- | --- |
| `shepherd` | `action`: `agents`, `herd`, or `prune`; optional `agentScope`: `user`, `project`, or `both` | Discover definitions, list active agents, or remove stale registrations. |
| `shepherd_status` | `id`: agent ID | Inspect an agent without focusing its pane. |
| `shepherd_read` | `name`: agent name, agent ID, or pane ID; optional `lines`, `source` | Read recent terminal output for diagnostics. |

## Lifecycle

| Tool | Arguments | Purpose |
| --- | --- | --- |
| `shepherd_spawn` | `agent`, `label`; optional `placement`, `cwd`, `model` | Create an idle persistent agent. Placement is `pane_right`, `pane_down`, `tab`, or `workspace`; the default is a background tab. |
| `shepherd_prompt` | `id`: agent ID, `message`: task or follow-up | Submit work and return immediately with a prompt ID. |
| `shepherd_wait` | `id`: prompt ID or array of prompt IDs | Wait for one or more prompts and return their results. |
| `shepherd_watch` | `id`: prompt ID or array of prompt IDs | Register a non-blocking completion watcher. |
| `shepherd_close` | `id`: agent ID | Close an owned agent and cancel unresolved prompts. |

Example:

```text
shepherd_spawn({
  agent: "worker",
  label: "implementation",
  placement: "pane_right",
  cwd: "/path/to/project",
  model: "anthropic/claude-sonnet-4-5"
})
```

`cwd` and `model` default to the Shepherd session. Agent scope, project approval, and prompt-shaping options come from settings and the discovered definition rather than spawn arguments. Only panes created and recorded by pi-shepherd can be closed by the extension.
