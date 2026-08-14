# pi-shepherd

A no-fuss **Herdr-native** pi extension for managing your coding agents: delegation
and herding **pi agents inside Herdr**.

> **Philosophy:** bare bones, works out of the box. **Every** delegated agent runs in
> its own real **Herdr tab** — you watch it work live, and the result is handed back
> to your main pi instance when it completes. No invisible subprocesses.

```
you ──► sheepdog ──► a new Herdr tab (e.g. "scout") runs pi live, completes, hands the result back
        └────────────► shepherd   (list / start / prompt / status / read / close / gc)
```

Two capabilities, one extension, exposed to the model as two **tools**. The
naming is thematic: the **shepherd manages the herd**; the **sheepdog** is the
laborer you send out to fetch one result and bring it back.

- **`sheepdog`** — delegate a task to a specialized agent (`scout`, `planner`,
  `reviewer`, `worker`, …). It runs **live in a new Herdr tab labelled with the
  agent name**, gets the delegated system prompt + tool/model config, and on
  completion the main instance picks up its final output. Herdr-native from any
  prompt: even if pi was started from a plain terminal, the referenced headless
  Herdr server is started/attached automatically.
- **`shepherd`** — manage the pi agents living in your Herdr panes: see them
  (`list`), start a sibling agent (`start`), push a prompt (`prompt`), check
  status / read output (`status`, `read`), and close panes that pi-shepherd
  created (`close`). Panes pi-shepherd created are marked `●`. `gc` prunes
  stale registry entries (panes that no longer exist) and cleans their temp dirs.

> **Compatibility:** the delegation tool is named **`sheepdog`** (not
> `subagent`) so it coexists with the `pi-herdr-agents` package, whose own
> `subagent` tool drives same-name Herdr-pane/worktree agents. Registering two
> tools called `subagent` would make pi fail to load any extension.

