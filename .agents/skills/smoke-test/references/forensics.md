# Smoke forensics

## hc: before/after snapshot

```sh
for d in /tmp/pi-shepherd-broker-*/; do
  s=$(python3 -c "import json;print(json.load(open('$d/broker.json'))['sessionId'])" 2>/dev/null)
  echo "$s $d"
done | sort > /tmp/smoke-before.txt
# ... run the smoke ...
# ... same loop to /tmp/smoke-after.txt, then:
comm -13 /tmp/smoke-before.txt /tmp/smoke-after.txt   # new dirs: expect only the session broker
```

Reload nuance: each process lifetime mints one broker dir per
session, so a reload between snapshots legitimately shows one new
session dir (same sessionId, new brokerId; the old dir is inert —
no process or timer references it). Take both snapshots within one
process lifetime, and expect exactly one live store.

## hc: junk check

Any new dir whose `broker.json` sessionId starts with `hc-parent-`
is a fallback-keyed junk store minted by a bare `ensureBroker()` on a
path that should have threaded the drain's session-keyed broker.
Zero is the only passing number.

## Timing interpretation

- Settle lag after the done lands in `parent/inbox` (or moves to
  `parent/processed/`): **< 10 s** means a live drain path consumed it
  (background tick or tool-call drain). Near the delegate deadline
  means only the deadline drain fired — the prompt paths are broken.
- Caveat: the 250 ms tick consumes inbox files fast, so inbox
  *presence* polls can miss arrivals entirely. Detect arrival via new
  files in `parent/processed/` (they persist), not via inbox
  non-emptiness.
- Status-view caveat: the view carries unsettled tasks only. Task gone
  + agent known = settled.

## herdr

No `/tmp` session brokers. Forensics are pane-scoped inbox dirs (see
`src/runtimes/herdr/messaging.ts` `inboxPath`) plus the owned-pane
registry (`created-panes.json`). Raw pane ids must never bypass the
ownership check on close.
