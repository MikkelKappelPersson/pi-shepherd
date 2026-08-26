# Plan: Split the Shepherd Tool Surface

Status: in progress — Phases 0–2 complete
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

- [ ] Capture current behavior: run `npm test`; record pass set. ✅ All 7 suites pass.
- [ ] Add a schema-shape regression test: assert every registered tool's root JSON Schema
      has `"type": "object"` (fails today for `shepherd`; becomes the invariant).
      ✅ `test/verify-tool-schemas.mjs` added as `schemas:test`; currently red
      (documents the bare-`anyOf` root). Joins the default `test` chain in Phase 2
      when it turns green.
- [ ] Optional: snapshot the current serialized `ShepherdParams` for diffing.

Files: `test/verify-tool-schemas.mjs` (new), `package.json` (wire test if needed).

### Phase 1 — Unify the core path

Make `doAction()` the single entry so tools and command can never diverge.

- [ ] Refactor `/shepherd` handler branches (`agents`, `herd`, `start`) to construct args
      objects and call `doAction()`, rendering via a small result-to-notification helper,
      instead of calling `discoverAgents`/`listHerdrAgents`/`startAgent` directly.
- [ ] Keep `settings` branch command-only (no model-facing equivalent needed).
- [ ] Extract `parentArtifactSessionForCommand` reuse so command and tool resolve
      artifact sessions identically.

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
- [ ] Update prepareShepherdArguments: kept as-is; reused by Phase 3 tools. ✅
- [ ] Update `prepareShepherdArguments`: keep string-coercion recovery; drop nothing else.
- [ ] Update `renderCall`/`renderResult` (they key off `args.action` and keep working).

Acceptance: schema test from Phase 0 passes ✅; `npm test` green ✅; serialized
schema confirmed flat (`type: object`, enum action) ✅.

Files: `shepherd.ts`. ✅ Done

### Phase 3 — Extract handle-centric tools

One registration helper, five declarative tools. All roots are plain objects.

- [ ] Generalize `registerShepherdTool` into `registerShepherdTools(pi)` registering:
      - `shepherd_spawn`: `agent` (required), `agentScope`, `placement`, `direction`,
        `confirmProjectAgents`, `cwd`, `model`, `omitSystemPrompt`, `timeout`
      - `shepherd_prompt`: `handle` (required), `message` (required), `timeout`
      - `shepherd_wait`: `handle` (required, string-or-object, or arrays of either), `timeout`
      - `shepherd_status`: `handle` (required)
      - `shepherd_close`: `handle` (required)
      - `shepherd_read`: `name` (required), `lines`?, `source`?
- [ ] Share `HandleSchema`, timeout, and completion-state enums across definitions.
- [ ] Each tool delegates to `doAction({action: '<verb>', ...params}, ...)`.
- [ ] Per-tool `description`: short, operational; cross-reference siblings
      ("wait on handles returned by shepherd_prompt").
- [ ] `renderCall`: prefix label per tool (`shepherd_start scout --cwd …`) reusing
      `shepherdCallPreview` internals; keep the CLI-style look.
- [ ] Keep `promptSnippet`/`promptGuidelines` content but split: lifecycle guidelines
      belong to Phase 5's system-prompt work; per-tool usage notes stay local.

Acceptance: schema test passes for all six tools; multi-wait and close-cancellation
verified live (existing verify scripts cover the underlying flows).

Files: `shepherd.ts`, `types.ts` (if params types move), `index.ts`.

### Phase 4 — Extend the `/shepherd` command

Bring the human surface up to parity, scoped sensibly.

- [ ] Decide blocking policy (recommended): allow quick actions only —
      `status`, `read` join `agents|herd|spawn|settings`; keep `prompt`/`wait`/
      `close` **model-only** initially (they can block minutes or mutate agent state
      mid-conversation). Revisit after real-world use.
- [ ] Rename the command verb `start` → `spawn` everywhere (handler branch,
      completions, hints); no alias retained.
- [ ] Factor the CLI grammar into `parseShepherdCli(args)` shared with
      `shepherdCallPreview` (parser = inverse of renderer); replace
      `parseStartCommand` with it.
- [ ] Extend `getArgumentCompletions`: actions first; for `status`/`read`, complete
      discovered agent names (reuse the pattern already used for `spawn`).

Acceptance: `/shepherd status <agent>` prints summary; unknown input prints the
updated hint line; completions verified in TUI.

Files: `index.ts`, `cli.ts`.

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
