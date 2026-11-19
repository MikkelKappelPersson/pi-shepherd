# Intent — No-parent sheep in the Herdr app

`specs/014-no-parent-hc-sheep` · Author: Mikkel (product owner) · 2026-11-19 · approved

## Problem

When I spawn a Sheep from a Shepherd session running in the Herdr app, it
always shows up as a subagent nested under its parent in Herdr's agents list.
It gets a terminal in the background, but visually it belongs to the Shepherd,
not next to it. I cannot choose to have it appear as its own separate agent.

The same thing happens when I type `/shepherd spawn worker` myself. I usually
do that precisely because I want a separate agent that has the right context
but is not a child sitting under the current one. Today I have to spawn it and
then fix the layout by hand, which is not what I meant when I asked for a
separate agent.

In the older Herdr TUI this is not a problem: agents already appear as their
own panes or tabs. This is about the Herdr app and its hc terminals only.

## Proposed outcome

Sheep spawning keeps two clear modes:

1. **Subagent (default)** — behaves exactly as it does today. The new agent
   is visibly under its parent in Herdr's agents list. This is what normal
   delegation should keep producing, and nothing should change for people who
   never ask for anything different.
2. **No-parent agent (on request)** — the new agent gets its own tab at the
   same level, is not listed under any parent, and still behaves as a proper
   Shepherd agent: I can delegate to it, message it, watch its work, and close
   it using the same opaque ids and fieldnotes as before.

There should be a way to ask for the no-parent mode when spawning. When I
manually run `/shepherd spawn <agent>`, that should always be no-parent,
because that command means "give me a separate agent with this context".

I want to be sure the older Herdr TUI is not affected. My understanding is
that the TUI has no parent/subagent distinction at all, so there is nothing to
change there — please verify this rather than assume it.

## Affected users and systems

- Me and other Shepherd users who run Shepherd from a terminal in the Herdr
  app.
- People who delegate to subagents and must keep getting today's behaviour.
- People who use `/shepherd spawn` by hand in the Herdr app.
- The hc runtime, the Herdr app's agents list and tab layout, and Shepherd's
  opaque-id lifecycle (delegate, watch, close, orphan reaping).
- Herdr TUI users: no change intended.

## Constraints

- Subagent stays the default for all automatic delegation. Existing prompts
  and workflows must not silently start producing no-parent agents.
- Manual `/shepherd spawn` in the Herdr app is always no-parent.
- The no-parent mode is hc-only. If the TUI already gives every agent its own
  pane, do not add a redundant option there and do not change TUI behaviour.
- A no-parent agent must still be a real Shepherd sheep: same opaque id,
  task tracking, messaging, fieldnotes, completion notices, and close path.
  Only its place in the Herdr layout changes.
- Backend choice stays app-side; the model must not be able to switch between
  the TUI and hc runtimes.
- No new dependencies, no migration, no change to agent definition files or
  shared settings for existing users.
- If the Herdr app context needed for a no-parent tab is missing, fail with a
  clear explanation instead of quietly spawning the wrong kind of agent.

## Naming decision

- The request is called `no_parent` so it matches hc's own `--no-parent`
  wording (product owner, 2026-11-19).

## Open questions

- Is the TUI really free of a parent/subagent distinction? (Research is
  expected to answer this; record the evidence in `research.md`.)
- What should the request be called in the tool surface, and should the slash
  command offer a way to force a subagent back for the rare case where that is
  wanted?
- If a no-parent agent has no usable Herdr space to land in, should the
  spawn fail outright or fall back to a subagent with a warning?
- Does orphan reaping after a Shepherd restart still find no-parent agents
  when the hc parent link is deliberately absent?

## Approval

- [x] Product owner reviewed and approved — Mikkel, 2026-11-19
