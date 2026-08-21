# pi-shepherd

A Herdr-native pi extension for explicit sheep lifecycle orchestration.
The Shepherd is the parent pi session and orchestrator. Its herd is made up of
sheep—created workers conventionally called agents or subagents—visible in Herdr
and controlled through five composable primitives:

```text
start(agent, options) -> AgentHandle
prompt(agentHandle, message, options) -> PromptHandle
wait(promptHandle | promptHandles) -> Result | Result[]
status(agentHandle) -> Status
close(agentHandle) -> void
```

The model-facing `shepherd` tool also retains diagnostic/operational actions:
`sheep`, `herd`, `read`, and `prune`.

## Lifecycle usage

`start` launches an idle persistent sheep. It never submits a task and has no
`stayOpen` option. The sheep remains alive until explicitly closed. By default it
creates a new background tab; pass `placement: "pane"` to split the current
pane, or `placement: "workspace"` to create a new workspace. Pane placement
uses a right split by default; pass `direction: "down"` for a pane below.
Use pi-shepherd
only when explicitly instructed because too many Herdr panes may crash pi.

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
parallel work, start multiple sheep, prompt each one, then wait on the array:

```text
scoutA = start("scout", options)
scoutB = start("scout", options)
promptA = prompt(scoutA, "Research authentication")
promptB = prompt(scoutB, "Research authorization")
[resultA, resultB] = wait([promptA, promptB])
close(scoutA)
close(scoutB)
```

Arrays wait concurrently and preserve input order. A single sheep may have
only one unresolved prompt. Sequential chains are composed by the caller:
wait for one result, include its text in the next prompt, and wait again.
Waiting never closes a sheep.

## Shepherd actions

| Action | Purpose |
|---|---|
| `start` | Create an idle persistent sheep in a background Herdr tab (or requested pane/workspace placement) |
| `prompt` | Submit one message using an `AgentHandle`; returns immediately |
| `wait` | Wait for one or many `PromptHandle`s |
| `status` | Inspect a handle without focusing or mutating Herdr |
| `close` | Explicitly close an owned sheep and cancel unresolved prompts |
| `sheep` | List available sheep (agent/subagent) definitions and source metadata |
| `herd` | List the live herd: sheep detected in Herdr panes |
| `read` | Read recent output for diagnostics |
| `prune` | Remove stale pi-shepherd pane registrations |

`read` accepts a sheep name, a Herdr pane id such as `w9:p18`, or a recorded
Shepherd pane id. Herdr's opaque internal pane handle (for example, `pane-14`)
is not a pane target and cannot be read. `recent` and `recent-unwrapped` may
return empty output for idle panes with no scrollback; use `visible` for the
current viewport or `detection` for Herdr's detection view.

Handles are stable objects returned in the tool result's `details.handle`.
The canonical handle syntax is to pass that complete native object unchanged
to the next lifecycle action. Do not pass only its `id`, manually JSON-encode it,
or reconstruct it from raw Herdr pane IDs. The model-facing tool has a narrow
transport-compatibility step that recovers when a provider encodes the nested
`handle` field as JSON text before validation. It also normalizes stringified
boolean and integer option values from transports that incorrectly serialize
primitive arguments; native JSON booleans and numbers remain preferred. For example:

```json
{
  "action": "prompt",
  "handle": {
    "id": "shepherd-agent-...",
    "agent": "worker",
    "paneId": "..."
  },
  "message": "Say hi"
}
```

Do not pass a different field such as `name`, `task`, an id string, a JSON
string, or a raw Herdr pane ID. For parallel `wait`, pass one native array of
the complete prompt handle objects returned by the two `prompt` actions; do not
manually stringify the array. If the tool reports an invalid handle shape, retry using
the exact native object from `details.handle`. `close` refuses any pane not recorded
in the pi-shepherd created-pane registry.

## Sheep discovery and security

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
Sheep retain the host user's normal pi tool permissions.

## Parent-bound note sessions

All sheep orchestrated by one parent pi session in the same project share one
persistent note session under:

```text
.shepherd/sessions/NNNN-orchestrator-<id>/
├── session.json
├── shepherd.md
└── <agent>-NN.md
```

The binding uses pi's parent `sessionManager.getSessionId()` and the parent
project root. A second `start` or `prompt` reuses that directory; each prompt
gets a distinct note linked from the `shepherd.md` fieldnotes collection. Child pi
JSONL files, Herdr panes, and lifecycle handles are execution state only.
Notes are retained after `wait`, `close`, timeout, and extension restart;
pi-shepherd does not automatically delete, archive, commit, or check out them.
Children receive the assigned note and shared fieldnotes paths in their prompt
context and must write only to their assigned note.

