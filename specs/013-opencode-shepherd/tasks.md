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
  - The "live re-verify pending" wording in the older bullets below is superseded by journal entries 10–13 — both fixes were live-confirmed. Those bullets are kept only as a chronological record.
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
- [x] T013 [US4] Acceptance: sequential delegations across hosts share notes; disabled-notes mode stays off everywhere.
  - Filesystem acceptance via `test/verify-cross-host-notes.mjs`: one opaque
    parent identity + one project root yields exactly one
    `.shepherd/sessions/NNNN-*` directory across sequential Pi → OpenCode and
    OpenCode → Pi delegations, with two/three distinct finalized notes, one
    MOC linking them, metadata reload, and no global index (spec 003 non-goal).
    Both per-session setting gates honor `fieldnotes: false` and stay off
    across a mid-session config flip; new sessions observe the change.
    Full suite: 653 PASS (exit 0).
  - Scope: the handoff is verified at the resolver/gate + artifact layer, not
    with two live host TUIs; cross-host sharing requires both hosts to present
    the same opaque parent identity for a project. A live two-host walkthrough
    remains optional (see "Later").

## Phase 5 — One package, verified twice (US5, US6)

**Goal**: single installable package, per-host docs, both suites gating every change.
**Checkpoint**: fresh installs in each host (following only that host's docs) both herd working sheep; both suites green.

- [x] T014 [P] [US6] Manifest carries both entries (Pi extension + OpenCode plugin); install verified fresh in each host with no steps from the other host.
  - `package.json` now declares `pi.extensions: ["./index.ts"]` and an
    `exports` map whose root resolves to `./src/opencode/server.ts` (the
    `Plugin.define` default export OpenCode loads via `plugins` in
    `opencode.json`).
  - `test/verify-packaging.mjs` packs the tarball, asserts both entry files
    and the shared engine are shipped, installs it into an isolated consumer,
    and checks bare `@luminascale/pi-shepherd` resolves to the OpenCode plugin
    while the installed manifest still declares the Pi entry. Full suite:
    657 PASS (exit 0).
- [x] T015 [P] [US6] README splits into per-host tracks on the first screen.
  - New title/host-neutral intro, a "Choose your host" picker linking to
    "Pi track" and "OpenCode track" before shared content. Each track has its
    own install/verify steps and host-specific behavior (Pi settings menu vs
    OpenCode file-based config and display-only command output).
  - `test/verify-host-docs.mjs` guards the first-screen split and the OpenCode
    `plugins` config snippet. Full suite: 657 PASS (exit 0).
- [x] T016 [US5] Mirrored OpenCode verification harness covering FR-001–FR-004; both harnesses run on every change.
  - `scripts/verify-suites.mjs` derives the Pi (36 scripts) and OpenCode
    (11 scripts) suites from `package.json`; `npm test` chains both, and a new
    `*:test` script cannot silently escape them.
  - `test/verify-opencode-surface.mjs` loads the real plugin module (module-load
    smoke test) and drives `setup` with a fake host, asserting the full tool
    family, visible-pane launch overrides, child-only completion, and
    watcher/notice isolation (FR-001–FR-004). This absorbs the harness-hardening
    "Later" item. Full suite: 661 PASS (exit 0).
- [x] T017 [US5] Release checklist: per-host impact notes; Pi-only change ships with zero OpenCode-side edits (and vice versa).
  - `docs/releasing.md` requires both suites green, explicit per-host impact
    lines, and the T018-before-T019 release order including the `npm deprecate`
    pointer.
  - `scripts/host-impact.mjs` classifies a git range (or `--files`) into
    Pi-only / OpenCode-only / shared / docs and prints the verdict;
    `test/verify-host-impact.mjs` covers every verdict plus the checklist.
- [x] T018 [US5] Farewell release on the old name: one-time migration notice (marker file; human sessions only; never in child sheep panes), README banner, final old-name publish plus `npm deprecate` with pointer to the new name. The old name gets its final notice-bearing release (`0.5.2`); the new package (`0.6.0`) is published first so the pointer is never a 404. See the revised ordering in `plan.md` and `docs/releasing.md`.
  - `src/core/migration.ts` emits a one-time, display-only notice gated by a
    per-host marker (`<agentDir>/pi-shepherd/migration-notice.json`). Child
    processes (`PI_SHEPHERD_SESSION` / `SHEPHERD_TASK_ID`) never see or consume
    it. Wired into Pi `session_start` and the OpenCode command output path;
    README banner and the deprecated-publish/deprecate ordering added.
  - `test/verify-migration-notice.mjs` covers once-only, per-host markers,
    child suppression, and both host entry points.
  - Operator note: the actual last old-name publish + `npm deprecate` remain a
    release action documented in `docs/releasing.md`; this commit carries the
    code/docs that must ship in it.
- [x] T019 [US6] Rename package to `@luminascale/shepherd` (manifest + URLs; FR-013); verify old-install → remove → new-install keeps settings and herd (SC-005).
  - Manifest name is now `@luminascale/shepherd`; README install commands and
    packaging tests updated. Repository URLs stay on the `pi-shepherd` repo,
    which is unchanged. All functional identifiers stay frozen: `shepherd_*`
    tool names, `SHEPHERD_`/`PI_SHEPHERD_` env prefixes, `pi-shepherd` user data
    dir, and `.shepherd/config.json`.
  - `test/verify-rename-migration.mjs` simulates old-install → remove →
    new-install with isolated HOME and asserts settings and the created-pane
    registry are read intact from the frozen paths. Full suite: 670 PASS
    (pi 36 + opencode 11 scripts).

## Later

- [x] Watcher completion notices must reach only human parent sessions, never a sheep pane, and must survive a transient parent-busy failure (found in live T011, 2026-11-18). `src/opencode/bridge.ts`: `noteTaskParent` and `promptParent` both reject sheep sessions; `promptParent` retries up to 3 times with backoff and logs on exhaustion instead of silently dropping. Regression: `test/verify-opencode-notice.mjs`. **Live-verified 2026-11-18:** completion notice landed in the parent session.
- [x] Reload resilience — **implemented the "document orphan-reap" option** (2026-11-18). Full rehydration would require restoring opaque-id tokens, broker singletons, task deadlines, reply correlation, watcher queues, and HC generation ids across the shared engine; the supported one-parent-per-process boundary makes that a redesign. Instead, `src/opencode/orphans.ts` detects live owned panes/terminals that have no in-memory `SheepRecord` after a reload, prunes confirmed-gone entries, and emits one display-only notice per distinct orphan set (marker: `orphan-notices.json` in the host data dir; native ids never leak). The `shepherd` tool gained `action: "reap"`, which closes only transports still recorded in the ownership registries for the calling session, then clears their entries and launch dirs. Regression: `test/verify-opencode-orphans.mjs` (fake Herdr/hc, isolated HOME) covers detection, one-time notice, new-orphan notice, reap, launch-dir cleanup, and cross-session protection. **Scope:** tracked tasks/watchers do not survive a restart; orphans are reported and reaped, not reattached. README documents the behavior.
- [x] Multi-parent broker multiplexing — **re-evaluated 2026-11-18, closed as a
      documented non-issue for supported flows.** The broker caches are
      process-singletons keyed by the parent session id (Herdr
      `ensureParentBroker`, hc `ensureBroker`), and a session switch creates a
      new broker rootDir. Interleaving two parent sessions in one server
      process can strand the other session's envelopes, but the whole engine
      — not just the brokers — is one-parent-per-process: `beginSession`
      clears watchers and retires opaque ids, the Herdr drain timer and hc
      poller each track one key, and hc ids carry a process-wide
      `generationId`. None of the micro-fixes work in isolation: removing the
      cache would mint a fresh empty mailbox per call, keying by root path is
      impossible before `createParentBroker` generates it, and a per-session
      broker map alone would still lose watchers and one-sided drains. Sheep
      of different parents cannot collide at the broker layer — unique
      rootDirs, broker ids, and capability validation reject cross-parent
      addressing. All supported flows (one parent, many sheep, peer replies,
      done-nudge, watcher notices) are covered and live-verified. If
      multi-parent concurrency becomes a requirement, it is a separate spec
      covering broker maps, deterministic roots, session-keyed registries and
      watchers, per-session timers, and capability survival — not a broker
      patch.
- [x] Sheep sessions that call a parent-only tool before binding must not be permanently misclassified as parents (found in live T011 re-run, 2026-11-18: verbatim from handB — "this session was not bound as a delegated sheep session, so the tool fell back to the parent form and returned Unknown child target"). `src/opencode/bridge.ts`: `markParentSession` no-ops for known sheep, `isParentSession` returns false for known sheep, `bindChildSession` clears stale parent marks. Regression in `test/verify-opencode-notice.mjs`. **Live-verified 2026-11-18:** handB replied via `shepherd_message` (zero shell calls), handA called `shepherd_done` completed, watcher completion reached the parent.
- [ ] Optional live T013 walkthrough — **blocked on a product decision, not
      on test infrastructure.** Cross-host sharing requires both hosts to
      present the same opaque parent identity; Pi uses its session id and
      OpenCode uses its session id, and neither public tool surface exposes an
      identity override. `test/verify-cross-host-notes.mjs` proves the shared
      layout works when the identity matches, but there is currently no
      supported way to arrange that in two live host sessions. Enabling this
      walkthrough needs a new, explicitly designed cross-host binding key
      (on both adapters, without regressing Pi) — budget it as a separate
      feature rather than forcing it into this handoff. Tracked as
      [GH #19](https://github.com/MikkelKappelPersson/shepherd/issues/19).
- [x] Verification-harness hardening (folded into T016 + contributor notes): the OpenCode suite loads `src/opencode/server.ts` for real via `verify-opencode-surface.mjs` (a bad import can no longer sit unnoticed), and `npm test` gates both suites. The live-testing rules remain in force for human handoffs: after every adapter change reload, confirm NO "failed to load plugin" lines, run one trivial tool call, then test; never touch plugin files mid-test; never delete the dev loader without restoring it; distrust model self-reports of tool presence and assert on artifacts.
- [ ] Native OpenCode session runtime (no Herdr dependency) — separate effort; Path A deliberately first.
- [ ] OpenCode settings UI — only if the file-config default (plan Q2) proves insufficient.
- [x] `/shepherd` command output must not start an agent turn (found during T011 sanity, 2026-11-18). Fixed via `ctx.session.prompt({ ..., resume: false })` in `src/opencode/display.ts`; unit + source-guard regression in `test/verify-opencode-display.mjs`. **Live-verified 2026-11-18:** command output rendered in full with no assistant turn (T011 journal entry 10).

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
