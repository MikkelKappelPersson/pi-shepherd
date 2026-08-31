# pi-shepherd

pi-shepherd is a no-fuss extension for native, low-level Herdr agent orchestration. The **Shepherd**—your main pi session—can launch and coordinate specialized agents in visible Herdr panes, while shared session fieldnotes (artifacts) let agents share context across delegated work.

## Key Features

-   **Native, no-fuss, low-level Herdr agent orchestration** — Shepherd uses native Herdr panes for all agents and simple, open primitives for agent orchestration. Everything is visible and inspectable. Shepherd does not impose a workflow; it gives you the tools to build your own.
-   **Herdr headless support** — work inside Herdr or from a plain terminal while keeping launched agents visible and inspectable in Herdr.
-   **Granular system-prompt and agent-context support** — Shepherd goes beyond standard definitions and utilises pi's open system-prompt. Shepherd agents can be defined with granular control over context for very specific and narrow agent and context control.
-   **Manual agent launch** — start an interactive specialist directly with `/shepherd spawn` and chat with it in its own pi session.
-   **Shared pi-session fieldnotes (artifacts)** — give agents a durable shared place to leave notes and share context across delegated work.

## Requirements

-   [pi](https://github.com/earendil-works/pi)
-   [Herdr](https://github.com/herdrdev/herdr)
-   Node.js 22 or newer

## Install

Install the package using pi’s package installer:

```bash
pi install npm:@luminascale/pi-shepherd
```

Reload pi, then verify that the extension is available:

```text
/shepherd agents
```

You should see the bundled agent definitions, including `scout`, `planner`, `worker`, and `reviewer`.

## Available tools

pi-shepherd exposes these tools to the Shepherd. You can use them explicitly when you need precise control, but ordinary natural-language requests are the recommended starting point:

| Tool | Purpose |
| --- | --- |
| `shepherd` | List definitions (`agents`), list active agents (`herd`), or remove stale pane registrations (`prune`) |
| `shepherd_spawn` | Create an idle persistent agent |
| `shepherd_prompt` | Submit a task; returns immediately with a prompt ID |
| `shepherd_wait` | Wait for one or more prompt IDs |
| `shepherd_watch` | Receive completion without blocking the current turn |
| `shepherd_status` | Inspect an agent without focusing its pane |
| `shepherd_close` | Close an owned agent and cancel unresolved prompts |
| `shepherd_read` | Read recent terminal output for diagnostics |

## Your first delegation

You do not need to call Shepherd’s tools yourself. After restarting pi, describe the work you want done in your normal conversation, or nudge the Shepherd to delegate it explicitly. Phrases such as “use Shepherd,” “ask the herd,” “ask a sheep,” “delegate this,” “orchestrate a review,” or “use a subagent” are all natural-language requests; no special syntax is required. For example:

> Ask a planner to create an implementation plan for adding authentication, including the relevant files and recommended steps.

The Shepherd starts the planner in a visible Herdr tab, gives it the task, collects its result, and reports back to you. This is the recommended one-shot workflow. Shepherd’s structured tools are still available when you need explicit lifecycle control, parallel work, or want to inspect what the Shepherd is doing; see [Placement and lifecycle](#placement-and-lifecycle) below.

### Work directly with a specialist agent

If you would rather work with a specialist directly, use the human command surface described in the [Command reference](#command-reference). Switch to the new Herdr tab to chat with the planner. Spawning creates an idle, persistent agent; it does not submit a task. Close interactive agents when you are finished so your Herdr session does not accumulate unnecessary panes.

## Common workflows

### Sequential work

Use sequential delegation when one agent’s result should inform the next agent’s task. Describe the handoff in your request:

> Ask a planner to create an implementation plan for adding authentication. Once it has finished, give its plan to a worker and ask the worker to implement the feature. Return the implementation result when it is complete.

The Shepherd waits for the planner before starting the worker and passes the planner’s result along as context. This is useful for plan-then-implement, research-then-review, or any workflow with a clear handoff.

### Parallel work

Use parallel delegation when tasks are independent. Ask the Shepherd to delegate them together:

> Ask two scouts to work in parallel: have one research how authentication is implemented and the other research authorization. Wait for both results, then summarize the findings and explain any relevant connections.

The Shepherd runs the independent tasks concurrently and combines their results. This is useful for comparing approaches, investigating separate parts of a codebase, or getting multiple reviews of the same change.

### Continue working while an agent runs

Use `shepherd_watch` when you want to continue the current turn instead of waiting synchronously:

```text
shepherd_watch({ id: prompt.id })
```

The call returns immediately. When the prompt finishes, Shepherd sends a follow-up containing the result. Watchers finish automatically after all their prompts settle; they do not close agents.

## Agent definitions

Agent definitions are Markdown files, so you can tune an agent’s behavior with granular system-prompt engineering. Define its role, workflow, tools, model, and prompt options in YAML frontmatter and the Markdown body. The supported frontmatter fields are:

| Field | Values | Default | Description |
| --- | --- | --- | --- |
| **`name`** | String | — | The agent’s name. **Required.** |
| **`description`** | String | — | A short description shown during discovery. **Required.** |
| **`tools`** | Comma-separated string or YAML list | pi’s default tools | Tools available to the agent. |
| **`model`** | Provider-qualified model, `null`, or `default` | Shepherd’s model | Select the model, for example `anthropic/claude-sonnet-4-5`. `null`, `default`, or omission inherits the Shepherd’s model. |
| **`omit-system-prompt`** | `true`, `false` | `false` | Omit pi’s built-in system prompt when `true`. |
| **`omit-pi-documentation`** | `true`, `false` | `false` | Omit pi’s built-in documentation guidance when `true`. |
| **`omit-context-files`** | `true`, `false` | `false` | Omit automatic `AGENTS.md` and `CLAUDE.md` context-file loading when `true`. |
| **`user-invocable`** | `true`, `false` | `true` | Indicate whether the agent is intended to be directly invoked by a user. |

For example:

```markdown
---
name: tester
description: Runs and evaluates GUI tests
tools: read, grep, find
model: anthropic/claude-sonnet-4-5
omit-system-prompt: false
omit-pi-documentation: true
omit-context-files: true
user-invocable: true
---

You are a focused GUI testing specialist. Report reproducible failures
with exact steps and useful evidence.
```


### Bundled definitions and discovery

The bundled agent definitions are:

-   `scout` — fast codebase investigation
-   `planner` — planning and decomposition
-   `worker` — implementation work
-   `reviewer` — review and verification

User and project definitions can add or override these names. Discovery precedence is:

1.  `~/.pi/agent/agents/`
2.  `~/.agents/agents/`
3.  nearest project `.pi/agents/`
4.  nearest project `.agents/agents/`
5.  bundled `.pi/agents/`
6.  bundled `.agents/agents/`

User-level discovery is the default. Project definitions are repo-controlled, require explicitly selecting project/both scope, and require confirmation when running interactively. The bundled definitions can be disabled from settings. Agents retain the host user’s normal pi tool permissions.

## Placement and lifecycle

By default, `shepherd_spawn` creates a background Herdr tab. You can request a pane or workspace placement:

```text
shepherd_spawn({
  agent: "worker",
  label: "implementation",
  placement: "pane_right", // pane_right, pane_down, tab, or workspace
})
```

The working directory and model default to the Shepherd session. `cwd` and `model` can be supplied when spawning. Agent scope, project approval, and prompt-shaping options come from Shepherd settings and the discovered agent definition; they are not spawn overrides.

Lifecycle tools use short, opaque, session-scoped IDs:

```text
shepherd_spawn -> agent ID
shepherd_prompt -> prompt ID
shepherd_wait -> result
```

Use the returned agent ID for `status` and `close`, and the returned prompt ID for `wait` and `watch`. Do not substitute a Herdr pane ID for a lifecycle ID. Pane IDs are only diagnostic targets for `shepherd_read`.

## Command reference

The slash command is useful when you want to manage an agent directly rather than ask the Shepherd to orchestrate a task:

```text
/shepherd agents                # list available definitions
/shepherd agents both           # include project definitions
/shepherd herd                  # list active agents
/shepherd spawn worker          # spawn an interactive agent
/shepherd status worker         # inspect an agent
/shepherd read worker --lines=20
/shepherd settings
```

Supported actions are `agents`, `herd`, `prune`, `spawn`, `status`, `read`, and `settings`. `/shepherd list` remains a compatibility alias for `/shepherd agents`. Optional spawn flags include: `--placement pane_right|pane_down|tab|workspace`, `--cwd <path>`, and `--model <provider/model>`.

For one-shot delegation, prompting, waiting, parallel work, and opaque-ID lifecycle control, use the structured `shepherd_*` tools instead of manual commands. The old single-tool form such as `shepherd({ action: "prompt", ... })` is no longer supported.

## Settings

Open `/shepherd` or `/shepherd settings` to configure pi-shepherd. The menu shows the effective values currently in use; use the arrow keys and Enter to cycle values, and `Esc` to close it. The following options are available:

| Option | Values | Default | Description |
| --- | --- | --- | --- |
| **Settings scope** (`settingsScope`) | `user`, `project` | `user` | Select whether values come from the user configuration or the project delta. This pointer is always stored in the user configuration. |
| **Agent scope** (`agentScope`) | `user`, `project`, `both` | `user` | Select which agent definition directories are searched. Project agents are repo-controlled. |
| **Include bundled agents** (`includeBundledAgents`) | on, off | on | Include the built-in `scout`, `planner`, `worker`, and `reviewer` definitions in discovery. |
| **Confirm project agents** (`confirmProjectAgents`) | on, off | on | Prompt before running project-local agent definitions. Disable only for projects and definitions you trust. |
| **Keep tab open after done** (`keepOpen`) | on, off | on | Leave the Herdr tab open after an agent completes so its output can be inspected. |
| **Keep agent alive after done** (`stayOpen`) | on, off | off | Keep the agent's pi process alive after completion so you can continue driving it in its tab. |
| **Enable fieldnotes** (`fieldnotes`) | on, off | on | Create durable shared session notes for delegated prompts. Changes take effect when the next pi session starts. |
| **Use sheep emoji** (`emojiSheep`) | on, off | on | Show the animated `🐑` marker beside actively working agents; off uses a plain marker instead. |
| **Default run timeout** (`timeout`) | `1`, `2`, `5`, `10`, `20`, `30`, or `60` minutes | `20` minutes | Set the default time limit before a Herdr run is reported as timed out. |
| **Stale wait reminder** (`staleWaitThreshold`) | `off`, `1`, `2`, `5`, `10`, `15`, or `30` minutes | `5` minutes | A task waiting longer than this on a required reply raises one stale-wait reminder. `off` disables reminders; reminders never cancel or block the task. |

The settings menu also supports fuzzy search with `/`. Configuration is validated when read; invalid or missing values fall back to the next layer or the defaults above.

### Stale-wait reminders

When a delegated task is **waiting** on a required reply (set with `shepherd_message` + `expectsReply`, or set by the child asking another participant), it can sit there for a while if the target is busy. `staleWaitThreshold` controls how long a task may wait before the parent receives a **single** stale-wait reminder naming the task, the question, the target, and how long it has been waiting. The reminder is informational: it never cancels, times out, or blocks the task. The task's own reply deadline (`timeout`) remains the authoritative bound and settles the task as `blocked` if the reply never comes. A reply (or the task resuming/completing) clears the episode, so the same wait never re-notifies while open.

User settings are stored in `pi-shepherd/config.json` inside the active pi agent directory (`~/.pi/agent` by default, or `PI_CODING_AGENT_DIR`). Project overrides are stored in `.shepherd/config.json` in the current working directory. Project configuration is a field-by-field delta over the user configuration: only values different from the user layer are written, and unset fields continue to inherit from it. The settings scope itself is always stored in the user file. A project configuration therefore requires selecting the `project` settings scope; project files are not searched by default.

For example, a user configuration can contain:

```json
{
  "settingsScope": "user",
  "agentScope": "both",
  "includeBundledAgents": true,
  "confirmProjectAgents": true,
  "keepOpen": true,
  "stayOpen": false,
  "fieldnotes": true,
  "emojiSheep": true,
  "timeout": 20,
  "staleWaitThreshold": 5
}
```

## Diagnostic tools

These commands are primarily useful for contributors and local development checkouts. Use the diagnostic extractor when you need to see the fully assembled prompt that pi will give the Shepherd or a discovered agent:

```bash
npm run extract:system-prompt -- shepherd
npm run extract:system-prompt -- agent scout --scope both --cwd /path/to/project
npm run extract:system-prompt -- agent scout --output /tmp/scout-system.md
npm run extract:system-prompt -- shepherd --json
```

This captures the prompt at pi’s `before_agent_start` hook without making a provider request. For the full prompt-composition workflow and troubleshooting, see the [Diagnostics guide](docs/diagnostics.md).

### Inspect active agents

```text
/shepherd herd
```

The command lists all active agents currently detected in Herdr. For one agent, use `/shepherd status` or `/shepherd read`.

## Fieldnotes

When fieldnotes are enabled, all agents orchestrated by one Shepherd session in the same project share a durable note session:

```text
.shepherd/sessions/NNNN-orchestrator-<id>/
├── session.json
├── shepherd.md
└── <agent>-NN.md
```

`shepherd.md` is the shared index, and each delegated prompt receives its own note. Notes are retained after waiting, closing, timeout, or extension restart; pi-shepherd does not automatically delete, archive, commit, or check them out. The fieldnotes setting is session-scoped, so start a new Shepherd session after changing it. Existing agents retain the current session’s behavior.

## Troubleshooting

### An agent is not responding

Inspect its state and terminal output:

```text
/shepherd status <agent>
/shepherd read <agent>
```

### There are too many Herdr panes

The slash command does not close lifecycle-managed agents. Use `shepherd_close` with the agent ID returned by `shepherd_spawn`:

```text
shepherd_close({ id: agent.id })
```

### There are stale pane registrations

Remove registrations for panes that no longer exist:

```text
/shepherd prune
```

## Herdr runtime and safety

pi-shepherd uses the `herdr` CLI and never uses an invisible subprocess fallback. It works inside Herdr or from a plain terminal by ensuring a headless Herdr server is available. Background tabs use `--no-focus`, preserve the requested working directory, and remain visible for inspection.

Only panes recorded in pi-shepherd’s created-pane registry may be closed by the extension. Temporary launch and session resources are cleaned only after the child pane is confirmed gone.

## Contributing

For development setup, testing instructions, and contribution guidelines, see
[CONTRIBUTING.md](CONTRIBUTING.md).
