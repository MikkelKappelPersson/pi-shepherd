# Bundled subagents (project scope)

Built-in functional subagents shipped with pi-shepherd live here, in pi's
project agent location. They use the **standard VS Code custom-agent syntax**
(YAML frontmatter + Markdown body, `.md` or `.agent.md`).

These are the **lowest-precedence base set**: user/project agents anywhere else
override a built-in with the same name, so you can replace any of them by
dropping your own `scout.md`, `reviewer.md`, etc. in `~/.pi/agent/agents/`.

Example:

```markdown
---
name: scout
description: Fast codebase recon, returns compressed context
tools: read, grep, find, ls
---
You are a scout. Survey the codebase with read-only tools and return a
compressed summary of the most relevant context for the task.
```
