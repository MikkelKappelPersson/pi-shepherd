# Tasks — Shepherd for OpenCode

`specs/013-opencode-shepherd` · draft · spec: `spec.md` · plan: `plan.md`

## Phase 1 — Engine decoupling (US5)

**Goal**: shared engine imports nothing host-specific; Pi behaves exactly
as before.
**Checkpoint**: full existing `verify-*` suites green, zero Pi behavior change.

- [x] T001 [US5] Inject agent/config directories and frontmatter parsing into `src/core/discovery.ts` and `src/core/config.ts` (no `@earendil-works` imports left in shared engine).
- [x] T002 [US5] Parameterize the launch-file builder (`src/runtimes/herdr/herdr.ts`) by child binary, child entry, and env-capability prefix; Pi passes today's values.
- [x] T003 [US5] Run all `verify-*` suites plus manual Pi spawn → delegate → watch → close; confirm green and unchanged.

## Phase 2 — OpenCode spawn and inspect (US1)

**Goal**: an OpenCode user can herd visible sheep.
**Checkpoint**: spawn → status → read → close works from OpenCode; unknown names and unreachable Herdr fail cleanly.

- [x] T004 [US1] OpenCode server-plugin skeleton with tool surface for `spawn`, `herd`/`agents`, `status`, `read`, `close` routed through the shared runtime resolver.
- [x] T005 [US1] Child boot via interactive `opencode` in pane/terminal using the parameterized builder (T002); readiness/tail reuse as-is.
- [x] T006 [P] [US1] Human command surface mirroring Pi's (`agents`, `herd`, `spawn`, `status`, `read`).
- [x] T007 [US1] Acceptance: unknown agent name, unreachable Herdr, and duplicate-label spawn all produce their specified errors.

## Phase 3 — Tracked work and messaging (US2, US3)

**Goal**: the full delegate → watch → done loop plus mid-task questions work from OpenCode.
**Checkpoint**: delegate while doing other work, receive completion; question → reply → resume completes.

