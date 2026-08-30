# pi-shepherd 🐑

A Herdr-native pi extension for delegating work to specialized pi agents. Let your parent session guide a visible herd of specialized sheep through research, planning, implementation, and review. A
parent pi session can start agents in visible Herdr panes, give them tasks, and
collect their results without losing control of their lifecycle.

## The terminology

- **Parent** — your current pi session, which coordinates the work.
- **Sheep** (or **agent**) — one running child pi session. “Sheep” and “agent”
  are interchangeable throughout Shepherd.
- **Herd** — the collection of all active sheep/agents.
- **Agent definition** — a Markdown file describing an agent’s role and prompt.

The names are intentionally a little playful, but the distinction matters: a
herd is the whole group; a sheep is one instance in that group.

## Requirements

- [pi](https://github.com/badlogic/pi-mono)
- [Herdr](https://github.com/MikkelKappelPersson/herdr)

## Install

Install the package using pi’s package installer:

```bash
pi install npm:@luminascale/pi-shepherd
```

Restart pi, then verify that the extension is available:

```text
/shepherd agents
```

You should see the bundled agent definitions, including `scout`, `planner`,
`worker`, and `reviewer`.

## Your first delegation

The normal one-shot workflow is:

1. Spawn a sheep.
2. Prompt it with a task.
3. Wait for its result.
4. Close it when you are finished.

For example:

```text
agent = shepherd_spawn({ agent: "scout", label: "authentication research" })

prompt = shepherd_prompt({
  id: agent.id,
  message: "Find how authentication is implemented and summarize the relevant files.",
})

result = shepherd_wait({ id: prompt.id })
shepherd_close({ id: agent.id })
```

Spawning creates an idle, persistent sheep; it does not submit a task.
Prompting is non-blocking. Waiting is the synchronization point, and waiting
does not close the sheep. Close finished sheep explicitly so your Herdr session
does not accumulate unnecessary panes.

## Common workflows

### Parallel work

Spawn and prompt multiple sheep, then wait for all prompt IDs at once:

```text
scoutA = shepherd_spawn({ agent: "scout", label: "authentication" })
scoutB = shepherd_spawn({ agent: "scout", label: "authorization" })

promptA = shepherd_prompt({ id: scoutA.id, message: "Research authentication." })
promptB = shepherd_prompt({ id: scoutB.id, message: "Research authorization." })

[resultA, resultB] = shepherd_wait({ id: [promptA.id, promptB.id] })

shepherd_close({ id: scoutA.id })
shepherd_close({ id: scoutB.id })
```

Array waits run concurrently and preserve the order of the input prompt IDs.
A single sheep may have only one unresolved prompt at a time.

### Continue working while a sheep runs

Use `shepherd_watch` when you want to continue the current turn instead of
waiting synchronously:

```text
shepherd_watch({ id: prompt.id })
```

The call returns immediately. When the prompt finishes, Shepherd sends a
follow-up containing the result. Watchers finish automatically after all their
prompts settle; they do not close sheep.

### Chat directly with a sheep

You can launch a researcher—or any other specialized sheep—and chat with it
directly in its own pi session. This is useful when you want to ask follow-up
questions, guide an investigation interactively, inspect its work as it
progresses, or keep it available as a specialist.

For example, launch the bundled researcher:

```text
/shepherd spawn scout
```

This creates a persistent Herdr tab without focusing it. Switch to the new tab
to chat directly with the scout. Each sheep has its own pi session, tools,
working directory, model, and agent-specific system prompt; it does not inherit
the parent conversation history.

### Work alongside a sheep

Manual sheep are not limited to research. Launch a `planner`, `worker`, or
`reviewer` the same way when you want a persistent specialist to work alongside
you rather than receive a single delegated task:

```text
/shepherd spawn worker
```

You can also use `/shepherd status` and `/shepherd read` to inspect a sheep
without switching to its tab.

Agent definitions are Markdown files, so you can tune a sheep’s behavior with
granular system-prompt engineering. Define its role, workflow, tools, model,
and prompt options in YAML frontmatter and the Markdown body. For example:

```markdown
---
name: tester
description: Runs and evaluates GUI tests
omitPiDocumentation: true
omitContextFiles: true
---

You are a focused GUI testing specialist. Report reproducible failures
with exact steps and useful evidence.
```

Use the diagnostic extractor when you need to see the fully assembled prompt
that pi will give the parent or a discovered sheep:

```bash
npm run extract:system-prompt -- shepherd
npm run extract:system-prompt -- agent scout --scope both --cwd /path/to/project
npm run extract:system-prompt -- agent scout --output /tmp/scout-system.md
npm run extract:system-prompt -- shepherd --json
```

This captures the prompt at pi’s `before_agent_start` hook without making a
provider request. For the full prompt-composition workflow and troubleshooting,
see the [Diagnostics guide](docs/diagnostics.md).

### Inspect the active herd

```text
/shepherd herd
```

The command lists all active sheep currently detected in Herdr. For one sheep,
use `/shepherd status` or `/shepherd read`.

## Placement and lifecycle tools

By default, `shepherd_spawn` creates a background Herdr tab. You can request a
pane or workspace placement:

```text
shepherd_spawn({
  agent: "worker",
  label: "implementation",
  placement: "pane_right", // pane_right, pane_down, tab, or workspace
})
```

The working directory and model default to the parent session. `cwd` and
`model` can be supplied when spawning. Agent scope, project approval, and
prompt-shaping options come from Shepherd settings and the discovered agent
definition; they are not spawn overrides.

The model-facing tools are:

| Tool | Purpose |
|---|---|
| `shepherd` (`agents`) | List available agent definitions |
| `shepherd` (`herd`) | List all active sheep in Herdr |
| `shepherd` (`prune`) | Remove stale pane registrations |
| `shepherd_spawn` | Create an idle persistent sheep |
| `shepherd_prompt` | Submit a task; returns immediately with a prompt ID |
| `shepherd_wait` | Wait for one or more prompt IDs |
| `shepherd_watch` | Receive completion without blocking the current turn |
| `shepherd_status` | Inspect a sheep without focusing its pane |
| `shepherd_close` | Close an owned sheep and cancel unresolved prompts |
| `shepherd_read` | Read recent terminal output for diagnostics |

Lifecycle tools use short, opaque, session-scoped IDs:

```text
shepherd_spawn -> agent ID
shepherd_prompt -> prompt ID
shepherd_wait -> result
```

Use the returned agent ID for `status` and `close`, and the returned prompt ID
for `wait` and `watch`. Do not substitute a Herdr pane ID for a lifecycle ID.
Pane IDs are only diagnostic targets for `shepherd_read`.

## Manual commands

The slash command is useful when you want to manage a sheep directly rather than
ask the parent model to orchestrate a task:

```text
/shepherd agents                # list available definitions
/shepherd agents both           # include project definitions
/shepherd herd                  # list the active herd
/shepherd spawn worker          # spawn an interactive sheep
/shepherd status worker         # inspect a sheep
/shepherd read worker --lines=20
/shepherd settings
```

Supported actions are `agents`, `herd`, `prune`, `spawn`, `status`, `read`, and
`settings`. `/shepherd list` remains a compatibility alias for
`/shepherd agents`. Optional spawn flags include:
`--placement pane_right|pane_down|tab|workspace`, `--cwd <path>`, and
`--model <provider/model>`.

For one-shot delegation, prompting, waiting, parallel work, and opaque-ID
lifecycle control, use the structured `shepherd_*` tools instead of manual
commands. The old single-tool form such as
`shepherd({ action: "prompt", ... })` is no longer supported.

## Agent definitions and discovery

Agent definitions use VS Code custom-agent Markdown (`.md` or `.agent.md`) with
YAML frontmatter and a Markdown system prompt. The bundled definitions are:

- `scout` — fast codebase investigation
- `planner` — planning and decomposition
- `worker` — implementation work
- `reviewer` — review and verification

User and project definitions can add or override these names. Discovery
precedence is:

1. `~/.pi/agent/agents/`
2. `~/.agents/agents/`
3. nearest project `.pi/agents/`
4. nearest project `.agents/agents/`
5. bundled `.pi/agents/`
6. bundled `.agents/agents/`

User-level discovery is the default. Project definitions are repo-controlled,
require explicitly selecting project/both scope, and require confirmation when
running interactively. The bundled definitions can be disabled from settings.
Agents retain the host user’s normal pi tool permissions.

## Settings

Open `/shepherd` or `/shepherd settings` to configure pi-shepherd. Settings
include:

- **Settings scope** — use user settings or a project delta
- **Include bundled agents** — enabled by default
- **Enable fieldnotes** — enabled by default
- **Use sheep emoji** — controls the decorative working-agent marker

User settings are stored in `pi-shepherd/config.json` inside the active pi
agent directory (`~/.pi/agent` by default, or `PI_CODING_AGENT_DIR`). Project
overrides are stored in `.shepherd/config.json` in the current working
directory. Project configuration is a field-by-field delta over the user
configuration; the settings scope itself is always stored in the user file.

## Fieldnotes

When fieldnotes are enabled, all sheep orchestrated by one parent session in the
same project share a durable note session:

```text
.shepherd/sessions/NNNN-orchestrator-<id>/
├── session.json
├── shepherd.md
└── <agent>-NN.md
```

`shepherd.md` is the shared index, and each delegated prompt receives its own
note. Notes are retained after waiting, closing, timeout, or extension restart;
pi-shepherd does not automatically delete, archive, commit, or check them out.
The fieldnotes setting is session-scoped, so start a new parent pi session after
changing it. Existing sheep retain the current session’s behavior.

## Troubleshooting

### No agents are listed

Try:

```text
/shepherd agents both
```

Also check that bundled agents are enabled in `/shepherd settings`.

### A sheep is not responding

Inspect its state and terminal output:

```text
/shepherd status <agent>
/shepherd read <agent>
```

### There are too many Herdr panes

The slash command does not close lifecycle-managed sheep. Use
`shepherd_close` with the agent ID returned by `shepherd_spawn`:

```text
shepherd_close({ id: agent.id })
```

### I need prompt or transport diagnostics

See the [Diagnostics guide](docs/diagnostics.md) for the complete system-prompt
extraction workflow, transport details, prompt composition, and troubleshooting.

## Herdr runtime and safety

pi-shepherd uses the `herdr` CLI and never uses an invisible subprocess fallback.
It works inside Herdr or from a plain terminal by ensuring a headless Herdr
server is available. Background tabs use `--no-focus`, preserve the requested
working directory, and remain visible for inspection.

Only panes recorded in pi-shepherd’s created-pane registry may be closed by the
extension. Temporary launch and session resources are cleaned only after the
child pane is confirmed gone.

## Development and tests

TypeScript runs directly; there is no build step. Run the test suite with:

```bash
npm test
```

The tests cover discovery, launch configuration, lifecycle ID validation,
active-prompt enforcement, settlement/cancellation, concurrent waits,
watchers, fieldnote sessions, settings, and the parent extension surface.
