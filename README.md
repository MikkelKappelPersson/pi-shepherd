# pi-shepherd

A no-fuss **pi extension** for managing your coding agents: delegation to
**subagents** and herding **pi agents inside Herdr**.

> **Philosophy:** bare bones, works out of the box. Drop in agent definitions,
> spawn them, herd them. No ceremony.

```
you ──► /pi-shepherd ──► subagents (isolated pi workers, self-contained prompts)
        └────────────► herd   (pi agents running in Herdr panes — list / start / prompt / status)
```

Two capabilities, one extension:

- **Subagents** — delegate tasks to isolated pi subprocesses so each has its own
  context window. Ships with a small set of functional subagents (`scout`,
  `planner`, `reviewer`, `worker`) so it works before you write your own.
- **Herd** — manage the pi agents living in your Herdr panes: see what they're
  doing, start a sibling agent, push a prompt, wait for an answer.

Agent definitions are loaded from plain Markdown files using the
[standard VS Code custom-agent syntax](https://code.visualstudio.com/docs/agent-customization/custom-agents)
(YAML frontmatter + Markdown body), so any `.agent.md` you already have just works.

---

## Agent discovery

Agents are discovered from these locations, in order (later/**project**/closer
wins over earlier ones with the same name):

| Scope       | Location                         | Notes                          |
|-------------|----------------------------------|--------------------------------|
| user        | `~/.pi/agent/agents/`            | pi's own agent dir             |
| user        | `~/.agents/agents/`              | cross-tool shared agent dir    |
| project     | `<project>/.pi/agents/`          | project-scoped pi agents       |
| project     | `<project>/.agents/agents/`      | project-scoped shared agents  |
| **bundled** | `…/pi-shepherd/.pi/agents/`      | built-in subagents shipped with pi-shepherd |
| **bundled** | `…/pi-shepherd/.agents/agents/`  | built-ins, shared/cross-tool format        |

> **Bundled agents** are the package's own defaults, living in pi-shepherd's
> own `.pi/agents/` and `.agents/agents/` directories — the same layout it
> discovers from. They are the **lowest precedence**: any user/project agent
> with the same name overrides them, so you replace a built-in by dropping
> your own file in `~/.pi/agent/agents/`.

- Files may use the `.agent.md` or `.md` extension. Both are parsed the same way.
- All four locations support the **VS Code custom-agent format** — YAML
  frontmatter (`name`, `description`, `tools`, `model`, …) plus a Markdown body
  used as the system prompt.
- **Project agents are gated by trust.** By default only user-level agents load.
  Enable project agents with `agentScope: "project" | "both"` (and confirm on
  each run when interactive). This mirrors the security posture of pi's built-in
  subagent tool.

### Example agent definition (VS Code syntax)

```markdown
---
name: my-reviewer
description: Reviews diffs for bugs, security, and readability
tools: read, grep, find, ls, bash
model: claude-sonnet-4-5
---
You are a code reviewer. Read the provided diff/context, identify bugs,
security issues, and readability problems, and report only actionable
findings in a concise list. Do not edit files.
```

---

## Usage

### Subagents (isolated workers)

| Command | Action |
|---------|--------|
| `/pi-shepherd <agent> <task>`      | Run one subagent on a task |
| `/pi-shepherd list`                | List discovered agents and their source |
| `/pi-shepherd herd`                | List pi agents currently running in Herdr panes |

You can also instruct pi naturally: *"run 2 scouts in parallel — one on auth,
one on billing"* or *"use review on the last commit"*.

A subagent runs as its own **pi subprocess** with a delegated system prompt and
its own tool/model config. You get streaming output, per-agent usage stats
(turns / tokens / cost / context), and Ctrl+C abort that kills the child.

Modes:

| Mode      | Description                                          |
|-----------|------------------------------------------------------|
| Single    | One agent, one task                                  |
| Parallel  | Up to 8 tasks, 4 concurrent, streamed simultaneously |
| Chain     | Sequential steps; `{previous}` placeholder pipes context |

### Herd (pi agents in Herdr panes)

pi-shepherd drives Herdr through the `herdr` CLI (Herdr must be running and
`HERDR_ENV=1`).

- **List** — show live pi agents in Herdr, their pane, and `idle`/`working`/`blocked`/`done` state.
- **Start** — split a sibling pane (right by default, preserving your cwd) and
  launch a named pi agent in it with `--no-focus`.
- **Prompt** — send a task to a named agent across the floor and wait for it to settle.
- **Status / read** — check lifecycle state and pull recent output from a pane.

Example:

```bash
# under the hood — start a reviewer agent as a right-hand sibling
herdr pane split --current --direction right --cwd "$PWD" --no-focus
herdr agent start reviewer --kind pi --pane <pane-id>
herdr agent prompt reviewer "Review the current diff." --wait --timeout 120000
```

---

## What ships out of the box

Functional subagents, ready to use, no setup:

| Agent      | Purpose                          | Tools |
|------------|----------------------------------|-------|
| `scout`    | Fast codebase recon, returns compressed context | read, grep, find, ls |
| `planner`  | Implementation plans, read-only  | read, grep, find, ls |
| `reviewer` | Code review                      | read, grep, find, ls, bash |
| `worker`   | General-purpose implementation   | all default tools |

Workflow presets:

| Prompt | Flow |
|--------|------|
| `/implement <query>` | scout → planner → worker |
| `/scout-and-plan <query>` | scout → planner |
| `/implement-and-review <query>` | worker → reviewer → worker |

---

## Install

The extension lives in `~/.pi/agent/extensions/pi-shepherd/`, so pi
auto-discovers it on the next start or `/reload`.

Requirements:

- **pi** with the extension loader (extensions dir on disk, no build step —
  edit `.ts` and reload).
- **Herdr** (for the *herd* capability only) — a running Herdr session,
  `HERDR_ENV=1`, `herdr` on PATH. Subagents work without Herdr.

---

## Configuration

- **Agent scope** — `agentScope: "user" | "project" | "both"` (default `user`).
  Enabling project agents loads repo-controlled prompts; only do this for repos
  you trust.
- **Agent locations** — the four discovery dirs above. User agents always load;
  add files there to extend the built-in set (user agents override built-ins
  with the same name).

---

## Security notes

- Subagents run with a delegated system prompt and full tool access for that
  worker. User-level definitions are yours; **project-level definitions are
  repo-controlled** — a malicious repo could instruct the model to run shell
  commands. Keep `agentScope` conservative and confirm project agents.
- The herd capability launches real pi agents in Herdr panes with your tools and
  credentials. Only herd agents you trust.
- A subagent's context is isolated, but its tools run with your local
  permissions — the same blast radius as running pi normally.

---

## Project layout

```
~/.pi/agent/extensions/pi-shepherd/
├── index.ts          # extension entry: /pi-shepherd command + tool registration
├── discovery.ts      # agent discovery + VS Code .agent.md parsing (pure, testable)
├── subagent.ts       # spawn isolated pi subprocesses (single / parallel / chain)
├── herd.ts           # Herdr CLI wrappers (list / start / prompt / read)
├── .pi/agents/       # bundled built-in subagents (pi project format)
├── .agents/agents/   # bundled built-in subagents (shared/cross-tool format)
├── prompts/          # workflow presets (/implement, /scout-and-plan, ...)
├── README.md         # this file
└── PLAN.md           # implementation roadmap
```

See [PLAN.md](./PLAN.md) for the implementation roadmap.
