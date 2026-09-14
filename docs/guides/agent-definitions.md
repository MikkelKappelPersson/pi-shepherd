# Agent definitions

Agent definitions are Markdown files with YAML frontmatter followed by the agent's instructions. They control an agent's role, tools, model, and prompt composition.

| Field | Values | Default | Description |
| --- | --- | --- | --- |
| `name` | String | — | Agent name. **Required.** |
| `description` | String | — | Description shown during discovery. **Required.** |
| `tools` | Comma-separated string or YAML list | pi's default tools | Tools available to the agent. |
| `model` | Provider-qualified model, `null`, or `default` | Shepherd's model | For example, `anthropic/claude-sonnet-4-5`. Omission, `null`, and `default` inherit the Shepherd's model. |
| `thinking` | `default`, `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` | Shepherd's level | Omission, `null`, empty, and `default` inherit the Shepherd's current thinking level. Pi clamps unsupported levels to the child model's capabilities. |
| `omit-system-prompt` | `true`, `false` | `false` | Omit pi's built-in system prompt. |
| `omit-pi-documentation` | `true`, `false` | `false` | Omit pi's built-in documentation guidance. |
| `omit-context-files` | `true`, `false` | `false` | Omit automatic `AGENTS.md` and `CLAUDE.md` loading. |
| `user-invocable` | `true`, `false` | `true` | Whether the agent is intended for direct user invocation. |

Example:

```markdown
---
name: tester
description: Runs and evaluates GUI tests
tools: read, grep, find
model: anthropic/claude-sonnet-4-5
thinking: high
omit-system-prompt: false
omit-pi-documentation: true
omit-context-files: true
user-invocable: true
---

You are a focused GUI testing specialist. Report reproducible failures
with exact steps and useful evidence.
```

`thinking` is a requested level. Pi clamps it to a level supported by the
child model, so `xhigh` may become `high`, and a model that cannot
disable reasoning may not honor `off`. `none` is invalid; use `off` for an
explicit no-reasoning request. Invalid `thinking` or `model` values cause that definition to be skipped during discovery rather than preventing other agents from loading.

See the [README](../../README.md) for discovery precedence, bundled agents,
and project-agent approval behavior.
