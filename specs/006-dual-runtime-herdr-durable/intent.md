# Intent — Dual-runtime Shepherd (Herdr + Durable)

## Why this exists

pi-shepherd already works: an orchestrator herds one specialist per task in
visible Herdr panes. One team runs test-driver agents against the app under
test, and on crash a different-context reviewer takes over. That workflow
must not break.

A second need has appeared alongside it: a company test agent that runs
overnight. Multiple users, different models per user (free local vs. company
Copilot), test plans submitted in the evening, reports read in the morning.
Herdr panes alone cannot survive a 2am reboot, deduplicate a retried submit,
account usage per model, or run headless. That is what durable execution is
for.

This spec exists to serve **both** without forking the project into two
mental models.

## Who it serves

1. **Today's Herdr user** — drives shepherd interactively, watches sheep
   work, reads panes. Fieldnotes are the agents' shared memory, not a
   human deliverable. Must notice zero change by default.
2. **Overnight test owner** — submits a test plan, sleeps, reads a report.
   Needs resume-after-crash, no double test runs, per-user model routing,
   and a readable morning artifact. Never opens a Herdr pane if they do not
   want to.
3. **Maintainer (us)** — one codebase, one tool surface, one agent format.
   No parallel `herdr_*` vs `durable_*` universe to document and test twice.

## What success looks like

- The same orchestrator prompt — _"run plan A with test-driver, on crash
  hand fieldnote + logs to crash-reviewer, return both"_ — runs unchanged
  on Herdr by day and on durable by night.
- A user with a free local model and a user with a Copilot subscription use
  the same agents; only the Shepherd session's default model differs.
- A host reboot at 2am is a non-event: reopen, `resume()`, agent memory
  intact, HTML report still renders. Same `requestId` never runs the test
  suite twice.
- Morning handoff is a templated HTML file owned by the app, rendered
  from job state. `shepherd.md` is never the human report — it is the
  shepherd/sheep working memory that the report was built from.
- A newcomer reading the README still learns "shepherd herds sheep in
  Herdr" first. Durable appears as one settings row: _night pen_.

## Guiding values

1. **Herdr-first.** Visibility is the product. Panes, `herd/spawn/read`,
   🐑 widget stay default. Fieldnotes stay the agents' working memory —
   they survive compaction and restarts and stay the agents' truth —
   never the human handoff.
2. **Same shepherd, different field.** Durable is a backend, not a rebrand.
   Tool names, opaque IDs, agent Markdown, and handoff habits do not fork.
3. **No magic.** Shepherd stays low-level and explicit:
   `spawn -> delegate -> watch -> done`. No hidden workflow modes, no
   invented completions, no closing panes we did not create.
4. **Agent memory, not human handoff.** `shepherd.md` + per-agent notes
   are for shepherd/sheep to track what is going on. If a detail only
   exists inside SQLite, it does not count as shared agent context — docs
   mirror to files. Human handoff is a separate templated HTML file with
   nothing to do with shepherd internals.
5. **Boring by default.** No SQLite required, no new deps for Herdr-only
   installs, no migration, no rewrite. Durable is opt-in and clearly
   experimental.

## Deliberate temptations to resist

- Adding a second tool family (`durable_spawn`, ...). One surface, backend
  switches underneath.
- Leaking durable vocabulary (`conversationId`, `pi.live`) into user docs
  or tool results.
- Making panes write-capable viewers of durable state (dual-write). Panes
  in `auto` mode tail; execution stays in one place.
- Marking test-driving tools `replay: safe` to make demos pass. Rerunning
  side effects silently is worse than reporting `interrupted`.
- Letting a committed project config disable trust gates or force durable
  on for everyone. Backend choice follows the same user-owned safety rules
  as agents.

## When we are done

We can delete this file's doubts: shepherd still means herding inspectable
sheep — panes by day, committed views by night — it just also works while
we sleep.
