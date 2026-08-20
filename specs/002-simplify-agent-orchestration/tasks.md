# Tasks: Low-Level Agent Orchestration

Work through these tasks in order unless a task is explicitly marked as
independent. Cross off a task only after its implementation and verification
are complete.

## Phase 1 — Foundations

- [x] **1.1 Define public lifecycle types**
  - Add serializable `AgentHandle`, `PromptHandle`, `Status`, and `Result`
    shapes.
  - Define supported lifecycle states and structured error fields.
  - Keep public handles opaque; do not require callers to pass raw pane IDs.

- [x] **1.2 Add agent and prompt registries**
  - Track live agents by stable handle ID.
  - Track prompts by stable prompt ID.
  - Associate each prompt with its owning agent.
  - Track one unresolved prompt per agent.
  - Add lookup, invalidation, settlement, and cleanup helpers.

- [x] **1.3 Preserve ownership and safety invariants**
  - Reuse the created-pane registry for ownership checks.
  - Reject foreign, unknown, and closed handles clearly.
  - Ensure raw pane IDs cannot bypass close ownership checks.
  - Define behavior for stale registries and extension reloads.

## Phase 2 — Persistent `start`

- [x] **2.1 Separate launch from task submission**
  - Refactor Herdr launch helpers so starting pi does not require a task.
  - Preserve agent system prompt, tools, model, cwd, and prompt-mode behavior.
  - Remove `stayOpen` from the new low-level start path.
  - Ensure the launched agent remains alive until explicitly closed.

- [x] **2.2 Add placement options**
  - Support requested tab or sibling-pane placement.
  - Preserve caller cwd unless overridden.
  - Use `--no-focus` by default for background agents.
  - Parse all Herdr IDs from command results rather than predicting them.

- [x] **2.3 Implement `start(agent, options)`
  - Discover the agent fresh from disk.
  - Apply user/project scope and trust confirmation.
  - Ensure Herdr is available.
  - Create and record the pane/tab.
  - Launch pi with no initial user message.
  - Wait for shell readiness and Herdr agent detection.
  - Register and return an `AgentHandle`.
  - Clean up safely if startup fails after pane creation.

- [x] **2.4 Verify `start`**
  - Confirmed `startAgent("scout", ...)` returned a stable serialized handle.
  - Confirmed the agent was detected and reported `idle` through `statusAgent`.
  - Confirmed the persistent agent remained addressable after `start` returned.
  - Confirmed the created Herdr tab/pane was closed through the ownership-safe path.
  - The live check used the current workspace and explicit cwd; placement is currently tab-based.
  - Project-agent trust gating remains implemented in `startAgent`.

## Phase 3 — Non-blocking `prompt`

- [x] **3.1 Add non-blocking prompt submission**
  - Resolve and validate the `AgentHandle`.
  - Reject agents with an unresolved prompt.
  - Confirm Herdr detects the agent before sending.
  - Submit exactly one message without waiting for completion.
  - Detect failed submission and settle it without returning a usable handle.
  - Register and immediately return a `PromptHandle`.

- [x] **3.2 Track prompt lifecycle**
  - Store submission time and timeout.
  - Associate prompt state with its agent.
  - Ensure submission errors do not leave phantom active prompts.
  - Ensure an agent becomes promptable again after settlement.

- [x] **3.3 Verify `prompt`**
  - Confirmed `promptAgent` returned a prompt handle without waiting for completion.
  - Confirmed a second prompt on the same agent was rejected while active.
  - Confirmed waiting settled the prompt and a subsequent prompt was accepted.
  - Confirmed prompt/result IDs remained associated across both prompts.
  - Submission failure handling is implemented; a dedicated forced-failure check remains useful.

## Phase 4 — `wait`

- [x] **4.1 Implement single-prompt wait**
  - Waits for a post-submission Herdr transition rather than accepting pre-submit idle.
  - Handles idle, done, blocked, timeout, and cancellation results.
  - Recovers diagnostic response text from the pane after settlement.
  - Does not read or delete the live child session file.
  - Returns a structured `Result` tied to prompt and agent IDs.
  - Clears the agent's active prompt exactly once.

- [x] **4.2 Implement multi-prompt wait**
  - Accepts one prompt handle or an array of handles.
  - Waits concurrently for arrays using `Promise.all`.
  - Preserves input ordering in the result array.
  - Returns one structured result per input, including failures.
  - Converts individual wait errors into failed results so successful results remain visible.
  - Supports wait-for-all only.

- [x] **4.3 Verify `wait`**
  - Verified prompt results preserve their corresponding prompt IDs.
  - Verified two prompts were waited concurrently.
  - Verified multi-wait preserves input order.
  - Verified an unknown prompt produced a failed result alongside a successful result.
  - Verified settled prompts can be reused for subsequent lifecycle checks.

