# pi-shepherd

A Herdr-native pi extension for explicit agent lifecycle orchestration.
Agents are visible in Herdr and are controlled through five composable
primitives:

```text
start(agent, options) -> AgentHandle
prompt(agentHandle, message, options) -> PromptHandle
wait(promptHandle | promptHandles) -> Result | Result[]
status(agentHandle) -> Status
close(agentHandle) -> void
```

The model-facing `shepherd` tool also retains diagnostic/operational actions:
`agents`, `list`, `read`, and `gc`.

## Lifecycle usage

`start` launches an idle persistent agent. It never submits a task and has no
`stayOpen` option. The agent remains alive until explicitly closed.

```text
agent = shepherd({ action: "start", agent: "scout", cwd: project })
prompt = shepherd({
  action: "prompt",
  handle: agent.handle,
  message: "Research the authentication code",
})
result = shepherd({ action: "wait", handle: prompt.handle })
shepherd({ action: "close", handle: agent.handle })
```

Prompt submission is non-blocking. `wait` is the synchronization point. For
parallel work, start multiple agents, prompt each one, then wait on the array:

```text
scoutA = start("scout", options)
scoutB = start("scout", options)
promptA = prompt(scoutA, "Research authentication")
promptB = prompt(scoutB, "Research authorization")
[resultA, resultB] = wait([promptA, promptB])
close(scoutA)
close(scoutB)
```

Arrays wait concurrently and preserve input order. A single agent may have
only one unresolved prompt. Sequential chains are composed by the caller:
wait for one result, include its text in the next prompt, and wait again.
Waiting never closes an agent.

## Shepherd actions

| Action | Purpose |
|---|---|
| `start` | Create an idle persistent discovered agent in a background Herdr tab |
| `prompt` | Submit one message using an `AgentHandle`; returns immediately |
| `wait` | Wait for one or many `PromptHandle`s |
| `status` | Inspect a handle without focusing or mutating Herdr |
| `close` | Explicitly close an owned agent and cancel unresolved prompts |
| `agents` | List discovered agent definitions and source metadata |
| `list` | List live Herdr agents |
| `read` | Read recent output for diagnostics |
| `gc` | Prune stale pi-shepherd pane registrations |

Handles are opaque, stable serialized IDs. Callers should never construct
handles from raw pane IDs. `close` refuses any pane not recorded in the
pi-shepherd created-pane registry.

## Agent discovery and security

Definitions use VS Code custom-agent Markdown (`.md` or `.agent.md`) with YAML
frontmatter and a Markdown system prompt. Discovery precedence is:

1. `~/.pi/agent/agents/`
2. `~/.agents/agents/`
3. nearest project `.pi/agents/`
4. nearest project `.agents/agents/`
5. bundled `.pi/agents/`
6. bundled `.agents/agents/`

User-level discovery is the default. Project definitions are repo-controlled,
require explicit project/both scope, and require confirmation when interactive.
Agents retain the host user's normal pi tool permissions.

## Herdr runtime

pi-shepherd uses the `herdr` CLI and never uses an invisible subprocess
fallback. It works inside Herdr or from a plain terminal by ensuring a
headless Herdr server is available. Background tabs use `--no-focus`, preserve
the requested cwd, and remain visible for inspection.

Temporary launch/session files are retained while pi is alive and cleaned only
after the pane is confirmed gone. The pane ownership registry is the source of
truth for safe close operations.

## Slash command

`/shepherd list`, `/shepherd agents`, `/shepherd herd`, and
`/shepherd settings` remain available. The slash command no longer accepts
`<agent> <task>`; use the lifecycle tool protocol for work submission.

## Development and tests

TypeScript runs directly; there is no build step. Run the focused suite with:

```bash
npm test
```

The tests cover discovery, launch configuration, opaque registry behavior,
active-prompt enforcement, settlement/cancellation, and concurrent multi-wait.
Live Herdr verification should additionally cover idle start, non-blocking
prompt, result recovery, parallel prompts, iterative prompting, close, focus
preservation, and ownership protection.
