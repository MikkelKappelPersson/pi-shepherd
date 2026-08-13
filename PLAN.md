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
├── index.ts          extension entry: registers tools + /pi-shepherd command
├── discovery.ts      agent discovery + VS Code frontmatter parsing (pure, testable)
├── subagent.ts       pi-subagent tool: run each agent live in a Herdr tab (single/parallel/chain)
├── herd.ts           herd tool: Herdr CLI wrappers (list/start/prompt/status/read/close) + herdr agent runner
├── shepherd-done.ts  in-tab extension: shepherd_done tool + completion sidecar on agent_end
├── .pi/agents/       built-in subagents (pi project format)
├── .agents/agents/   built-in subagents (shared/cross-tool format)
├── prompts/          workflow presets
├── README.md
└── PLAN.md
```

Two tool surface areas exposed to the model:

1. **`pi-subagent`** (custom tool) — delegate to an agent that runs **live in a
   new Herdr tab** (labelled with the agent name), works there, and reports its
   final output back on completion. **Herdr-native**: no subprocess fallback —
   from a plain terminal the referenced headless Herdr server is
   started/attached automatically. Named `pi-subagent`, not `subagent`, so it
   coexists with the `pi-herdr-agents` package (its `subagent` tool drives
   Herdr-pane/worktree agents; two tools named `subagent` would fail extension
   loading).
2. **`herd`** (custom tool) — manage pi agents already running in Herdr panes
   (list/start/prompt/status/read/close).

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

## Phase 2 — Subagent tool (`subagent.ts`) — reworked: Herdr-native ✅

Originally adapted pi's `examples/extensions/subagent` isolated-subprocess
runner. Per the “no invisible subprocesses” direction, that subprocess fallback
was **removed**: every delegated agent now runs **live in a Herdr tab**. The
unit of work is `runSingleAgent`, which routes to the herdr runner in `herd.ts`.

- [x] `runSingleAgent` (herdr runtime): `runAgentInHerdr` → create a tab,
      run pi with the delegated system prompt + tool/model config, wait for a
      completion sidecar, pick up the final output.
- [x] Modes: **Single** `{agent, task}`; **Parallel** `{tasks: [...]}` (max 8,
      4 concurrent); **Chain** `{chain: [...]}` with `{previous}` placeholder.
- [x] Options: `keepOpen` (default `true` — tab left open for inspection) and
      `timeout` (default 10 min).
- [x] Progress via `onProgress` (session-file tail) while the tab runs.
- [x] Re-read agent files from disk on each invocation (`discoverAgents`).
- [x] `subagentOnce()` helper so `/pi-shepherd <agent> <task>` uses the same
      herdr path without the tool UI.
- **Accept**: ✅ verified live — `subagentOnce({agent: "scout", …})` created a
      "scout" tab, ran pi in it, exited via `shepherd_done`, echoed
      `__SHEPHERD_DONE_0__`, and returned the answer with the tab left open.

## Phase 2b — In-tab completion (`shepherd-done.ts`) ✅

Extension loaded into delegated pi tabs. On `agent_end` with a normal-ish latest
assistant turn (or via the explicit `shepherd_done` tool) it writes a
`<session>.exit` completion sidecar and `ctx.shutdown()`s, so the parent knows
when the child finished and can pick up its session file.

## Phase 3 — Built-in functional subagents (`.pi/agents/` + `.agents/agents/`) ✅

Minimal, genuinely useful agents in VS Code syntax; ship in pi-shepherd's own
bundled dirs so any user/project agent overrides them by name.

- [x] `scout` — fast recon, returns compressed context; read-only
      (`read, grep, find, ls`).
- [x] `planner` — implementation plans; read-only (`read, grep, find, ls`).
- [x] `reviewer` — code review (`read, grep, find, ls, bash`).
- [x] `worker` — general-purpose implementation (all default tools).
- [ ] Workflow **prompt templates** in `prompts/`: `/implement`,
      `/scout-and-plan`, `/implement-and-review`. *(future)*
- **Accept**: ✅ scout runs out of the box (verified).

## Phase 4 — Herd (Herdr integration) (`herd.ts`) ✅

Manage pi agents living in Herdr panes via the `herdr` CLI. Also carries the
**herdr agent runner** (`runAgentInHerdr`) used by `pi-subagent`, and is now
**herdr-native from any terminal**. Verified against the live CLI.

- [x] **guard**: `herdr` CLI on PATH + (inside Herdr OR a reachable/startable
      headless server), else a clear “install/start Herdr” message.
- [x] **ensureHerdrRuntime / getHerdrWorkspaceId** — start `herdr server`
      detached when down (plain-terminal launch) and resolve a workspace.
- [x] **list** — `herdr agent list` → name, pane id, state
      (`idle/working/blocked/done/unknown`); marks pi-shepherd-created panes `●`.
- [x] **start** — `herdr pane split <HERDR_PANE_ID> --direction right --cwd
      "$PWD" --no-focus`, then `herdr agent start <name> --kind pi --pane
      <id>`; retries `agent_pane_busy` while the new shell spins up.
- [x] **prompt** — `herdr agent prompt <target> "<task>" --wait --until done
      --timeout …`.
- [x] **status / read** — `herdr agent get <target>` + `herdr agent read
      <target> --source recent-unwrapped --lines N --format text`.
- [x] **close** — `herdr pane close`, but only for panes in the pi-shepherd
      registry (`~/.pi/agent/pi-shepherd/created-panes.json`); refuses unknown
      panes.
- [x] **runAgentInHerdr** — create tab → wait for shell → write launch script
      → `pane run` → poll `<session>.exit` sidecar / `__SHEPHERD_DONE_` sentinel
      → wait for child exit → parse session → pick up result → leave tab open
      (or close when `keepOpen:false`).
- [x] Safety: `--no-focus` for background; registry-guarded `close`; never kill
      the Herdr server.
- **Accept**: ✅ verified live — a `scout` run created a tab, ran pi, exited
      via `shepherd_done`, echoed `__SHEPHERD_DONE_0__`, `list`/`close` handle
      the leftover pane via the registry.

## Phase 5 — Command surface & polish (`index.ts`) 🔶

- [x] Register the `/pi-shepherd` command: `list`, `<agent> <task>`, `herd`.
- [x] Register the `pi-subagent` + `herd` custom tools for natural-language use.
- [x] Progress via `ctx.ui` (`setStatus`, `notify`); graceful failures.
- [x] Herdr-native pivot: removed the subprocess fallback; `pi-subagent` always
      runs a Herdr tab (auto-starting the server from a plain terminal).
- [x] Docs updated (README, AGENTS.md, PLAN.md) to match the code.
- [ ] Commit the repo (currently uncommitted after the latest work).

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
  - `/pi-shepherd scout "…"` — expect a `scout` tab that runs pi, finishes with
    `__SHEPHERD_DONE_0__`, and leaves the tab open; then `herd close <pane>`.
  - Herd: `list` (look for the `●` marker), `start`, `prompt --wait`, `close`.
- Add tiny fixture agent dirs under a temp cwd to exercise discovery precedence.

## Security posture

- **Project agents are repo-controlled** — gated behind `agentScope`; confirm
  when interactive. Prefer user agents.
- Subagents run with the host user's tool permissions (same blast radius as pi),
  each in its own Herdr tab with an isolated context window.
- Herd launches real pi agents with your credentials into Herdr panes; only
  drive trusted agents. Follow the Herdr skill's safety rules (no killing
  server, `--no-focus` for background work, and only close panes recorded in
  the pi-shepherd registry).