- [x] T008 [US2] `delegate` + `watch` tools with watcher/notifier bridges and exactly-once delivery (settled results retrievable, late watchers served synchronously).
- [x] T009 [US2] OpenCode child `shepherd_done` tool publishing the shared `task_done` envelope (task inference, mismatch rejection, broker-unavailable error).
- [x] T010 [US3] Parent/peer `shepherd_message` on both sides with `expectsReply` waiting semantics, reply correlation, and the bounded done-nudge + stall escalation.
- [x] T011 [US2] Acceptance remainder: peer reply → resume → done end-to-end without reloads; done-nudge fires for a forgetful sheep; unknown-task done/message errors; missed deadline settles with explanation.
  - Live 2026-11-18: A and B PASS (B after the sheep/parent-classification fix), C PASS for `shepherd_message` (the sheep-only `shepherd_done` gate is a correct refusal, not the bad-id error — see journal).
  - Coverage check: missed deadline is engine-level shared with OpenCode (`verify-unseen-completions.mjs`); done-nudge and sheep-context unknown-task had no OpenCode coverage, so `test/verify-opencode-nudge.mjs` was added (both PASS). Full suite: 645 PASS. The handoff is complete; see the T011 journal below.
  - Mechanism proven pre-restart (rose→jack reply resolved the wait; done fired the watcher). Full peer-`expectsReply` re-run pending quota reset.
  - Post-restart "successes" were INVALID: the bench deleted the dev loader during cache-busting, so later tool output was model improvisation (t28 re-ran adapter logic via shell). Verify tool presence + side-effect artifacts (terminals, broker dirs, registry), never prose alone. Requires: loader file present, fresh server, trivial tool call first, no touches mid-test, fresh TUI sessions (TUIs hold stale catalogs across restarts).
  - **Live T011 run, 2026-11-18 (after display fix):** sanity `shepherd agents` via tool returned 4 agents; `/shepherd agents`/`spawn` command output renders in full with no turn. **Test A PASS** — handA (`shepherd-agent-e221ed63-0ca40db9-d4b5-474a-9b36-0eb1b658c0b6`) completed `shepherd-task-e221ed63-90ac8f1e-ea03-472d-964d-331c07aabbe7`; watcher text: "Replied HAND and marked the delegated task complete." **Test B core loop completed but with two findings:** handB (`shepherd-agent-e221ed63-dea0af1a-a7f8-4232-91a9-9eb37f37bb56`) answered "My label is handB"; handA forwarded it and called `shepherd_done` completed on `shepherd-task-e221ed63-11c1e389-af86-4b61-898e-8d4ddb0c435a`. (1) handB could NOT reply via the `shepherd_message` tool: verbatim — "I'll deliver the correlated reply directly through the broker files (the tool's parent-form path can't address a peer in another session)" and "The correlated parent-form call was rejected because the peer lives in a different broker session, so I delivered the reply through the shared broker (reply envelope + parent replyReceived mirror) and relayed the answer text to handA's terminal." This is the known multi-parent broker multiplexing limit (Later), now blocking the documented peer path. (2) The watcher completion for task `11c1e389` did NOT arrive in the parent session; it appeared in **handB's** pane, while the parent received only handA's forwarded `shepherd_message` (`shepherd-message-e029df62-9911-491f-9d3a-c669d5f62044`, replyTo `shepherd-message-c607d4bd-85b7-4b6f-a6cc-1717ab660001`). **Fixed (code complete, live re-verify pending):** `src/opencode/bridge.ts` now refuses to register a sheep session as a task parent in `noteTaskParent`, refuses to notify sheep sessions in `promptParent`, and retries a transient `session.prompt` failure up to 3 times instead of silently dropping it. Regression: `test/verify-opencode-notice.mjs`. Also: the first handA id (`shepherd-agent-e221ed63-2ef15b1c-...`) was orphaned by the OpenCode server restart (in-memory registry reset; see Later reload-resilience item) — fresh spawn was required.
  - **Finding (human T011 sanity, 2026-11-18) — FIXED, live re-verify pending:** the human `/shepherd` command listed the 4 agents correctly, but also started an assistant turn. Owner reported the invocation as `/shepherd agent`; the displayed header was `[shepherd agents]`. Root cause: `src/opencode/server.ts` command handler delivered every result via `ctx.session.prompt({ sessionID, text: ... })`; `session.prompt` posts a user message and wakes the model, so the command's own output re-entered the model and started a turn. Fix: command output now goes through `src/opencode/display.ts` → `ctx.session.prompt({ sessionID, text, resume: false })`. OpenCode's session layer skips `execution.wake()` when `resume: false`, so the result renders as a full normal message with no assistant turn. Rejected alternatives: `noReply` (v1 only — absent from the installed v2.3.0 prompt schema) and `session.synthetic` (the TUI renders synthetic messages as a single-line truncated notice using `description ?? text`, so a multi-line agent list collapsed to a bare `◈shepherd` label). Parent-session notices (`bridge.ts`) still use `session.prompt` without `resume: false` intentionally. Regression covered by `test/verify-opencode-display.mjs` (unit + source guard). Live confirmation is part of resuming the T011 handoff with a fresh server/TUI.

## Phase 4 — Shared fieldnotes (US4)

**Goal**: notes flow across delegations and across hosts.
**Checkpoint**: Pi sheep reads OpenCode sheep's notes and vice versa.

- [x] T012 [US4] Parent artifact-session resolution in the OpenCode adapter onto the same shared layout Pi uses.
  - Added `src/opencode/fieldnotes.ts`: resolves/creates the parent fieldnotes
    session with the OpenCode session id as the opaque parent identity and the
    session cwd as the project root, using the shared engine resolver — no
    layout duplication and no Pi adapter import. The fieldnotes setting is
    snapshotted per `(session id, cwd)` like Pi's session-scoped setting.
  - `spawnSheep` resolves once and threads the session into both hc and Herdr
    runtime contexts (so the agent record and later delegates reserve notes);
    `delegateSheep` re-resolves so a task always reserves its note. Spawn
    results now print `fieldnote: <relative path>` when enabled.
  - Regression: `test/verify-opencode-fieldnotes.mjs` — layout creation/reuse,
    identity+root separation, Pi↔OpenCode resolution of the same session and
    shared notes, disabled/session-scoped gate, and spawn/delegate wiring.
    Full suite: 650 PASS (exit 0).
- [ ] T013 [US4] Acceptance: sequential delegations across hosts share notes; disabled-notes mode stays off everywhere.

## Phase 5 — One package, verified twice (US5, US6)

