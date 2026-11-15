---
name: smoke-test
description: Live smoke-test Shepherd sheep on hc or herdr backends (spawn/delegate/watch/status/close, completion timing, broker forensics). Use when asked to smoke-test Shepherd, verify completions arrive, or check for junk broker stores.
---

# Smoke test

Live proof that delegated work settles and the parent hears about it.
Deterministic suites (`npm test`) are the pre-gate — run them first.
Smokes are the live complement, not a replacement.

What's in this skill:

- **Track A — Shepherd-driven smoke** (below): the spawn → delegate →
  watch → status → close sequence, same on both backends, with
  message-free and idle-wake variants.
- **Track B — direct-runtime poll probe** (below): `scripts/live-smoke-poll.mjs`,
  runnable headless via `npm run smoke:poll` (hc only, ~3–4 min).
- **`references/forensics.md`**: broker before/after snapshots, junk-store
  checks, timing interpretation, herdr pane notes.
- **Track C — messaging smoke** (below): parent→child→parent
  `expectsReply` round trip, then peer→peer ping/pong between two
  sheep with the parent out of the middle.
- **Backend differences table** (bottom): hc vs herdr at a glance.

## Track A — Shepherd-driven smoke (both backends)

Same tool-call sequence on either backend; only the setup differs.

**Setup.** hc: default when called from an hc app session. herdr: run
from inside a herdr pane, or pin `backend: "herdr"` in user config and
reload. Confirm which backend you are on before starting.

**Steps.**

1. Snapshot broker state (see `references/forensics.md`).
2. `shepherd_spawn` a `scout` (quick recon) or `worker` (timed sleep).
3. `shepherd_delegate` a short task with an explicit timeout.
4. `shepherd_watch` immediately — expect `pending` (registration is
   non-blocking and returns at once).
5. Wait out the work (sleep in bash; ~90 s for a small recon).
6. `shepherd_status` — expect fresh state; on current code the status
   view drains first, so this is a live read, not a stale one.
7. `shepherd_close` the sheep. Always close — never leave sheep running
   past the smoke.
8. Diff broker state against the snapshot: exactly the expected stores,
   zero junk (forensics reference).

**Variants.**

- *Message-free (poll proof):* send no `shepherd_message` for the whole
  run. Completion must still arrive promptly — on hc that means the
  250 ms background poll settled it, not the far-away delegate
  deadline. If completion takes ~deadline instead of ~seconds, the poll
  is broken.
- *Idle wake (unseen path):* delegate with NO watcher, end your turn.
  The completion must reopen your turn as a coalesced unseen notice
  naming the `shepherd_watch` retrieval call. Then watch (returns
  completed synchronously) and close.

**Pass criteria.** Spawn/delegate/watch/status/close all succeed;
completion arrives in seconds-to-minutes (bounded by the work, never
by the deadline); no `hc-parent-*` junk stores; sheep closed.

## Track B — direct-runtime poll probe (hc only)

`scripts/live-smoke-poll.mjs` delegates with a 30-minute deadline and
then observes *only* through drain-free reads (status view + inbox dir
stats — no watch, no message, no status calls). Any prompt settlement
is therefore the background poll, unconfounded. Run from the repo
root; takes ~3–4 minutes (live `hc run --bg` child).

```sh
node --experimental-strip-types --disable-warning=ExperimentalWarning \
  .agents/skills/smoke-test/scripts/live-smoke-poll.mjs
```

It asserts: poller running while work is open, done arrives, settle
lag after arrival is poll-bounded (< 10 s, not deadline-bound), no
junk stores, close clean.

## Track C — messaging smoke (both backends)

Covers what Tracks A/B don't: a real parent→child request with a
correlated reply, and a real peer→peer exchange with the parent out
of the middle. Needs real children (wakes + broker relay are the
point), so this is Shepherd-driven only — no script version. ~5 min.

Wake semantics to rely on: a message with `expectsReply` and any
message with `replyTo` wake a waiting agent automatically; a plain
`followUp` with neither only queues. So every leg that must wake
someone is a request or a reply, never a bare follow-up. A child
that has nothing to do yet ends its turn WITHOUT `shepherd_done`
and lets the incoming message wake it.

**C1 — parent→child→parent round trip.**

1. Snapshot broker state; `shepherd_spawn` one `worker`.
2. `shepherd_delegate` a stand-by task with NO time limit in the
   text ("wait as long as it takes; never give up") — first-wins
   settlement means a premature give-up `done` poisons the task
   (observed live: a give-up `failed` won over the correct reply
   that arrived 9 s later). The delegate `timeout` is the backstop.
   Task: stand by, reply via `shepherd_message` (`replyTo` the
   request, text = the code word), then `shepherd_done`.
3. `shepherd_message` to the exact agent id with
   `expectsReply: true` (plus the task id; `delivery: "steer"` is now
   the default and may be omitted),
   text "request: report code word `mango-<pid>`". Steer, not
   followUp — a followUp to an idle child sat queued for minutes
   (observed live). The request wakes the child; the task waits.
4. Expect the reply notification naming the request, then the
   `shepherd_done` completion via watch. Assert the code word matches
   in both the reply and the done summary.
5. `shepherd_close`; diff broker state (no junk).

Budget minutes, not seconds: child boot plus the idle-wake leg
dominates on hc. Consumed envelopes land in broker-root
`processed/`, not `parent/processed/` — look there for forensics.

**C2 — peer→peer ping/pong.**

1. `shepherd_spawn` two `worker`s, A and B. Nonce `ping-<pid>`.
2. Delegate to B with NO time limit in the text (same first-wins
   reason as C1): "Stand by. When a message from a peer arrives,
   reply to the sender via `shepherd_message` (set `replyTo`, text
   `pong-<pid>`), then `shepherd_done` with the RECEIVED text as
   summary." Timeout 10. B ends its turn waiting.
3. Delegate to A, embedding B's exact agent id: "Send
   `ping-<pid>` to agent <B-id> via `shepherd_message` with
   `expectsReply: true`. Then end your turn WITHOUT `shepherd_done`
   and wait — no time limit, never give up. When the reply arrives,
   `shepherd_done` with the reply text as summary." Timeout 10.
4. Watch both tasks (expect pending, then both completed — order:
   B first, then A).
5. Assert A's done summary is `pong-<pid>` and B's is `ping-<pid>`:
   the full round trip went through the broker relay with no parent
   involvement. Close both; diff broker state (no junk).

**Pass criteria.** C1: reply notification + done, code word intact
both ways. C2: crossed summaries exact, both sheep closed, no junk.
Timeouts must never fire — a timeout means a wake or relay failed.

## Backend differences

| | hc | herdr |
|---|---|---|
| Parent drain trigger | 250 ms background poll + drain-first watch/status/deadline | 250 ms `parentBrokerTimer` + drain on tool calls |
| Completion store | `/tmp/pi-shepherd-broker-*/` session dirs | pane-scoped inbox dirs (no `/tmp` session brokers) |
| Junk signature | `hc-parent-*` session ids | raw pane-id bypasses of the ownership registry |
| Settled task in status view | disappears (view carries unsettled tasks only) | check `describeH...StatusView` equivalent |

The status-view-clears-on-settle rule (hc) is a classic false alarm:
a delegated task vanishing from the view while the agent is still
known MEANS settled, not lost.
