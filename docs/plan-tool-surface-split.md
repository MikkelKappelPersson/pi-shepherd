# Plan: Split the Shepherd Tool Surface

Status: in progress — Phases 0–4 complete (verified 2026-08-26). Next: Phase 5.
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

- Cross-field rules (`wait` requires `handle`) are enforced by JSON Schema today, but
  any flattening loses that unless handled explicitly.
- The unified conceptual narrative (sheep, handles, lifecycle ordering) lives inside the
  single tool description, coupling "what shepherd is" to "how one tool is shaped".
- The existing `/shepherd` command duplicates logic (`agents`/`herd`/`start` re-implement
  what `doAction` already does) instead of delegating to the same core.

## 2. Goals

1. No bare-`anyOf` root anywhere on the wire → works on constrained backends.
2. Declarative requiredness (`handle: required`) via separate flat-schema tools.
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
   ├─ shepherd_prompt (handle, message, timeout)  └─ prompt/wait/close         (new, see §5)
   ├─ shepherd_wait   (handle[], timeout)
   ├─ shepherd_status (handle)
   ├─ shepherd_close  (handle)
   └─ shepherd_read   (name, lines, source)
```

Schema fragments shared across tools: `HandleSchema`, timeout/lines/source optionals.

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

### Phase 3 — Extract handle-centric tools

One registration helper, six declarative tools. All roots are plain objects.

- [x] Generalize `registerShepherdTool` into `registerShepherdTools(pi)` registering:
      - `shepherd_spawn`: `agent` (required), `agentScope`, `placement`, `direction`,
        `confirmProjectAgents`, `cwd`, `model`, `omitSystemPrompt`. ✅ (deliberately no
        `timeout`: startup readiness uses fixed internal grace periods; timeout only
        applies to prompts/waits — see the start-case comment in `doAction`)
      - `shepherd_prompt`: `handle` (required), `message` (required), `timeout` ✅
      - `shepherd_wait`: `handle` (required; object or native array of objects), `timeout` ✅
      - `shepherd_status`: `handle` (required) ✅
      - `shepherd_close`: `handle` (required) ✅
      - `shepherd_read`: `name` (required), `lines`?, `source`? ✅
      - Note: the core action `start` was renamed to `spawn` (`SpawnParams`) to match the
        tool naming scheme; the `/shepherd` command verb was renamed in Phase 4.
- [x] Share `HandleSchema`, timeout, and completion-state enums across definitions.
      ✅ Done by deriving each tool schema with `Type.Omit(<LifecycleParams>, ['action'])`,
      which reuses the existing `AgentHandleInputSchema`/`PromptHandleInputSchema` and
      the shared timeout/enum definitions from `types.ts` — zero duplicated field schemas.
- [x] Each tool delegates to `doAction({action: '<verb>', ...params}, ...)`.
      ✅ Via a shared `executeShepherd(label, args, ctx, ...)` wrapper (Herdr gate +
      try/catch to a friendly text result).
- [x] Per-tool `description`: short, operational; cross-references siblings
      ("Pass the complete native agent handle from shepherd_spawn" etc.). ✅
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
      AgentHandle ids from the session registry; 3-char-prefix candidates
      (`/shepherd spo` → `spawn <agent>`) preserved for spawn/status/read.
- [x] `status` target resolution: `statusHandleTarget` maps agent name / handle id /
      pane id to the complete handle object (live-registry lookup, id-only fallback).

Acceptance: `/shepherd status <agent>` prints summary ✅ (live: state `idle` after
spawn); unknown input prints the updated hint line ✅ (`parseShepherdCli` error +
Usage); command paths live-verified (status, read w/ quoted args). The full TUI UX
pass (completions feel, long-running guardrails) stays in Phase 7.

Files: `cli.ts` (new), `index.ts`, `shepherd.ts` (preview moved to cli.ts),
`test/verify-cli.mjs` (new), `package.json` (wire `cli:test`), plan doc.

### Phase 5 — Relocate the narrative

- [ ] Move lifecycle guidance (sequential-vs-parallel wait, waiting doesn't close,
      pass handles unchanged, fieldnotes contract) from tool descriptions into the
      extension's system-prompt contribution (`system-prompt.ts` wiring used by
      `index.ts`).
- [ ] Trim `SHEPHERD_TOOL_PROMPT_GUIDELINES` accordingly; keep per-tool usage hints local.
- [ ] Meta-description ("subagent framework for native Herdr orchestration") stays at
      the top of the `shepherd` tool description and the command description.

Files: `system-prompt.ts`, `shepherd.ts`.

### Phase 6 — Docs & conventions

- [ ] AGENTS.md: replace "the model-facing tool definition is the source of truth"
      with "core semantics live in `doAction()`/`lifecycle.ts`; tools and `/shepherd`
      are thin adapters."
- [ ] `docs/dictionary`: add entries for the split tool names and note the two surfaces.
- [ ] README: update invocation examples (both `shepherd_wait …` and `/shepherd …`),
      add a compatibility note (old `shepherd action=prompt` form is gone).
- [ ] Grep sweep for stale references: `shepherd action=`, `action=start` etc. in
      docs, skills, prompts, and test fixtures.

### Phase 7 — Verification

- [ ] `npm test` fully green including new schema-invariant test.
- [ ] Live Herdr checklist (per AGENTS.md): idle start, non-blocking prompt,
      single wait/result, concurrent multi-wait, iterative prompting, status,
      close cancellation, focus preservation, ownership protection.
- [ ] Constrained-backend check: run a session with `stealth/ox-alpha` (or any backend
      that previously emitted `{}`) and confirm tool calls now carry arguments.
- [ ] Soft-guidance sanity: confirm Claude/GPT-style models handle the split tools.
- [ ] Command UX pass: completions, error hints, long-running-action guardrails.

## 5. Open decisions

| Question | Decision |
|---|---|
| Tool naming scheme | **Resolved:** `shepherd_<verb>`, lifecycle verbs are `spawn`, `prompt`, `wait`, `status`, `close`, `read` |
| `start` vs `spawn` in `/shepherd` command | **Resolved:** `/shepherd spawn worker` fully replaces `/shepherd start worker`; no alias |
| `read` placement | **Resolved:** own tool `shepherd_read(name, lines?, source?)` |
| Handle representation | **Resolved:** accept string-or-object handles (arrays of either for wait); normalize in `prepareShepherdArguments` |
| Old single-tool form | **Resolved:** hard remove; grep sweep covers stragglers |
| `prompt`/`wait`/`close` via command | Deferred to Phase 4 (model-only initially) |

## 6. Risk notes

- **Largest regression risk**: Phase 3 splitting — mitigated by keeping every tool a
  pure `doAction` delegate and reusing verify scripts unchanged.
- **Prompt-quality risk**: models accustomed to one tool may mis-select between
  `prompt`/`wait`; mitigated by cross-referencing descriptions + system-prompt guidance.
- **Doc drift**: two surfaces double the places to update; the grep sweep in Phase 6 is
  the safety net.
