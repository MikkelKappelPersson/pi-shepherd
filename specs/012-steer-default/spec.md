# Spec — 012 steer default

## 1. Behavior

- The default `delivery` for `shepherd_message` (parent and child
  surfaces, both runtimes) becomes `steer`. Explicit `followUp` still
  queues passively; explicit `steer` is unchanged.
- Wake semantics are untouched: `triggerTurn` stays kind-driven
  (`expectsReply` / `replyTo` / task delegation wake; plain chatter
  does not). The change is interruption urgency for busy recipients
  and prompt turn-start for idle ones, not who wakes.
- Deliberate trade: a plain FYI with no flag now interrupts a busy
  recipient instead of queueing. Senders who want passivity say
  `followUp` explicitly. Rationale: FYI-to-a-sheep is rare; actionable
  traffic is the norm.

## 2. Implementation

- `deliveryMode()` (`src/extension/shepherd-done.ts`): invert —
  `'followUp'` only when explicitly passed, else `'steer'`. Covers
  child-side ingestion and child-built envelopes on both runtimes.
- hc stamps (`src/runtimes/hc/runtime.ts`, three envelope sites +
  the direct-terminal `--force` send): invert each ternary. The
  `--force` send now fires by default, matching the prompt-delivery
  intent (proven live in Track C1b).
- herdr stamps (`src/runtimes/herdr/lifecycle.ts`, expectsReply +
  plain branches): invert both.
- Parent `shepherd_message` schema description + the hc-path
  `returnValue` fallback (`?? 'steer'`): report the effective default.
- No changes to explicit `delivery: 'followUp'` senders (nudges,
  stale/task bridges, task-delegation envelopes — delegation wakes
  by kind). No changes to `triggerTurn` logic anywhere.

## 3. Verification

- Full `npm test` green (no suite pins the default; any that does
  gets updated only if the pin contradicts this spec).
- Live: skill Track C2 rerun with the `delivery` flag omitted on
  both legs — crossed summaries exact (`ping-69415` / `pong-69415`),
  and broker forensics show both envelopes carried `steer`. (C1 with
  an omitted flag needs a reloaded parent, since the stale session
  stamps the old default; deferred to the next reload.)
