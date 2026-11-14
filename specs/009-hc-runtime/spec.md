# Spec — hc-app Runtime (Herdr TUI + hc core)

## Status

Proposed. No behavior change yet.

## Surface — no model-facing change

Same tools, same opaque IDs, same agent Markdown:

```text
shepherd_spawn(agent, {cwd, label, placement}) -> agent ID
shepherd_delegate(agentID, task) -> task ID
shepherd_message(target, message, {...}) -> message ID
shepherd_watch({id}) -> completion(s)
shepherd_status(agentID) -> {proc, task, waitingOn, stale}
shepherd_close({id})
shepherd_read(agent, {lines})
child: shepherd_message(parent|peer) + shepherd_done
```

No `backend` field on any tool schema, prompt snippet, or result.
A model must not be able to decide runtimes.

## Backend setting (app side only)

```jsonc
// user layer (pi-shepherd/config.json) + optional project delta
{
  "backend": "auto" // | "herdr" | "hc" — default "auto"
}
```

- `auto` (default): resolve per command from caller environment
  (see Detection). Run where called from.
- `herdr`: pin to TUI runtime. Fail cleanly if `herdr` CLI/server
  unreachable — do not fall back to `hc` silently.
- `hc`: pin to app runtime. Fail cleanly if `hc`/socket unreachable —
  do not fall back to `herdr` silently.
- Setting lives in `/shepherd settings` UI + config files only.
  `confirmProjectAgents`-style safety: project config may suggest but
  must not force a runtime for everyone (user-owned precedence, same
  rule as agents). Exact precedence to be fixed in plan (proposal:
  explicit user pin > auto-detect; dormant project file never forces).

## Detection — where are we?

Authoritative signals only (env + binary + socket), never labels/titles.

```text
herdr-tui iff:
  HERDR_ENV == "1" AND HERDR_PANE_ID set AND `herdr --version` ok
  (+ optional: ~/.config/herdr/herdr.sock reachable)

hc-app iff:
  HC_TERMINAL_ID set AND HC_TERMINAL_SOCKET exists AND `hc ls` ok
  (+ optional: GIO_LAUNCHED_DESKTOP_FILE == herdr-app.desktop)

plain otherwise:
  neither env set. May drive either headless server if reachable,
  else error with setup hint.
```

Rules:

- Check per command (cheap: env first, then cached binary/socket probe
  with short timeout). No sticky process-global decision.
- Nested case (`HC_TERMINAL_ID=t4 parent=t1`): innermost caller wins.
  If both Herdr and hc signals present, prefer the direct caller env
  (`HC_*` when invoked from `hc`, `HERDR_*` when invoked from TUI pane).
- `plain` + `auto`: prefer reachable `herdr` server if up, else `hc`
  socket if up, else error naming both setup hints. Never guess topology.
- Detection result is internal only. Never leak `paneId`, `t4`,
  `conversationId`, socket paths, or `HERDR_*`/`HC_*` values in tool
  results or widget rows — opaque IDs only.

## Runtime interface

Reuse `src/runtimes/runtime.ts` (`ShepherdRuntime`) unchanged:

```text
src/runtimes/
  runtime.ts   # unchanged 7-method contract
  herdr/       # existing
  hc/          # new: runtime.ts over `hc run/send/read/wait/kill`
src/core/      # shared: discovery, ids, config, artifact-sessions
src/extension/ # unchanged surface; resolves runtime per command
```

- `spawn`: `hc run --bg pi ...` + `hc label` ownership; `placement`
  may differ (TUI `pane_right/tab/workspace` vs app terminals) but
  caller-visible semantics stay identical (background, `--no-focus`
  equivalent, cwd preserved, inspectable).
- `delegate/message/watch/status/close/read`: map onto
  `hc send/read/wait/get/kill` with same opaque-ID contract.
  Raw `t4` / `w1:p1` never accepted as handles, never leaked in
  `status/read/prune`.
- Ownership: new `created-terminals.json` beside `created-panes.json`.
  Only close what this Shepherd created.

## Safety

- Keep all current Herdr invariants (`--no-focus`, only-close-ours,
  temp-dir lifetime, `confirmProjectAgents` user-owned).
- Mirror for `hc`: only `hc kill/rm` owned terminals; background terminals
  use `keep`; never `hc server stop` from a live session.
- Cross-runtime refusal: pinned-but-unreachable backend returns a
  service message + `call/return/details` (standard Shepherd error shape)
  with the setup hint, not a fallback spawn.

## Verification (deferred to tasks.md)

- Suite green on `backend: herdr` unchanged.
- New `verify-hc-matrix.mjs`: same orchestrator prompts on both runtimes;
  opaque-ID contract holds; cross-spawn refusal; `expectsReply` +
  `staleWaitThreshold` + `timeout` parity; fieldnotes mirror intact.
- Live: TUI spawn/read/close unchanged; app spawn/read/close from `hc`;
  `auto` in each caller runs local.
