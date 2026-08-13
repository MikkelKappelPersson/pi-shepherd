# pi-shepherd — Implementation Plan

A no-fuss pi extension: **subagents** (isolated pi workers) + **herding pi
agents in Herdr**. This is the working roadmap for anyone (human or agent)
building the extension. Keep it in sync with `README.md`.

## North star

Bare bones, functional out of the box. Drop in agent `.agent.md` files, spawn
them, herd them. User edits `.ts` files and `/reload`s — **no build step, no
bundler, no config ceremony**.

Stack mirrors `pi-ops`:
- **TypeScript**, run directly by pi (Bun-style). No build — edit + `/reload`.
- Uses `@earendil-works/pi-coding-agent` API + the `parseFrontmatter`,
  `CONFIG_DIR_NAME`, `getAgentDir` helpers.
- Herdr integration shells out to the **`herdr` CLI**; no js library.
- Agent definitions use the **VS Code custom-agent syntax** (`.agent.md`).

## Architecture

```
pi-shepherd/
├── index.ts        extension entry: registers tools + /pi-shepherd command
├── discovery.ts    agent discovery + VS Code frontmatter parsing (pure, testable)
├── subagent.ts     spawn isolated pi subprocesses (single/parallel/chain)
├── herd.ts         Herdr CLI wrappers (list/start/prompt/read)
├── .pi/agents/     built-in subagents (pi project format)
├── .agents/agents/ built-in subagents (shared/cross-tool format)
├── prompts/        workflow presets
├── README.md
└── PLAN.md
```

Two tool surface areas exposed to the model:

1. **`subagent`** (custom tool) — delegate to an isolated pi worker.
2. **`herd`** (custom tool) — manage pi agents already running in Herdr panes.

Plus the `/pi-shepherd` slash command for listing agents and herding.

---

## Phase 0 — Scaffold

- [x] `package.json` (name `pi-shepherd`, `type: "module"`).
- [x] `.gitignore` (`node_modules`, `.gk/`).
- [ ] `tsconfig.json` — **omitted on purpose**: pi runs `.ts` directly (Bun-style) and neither `pi-ops` nor the official examples ship one. Add only if we adopt a type-check step.
- [x] `AGENTS.md` mirroring `pi-ops`/`AGENTS.md` (runtime, invariants, conventions, testing, security).
- [x] Stub `index.ts` registering `/pi-shepherd`.
- **Accept**: `/pi-shepherd` command is discovered (verified via a stderr probe in headless JSON mode; UI `notify` is silent headless so use probes to confirm).

---

## Phase 1 — Agent discovery & parsing (`discovery.ts`) ✅

Done in `discovery.ts` (+ `test/` harness). Extends pi's subagent example
pattern for the external locations + two bundled, with VS Code syntax.

- [x] **Locations & precedence** (later = more specific, wins on name collision):
      1. `~/.pi/agent/agents/` (user)
      2. `~/.agents/agents/` (user)
      3. `<project>/.pi/agents/` (project, nearest ancestor walked up)
      4. `<project>/.agents/agents/` (project)
      5. **Bundled** `<package>/.pi/agents/` (base set — pi's project format)
      6. **Bundled** `<package>/.agents/agents/` (base set — shared/cross-tool format)

      Bundled dirs are pi-shepherd's own defaults: the same two locations it
      discovers, so a user/project agent with the same name overrides a built-in
      without touching the package. Resolve precedence as
      `user > project > bundled`, with the `.pi/` vs `.agents/` distinction only
      mattering within the bundled base.
- [x] Accept both `.agent.md` and `.md` extensions in each dir.
- [x] Parse **VS Code custom-agent frontmatter** via `parseFrontmatter`:
      `name`, `description`, `tools`, `model` + pass-through `user-invocable`,
      `disable-model-invocation`, `agents`, `handoffs`. `tools` accepts
      comma-string or YAML array.
- [x] Precedence: first location (earlier in the 1-6 order) declaring a name
      wins; within a dir an earlier file wins. Bundled dirs are the base set.
- [x] **Trust gating**: `agentScope: "user" | "project" | "both"` (default
      `user`) in `discoverAgents`. Project agents only load when enabled.
- [x] Expose `discoverAgents(cwd, scope)` + `formatAgentList()` (pure).
- [x] `test/verify-discovery.mjs` — fixture tree in `test/fixtures/` exercises
      all locations + precedence + scope filtering (sets `$HOME` to the
      fixture home to control user dirs). Run: `npm run discovery:test`.

  > Needs `node_modules/@earendil-works/pi-coding-agent` resolvable for the
  > standalone `node` test (symlink to the pi install or `npm i`), since pi
  > itself supplies that resolution at runtime.

- **Accept**: ✅ `discoverAgents` returns the correct set/precedence for each
  of the four locations + bundled; `formatAgentList` shows name + source.
  Wired into `/pi-shepherd list`; extension loads cleanly under pi (no
  `./discovery.ts` resolve error).

---

## Phase 2 — Subagent tool (`subagent.ts`)

Adapt pi's `examples/extensions/subagent/index.ts` (isolated pi subprocess,
streaming, abort) to use our discovery + built-in agents.

