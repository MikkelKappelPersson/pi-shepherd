# Plan: Split the Shepherd Tool Surface

Status: in progress — Phases 0–5 complete (verified 2026-08-26). Next: Phase 6.
Related discussion: constrained-sampling backends drop arguments on bare-`anyOf` tool schemas

## 1. Problem

`shepherd.ts` defines the model-facing tool parameters as a TypeBox discriminated
union:

```ts
export const ShepherdParams = Type.Union([HerdParams, AgentsParams, StartParams, ...], {...});
```

The emitted JSON Schema has **no root `"type": "object"`** — only `{"anyOf": [...],
"description": "..."}`. Pi passes `tool.parameters` to providers essentially unchanged.
Backends that use grammar/schema-constrained decoding of tool-call arguments (observed
with `stealth/ox-alpha` via OpenRouter) have no allowed properties at the top level and
emit `{}` for every call, unrecoverably. Models served behind soft-guidance APIs
(Claude/GPT first-party) work fine, which masks the bug.

Secondary issues surfaced by the investigation:

- Cross-field rules (`wait` requires a prompt `id`) are enforced by JSON Schema today, but
  any flattening loses that unless handled explicitly.
- The unified conceptual narrative (sheep, ids, lifecycle ordering) lives inside the
  single tool description, coupling "what shepherd is" to "how one tool is shaped".
- The existing `/shepherd` command duplicates logic (`agents`/`herd`/`start` re-implement
  what `doAction` already does) instead of delegating to the same core.

## 2. Goals

1. No bare-`anyOf` root anywhere on the wire → works on constrained backends.
2. Declarative requiredness (`id: required`) via separate flat-schema tools.
3. Preserve user ergonomics: `/shepherd spawn worker` (renamed from `start`) keeps working, gains coverage.
4. Single source of truth for behavior: both tools and command delegate to core.
5. Unified meta-description ("subagent framework for native Herdr orchestration") kept
   in one obvious place.

## Non-goals

- No changes to Herdr integration, discovery precedence, or pane ownership invariants.
- No pi-core changes (schema normalization stays out of scope).
- No renaming of persisted settings or artifact-session behavior.

## 3. Target architecture

```
                ┌──────────── core: doAction() / lifecycle.ts ────────────┐
                │            single source of truth for behavior          │
                ▼                        ▼                                ▼
   model surface (flat tools)         user surface (/shepherd cmd)     future RPC?
   ├─ shepherd        (herd|agents|prune)         ├─ agents, herd, spawn      (existing, renamed)
   ├─ shepherd_spawn  (agent, options…)           ├─ status, read             (new)
   ├─ shepherd_prompt (id, message, timeout)     └─ prompt/wait/close         (new, see §5)
   ├─ shepherd_wait   (id[], timeout)
   ├─ shepherd_status (id)
   ├─ shepherd_close  (id)
   └─ shepherd_read   (name, lines, source)
```

Schema fragments shared across tools: opaque agent/prompt id schemas, timeout/lines/source optionals.

## 4. Phases

### Phase 0 — Baseline & guardrails

- [x] Capture current behavior: run `npm test`; record pass set. ✅ All 8 suites pass (schemas:test was added as the 8th).
- [x] Add a schema-shape regression test: assert every registered tool's root JSON Schema
      has `"type": "object"` (fails today for `shepherd`; becomes the invariant).
      ✅ `test/verify-tool-schemas.mjs` added as `schemas:test`; wired into the default
      `test` chain (runs first) and green now that the union is gone. Phase 3 adds the
      six new tools to the checked list (placeholders already in the file).
- [ ] Optional: snapshot the current serialized `ShepherdParams` for diffing. (skipped — the flat schema is small enough to verify by eye)

Files: `test/verify-tool-schemas.mjs` (new), `package.json` (wire test if needed).

### Phase 1 — Unify the core path

Make `doAction()` the single entry so tools and command can never diverge.

- [x] Refactor `/shepherd` handler branches (`agents`, `herd`, `start`) to construct args
      objects and call `doAction()`, rendering via a small result-to-notification helper,
      instead of calling `discoverAgents`/`listHerdrAgents`/`startAgent` directly.
      ✅ Done via `runCommandAction()` in `index.ts`; results surface as notifications.
