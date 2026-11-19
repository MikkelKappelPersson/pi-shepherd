# Research — Can hc make a separate, parentless agent tab?

`specs/014-no-parent-hc-sheep` · 2026-11-19

## Question

Can an hc-backed Shepherd launch an agent that is visible in its own Herdr
app tab but is **not** shown as a subagent under its parent — and is there an
equivalent in the older Herdr TUI?

## Context

The choice determines whether the no-parent mode is hc-only or must also be
implemented for the TUI backend. Evidence was gathered from CLI help, the
installed Herdr app guide, the current runtime source, and a live experiment.

## Findings

- `hc run --help` exposes `--parent <PARENT>`, **`--no-parent`** ("No parent,
  even when started from a terminal"), `--outlive-parent`, and repeatable
  `--label KEY=VALUE`. Source: `hc run --help`.
- The Herdr app shows a core terminal in a tab only when it carries the
  `herdr.space=<id>` label; `herdr.tab=<id>` selects the tab, and without it
  Herdr creates one. Sub-agents are defined by the core's recorded `parent`
  from `hc run`. Source: `~/.config/herdr-app/AGENTS.md` (terminal adoption,
  agents/sub-agents sections); `herdr-app --skill`.
- Live experiment: `hc run --bg --no-parent --outlive-parent --label
  herdr.space=<caller's space> --name detach-test sleep 300` produced terminal
  `t3d` with `parent: null`, a new tab in the shepherd space, and **no entry**
  in the parent terminal's `sub_agents` list. It was then killed and removed.
  Source: `hc get t3d`, `herdr-app ls`.
- The caller's space id is discoverable at runtime from the calling terminal:
  `hc get "$HC_TERMINAL_ID"` → `labels["herdr.space"]` (in this session,
  `sp269c052ae98ba6c9eb385d736729570f`). Source: `hc get $HC_TERMINAL_ID`.
- The current hc launch in `src/runtimes/hc/hc.ts` (`launchPiInHcTerminal`)
  uses `hc run --bg --json --cwd … --label shepherd.owned=true --label
  shepherd.agent=… --no-notify --outlive-parent bash <launch-script>` — it
  passes neither `--no-parent` nor `herdr.space`, which explains today's
  nested display.
- A live probe calling `shepherd_spawn({ agent: "worker", label: "flag test",
  no_parent: true })` **succeeded** but spawned an ordinary subagent:
  terminal `t3f` had `parent: t2g` and no `shepherd.no-parent` or
  `herdr.space` label. Unknown spawn options are currently ignored, not
  rejected. The new flag must therefore be parsed and validated explicitly,
  or callers will get a silent no-op — the exact failure FR-008 forbids. The
  probe agent was closed with `shepherd_close`.
- Orphan reaping in the hc runtime is ownership-registry based
  (`forgetOwnedTerminal` checks the recorded owner), not dependent on the hc
  `parent` field. Source: `src/runtimes/hc/hc.ts`.
- Herdr TUI has no equivalent switch: `herdr tab create --help`,
  `herdr pane split --help`, and `herdr workspace create --help` offer no
  parent/no-parent option; the TUI starts the terminal process for each pane
  itself. The herdr backend already creates a tab/pane per agent via
  `herdr tab create` / `herdr pane split` (`src/runtimes/herdr/herdr.ts`).
  Source: CLI help + runtime source.

## Decision

Implement the mode in the hc runtime only: when no-parent is requested, add
`--no-parent` and `herdr.space=<caller space>` to the launch and record a
`shepherd.no-parent` label. The herdr/TUI backend ignores the mode, because
its agents already have their own pane and no parent relationship exists to
remove. No new dependency is required.

## Alternatives rejected

- `herdr-app do terminal.keep … place tab` after a normal spawn — gives a tab
  but leaves the hc `parent`, so the agent still appears under the parent.
- Using the herdr/TUI backend for manual spawns — wrong runtime, needs the
  TUI server, and would cross-spawn from the app.

## Visual baseline (live Herdr app, 2026-11-19)

Captured with `herdr-app ls` in the `shepherd` space. A default spawn and a
`no_parent: true` spawn were launched back-to-back from the same caller;
`hc get` supplies the native details that the app summary omits.

```text
default (scout, "baseline subagent")            no_parent (worker, "separate tab")
  hc:   t3g                                       hc:   t3h
  parent: t2g                                     parent: null
  labels: shepherd.owned/agent/name               labels: + herdr.space=<caller space>
          (no herdr.space)                                + shepherd.no-parent=true
  herdr: sub_agents of t2g, tab OpenCode          herdr: own tab tb065b387…, sub_agents []
```

`hc get t3h` also reported `die_with_parent: false` and `where: shepherd / 2`,
confirming the terminal was adopted into a new tab in the caller's space.
Lifecycle parity was then checked on a fresh no-parent sheep: delegate →
watch → completion (`OK`) → message → close all succeeded with opaque ids.

## Follow-ups

- Confirm the exact hc version bundled with supported Herdr app releases
  accepts `--no-parent` (present in the installed 0.9.5-era toolchain).
- Decide whether a no-parent agent should be allowed to opt back into a
  parent relationship later (not proposed in this spec).