Agent definitions are loaded from plain Markdown files using the
[standard VS Code custom-agent syntax](https://code.visualstudio.com/docs/agent-customization/custom-agents)
(YAML frontmatter + Markdown body), so any `.agent.md` you already have just works.

---

## Agent discovery

Agents are discovered from these locations, in order (earlier/higher-precedence
locations win over later ones with the same name):

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
  frontmatter (`name`, `description`, `tools`, `model`, `omit-system-prompt`, …)
  plus a Markdown body used as the system prompt.
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
# Set true to replace pi's built-in default with the Markdown body.
omit-system-prompt: false
---
You are a code reviewer. Read the provided diff/context, identify bugs,
security issues, and readability problems, and report only actionable
findings in a concise list. Do not edit files.
```

---

## Usage

### Delegation (Herdr tabs) — `sheepdog`

| Command | Action |
|---------|--------|
| `/pi-shepherd <agent> <task>`      | Run one agent in a Herdr tab and pick up the result |
| `/pi-shepherd list`                | List discovered agents and their source |
| `/pi-shepherd herd`                | Herd hint (the `shepherd` tool does the work) |
| `/pi-shepherd settings` (`/pi-shepherd-settings`) | Open the settings menu (inline, like `/settings`) |

You can also instruct pi naturally: *"scout the readme"* or *"run 2 scouts in
parallel — one on auth, one on billing"* — the model uses the `sheepdog` tool
(single / parallel / chain) to do it.

Each agent runs **live in its own Herdr tab** (labelled `scout`, `planner`, …):

1. a new tab is created in the current (or resolved) workspace;
2. `pi` starts there with the agent's delegated system prompt, tools and model;
3. you can watch it work in the tab;
4. when it finishes (it calls `shepherd_done`, or its turn completes), a
   completion sidecar is written and its output is handed back to the parent;
   by default the subagent **stays open** in the tab (it does not exit) so you
   can keep driving it;
5. the parent pi instance picks up the final output and reports it back;
6. the tab is left open for inspection — the subagent may still be running, so
you can keep prompting it, or close it with `shepherd close <pane>` (or in Herdr
directly).

Options: `keepOpen` (default `true` — set `false` to auto-close the tab),
`stayOpen` (default `true` — keep the subagent's pi **alive** in the tab after
it completes so you can keep driving it; set `false` to have it exit on done),
`timeout` (ms, default 10 min), and the optional `omitSystemPrompt` override.
When supplied, it overrides the selected agent's `omit-system-prompt`
frontmatter (including an explicit `false`). When the override and frontmatter
are both absent, the effective value is `false`. When enabled, the agent
Markdown body is passed as a replacement system prompt via `--system-prompt`:
this omits only pi's built-in default system prompt. The task and completion
instructions are still passed as input. In
both modes, pi's project context—including `AGENTS.md` and other context
files—is retained, as are the selected tools and permissions. Modes:

| Mode      | Description                                          |
|-----------|------------------------------------------------------|
| Single    | One agent, one task                                  |
| Parallel  | Up to 8 tasks, 4 concurrent, each in its own tab     |
| Chain     | Sequential steps; `{previous}` placeholder pipes context |

#### Delegated input context

Every `sheepdog` invocation starts a fresh child pi session in a Herdr tab. In
normal mode (`omitSystemPrompt: false`), the child receives pi's built-in
default system prompt plus the discovered agent definition's Markdown body as
an appended system prompt. In replacement mode (`omitSystemPrompt: true`), the
child receives the agent Markdown body as its system prompt instead, omitting
only pi's built-in default. In both modes, pi's project context—including
`AGENTS.md` and other context files—remains available. The child also receives
the delegated `task` as user input, followed by autonomous shepherd
instructions to complete the task and call `shepherd_done`; those instructions
are retained in both modes. It runs with the requested agent's `cwd`, `model`,
and `tools` (plus the completion tool), rather than inheriting the parent's
conversation. In a chain, `{previous}` in the next step's task is replaced
with the prior step's returned output. Parallel tasks start independent fresh
sessions.

`omitSystemPrompt: true` is a per-call sheepdog option that selects the
replacement behavior above. `false` (including the default) combines pi's
built-in default with the agent body; `true` replaces the built-in default with
the agent body. Neither mode omits project `AGENTS.md`/context files, the task,
completion instructions, model, cwd, or tools. Resolution is explicit call
option (including explicit `false`), then the selected agent's
`omit-system-prompt` frontmatter, then `false`. The frontmatter value must be a
YAML boolean (`true` or `false`); other types are ignored. The option is
available on the `sheepdog` tool; `/pi-shepherd <agent> <task>` has no separate
option and therefore uses the agent frontmatter/default behavior. Likewise,
`shepherd start` keeps its existing launch behavior.

### Shepherd (pi agents in Herdr panes)

pi-shepherd drives Herdr through the `herdr` CLI (works from inside Herdr *or* a
plain terminal — the headless server is started/attached automatically).

- **List** — show live pi agents in Herdr, their pane, `idle`/`working`/`blocked`/`done` state, and mark `●` the panes pi-shepherd created.
- **Start** — split a sibling pane (right by default, preserving your cwd) and launch a named pi agent in it with `--no-focus`.
- **Prompt** — send a task to a named agent across the floor and wait for it to settle.
- **Status / read** — check lifecycle state and pull recent output from a pane.
- **Close** — close a pane that pi-shepherd created (by pane id or agent name). It refuses to close panes it didn't create (safety).

Example (what the `shepherd` tool does under the hood — the task is delivered at launch via the same pane-run launch script the delegation path uses, so it lands reliably instead of relying on flaky `herdr agent start`/prompt keystroke timing):

```bash
# start a reviewer agent as a right-hand sibling of the current pane, task baked in
herdr pane split "$HERDR_PANE_ID" --direction right --cwd "$PWD" --no-focus
# wait for its shell, then boot pi with the launch script (session + @task file)
herdr pane run <pane-id> 'bash /tmp/pi-shepherd-*/launch-reviewer.sh'
herdr agent read <pane-id> --source recent-unwrapped --lines 40 --format text
```

A `shepherd start` with no `task` boots a bare pi you drive later with
`shepherd prompt`; a `task` given to `start` is delivered at launch.

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
- **Herdr** — pi-shepherd is **Herdr-native**: the `herdr` CLI must be on PATH.
  When pi runs inside Herdr it uses the current session; when launched from a
  plain terminal it automatically starts/attaches the referenced headless Herdr
  server and resolves a workspace for the new tab.

---

## Configuration

- **Settings menu** — `/pi-shepherd settings` (or `/pi-shepherd-settings`) opens
  an **inline** settings list in the writing-field slot, exactly like pi's own
  `/settings`: arrows navigate, Enter cycles a value, `/` fuzzy-searches, esc
  closes. Settings are stored at `~/.pi/agent/pi-shepherd/settings.json` and read
  fresh (no reload needed). Every `sheepdog`/`shepherd` run falls back to these
  values when a call doesn't pass them explicitly. Typing `/pi-shepherd ` also
  shows `list`/`herd`/`settings`/agents in the native autocomplete menu.

### Persisted settings (`settings.json`)

- **Agent scope** — `agentScope: "user" | "project" | "both"` (default `user`).
  Enabling project agents loads repo-controlled prompts; only do this for repos
  you trust.
- **Confirm project agents** — `confirmProjectAgents` (default `true`): prompt
  before running repo-controlled project agents.
- **Agent locations** — the four discovery dirs above. User agents always load;
  add files there to extend the built-in set (user agents override built-ins
  with the same name).
- **`sheepdog` defaults** — `keepOpen` (default `true`: leave the tab open for
  inspection; set `false` to auto-close), `stayOpen` (default `true`: keep the
  subagent's pi process alive after completion so you can keep driving it in the
  tab; set `false` to have it exit on done) and `timeout` (ms, default 10 min).
  `omitSystemPrompt` is an optional per-call `sheepdog` boolean, not a persisted
  setting. Resolution is explicit call option > agent frontmatter
  `omit-system-prompt` (strict YAML boolean) > `false`. When `false`, pi's
  built-in default and the discovered agent Markdown body are combined; when
  `true`, the body replaces only pi's built-in default. Project `AGENTS.md` and
  other context files, plus the fresh-session task/completion input, cwd, model,
  and tools, remain in both modes.

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
├── settings.ts       # persisted settings store (~/.pi/agent/pi-shepherd/settings.json)
├── settings-ui.ts    # /pi-shepherd settings menu (inline in the editor slot, SettingsList)
├── subagent.ts       # sheepdog tool: run each agent live in a Herdr tab (single/parallel/chain)
├── herd.ts           # shepherd tool (list/start/prompt/status/read/close/gc) + herdr agent runner (runAgentInHerdr)
├── test/             # verification: discovery fixtures + Herdr-independent launch checks
├── .pi/agents/       # bundled built-in subagents (pi project format) — scout, planner, reviewer, worker
├── .agents/agents/   # bundled built-in subagents (shared/cross-tool format, mirrors of the above)
├── shepherd-done.ts  # in-tab extension: shepherd_done tool + completion sidecar on agent_end
├── prompts/          # workflow presets (/implement, /scout-and-plan, ...)  [future]
├── README.md         # this file
└── PLAN.md           # implementation roadmap
```

See [PLAN.md](./PLAN.md) for the implementation roadmap.
