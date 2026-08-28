# pi-shepherd

A Herdr-native pi extension for explicit agent lifecycle orchestration.
The Shepherd is the parent pi session and orchestrator. Its herd is made up of
specialized agents (also called sheep), created from their Markdown
definitions and visible in Herdr. The model-facing surface has one umbrella
control tool plus eight composable lifecycle tools:

```text
shepherd({ action: "agents" | "herd" | "prune" })
shepherd_spawn({ agent, label, placement?, cwd?, model? }) -> agent id
shepherd_prompt(agent id, message, options) -> prompt id
shepherd_wait(prompt id | prompt ids) -> Result | Result[]
shepherd_watch(prompt id | prompt ids) -> watcher id (non-blocking)
shepherd_status(agent id) -> Status
shepherd_close(agent id) -> void
shepherd_read(target, options) -> terminal output
```

The umbrella `shepherd` tool handles cheap control-plane actions and provides
shared lifecycle guidance. The split `shepherd_<verb>` tools handle agent
creation, prompting, waiting, inspection, closing, and terminal reads.

## Lifecycle usage

`shepherd_spawn` launches an idle persistent agent. It never submits a task
and has no `stayOpen` option. The agent remains alive until explicitly closed.
By default it creates a new background tab; pass `placement: "pane_right"` or
`placement: "pane_down"` to split the current pane, or `placement: "workspace"`
to create a new workspace. The working directory and model default to the
parent session. Agent scope, project approval, and prompt-shaping options come
from Shepherd settings and the discovered agent definition. Use pi-shepherd
only when explicitly instructed because too many Herdr panes may crash pi.

```text
agent = shepherd_spawn({ agent: "scout", label: "authentication research", cwd: project })
prompt = shepherd_prompt({
  id: agent.id,
  message: "Research the authentication code",
})
result = shepherd_wait({ id: prompt.id })
shepherd_close({ id: agent.id })
```

For work that should notify the parent without blocking its current turn:

```text
watcher = shepherd_watch({ id: prompt.id })
# The call returns immediately; process the custom Shepherd follow-up when it arrives.
```

Prompt submission is non-blocking. Use `shepherd_wait` as a deterministic
synchronization point, or use `shepherd_watch` when the parent should continue
without blocking. A watcher accepts one prompt id or an array of prompt ids and
returns immediately with `watcherId`, `pending`, and any `completed` results
that were already available. Later completions arrive as a custom Shepherd
follow-up message containing the watcher id, exact prompt id and agent id,
status, return code, error, and the child's final assistant text. Array watcher
completions are delivered as they settle and close-together completions may be
coalesced into one notification; coalesced arrays preserve the watch input
order. Watchers finish automatically after all
watched prompts settle; they do not close agents. Every tool result
includes `details.returnCode`: `0` means success; `1` is a failure; `2` is blocked; `124` is a timeout; and `130` is cancelled. The spawned pane prints the effective provider-qualified child model and exact
`pi` invocation for diagnostics. For parallel
work, spawn multiple agents, prompt each one, then wait on the array of prompt ids:

```text
scoutA = shepherd_spawn({ agent: "scout", label: "authentication", ...options })
scoutB = shepherd_spawn({ agent: "scout", label: "authorization", ...options })
promptA = shepherd_prompt({ id: scoutA.id, message: "Research authentication" })
promptB = shepherd_prompt({ id: scoutB.id, message: "Research authorization" })
[resultA, resultB] = shepherd_wait({ id: [promptA.id, promptB.id] })
shepherd_close({ id: scoutA.id })
shepherd_close({ id: scoutB.id })
```

Arrays wait concurrently and preserve input order. A single agent may have
only one unresolved prompt. Sequential chains are composed by the caller:
wait for one result, include its text in the next prompt, and wait again.
Waiting never closes an agent; close agents explicitly when they are no longer
needed.

## Shepherd tools

| Tool | Purpose |
|---|---|
| `shepherd` (`agents`) | List all available agents (also called sheep) and source metadata |
| `shepherd` (`herd`) | List the live herd: agents detected in Herdr panes |
| `shepherd` (`prune`) | Remove stale pi-shepherd pane registrations |
| `shepherd_spawn` | Create an idle persistent agent in a background Herdr tab (or requested pane/workspace placement) |
| `shepherd_prompt` | Submit one message using an agent id; returns a prompt id immediately |
| `shepherd_wait` | Wait for one or many prompt ids |
| `shepherd_watch` | Register a non-blocking watcher for one or many prompt ids |
| `shepherd_status` | Inspect an agent id without focusing or mutating Herdr |
| `shepherd_close` | Explicitly close an owned agent id and cancel unresolved prompts |
| `shepherd_read` | Read recent output for diagnostics |

