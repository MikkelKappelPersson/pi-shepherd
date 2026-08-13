# pi-shepherd — for agents maintaining this extension

A no-fuss **pi extension** for delegating to **subagents** (isolated pi
workers) and **herding pi agents inside Herdr** (list / start / prompt).

For *usage / discovery / security*, see `README.md`. This file is for agents
that **edit the code**. The implementation roadmap is `PLAN.md`.

## Runtime / stack

- **TypeScript, run directly by pi** (Bun-style). No bundler, no build step —
  edit `.ts` files and `/reload` (or restart pi) to apply changes.
- Uses the `@earendil-works/pi-coding-agent` extension API.
- Agent discovery uses the VS Code custom-agent syntax (`.agent.md` / `.md`
  with YAML frontmatter) and the pi helpers `parseFrontmatter`,
  `CONFIG_DIR_NAME`, `getAgentDir`.
- The **herd** capability shells out to the **`herdr` CLI** (no js library).
  Subagents spawn a **`pi` binary** as an isolated subprocess.

## Architecture

```
index.ts      extension entry: /pi-shepherd command + tool registration
discovery.ts  agent discovery + VS Code frontmatter parsing (pure, testable)  [Phase 1]
subagent.ts   spawn isolated pi subprocesses (single / parallel / chain)      [Phase 2]
herd.ts       Herdr CLI wrappers (list / start / prompt / read)               [Phase 4]
.pi/agents/   bundled built-in subagents (pi project format)                  [Phase 3]
.agents/agents/  bundled built-in subagents (shared/cross-tool format)        [Phase 3]
prompts/      workflow presets (/implement, /scout-and-plan, ...)             [Phase 3]
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
- **Herdr safety** (from the Herdr skill): verify `HERDR_ENV=1` first; prefer
  `--current` / explicit pane IDs; create a **sibling** pane with `--no-focus`
  unless the user asked for other topology; parse IDs from JSON, never guess;
  never close panes we didn't create; never kill the Herdr server.

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
  - Herd (Phase 4) requires a running Herdr session with `HERDR_ENV=1`.

## Security

- Subagents run with the host user's full tool permissions (same blast radius
  as running pi normally) but an isolated context window.
- **Project agent definitions are repo-controlled** — keep them gated behind
  `agentScope` and confirm before running. User-level definitions are personal.
- The herd capability launches real pi agents (your credentials, your tools)
  into Herdr panes. Only drive agents you trust, and follow the Herdr skill's
  safety rules.
