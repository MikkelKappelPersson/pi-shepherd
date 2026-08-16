# pi-shepherd — for agents maintaining this extension

A no-fuss **pi extension** for delegating to **subagents** (each running live in
a **Herdr tab**) and **herding pi agents inside Herdr** (list / start / prompt / close).

For *usage / discovery / security*, see `README.md`. This file is for agents
that **edit the code**. The implementation roadmap is `PLAN.md`.

## Default workflow — dogfood the extension's own subagents

When making changes to this repo, **default to delegating to the bundled
subagents** (via `shepherd action=delegate`) rather than doing everything inline:

- **scout** — recon the repo first (`shepherd delegate` → `scout`) to survey the
  relevant code before editing, or ask it to scout changes when context runs
  thin.
- **planner** — for non-trivial work, have a **planner** turn the scout's
  findings into a concrete implementation plan before touching files.
- **worker** — delegate the actual **build/implement** step to a **worker**
  (full capabilities, isolated context). There is no `builder` agent; **worker**
  is the build agent.
- **reviewer** — after implementing, have a **reviewer** (read-only) check the
  diff for quality and security.

You are the orchestrator: scout → plan → build (worker) → review. Run the
agents you trust; per the security notes below, their context is isolated but
their tool permissions match yours.

## Runtime / stack

- **TypeScript, run directly by pi** (Bun-style). No bundler, no build step —
  edit `.ts` files and `/reload` (or restart pi) to apply changes.
- Uses the `@earendil-works/pi-coding-agent` extension API.
- Agent discovery uses the VS Code custom-agent syntax (`.agent.md` / `.md`
  with YAML frontmatter) and the pi helpers `parseFrontmatter`,
  `CONFIG_DIR_NAME`, `getAgentDir`.
- The **herd** capability shells out to the **`herdr` CLI** (no js library).
  Subagents run as **pi agents inside Herdr tabs**: pi-shepherd creates a tab
  labelled with the agent name, runs the delegated `pi` process in it
  (`herdr pane run`), waits for a completion sidecar, and hands the result
  back to the parent.

## Architecture

```
index.ts      extension entry: /pi-shepherd command + tool registration
subagent.ts   delegation runner: runSingleAgent / executeDelegation (single/parallel/chain) ✅
shepherd-done.ts  in-tab extension: shepherd_done tool + completion sidecar on agent_end ✅
discovery.ts  agent discovery + VS Code frontmatter parsing (pure, testable) ✅
herdr.ts       shepherd tool: Herdr CLI wrappers (list/start/prompt/status/read/close) + herdr agent runner ✅
settings.ts   persisted defaults store (~/.pi/agent/pi-shepherd/settings.json, mtime-cached) ✅
settings-ui.ts  /pi-shepherd settings menu (inline in the editor slot, SettingsList) ✅
.pi/agents/   bundled built-in subagents (pi project format)                  ✅
.agents/agents/  bundled built-in subagents (shared/cross-tool format)        ✅
```

Files marked with a phase are not yet implemented (stub only). See `PLAN.md`.

## Invariants — do NOT break

- **Agent discovery order** (later/more specific wins on name collision):
  1. `~/.pi/agent/agents/` (user)
  2. `~/.agents/agents/` (user)
  3. `<project>/.pi/agents/` (project)
  4. `<project>/.agents/agents/` (project)
  5. **Bundled** `…/pi-shepherd/.pi/agents/` (lowest precedence base set)
  6. **Bundled** `…/pi-shepherd/.agents/agents/` (lowest precedence base set)

  Bundled agents live in pi-shepherd's own `.pi/agents/` and `.agents/agents/`
  (the same layout it discovers) so a user/project agent with the same name
  overrides a built-in without touching the package.
- **Project agents are trust-gated.** Default scope is `user`; a user must opt
  into `project`/`both`, with a confirmation when running interactively. Never
  run repo-controlled prompts by default.
- **Agent files are read fresh from disk every invocation** — never cache, so
  edits take effect live.
- **Tool names must not collide with `pi-herdr-agents`.** That package (an npm
  pi-package, always present here) registers `subagent`, `subagent_interrupt`,
  `subagents_list`, `subagent_resume`, `herdr_workflow`. Registering our own
  `subagent` would make pi refuse to load any extension.
  → Delegation is **`shepherd action=delegate`**; the fleet-management actions
  (list/start/prompt/status/read/close/gc) live on the same **`shepherd`** tool
  (mapping: the shepherd manages the herd). Do not register tools named
  `subagent`, `subagent_interrupt`, `subagents_list`, `subagent_resume`, or
  `herdr_workflow` — those belong to `pi-herdr-agents`.
- **Herdr-native**: pi-shepherd carries no subprocess fallback. Every delegated
  agent runs in a Herdr tab. From a plain terminal (no `HERDR_ENV`) the
  referenced headless Herdr server is started/attached automatically and a
  workspace is resolved for the tab.
- **Never close panes pi-shepherd didn't create.** Panes it creates (via
  `shepherd delegate` or `shepherd start`) are recorded in `~/.pi/agent/pi-shepherd/created-panes.json`;
  `shepherd close` only closes panes in that registry.
- **Nothing reads the child session before the child has exited.** The parent
  waits for the `__SHEPHERD_DONE_` sentinel (printed by the shell after `pi`
  exits) before parsing the session file and cleaning up temp files; otherwise
  a still-running child hits ENOENT on its own session file.

## Conventions

- `.ts` imports use explicit filename with extension: `from "./discovery.ts"`.
- `discovery.ts` stays **pure** — no pi-AI calls — so it can be exercised from
  a plain script.
- Agent files are bundled under `.pi/agents/` and `.agents/agents/`
  (lowest-precedence base set). User/project agents with the same name
  override built-ins.

## Testing / verification

- **No unit suite.** Verify interactively as features land:
  - `pi --mode json -p --no-session "/pi-shepherd list"`
  - Once Phase 1 lands, add tiny fixture agent dirs under a temp cwd to
    exercise discovery precedence across the four locations.
  - Herd (Phase 4): verify against a running Herdr server; `shepherd list`, `start`,
  `prompt --wait`, `close`. A live `shepherd delegate` run creates a tab, signals
  completion via the sidecar, and (with the default `stayOpen`) the subagent
  stays alive in the tab for you to keep driving — no `__SHEPHERD_DONE_` exit.
  With `stayOpen: false` it should exit and show `__SHEPHERD_DONE_0__` with
  `agent` back to idle.

## Security

- Subagents run with the host user's full tool permissions (same blast radius
  as running pi normally) but an isolated context window.
- **Project agent definitions are repo-controlled** — keep them gated behind
  `agentScope` and confirm before running. User-level definitions are personal.
- The herd capability launches real pi agents (your credentials, your tools)
  into Herdr panes. Only drive agents you trust, and follow the Herdr skill's
  safety rules.
