# Journal — 012 steer default

## Scope

One user sentence ("default should be steer") → compact spec, six
ternary flips, one suite pin, live proof, land.

## What changed

- `deliveryMode()` inverted (child-side choke point).
- hc: three envelope stamps + the direct-terminal send (now
  `--force` by default) inverted. The forcesend matches what the
  explicit-steer C1b run already proved prompt.
- herdr: both `sendParentMessage` stamps inverted.
- Parent schema description + hc-path `returnValue` fallback report
  the effective default.
- `test/verify-message-routing.mjs`: the plain-message default pin
  `followUp` → `steer` (the one pin that contradicted the spec).

## Design notes

- The wake (`triggerTurn`) stays kind-driven and untouched; only
  interruption urgency changed. Child→parent already steered
  wake-deserving messages — this aligns the other direction.
- Choke-point correction: the first cut assumed `deliveryMode` was
  the single default site; the runtimes stamp their own. All six
  found by grep, all flipped.
- Deliberate trade recorded in spec §1: flagless FYI now interrupts.
  Say `followUp` for passivity.
- Live proof limits: the C2-omitted run proves the child-side
  default (fresh child processes build their own envelopes).
  Post-reload C1-omitted (C4, `mango-69416`): the parent request
  with no flag carried `steer` forensically and completed intact —
  parent-side stamp proven too. All six sites now proven live.

## Verification

- `npm test` exit 0.
- Live C2-omitted: crossed `ping-69415`/`pong-69415`, envelopes
  forensically `steer`, zero junk dirs, both sheep closed.
