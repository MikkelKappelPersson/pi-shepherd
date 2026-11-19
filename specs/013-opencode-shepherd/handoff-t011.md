# Handoff: T011 live acceptance in OpenCode (human-driven)

**Spec:** `specs/013-opencode-shepherd` · **Task:** T011 remainder
**Date:** 2026-11-17 · **Status:** READY (verified 2026-11-18 morning: loader
present, fresh server, `shepherd agents` works, registries empty, quota back)

## Why human-driven

Pi-driven bench sessions (`hc send` into TUIs) proved unreliable for
acceptance: stale tool catalogs across restarts, 100K+ tokens of confused
context, and at least one session that faked tool results by re-running
adapter code via shell. A fresh human-opened session avoids all three and
matches real usage. The engine code is committed (`820f5da`) and the pi
suite is green (631 pass); only live OpenCode acceptance remains.

## Preconditions (assistant verifies before you start)

- [ ] `~/.config/opencode/plugins/shepherd-dev.ts` exists (the dev loader)
- [ ] Server log shows `loading plugin ... shepherd-dev.ts` with NO
      `failed to load plugin ... shepherd` lines after it
- [ ] Registries empty: `~/.config/opencode/pi-shepherd/created-terminals.json`
      and `created-panes.json` contain `[]`
- [ ] Assistant will NOT touch plugin/repo files, restart the server, or
      send anything into your session while you test (coordinate first)

## Setup (you)

1. Open a **new** terminal, `cd` to the repo
   (`/home/mikkelkp/projects/shepherd`), run `opencode`.
2. Fresh session (new TUI = new session). Do not reuse an old session —
   TUIs hold stale tool catalogs across server restarts.
3. Sanity check first — paste: `Call the shepherd tool with action agents.
   Report the agent names.`
   Expect 4 agents (reviewer, worker, planner, scout). If the model says
   the tool is unavailable, STOP and tell the assistant (do not let it
   improvise via shell — that invalidates the test).

## Test A — basic loop (must pass before B)

Paste, one step at a time, waiting for each result:

1. `Spawn scout label handA. Report the agent id, stop.`
2. `Delegate to <agent-id> with task: Reply with the word HAND then call
   shepherd_done with completed. Then watch the task id and report, stop.`

**Pass criteria:** watcher completion arrives with status completed and the
summary mentions HAND. Report back: agent id, task id, watcher text.

## Test B — peer question loop (the actual T011 goal)

1. `Spawn scout label handB. Report the agent id, stop.`
2. `Delegate to <handA-id> with task: Ask <handB-id> (label handB) the
   question "What is your label" using shepherd_message. When it replies,
   call shepherd_done with completed and the answer. Then watch, stop.`

**Pass criteria:** handA's question reaches handB; handB replies via
shepherd_message (with replyTo set); handA calls shepherd_done; the watcher
fires completed with the answer ("handB" — note: the sheep may answer
"scout", its agent type; either is fine as long as the loop completes).
Report back: both agent ids, task id, and the full watcher completion text.
If handB instead claims the tool is missing or improvises via shell, STOP —
paste its exact words back (that is itself a finding).

## Test C — error paths (cheap, do if quota allows)

1. `Call shepherd_done with taskId shepherd-task-0000-0000 and status
   completed. Report the exact error text, stop.`
2. `Call shepherd_message to shepherd-agent-0000-0000 with message hi.
   Report the exact error text, stop.`

**Pass criteria:** both fail with "unknown" errors naming the bad id (not
a crash, not a hang). Report the exact error strings.

## Test D — done-nudge (optional, slow)

Only if quota is comfortable: delegate a trivial task to handA, then ask
handA nothing further and wait ~3 minutes without prompting it. The parent
should receive a nudge reminder about the open task. Report whether any
nudge arrived (check the session — it appears as a shepherd notice).

## Rules while testing

- Do NOT edit repo files, restart the server, or touch
  `~/.config/opencode/plugins/` mid-test. If something looks broken,
  report it instead of fixing it.
- Keep pastes sequential: one tool-using instruction per message, wait
  for the result before the next.
- Report VERBATIM outputs (agent ids, task ids, watcher text, errors).
  Do not summarize — the ids are needed for log forensics.

## Report back

Paste into chat: for each test, PASS/FAIL/STOP + the verbatim artifacts.
The assistant correlates with server logs, ticks T011, and moves to Phase 4.