**Goal**: single installable package, per-host docs, both suites gating every change.
**Checkpoint**: fresh installs in each host (following only that host's docs) both herd working sheep; both suites green.

- [ ] T014 [P] [US6] Manifest carries both entries (Pi extension + OpenCode plugin); install verified fresh in each host with no steps from the other host.
- [ ] T015 [P] [US6] README splits into per-host tracks on the first screen.
- [ ] T016 [US5] Mirrored OpenCode verification harness covering FR-001–FR-004; both harnesses run on every change.
- [ ] T017 [US5] Release checklist: per-host impact notes; Pi-only change ships with zero OpenCode-side edits (and vice versa).
- [ ] T018 [US5] Farewell release on the old name: one-time migration notice (marker file; human sessions only; never in child sheep panes), README banner, publish `@luminascale/pi-shepherd` last, then `npm deprecate` with pointer to the new name. Ships before T019.
- [ ] T019 [US6] Rename package to `@luminascale/shepherd` (manifest + URLs; FR-013); verify old-install → remove → new-install keeps settings and herd (SC-005).

## Later

- [x] Watcher completion notices must reach only human parent sessions, never a sheep pane, and must survive a transient parent-busy failure (found in live T011, 2026-11-18). `src/opencode/bridge.ts`: `noteTaskParent` and `promptParent` both reject sheep sessions; `promptParent` retries up to 3 times with backoff and logs on exhaustion instead of silently dropping. Regression: `test/verify-opencode-notice.mjs`. **Live-verified 2026-11-18:** completion notice landed in the parent session.
- [ ] Reload resilience: plugin reload/server restart orphans live sheep (in-memory registry, brokers, watchers reset while panes/terminals survive). Persist minimal sheep/task maps and rehydrate on setup, or document orphan-reap. Found during Phase 3 peer testing (misdiagnosed first as broker session-key rotation). Recurred in live T011 2026-11-18: a handA spawned before the OpenCode restart was orphaned; a fresh spawn was required.
- [ ] Multi-parent broker multiplexing: both parent brokers are process-singletons (last-writer-wins per session key), so two concurrent OpenCode parents on different backends/sessions can strand envelopes. Phase 3 verifies single-parent flows only. **Narrowed 2026-11-18:** the specific peer-reply failure seen in T011 was NOT this limit — it was a stale parent mark on a sheep session (fixed below). Re-evaluate whether this broader limit is still observable before budgeting a redesign.
- [x] Sheep sessions that call a parent-only tool before binding must not be permanently misclassified as parents (found in live T011 re-run, 2026-11-18: verbatim from handB — "this session was not bound as a delegated sheep session, so the tool fell back to the parent form and returned Unknown child target"). `src/opencode/bridge.ts`: `markParentSession` no-ops for known sheep, `isParentSession` returns false for known sheep, `bindChildSession` clears stale parent marks. Regression in `test/verify-opencode-notice.mjs`. **Live-verified 2026-11-18:** handB replied via `shepherd_message` (zero shell calls), handA called `shepherd_done` completed, watcher completion reached the parent.
- [ ] Verification-harness hardening (fold into T016 + contributor notes): `node --check` does NOT resolve imports — add a real module-load smoke test (bun import of server.ts) so a bad import can never sit unnoticed. After every adapter change: reload, confirm NO "failed to load plugin" lines, run one trivial tool call, then test. Never touch plugin files mid-test (reloads straddle in-flight flows and orphan in-memory state). Never delete the dev loader without restoring it. Distrust model self-reports of tool absence/presence; assert on artifacts.
- [ ] Native OpenCode session runtime (no Herdr dependency) — separate effort; Path A deliberately first.
- [ ] OpenCode settings UI — only if the file-config default (plan Q2) proves insufficient.
- [x] `/shepherd` command output must not start an agent turn (found during T011 sanity, 2026-11-18). Fixed via `ctx.session.prompt({ ..., resume: false })` in `src/opencode/display.ts`; unit + source-guard regression in `test/verify-opencode-display.mjs`. Live TUI confirmation pending with the T011 handoff rerun.

## T011 live-attempt journal (2026-11-18)

Chronological record of what was tried and what happened, so a later reader
does not repeat a dead end.

1. **Pi-driven bench sessions (before this day)** — `hc send` into TUIs.
   Failed: stale tool catalogs across restarts, 100K+ token confused contexts,
   one session faked tool results by re-running adapter code via shell.
   Conclusion: human-driven fresh TUI only.
2. **Human sanity `/shepherd agent`** — listed 4 agents but started an
   assistant turn. Root cause: command output delivered via `session.prompt`.
3. **Fix attempt A — `session.synthetic(..., resume: false)`** — no turn, but
   the TUI rendered only a `◈shepherd` label (synthetic notices use
   `description ?? text`, single-line, truncated). Abandoned.
4. **Fix attempt B — `session.prompt(..., resume: false)`** — full multi-line
   output renders, no turn. Rejected `noReply` (v1-only, absent from v2.3.0
   prompt schema). Works. Side observation: "OpenCode thinks it's working"
   likely the busy indicator from the assistant's own reply; no pending inbox
   rows found. Left as-is.
5. **Test A (after restart)** — first handA id was orphaned by the OpenCode
   restart (in-memory registry reset). Fresh spawn, delegate, watch → PASS.
6. **Test B first run** — core loop completed (handB answered "My label is
   handB"; handA called `shepherd_done`) but handB could not use
   `shepherd_message` for the peer reply and improvised via broker files;
   the watcher completion appeared in handB's pane, not the parent. Initially
   attributed to multi-parent broker multiplexing.
7. **Fix — watcher-notice routing** — `noteTaskParent`/`promptParent` reject
   sheep sessions; `promptParent` retries up to 3 times. Code + unit test
   green, but not yet observable in a live run (see 9).
8. **Test B re-run (fresh plugin + herdr)** — handB again failed to reply via
   `shepherd_message`, this time with a precise error: "this session was not
   bound as a delegated sheep session, so the tool fell back to the parent
   form and returned Unknown child target." handA stayed `waiting`, so the
   task never settled and the watcher-notice fix could not be exercised.
   Root cause identified: a child that called a parent-only tool before its
   lazy session binding was permanently marked as a parent by
   `markParentSession`; `sheepMessage` then rejected it.
9. **Fix — sheep/parent classification** — `markParentSession` no-ops for
   known sheep, `isParentSession` excludes known sheep, `bindChildSession`
   clears stale parent marks. Regression in `test/verify-opencode-notice.mjs`;
   full suite green.
10. **Test B re-run after reload (SUCCESS)** — handB replied via
    `shepherd_message` only (session export shows zero shell calls), handA
    called `shepherd_done` completed, and the `shepherd_watcher completion`
    notice landed in the parent session with the answer. Both fixes verified
    live. The answer was `opencode` (the child agent's display name), which
    the handoff explicitly accepts.
11. **Close-out + Test C** — both Test B sheep were closed via
    `shepherd_close` and all Herdr sheep terminals confirmed gone; the stale
    `created-terminals.json` bookkeeping was cleared to `[]`. Test C results:
    - `shepherd_done({ taskId: "shepherd-task-0000-0000", status: "completed" })`
      from the human parent returned verbatim:
      `shepherd_done is a sheep-only tool: only the delegated sheep session may complete its task.`
      Correct refusal, but NOT the handoff's expected "unknown" error naming
      the bad id — that path is unreachable from a parent session, so the
      unknown-task error needs a sheep-context call to be exercised. No crash
      or hang.
    - `shepherd_message({ target: "shepherd-agent-0000-0000", message: "hi" })`
      returned verbatim: `Unknown agent id "shepherd-agent-0000-0000".
      Lifecycle ids are scoped to this Shepherd; use the id from the latest
      shepherd_spawn result, not an agent name, label, or pane id.` PASS.
12. **Coverage check + close** — existing suites cover missed deadline at the
    shared engine level (`verify-unseen-completions.mjs`), but nothing covered
    the OpenCode done-nudge path (`src/opencode/bridge.ts` event handler) or
    the OpenCode sheep-context `sheepDone()` unknown-task error. Added
    `test/verify-opencode-nudge.mjs`: fake Herdr + queued
    `session.execution.succeeded` events assert the nudge names the task, is
    delivered once, then escalates to the parent; a direct `sheepDone` call
    with `shepherd-task-0000-0000` asserts the unknown-task error names the
    bad id. Both PASS; full suite 645 PASS (exit 0). T011 ticked.
13. **Outcome** — all three code fixes (command display, notice routing,
    sheep/parent classification) are live-verified; the handoff's Tests A/B/C
    are complete. Outstanding non-blocking items remain in "Later": reload
    resilience, multi-parent broker multiplexing (narrowed), harness
    hardening, Phase 4/5 tasks.

## Notes

- `[P]` = parallel: different files, no dependency.
- `[US1]` = user story from `spec.md`; every task has one.
- Keep task ids stable; add new ones, do not renumber.
- Change code and spec together; update the plan if behavior changes.
- Tick a task only when its verification passes.
