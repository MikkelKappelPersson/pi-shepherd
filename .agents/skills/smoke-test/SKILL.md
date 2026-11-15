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