- [x] Keep `settings` branch command-only (no model-facing equivalent needed).
- [x] Extract `parentArtifactSessionForCommand` reuse so command and tool resolve
      artifact sessions identically.
      ✅ Via the "explicit `artifactSession` wins" pattern: the command pre-resolves
      tolerantly and passes the value, `doAction` honors an explicit value before
      resolving/requiring the parent session itself.

Acceptance: `/shepherd agents|herd|start <agent>` behave identically before/after;
command tests still pass.

Files: `index.ts`, possibly new `cli.ts` for arg parsing/render helpers.

### Phase 2 — Flatten the retained `shepherd` tool

Reduce `shepherd` to the control plane + inspection actions.

- [ ] Replace `Type.Union([...])` with one `Type.Object`: ✅
      - `action`: enum `['herd','agents','prune']`, plus optional `agentScope` (shared field for `agents`).
      - description: meta-narrative + compact per-action table. ✅
      - No per-action fields remain (`read` moved to `shepherd_read` in Phase 3). ✅
      - The old union survives internally as `AnyShepherdUnion`; `ShepherdArgs`
        (= its Static type) remains the core doAction signature so command and
        future tools keep full-typed access to every verb.
- [ ] Runtime validation is trivial at this point (enum-only); keep the same
      friendly text-result style used elsewhere. ✅ (doAction switch unchanged)
- [x] Update `prepareShepherdArguments`: kept as-is (string-coercion recovery for
      handles, booleans, integers); reused by the Phase 3 tools. ✅
- [x] Update `renderCall`/`renderResult` — they key off `args.action` and kept working.

Acceptance: schema test from Phase 0 passes ✅; `npm test` green ✅; serialized
schema confirmed flat (`type: object`, enum action) ✅.

Files: `shepherd.ts`. ✅ Done

### Phase 3 — Extract lifecycle tools

One registration helper, six declarative tools. All roots are plain objects.

- [x] Generalize `registerShepherdTool` into `registerShepherdTools(pi)` registering:
      - `shepherd_spawn`: `agent` (required), `label` (required), and optional
        `placement` (`pane_right`, `pane_down`, `tab`, or `workspace`), `cwd`, and
        `model`. Agent scope, project approval, and system-prompt behavior come
        from settings and the discovered agent definition. ✅ (deliberately no
        `timeout`: startup readiness uses fixed internal grace periods; timeout only
        applies to prompts/waits — see the start-case comment in `doAction`)
      - `shepherd_prompt`: `id` (required agent id), `message` (required), `timeout` ✅
      - `shepherd_wait`: `id` (required prompt id or array of prompt ids), `timeout` ✅
      - `shepherd_status`: `id` (required agent id) ✅
      - `shepherd_close`: `id` (required agent id) ✅
      - `shepherd_read`: `name` (required), `lines`?, `source`? ✅
      - Note: the core action `start` was renamed to `spawn` (`SpawnParams`) to match the
        tool naming scheme; the `/shepherd` command verb was renamed in Phase 4.
- [x] Share lifecycle id, timeout, and completion-state schemas across definitions.
      ✅ Originally derived with `Type.Omit(<LifecycleParams>, ['action'])`; superseded by the
      AGENTS.md convention that every registration spells out its fields inline, so each
      tool registration now declares its full `Type.Object` directly (identical fields and
      descriptions; the shared `*Params` schemas in `types.ts` remain the internal
      union/`doAction` contract only).
- [x] Each tool delegates to `doAction({action: '<verb>', ...params}, ...)`.
      ✅ Via a shared `executeShepherd(label, args, ctx, ...)` wrapper (Herdr gate +
      try/catch to a friendly text result).
- [x] Per-tool `description`: short, operational; cross-references siblings
      ("Pass the agent id returned by shepherd_spawn" etc.). ✅
- [x] `renderCall`: per-tool CLI-style call preview reusing `shepherdCallPreview`
      internals (e.g. `shepherd_spawn scout --cwd …`), plus a shared `renderToolResult`. ✅
