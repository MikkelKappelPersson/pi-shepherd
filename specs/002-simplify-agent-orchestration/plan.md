# Implementation Plan: Low-Level Agent Orchestration

This plan implements the contract in `spec.md` by making agent lifecycle and
prompt synchronization the primary pi-shepherd model. It deliberately avoids
adding workflow-specific behavior to the core API.

## Target surface

```text
start(agent, options) -> AgentHandle
prompt(agentHandle, message, options) -> PromptHandle
wait(promptHandle | promptHandles, options) -> Result | Result[]
status(agentHandle) -> Status
close(agentHandle) -> void
```

The model-facing `shepherd` tool remains action-discriminated. Existing
operational actions such as `agents`, `list`, `read`, and `gc` remain available.
Legacy `delegate` may be retained temporarily as a compatibility wrapper, but
new orchestration guidance should use the primitives.

## Design decisions

- `start` never accepts a task and always starts a persistent agent.
- `prompt` submits work and returns without waiting for completion.
- `wait` waits for one or many prompts; arrays wait concurrently and preserve
  input order.
- A single agent may have only one unresolved prompt initially.
- `wait` returns per-prompt failure results rather than discarding successful
  results when another prompt fails.
- Agents remain alive after `wait`; only `close` terminates them.
- One-shot behavior is `start + prompt + wait + close`.
- Public handles are stable serialized IDs, not raw Herdr pane IDs.
- Prompt and agent registries are session-scoped initially, with clear invalid
  handle errors after reload or process loss.
- Existing project-agent trust gating, Herdr focus rules, and close ownership
  checks remain unchanged.

## Phase 1 — Extract lifecycle primitives

### 1.1 Define internal types and registries

Add a small lifecycle module (for example `orchestration.ts`) containing:

- `AgentHandleRecord`: public ID, discovered agent name/config, pane/tab/
  workspace IDs, cwd, launch directory/session metadata, lifecycle state, and
  active prompt ID if any.
- `PromptHandleRecord`: public prompt ID, owning agent ID, submission time,
  timeout, state, and result metadata.
- `AgentHandle`, `PromptHandle`, `Status`, and `Result` serialized shapes.
- In-memory maps for live handles and unresolved prompts.
- ID generation that is opaque and collision-resistant within the session.

Keep the existing created-pane registry as the ownership source of truth. The
new agent registry may reference it but must not weaken its close checks.

Define helpers for:

- resolving a public handle;
- resolving legacy name/pane targets during migration;
- rejecting unknown, closed, or foreign handles;
- marking prompts settled/failed/cancelled exactly once;
- clearing active prompt state;
- returning safe, serializable tool details.

### 1.2 Refactor launch configuration

Split launch configuration from task submission in `herdr.ts`:

- Preserve agent discovery-derived system prompt, model, tools, cwd, and
  `omitSystemPrompt` behavior.
- Remove `stayOpen` from the new start path.
- Launch pi in a persistent interactive mode with no initial user task.
- Keep launch/session temp files for the lifetime of the child process.
- Ensure `start` waits for shell readiness and Herdr agent detection before
  returning.
- Ensure background starts use `--no-focus` by default.

The existing `writePiLaunchFiles`/`launchPiInPane` path should be reused where
possible, but its bare launch behavior must become the normal `start` behavior,
not a special workflow mode.

### 1.3 Implement `start`

Add an internal function such as:

```ts
startAgent(ctx, agentName, options, signal) -> Promise<AgentHandle>
```

It should:

1. Resolve the agent fresh from disk using the requested scope.
2. Apply project-agent confirmation/trust checks.
3. Ensure Herdr runtime availability.
4. Create the requested tab or sibling pane according to placement options.
5. Record ownership immediately after creation.
6. Launch persistent pi with the selected agent configuration and no task.
7. Wait until Herdr detects the agent.
8. Register and return the serialized `AgentHandle`.

On failure after pane creation, perform best-effort cleanup only for the pane
created by this operation and remove its temporary resources when safe.

## Phase 2 — Implement prompt and wait

### 2.1 Implement `prompt`

Add:

```ts
promptAgent(handle, message, options) -> Promise<PromptHandle>
```

Behavior:

1. Resolve the handle and verify the agent is live.
2. Reject if the agent has an unresolved prompt.
3. Confirm Herdr detects the agent before sending anything.
4. Submit the message using the Herdr agent surface without `--wait`.
5. Detect submission/stall errors and do not create a handle on failure.
6. Register and return a `PromptHandle` immediately.

The implementation must not use the current synchronous `herdr agent prompt
--wait` behavior for this path. If Herdr's CLI requires a separate command
for non-blocking submission, use that command; otherwise send through the
lowest-level supported agent input operation and then track lifecycle state.

Prompt options should initially include timeout and may include future
cancellation/settling options. Do not add workflow options.

### 2.2 Implement single `wait`

Add:

```ts
waitPrompt(promptHandle, options) -> Promise<Result>
```

It should poll/await the specific prompt's owning agent until it reaches a
settled state (`idle`, `done`, `blocked`, failure, timeout, or cancellation).
It must associate the result with the prompt handle rather than merely
reporting whatever state the agent happens to have.