`read` accepts an agent name, a Herdr pane id such as `w9:p18`, or a recorded
Shepherd pane id. Herdr's opaque internal pane handle (for example, `pane-14`)
is not a pane target and cannot be read. `recent` and `recent-unwrapped` may
return empty output for idle panes with no scrollback; use `visible` for the
current viewport or `detection` for Herdr's detection view.

Lifecycle operations use short, opaque, session-scoped ids rather than public
handle objects. `shepherd_spawn` returns an agent id; `shepherd_prompt` accepts
that id and returns a prompt id; `shepherd_wait` accepts the prompt id. Status
and close accept the agent id.

```json
{"id":"shepherd-agent-abc123","message":"Inspect the authentication code."}
```

For parallel `wait`, pass an array of prompt ids:

```json
{"id":["shepherd-prompt-one","shepherd-prompt-two"]}
```

The ids are not Herdr pane ids. A pane id is only a diagnostic target for
`shepherd_read`; it is not valid for prompt, wait, status, or close. If a
lifecycle id is unknown, it may belong to another parent session or the agent
may already be gone; spawn a replacement rather than deriving an id from a
pane. `close` still refuses any pane not recorded in the pi-shepherd created-pane
registry.

Some providers wrap these arguments in an outer transport envelope such as
`{"name":"shepherd_prompt","arguments":{...}}`; that `arguments` wrapper
belongs to the provider, not Shepherd. Pass the lifecycle id as a string inside
the argument object, not as a nested handle object or quoted JSON object. If an
agent name is rejected, use `shepherd({ action: "agents" })` and copy an exact
name from that list; names are case-sensitive and depend on the selected scope.

### XML transport example

The XML wrapper belongs to the provider or adapter. Shepherd's own arguments are
still the small JSON objects shown above. For an adapter that uses an
OpenAI-style envelope, a complete sequence looks like this (the ids are
illustrative; copy the actual ids from each result):

```xml
<tool_call>
{"name":"shepherd_spawn","arguments":{"agent":"scout"}}
</tool_call>

<tool_call>
{"name":"shepherd_prompt","arguments":{"id":"shepherd-agent-abc123","message":"Inspect the authentication implementation."}}
</tool_call>

<tool_call>
{"name":"shepherd_wait","arguments":{"id":"shepherd-prompt-def456"}}
</tool_call>

<tool_call>
{"name":"shepherd_close","arguments":{"id":"shepherd-agent-abc123"}}
</tool_call>
```

An adapter may instead use a flat XML envelope such as
`<tool_call name="shepherd_prompt">{"id":"...","message":"..."}</tool_call>`;
the adapter must unwrap it before invoking the tool. Do not add `name`,
`action`, or `arguments` to Shepherd's registered parameter schema.

## Agent discovery and security

Definitions use VS Code custom-agent Markdown (`.md` or `.agent.md`) with YAML
frontmatter and a Markdown system prompt. The bundled defaults are `scout`,
`planner`, `worker`, and `reviewer`; user/project definitions can add or
override names. Discovery precedence is:

1. `~/.pi/agent/agents/`
2. `~/.agents/agents/`
3. nearest project `.pi/agents/`
4. nearest project `.agents/agents/`
5. bundled `.pi/agents/`
6. bundled `.agents/agents/`

User-level discovery is the default. Project definitions are repo-controlled,
require explicit project/both scope, and require confirmation when interactive.
The bundled set can be excluded with the "Include bundled agents" setting in
`/shepherd` (on by default). Agents retain the host user's normal pi tool
permissions.

## Parent-bound note sessions

When fieldnotes are enabled, all agents orchestrated by one parent pi session
in the same project share one persistent note session under:

```text
.shepherd/sessions/NNNN-orchestrator-<id>/
├── session.json
├── shepherd.md
└── <agent>-NN.md
```

The binding uses pi's parent `sessionManager.getSessionId()` and the parent
project root. A second `spawn` or `prompt` reuses that directory; each prompt
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
a result. If you want to collaborate directly with a specific agent—for
example, inspect its role, ask follow-up questions, guide its investigation, or
keep it available as an interactive partner—spawn an idle agent manually:

```text
/shepherd agents                # list available definitions
/shepherd spawn worker          # spawn an idle, interactive worker
```

`spawn` creates a persistent Herdr tab without submitting a task or focusing the
new tab. Switch to it in Herdr and use the child pi session directly. The child
has the selected agent's Markdown system prompt, configured tools, project
working directory, and the parent Shepherd's current model (unless the agent
definition specifies a model). It also loads the normal project context for
that working directory unless its definition sets `omitContextFiles: true`,
but it does not inherit the Shepherd's conversation history or an implicit task.

The slash command uses the same action vocabulary as the model-facing
`shepherd` tool for the supported manual actions:

