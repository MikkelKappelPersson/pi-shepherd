# Diagnostics

This guide explains how to inspect the system prompts assembled by Pi and
pi-shepherd. It is useful when checking agent discovery, prompt composition,
Pi documentation guidance, project instructions, or an agent's configured
model and tools.

## Quick start

Run these commands from the pi-shepherd repository root:

```bash
# Inspect the parent Pi session (the Shepherd)
npm run extract:system-prompt -- shepherd

# Inspect a discovered child agent (also called a sheep)
npm run extract:system-prompt -- agent scout
```

The prompt is written to standard output. To save the raw prompt instead:

```bash
npm run extract:system-prompt -- agent scout \
  --output /tmp/scout-system-prompt.md
```

To receive metadata together with the prompt as JSON:

```bash
npm run extract:system-prompt -- shepherd --json
```

## What is captured

The extractor starts an ephemeral `pi --mode json` process and captures the
fully assembled prompt from Pi's `before_agent_start` hook. It stops the
process immediately after capture, before the first provider request, so this
diagnostic does not require a model response or an API call.

There are two modes:

- `shepherd` loads the pi-shepherd parent extension and captures the parent
  session's assembled prompt.
- `agent <agent>` resolves the named agent using pi-shepherd discovery, then
  captures a child session using that agent's prompt, model, and tools.

Only the extension required by the selected mode is loaded explicitly. This
keeps the diagnostic deterministic and avoids accidentally loading a second
copy of pi-shepherd from the installed Pi extensions.

The captured prompt can include more than the Markdown body of an agent
file—for example Pi's built-in instructions, project context, skills, tool
guidance, and pi-shepherd's prompt adjustments.

## Agent discovery options

By default, agents are discovered from the user scope. Use `--scope project` or
`--scope both` when you need project-controlled definitions:

```bash
npm run extract:system-prompt -- agent scout --scope both
npm run extract:system-prompt -- agent scout --scope project \
  --cwd /path/to/project
```

`--cwd` controls discovery and the project context used by the diagnostic
session. The default is the current working directory.

The regular discovery precedence is preserved: user definitions take
precedence over project definitions, followed by bundled definitions. If the
agent cannot be found, the command reports an error and exits without
capturing a prompt.

## Inspecting only the Shepherd contribution

If the fully assembled prompt is more detail than you need, use the narrower
agent-prompt diagnostic:

```bash
npm run show:shepherd-prompt -- scout
npm run show:shepherd-prompt -- scout --scope both --cwd /path/to/project
npm run show:shepherd-prompt -- scout --raw
```

This command reads the discovered agent definition directly. It shows the
Markdown system-prompt body and launch mode, but not Pi's built-in prompt,
project context, skills, or tool instructions.

Use this command to answer questions such as:

- Which agent definition was selected?
- Where did it come from?
- Is it being appended or used as a replacement?
- What exact Markdown body is being passed to the child?

Use `extract:system-prompt` when you need to answer how that body combines
with the rest of the child session's prompt.

## Useful extractor options

```text
--cwd <path>       Working directory for discovery and Pi (default: current)
--scope <scope>    user, project, or both (agent mode; default: user)
--output <path>    Save raw prompt to this path as well as stdout
--json             Print metadata and prompt as JSON
--model <model>    Override the diagnostic model
--prompt <text>    Use a custom harmless diagnostic user message
--timeout <sec>    Startup timeout in seconds (default: 20)
--pi <command>     Pi executable to run (default: pi)
```

For example, to compare a project prompt with a user prompt and record the
source metadata:

```bash
npm run extract:system-prompt -- agent scout \
  --scope both \
  --cwd /path/to/project \
  --json > /tmp/scout-system-prompt.json
```

The `--output` file contains only the raw prompt and is written with
restrictive permissions. JSON output is intended for inspection or automation;
its `systemPrompt` field contains the same captured prompt.

## Prompt composition details

When pi-shepherd launches an agent, the agent Markdown body replaces Pi's
generic leading identity paragraph unless the agent opts into a different
configuration. The remaining Pi instructions and context stay available.

An agent can omit only Pi's documentation guidance with frontmatter such as:

```markdown
---
name: scout
description: Fast codebase recon
omitPiDocumentation: true
---
```

This does not remove project instructions, skills, tools, or the agent body.

To inspect a child without Pi's automatic project context files, set the exact
camelCase frontmatter property to a YAML boolean:

```markdown
---
name: tester
description: Runs and evaluates GUI tests
omitContextFiles: true
---
```

This makes both a normal Shepherd launch and this diagnostic pass
`--no-context-files`, disabling automatic `AGENTS.md` and `CLAUDE.md` loading
for the child Pi session. The agent Markdown body, task/user prompt, Shepherd
fieldnotes context (when fieldnotes are enabled), configured tools, and model are unchanged. The property
is `false` by default; `omitContextFiles: false` leaves normal loading enabled,
and quoted values such as `"true"` are ignored.

The extractor is the easiest way to verify the effective result rather than
inferring it from the agent file alone.

## Troubleshooting

### Agent not found

Try listing available agents and check the scope and working directory:

```text
/shepherd agents
/shepherd agents both
```

Then rerun the extractor with `--scope both` and, if needed, `--cwd` pointing
to the project containing the definition.

### Timeout waiting for capture

Confirm that the `pi` executable is available and increase the timeout:

```bash
npm run extract:system-prompt -- shepherd --timeout 60
```

Use `--pi <command>` if Pi is not available as `pi` on `PATH`. Any diagnostic
startup errors are printed by the extractor.

### Unexpected prompt contents

Compare the two diagnostics:

1. `show:shepherd-prompt` verifies the selected agent definition and its exact
   body.
2. `extract:system-prompt` verifies the final assembled prompt, including Pi
   and project context.

Also check `--cwd`, `--scope`, and whether a higher-precedence user definition
has the same agent name.