## Herdr runtime

pi-shepherd uses the `herdr` CLI and never uses an invisible subprocess
fallback. It works inside Herdr or from a plain terminal by ensuring a
headless Herdr server is available. Background tabs use `--no-focus`, preserve
the requested cwd, and remain visible for inspection.

Temporary launch/session files are retained while pi is alive and cleaned only
after the pane is confirmed gone. The pane ownership registry is the source of
truth for safe close operations.

## Manual commands

Sometimes you do not want the Shepherd to delegate a one-shot task and collect
a result. If you want to collaborate directly with a specific sheep—for
example, inspect its role, ask follow-up questions, guide its investigation, or
keep it available as an interactive partner—start an idle sheep manually:

```text
/shepherd sheep                 # list available definitions
/shepherd start worker          # start an idle, interactive worker
```

`start` creates a persistent Herdr tab without submitting a task or focusing the
new tab. Switch to it in Herdr and use the child pi session directly. The child
has the selected agent's Markdown system prompt, configured tools, project
working directory, and the parent Shepherd's current model (unless the agent
definition specifies a model). It also loads the normal project context for
that working directory, but it does not inherit the Shepherd's conversation
history or an implicit task.

The slash command uses the same action vocabulary as the model-facing
`shepherd` tool for the supported manual actions:

```text
/shepherd sheep                 # list available definitions
/shepherd sheep both            # include project definitions
/shepherd herd                  # list live Herdr agents
/shepherd start worker          # start an interactive worker
/shepherd settings
```

`/shepherd list` and `/shepherd agents` remain accepted as compatibility
aliases for `/shepherd sheep`, but `sheep` is canonical. Optional `start` flags
include `--scope user|project|both`, `--placement pane|tab|workspace`,
`--direction right|down`, `--cwd <path>`, `--model <provider/model>`, and
`--omit-system-prompt`.

For one-shot delegation, prompting, waiting, parallel work, and opaque
handle-safe lifecycle control, use the structured `shepherd` tool protocol
instead of manual commands.

## System-prompt diagnostic

For the complete diagnostic workflow, options, prompt-composition details, and
troubleshooting, see the [Diagnostics guide](docs/diagnostics.md).

Use the standalone extractor when you need to inspect the fully assembled Pi
system prompt, rather than only the Markdown contribution from an agent
definition:

```bash
# The parent Pi session (the Shepherd)
npm run extract:system-prompt -- shepherd

# A discovered child agent (a sheep)
npm run extract:system-prompt -- sheep scout --scope both --cwd /path/to/project

# Save the raw prompt, or include diagnostic metadata as JSON
npm run extract:system-prompt -- sheep scout --output /tmp/scout-system.md
npm run extract:system-prompt -- shepherd --json
```

The script starts an ephemeral `pi --mode json` process, captures the prompt at
Pi's `before_agent_start` hook, and terminates it before a provider request is
made. It therefore does not need a model response or API call. Shepherd mode
loads the parent extension; sheep mode uses the discovered definition's prompt,
model, and tools. Only the requested pi-shepherd extension is loaded explicitly
so the diagnostic is deterministic. `--output` contains raw prompt text and is
written with restrictive permissions.

When pi-shepherd launches a sheep normally, the Markdown body of its agent
file replaces Pi's generic leading identity paragraph. For example, scout
starts with `You are a scout. Quickly investigate a codebase ...`, rather than
`You are an expert coding assistant ...`; the rest of Pi's built-in tools and
instructions remain available. The body is inserted only once. An agent can opt out of Pi's documentation
guidance with camelCase frontmatter; the default is `false`:

```markdown
---
name: scout
description: Fast codebase recon
omitPiDocumentation: true
---
```

This removes only the `Pi documentation ...` section from the built-in prompt;
project instructions, skills, tools, and the agent file body remain available.

## Development and tests

TypeScript runs directly; there is no build step. Run the focused suite with:

```bash
npm test
```

The tests cover discovery, launch configuration, strict handle-shape validation,
active-prompt enforcement, settlement/cancellation, and concurrent multi-wait.
Live Herdr verification should additionally cover idle start, non-blocking
prompt, result recovery, parallel prompts, iterative prompting, close, focus
preservation, and ownership protection.