- [x] Split `promptSnippet`/`promptGuidelines`: lifecycle tools share one snippet line;
      the control tool keeps the narrative + guidelines; the old `Workflow:` guideline
      line was dropped (superseded by per-tool descriptions). Full narrative relocation
      remains Phase 5.

Acceptance: schema test passes for all seven tools ✅; `npm test` green ✅; live
end-to-end verified under a running Herdr session: idle spawn, non-blocking prompt,
wait (status `done`), status, close, read-after-close, and prune ✅. (Full multi-wait /
close-cancellation live matrix stays in Phase 7 alongside the constrained-backend check.)

Files: `shepherd.ts`, `types.ts` (`SpawnParams`), `index.ts`. ✅ Done

### Phase 4 — Extend the `/shepherd` command

Bring the human surface up to parity, scoped sensibly.

- [x] Decide blocking policy (recommended): allow quick actions only —
      `status`, `read` join `agents|herd|spawn|settings`; keep `prompt`/`wait`/
      `close` **model-only** initially (they can block minutes or mutate agent state
      mid-conversation). Revisit after real-world use.
      ✅ `status` + `read` are command actions; prompt/wait/close remain model-only.
- [x] Rename the command verb `start` → `spawn` everywhere (handler branch,
      completions, hints); no alias retained. ✅ (/shepherd list|sheep aliases for
      *agents* remain, as before.)
- [x] Factor the CLI grammar into `parseShepherdCli(args)` shared with
      `shepherdCallPreview` (parser = inverse of renderer); replace
      `parseStartCommand` with it.
      ✅ Now `cli.ts`: one `OPTION_SPECS` table drives both `parseShepherdCli` (human)
      and `formatShepherdCommand` (tool-call previews, moved out of `shepherd.ts`). A
      quote-aware `tokenizeCli` makes the command split the exact inverse of the
      renderer's JSON quoting, so a rendered line reparses to the same args.
      Covered by the new `cli:test` suite (parses, rejections, round-trips).
- [x] Extend `getArgumentCompletions`: actions first; for `status`/`read`, complete
      discovered agent names (reuse the pattern already used for `spawn`).
      ✅ Action list now includes `status`/`read`; both also complete live
      agent ids from the session registry; 3-char-prefix candidates
      (`/shepherd spo` → `spawn <agent>`) preserved for spawn/status/read.
- [x] `status` target resolution: `statusHandleTarget` maps agent name / lifecycle id /
      pane id to the opaque lifecycle id (live-registry lookup, id fallback).

Acceptance: `/shepherd status <agent>` prints summary ✅ (live: state `idle` after
spawn); unknown input prints the updated hint line ✅ (`parseShepherdCli` error +
Usage); command paths live-verified (status, read w/ quoted args). The full TUI UX
pass (completions feel, long-running guardrails) stays in Phase 7.

Files: `cli.ts` (new), `index.ts`, `shepherd.ts` (preview moved to cli.ts),
`test/verify-cli.mjs` (new), `package.json` (wire `cli:test`), plan doc.

### Phase 5 — Consolidate the Shepherd narrative

Keep general Shepherd knowledge scoped to the umbrella `shepherd` tool rather than
injecting it into the global parent system prompt.

- [x] Make the umbrella `shepherd` tool the documentation and guidance hub for the
      complete Shepherd tool family (`agents`, `herd`, `prune`, `spawn`, `prompt`,
      `wait`, `status`, `close`, and `read`). ✅ Its description and prompt guidelines
      now document the control-plane actions and the full lifecycle.
- [x] Put shared lifecycle guidance on the umbrella tool: wait for independent work
      concurrently when possible, waiting does not close agents, pass lifecycle ids
      unchanged, and follow the shared `shepherd.md` fieldnotes contract. ✅
- [x] Keep individual lifecycle tool descriptions short and operational; retain only
      tool-specific usage hints and parameter expectations there. ✅ Removed duplicated
      wait/close lifecycle guidance from the split tool descriptions.
- [x] Keep the meta-description ("subagent framework for native Herdr orchestration")
      at the top of the umbrella `shepherd` tool description and the command description. ✅