- [ ] Rewrite as `runSubagent({ agent, task })` spawning a `pi` subprocess with
      the delegated system prompt + tool/model config.
- [ ] Modes: **Single** `{agent, task}`; **Parallel** `{tasks: [...]}` (max 8,
      4 concurrent); **Chain** `{chain: [...]}` with `{previous}` placeholder.
- [ ] Streaming output + usage stats (turns/tokens/cost/context per agent);
      Ctrl+C aborts and kills children.
- [ ] Return: final output to parent (cap parallel output ~50 KB/task), failure
      diagnostics from stderr on non-zero exit.
- [ ] Re-read agent files from disk on each invocation so edits take effect live.
- **Accept**: `/pi-shepherd scout "find auth code"`, a parallel run, and a chain
  all complete with per-agent usage and clean abort.

---

## Phase 3 — Built-in functional subagents (`.pi/agents/` + `.agents/agents/`)

Write minimal, genuinely useful agents in VS Code syntax so the extension is
useful before any custom agents exist. They ship in pi-shepherd's own bundled
dirs so any user/project agent overrides them by name.

- [ ] `scout` — fast recon, returns compressed context; read-only
      (`read, grep, find, ls`).
- [ ] `planner` — implementation plans; read-only (`read, grep, find, ls`).
- [ ] `reviewer` — code review (`read, grep, find, ls, bash`).
- [ ] `worker` — general-purpose implementation (all default tools).
- [ ] Workflow **prompt templates** in `prompts/`: `/implement`,
      `/scout-and-plan`, `/implement-and-review`.
- **Accept**: each agent does its job out of the box; workflow presets chain
  them with context handoff.

---

## Phase 4 — Herd (Herdr integration) (`herd.ts`)

Manage pi agents living in Herdr panes via the `herdr` CLI. Follow the Herdr
skill: verify `HERDR_ENV=1` first; use `--current`/explicit pane IDs; parse IDs
from JSON; create a **sibling** pane unless the user asked for other topology.

- [ ] **guard**: require `HERDR_ENV=1` + `herdr` on PATH, else report "not in
      Herdr" and stop.
- [ ] **list** — `herdr agent list` (filter to pi) → name, pane ID, state
      (`idle/working/blocked/done/unknown`).
- [ ] **start** — `herdr pane split --current --direction right --cwd "$PWD"
      --no-focus`, then `herdr agent start <name> --kind pi --pane <id>`; parse
      the new pane ID from `.result.pane.pane_id`.
- [ ] **prompt** — `herdr agent prompt <name> "<task>" --wait --timeout …`;
      surface stall/blocked back to the caller.
- [ ] **status / read** — `herdr agent get <name>` + `herdr agent read <name>
      --source recent-unwrapped --lines N`.
- [ ] Safety: honor requested direction; `--no-focus` for background; never
      close panes we didn't create; never kill the Herdr server.
- **Accept**: from a Herdr pane, `list` shows live agents, `start` spawns a
  sibling pi agent, `prompt --wait` returns a settled answer.

---

## Phase 5 — Command surface & polish (`index.ts`)

- [ ] Register the `/pi-shepherd` command: `list`, `<agent> <task>`, `herd`.
- [ ] Register the `subagent` + `herd` custom tools for natural-language use.
- [ ] Progress via `ctx.ui` (`setStatus`, `notify`); graceful failures.
- [ ] Finalize this README + AGENTS.md; verify docs match the code.
- [ ] Commit the repo (pi-shepherd is an empty git repo, no commits yet).

**Stretch / future:**
- `handoffs` support from VS Code frontmatter to suggest next actions.
- Multi-project agent sets / per-config discovery dirs.
- Smart placement: choose split direction from `herdr pane layout`.
- Notifications when a herded agent goes `blocked` or `done`.

---

## Conventions (enforced from Phase 0)

- `.ts` imports use explicit filename with extension (`from "./herd.ts"`).
- `discovery.ts` stays **pure** — no pi AI calls; testable from a script.
- Agent prompt files are read fresh from disk each run — never cache.
- Mirror `pi-ops`/`AGENTS.md` structure: runtime / architecture / invariants /
  conventions / testing / security.

## Testing / verification

- No unit suite; verify interactively like pi-ops:
  - `pi --mode json -p --no-session "/pi-shepherd list"`
  - `/pi-shepherd scout "…"`, `worker "…"`, a parallel + a chain run.
  - Herd (requires Herdr): `list`, `start`, `prompt --wait`.
- Add tiny fixture agent dirs under a temp cwd to exercise discovery precedence.

## Security posture

- **Project agents are repo-controlled** — gated behind `agentScope`; confirm
  when interactive. Prefer user agents.
- Subagents run with the host user's tool permissions (same blast radius as pi).
- Herd launches real pi agents with your credentials into Herdr panes; only
  drive trusted agents. Follow the Herdr skill's safety rules (no killing
  server, no closing unnamed panes, `--no-focus` for background work).