```text
/shepherd agents                # list available definitions
/shepherd agents both           # include project definitions
/shepherd herd                  # list live Herdr agents
/shepherd spawn worker          # spawn an interactive worker
/shepherd status worker         # inspect an agent
/shepherd read worker --lines=20
/shepherd settings
```

`/shepherd list` and `/shepherd agents` remain accepted as compatibility
aliases for `/shepherd agents`, but `agents` is canonical. Optional `spawn` flags
include `--placement pane_right|pane_down|tab|workspace`, `--cwd <path>`, and
`--model <provider/model>`. Agent scope, project approval, and prompt-shaping
flags are not spawn arguments; they are controlled by settings and the agent
definition.

For one-shot delegation, prompting, waiting, parallel work, and opaque-id
lifecycle control, use the structured `shepherd_*` tool protocol
instead of manual commands. The old single-tool form such as
`shepherd({ action: "prompt", ... })` is no longer supported.

## Settings

Open `/shepherd` (with no arguments) or `/shepherd settings` to configure
pi-shepherd. The first menu item, **Settings scope**, selects where the
effective values come from and where edits are written:

- **User** (default) — `pi-shepherd/config.json` inside the active pi agent
  dir (`~/.pi/agent` by default; overridable with `PI_CODING_AGENT_DIR`). The
  base layer for every session, whatever directory pi runs in.
- **Project** — `.shepherd/config.json` in the current working directory (the
  same `.shepherd` root fieldnotes use; no walk-up). It is a *delta* on top of
  the user file: every field present overrides the matching user field one by
  one, and the menu writes only the fields that actually differ (an empty
  file is pure user values). Switching the scope to **project** when the file
  does not exist yet creates it as an empty delta and notifies you. The
  scope itself is always stored in the user file, since it is the pointer to
  where to look.

The menu shows the merged, effective values and includes an **Enable
fieldnotes** toggle and a **Use sheep emoji** toggle. Sheep emoji are enabled
by default; disabling the latter replaces the
animated `🐑` marker in the working-agent widget with a plain `o`. This setting
only affects the decorative sheep marker; the state symbols and box-drawing
characters remain unchanged.

The fieldnotes toggle defaults to enabled and, when enabled, creates the durable
`shepherd.md` index and one note per delegated prompt. When disabled, new agents
receive no fieldnotes context and delegated prompts do not create or update note
files; existing notes are retained. The fieldnotes toggle is intentionally
session-scoped: save the setting and start a new parent pi session for it to
apply. Agents already running in the current session retain the current
fieldnotes behavior.

## System-prompt diagnostic

For the complete diagnostic workflow, options, prompt-composition details, and
troubleshooting, see the [Diagnostics guide](docs/diagnostics.md).

Use the standalone extractor when you need to inspect the fully assembled Pi
system prompt, rather than only the Markdown contribution from an agent
definition:

```bash
# The parent Pi session (the Shepherd)
npm run extract:system-prompt -- shepherd

# A discovered child agent (also called a sheep)
npm run extract:system-prompt -- agent scout --scope both --cwd /path/to/project

# Save the raw prompt, or include diagnostic metadata as JSON
npm run extract:system-prompt -- agent scout --output /tmp/scout-system.md
npm run extract:system-prompt -- shepherd --json
```

The script starts an ephemeral `pi --mode json` process, captures the prompt at
Pi's `before_agent_start` hook, and terminates it before a provider request is
made. It therefore does not need a model response or API call. Shepherd mode
loads the parent extension; agent mode uses the discovered definition's prompt,
model, and tools. Only the requested pi-shepherd extension is loaded explicitly
so the diagnostic is deterministic. `--output` contains raw prompt text and is
written with restrictive permissions.

When pi-shepherd launches an agent normally, the Markdown body of its agent
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

To disable Pi's automatic project context-file loading for a child session, use
`omitContextFiles: true`:

```markdown
---
name: tester
description: Runs and evaluates GUI tests
omitContextFiles: true
---
```

This passes Pi's `--no-context-files` option and prevents automatic loading of
`AGENTS.md` and `CLAUDE.md` for that child session. It does not remove the
agent Markdown body, task/user prompts, Shepherd fieldnotes context (when
fieldnotes are enabled), tools, or model configuration. The property defaults
to `false` and must be a YAML boolean; quoted values such as `"true"` are ignored.

## Development and tests

TypeScript runs directly; there is no build step. Run the focused suite with:

```bash
npm test
```

The tests cover discovery, launch configuration, lifecycle id validation,
active-prompt enforcement, settlement/cancellation, and concurrent multi-wait.
Live Herdr verification should additionally cover idle spawn, non-blocking
prompt, result recovery, parallel prompts, iterative prompting, close, focus
preservation, and ownership protection.
