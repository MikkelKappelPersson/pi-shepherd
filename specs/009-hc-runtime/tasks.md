# Tasks — 009 hc-runtime

Work in order. Phase 0 must stay green before Phase 1 starts.

## Overnight run + testing (no reload)

- This runs overnight. The main Pi session cannot reload extensions,
  so never rely on in-place reload for live verification.
- For live tests needing new code: `hc run --bg` a fresh herdr-core
  agent (full `pi` path), then have that child call `shepherd_*`
  (`spawn`/`delegate`/`watch`/`done`) to spawn agents. That yields
  a fresh Pi session with updated code.
- Keep `npm test` green in the current session for unit checks; use
  the fresh `hc` child only for live spawn/delegate/watch proof.

## Phase 0 — Detect + setting, no behavior change

- [ ] **0.1 Add `src/runtimes/detect.ts`**
  - Pure `detectCaller(): herdr-tui | hc-app | plain` from env + binary +
    socket only. Unit-testable with injected env/exec.
  - Cases: TUI (`HERDR_ENV=1` + `HERDR_PANE_ID` + `herdr --version`),
    app (`HC_TERMINAL_ID` + `HC_TERMINAL_SOCKET` + `hc ls`),
    plain, nested (innermost wins).
  - No tool/result/README change.

- [ ] **0.2 Add `backend` setting (`auto` default)**
  - Extend `src/core/config.ts` store + `/shepherd settings` UI with one
    row: `backend: auto|herdr|hc`, default `auto`.
  - User-owned precedence (project cannot force). No `shepherd_*` schema
    change. Document: setting is app-side, model never decides.
  - `resolveBackend(pin, caller)`: pin if `herdr|hc`, else caller mapping
    (`herdr-tui->herdr`, `hc-app->hc`, `plain->reachable-or-error`).
  - Pinned-but-unreachable fails cleanly with setup hint, no fallback.

- [ ] **0.3 Verify Phase 0**
  - `npm test` green; existing `verify-*.mjs` untouched.
  - Unit: detect matrix (TUI/app/plain/nested/missing-binary).
  - Live: TUI caller still spawns TUI; app caller resolves `hc` (error
    until Phase 1 implements it — must be clean refusal, not cross-spawn).

## Phase 1 — hc spawn/delegate/watch/done

- [ ] **1.1 Scaffold `src/runtimes/hc/`**
  - `hc.ts`: `isHcAvailable`, `hcExec`, `recordCreatedTerminal`,
    `pruneStaleCreatedTerminals`, launch-file writer reuse.
  - `runtime.ts`: `createHcRuntime(ctx)` implementing `ShepherdRuntime`
    over `hc run/send/read/wait/kill`. No `herdr` import.

- [ ] **1.2 Wire resolver**
  - Route `delegate/close` (1:1) through resolved runtime first; keep
    spawn/message/status/read on concrete runtime with comment until
    parity proven (same Phase-0 pattern as 006 task 0.3).
  - Add `verify-hc-matrix.mjs`: same prompts both backends, opaque-ID
    refusal (`t4`/`w1:p1` rejected), ownership refusal.

## Phase 2 — Parity + docs + live

- [ ] **2.1 message/status/read parity** (`expectsReply`, `staleWaitThreshold`,
  `timeout->blocked`, `read --lines` tail, `done`-nudge).
- [ ] **2.2 Fieldnotes check** (same `.shepherd/sessions/` bridge on both).
- [ ] **2.3 Docs + live proof** (README one row: night-pen style; live TUI
  + app spawns, `auto` runs local, pins refuse cleanly).