## Phase 5 — `status` and `close`

- [x] **5.1 Implement handle-based `status`**
  - Resolves an `AgentHandle`.
  - Queries Herdr without focusing or mutating the pane.
  - Returns stable identity and placement metadata.
  - Maps missing panes to `failed` and closed handles to `closed`.
  - Handles stale and closed handles with clear errors/results.

- [x] **5.2 Implement handle-based `close`**
  - Resolves only valid lifecycle handles.
  - Refuses panes absent from the pi-shepherd ownership registry.
  - Cancels unresolved prompts deterministically.
  - Closes the pane through the existing safe path.
  - Cleans temporary resources only after pane disappearance.
  - Repeated close calls are idempotent.

- [x] **5.3 Verify lifecycle termination**
  - Verified `wait` leaves the agent alive after normal settlement.
  - Verified `close` terminated the created Herdr pane.
  - Verified waiting after close returned `cancelled`.
  - Verified status after close returned `closed`.
  - Verified an unowned/foreign handle is rejected without closing its pane.

## Phase 6 — Shepherd tool integration

- [x] **6.1 Add tool schemas**
  - Add `action: "start"` with agent and launch/placement options.
  - Add `action: "prompt"` with agent handle and message.
  - Add `action: "wait"` with one or many prompt handles.
  - Update `status` and `close` to accept agent handles.
  - Keep `sheep`, `herd`, `read`, and `prune`.

- [x] **6.2 Update tool execution**
  - Route actions to the lifecycle primitives.
  - Return structured handles, statuses, and results.
  - Preserve useful human-readable text output.
  - Return partial multi-wait results on failure.
  - Maintain clear invalid-handle errors.

- [x] **6.3 Update model-facing guidance**
  - Explain start-without-task semantics.
  - Explain prompt-then-wait semantics.
  - Show parallel work using `wait([promptA, promptB])`.
  - Show chains as explicit caller composition.
  - Explain that `close` is explicit.

## Phase 7 — Compatibility migration

- [x] **7.1 Remove legacy delegation**
  - Deleted the legacy `delegate` action and workflow modes.
  - Removed `subagent.ts` and the one-shot delegation runner.
  - Low-level lifecycle primitives are now the only orchestration API.

- [x] **7.2 Resolve lifecycle cleanup policy**
  - Legacy compatibility cleanup is no longer applicable because delegation was removed.
  - `start` never closes automatically; callers explicitly call `close`.
  - One-shot behavior is explicitly composed as `start + prompt + wait + close`.
  - `stayOpen` is not exposed on the low-level `start` schema.

- [x] **7.3 Update slash commands**
  - Keep existing slash-command compatibility where useful.
  - Ensure its implementation does not depend on task-bearing `start`.
  - Update output to show returned handles where relevant.

## Phase 8 — Documentation and tests

- [x] **8.1 Update README**
  - Documents the low-level primitive API.
  - Replaces workflow examples with explicit composition examples.
  - Documents persistent start and explicit close.
  - Documents that legacy delegation modes were removed.

- [x] **8.2 Update root `PLAN.md`**
  - Replaced the workflow-centric architecture description.
  - Recorded lifecycle primitive implementation status.
  - Kept runtime, Herdr, and security invariants accurate.

- [x] **8.3 Add registry tests**
  - Added `test/verify-registry.mjs` covering serialization, lookup, unknown handles,
    active-prompt enforcement, idempotent settlement, and cancellation.

- [x] **8.4 Add multi-wait tests**
  - Added `test/verify-multi-wait.mjs` covering concurrent waiting and input order.
  - Live verification covered partial failure results and cancellation handling.

- [x] **8.5 Run live Herdr verification**
  - Started idle `scout` agents in live Herdr tabs.
  - Confirmed non-blocking prompt return and exact response recovery.
  - Waited for a single result and verified prompt/result association.
  - Started two agents, prompted both, and waited concurrently with ordered results.
  - Exercised iterative prompting on one persistent agent.
  - Closed agents and verified cancellation, closed status, and cleanup.
  - Verified background starts preserved the focused caller pane.
  - Verified ownership protection refused a foreign pane handle.

## Completion checklist

- [x] All Phase 1–5 lifecycle primitives work independently of workflow modes.
- [x] All Phase 6 tool actions are available and documented.
- [x] Legacy workflows were removed rather than retained as wrappers.
- [x] Existing discovery, trust, Herdr, and temp-file safety behavior remains
      intact.
- [x] README and root `PLAN.md` are synchronized with the implementation.
- [x] Tests and live Herdr verification pass.