- [x] Verify that the umbrella Shepherd tools and their guidance are exposed only in
      the parent/orchestrator session, not in launched worker sessions. ✅ Added a
      `PI_SHEPHERD_SESSION` guard around parent-only Shepherd tools, commands, settings,
      and widget registration; the new `parent-surface:test` probes both environments.
- [x] Do not add a global `before_agent_start` lifecycle-guidance hook unless a later
      use case shows that the umbrella tool's scoped guidance is insufficient. ✅

Acceptance: the umbrella `shepherd` tool explains the shared lifecycle and fieldnote
rules; each split tool explains only its own operation; worker sessions do not receive
parent orchestration tools or guidance. ✅ `npm test` green.

Files: `shepherd.ts`, `index.ts`, `test/verify-parent-surface.mjs`, `package.json`.

### Phase 6 — Docs & conventions

- [x] AGENTS.md: replace "the model-facing tool definition is the source of truth"
      with "core semantics live in `doAction()`/`lifecycle.ts`; tools and `/shepherd`
      are thin adapters." ✅
- [x] `docs/dictionary`: add entries for the split tool names and note the two surfaces. ✅
- [x] README: update invocation examples (both `shepherd_wait …` and `/shepherd …`),
      add a compatibility note (old `shepherd action=prompt` form is gone). ✅
- [x] Grep sweep for stale references: `shepherd action=`, `action=start` etc. in
      active docs, skills, prompts, and test fixtures. ✅ Current public docs and
      implementation references are clean; the archived Phase 2 design records
      retain historical `start` terminology, while current Phase 3 artifact examples
      use `spawn`.

### Phase 7 — Verification

- [x] `npm test` fully green including the flat-object schema-invariant test. ✅
- [x] Live Herdr checklist (per AGENTS.md): idle spawn, non-blocking prompt,
      single wait/result, concurrent multi-wait, iterative prompting, status,
      close cancellation, focus preservation, ownership protection. ✅ Verified
      against the running Herdr server; owned panes were closed and stale
      registrations pruned.
- [x] Constrained-backend check: `stealth/ox-alpha` is no longer available
      (OpenRouter returned 404), so `z-ai/glm-5.3` was used instead; it emitted
      `{"action":"agents"}` and completed the call successfully. ✅
- [x] Soft-guidance sanity: GPT-style `openai/gpt-5.6-luna` selected the split
      `shepherd_prompt` and `shepherd_read` tools with structured arguments. ✅
- [x] Command UX pass: added `test/verify-command-ux.mjs` covering partial and
      argument completions, usage/error hints, and spawn status cleanup. ✅

## 5. Open decisions

| Question | Decision |
|---|---|
| Tool naming scheme | **Resolved:** `shepherd_<verb>`, lifecycle verbs are `spawn`, `prompt`, `wait`, `status`, `close`, `read` |
| `start` vs `spawn` in `/shepherd` command | **Resolved:** `/shepherd spawn worker` fully replaces `/shepherd start worker`; no alias |
| `read` placement | **Resolved:** own tool `shepherd_read(name, lines?, source?)` |
| Lifecycle reference representation | **Resolved:** public tools accept opaque string ids (an array of ids for wait); full handles remain internal, with legacy nested handles migrated in `prepareShepherdArguments` |
| Old single-tool form | **Resolved:** hard remove; grep sweep covers stragglers |
| `prompt`/`wait`/`close` via command | **Resolved:** model-only initially; revisit after real-world use |
| General lifecycle guidance location | **Resolved:** umbrella `shepherd` tool guidance; do not use the global system prompt initially |

## 6. Risk notes

- **Largest regression risk**: Phase 3 splitting — mitigated by keeping every tool a
  pure `doAction` delegate and reusing verify scripts unchanged.
- **Prompt-quality risk**: models accustomed to one tool may mis-select between
  `prompt`/`wait`; mitigated by cross-referencing descriptions + umbrella-tool guidance.
- **Doc drift**: two surfaces double the places to update; the grep sweep in Phase 6 is
  the safety net.