Recover response text through the existing safe mechanisms:

- completion sidecar/session data where available;
- Herdr output as a diagnostic fallback;
- never read or delete a still-running child session file.

When settled, mark the prompt complete and clear the owning agent's active
prompt. A subsequent prompt on that agent is then allowed.

### 2.3 Implement multi-wait

Add:

```ts
waitPrompts(promptHandles, options) -> Promise<Result[]>
```

Use concurrent waits (`Promise.all` over individual wait operations), not a
sequential loop. Preserve the caller's input order. Convert individual
exceptions into structured failed results so all handles are represented.

Initially support wait-for-all only. Do not add `until: "any"` until the basic
contract is proven.

## Phase 3 — Implement status and close

### 3.1 `status`

Add `statusAgent(handle)` backed by `herdr agent get`. Return the stable handle
identity plus Herdr state (`idle`, `working`, `blocked`, `done`, `unknown`) and
map missing/dead panes to `failed` or `closed` consistently.

Status must not focus panes or mutate Herdr state. It should tolerate stale
registry entries and return actionable invalid-handle errors.

### 3.2 `close`

Add `closeAgent(handle)` using the existing ownership-guarded close path.

Before/while closing:

- reject foreign handles and unregistered raw panes;
- mark unresolved prompts as cancelled/failed so future waits terminate;
- remove the live agent registration;
- clean temporary launch resources only after the child process is gone;
- preserve created-pane registry semantics and idempotency.

Do not close agents automatically after `wait`.

## Phase 4 — Wire the shepherd tool

Update `types.ts` and `shepherd.ts`:

- Add schemas/actions for `start`, `prompt`, `wait`, `status`, and `close`.
- `start` requires agent plus options but no task.
- `prompt` accepts a serialized agent handle and message.
- `wait` accepts one serialized prompt handle or an array.
- `status` and `close` accept serialized agent handles.
- Keep legacy name/pane target resolution only for existing management flows
  during migration.
- Return structured details containing handles, statuses, and results.
- Make tool descriptions explain the two-step `prompt` then `wait` protocol.
- Update the tool prompt/guidelines so parallel work is shown as multiple
  starts/prompts followed by one `wait([...])` call.

Retain `read`, because it is needed for diagnosing blocked agents and result
recovery. Retain `agents`, `list`, and `gc`.

## Phase 5 — Compatibility and subagent migration

### 5.1 Compatibility wrapper

Refactor `subagent.ts` so the old delegation modes call the primitives where
practical:

```text
delegate(single)   = start + prompt + wait
                    (+ close when one-shot cleanup is requested)
delegate(parallel) = multiple start/prompt + wait(all)
delegate(chain)    = repeated start + prompt + wait
```

The wrapper may preserve existing artifact/session behavior while migration is
underway. It must not add `stayOpen` to `start`; persistence is controlled by
whether/when the wrapper calls `close`.

### 5.2 Slash command and docs

Update `/shepherd` behavior and README examples to show primitive usage. Make
clear that:

- `start` launches an idle persistent agent;
- `prompt` returns a prompt handle immediately;
- `wait` synchronizes one or many prompts;
- `close` is explicit.

Mark workflow modes as compatibility conveniences if they remain exposed.
Update root `PLAN.md` only after this spec implementation is complete, so the
existing roadmap accurately reflects the migration.

## Phase 6 — Tests and live verification

Add focused tests for pure registry/result behavior where possible:

- stable handle serialization and lookup;
- unknown/closed/foreign handle rejection;
- one active prompt per agent;
- prompt settlement clears active state exactly once;
- multi-wait preserves input order;
- multi-wait returns partial failures;
- close cancels unresolved prompts;
- no automatic close after wait.

Add a fake Herdr/CLI seam or injectable runner for non-live tests if the current
module structure makes this practical. Keep `discovery.ts` pure.

Run live verification in Herdr:

1. `start("scout", options)` creates an idle visible agent and sends no task.
2. `prompt(handle, task)` returns before completion.
3. `wait(promptHandle)` returns the task result.
4. Start two agents, prompt both, then `wait([pA, pB])`; verify concurrent
   execution and ordered results.
5. Prompt the same agent twice before waiting; verify the second prompt is
   rejected.
6. Wait, prompt again, and verify iterative use works.
7. Close the agent and verify future status/wait behavior is deterministic.
8. Attempt to close an unowned pane and verify refusal.
9. Verify project-agent trust confirmation and plain-terminal Herdr startup
   remain intact.

## Completion checklist

- [ ] Primitive types/registries implemented.
- [ ] Persistent no-task `start` implemented.
- [ ] Immediate non-blocking `prompt` implemented.
- [ ] Single and concurrent multi-prompt `wait` implemented.
- [ ] Structured partial-failure results implemented.
- [ ] Handle-based `status` and ownership-safe `close` implemented.
- [ ] Tool schemas and model-facing guidance updated.
- [ ] Legacy delegation migrated or clearly isolated as compatibility code.
- [ ] README, root `PLAN.md`, and relevant comments updated.
- [ ] Registry, lifecycle, safety, and live Herdr checks pass.
