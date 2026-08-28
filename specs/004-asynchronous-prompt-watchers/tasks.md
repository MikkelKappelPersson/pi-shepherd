# Tasks: Non-blocking Shepherd Prompt Watchers

Implement in order. Mark a task complete only after its code and focused
verification pass. Do not modify `shepherd_wait` as part of this feature.

## Phase 1 — Protocol and registry

- [ ] **1.1 Define watcher types**
  - Add watcher handle, registration result, and notification types.
  - Reuse existing prompt result fields for terminal outcomes.
  - Keep watcher ids opaque and distinct from agent, prompt, and Herdr pane ids.

- [ ] **1.2 Add watcher registry state**
  - Track watcher records and prompt-to-watcher relationships.
  - Track per-watcher delivered prompt ids.
  - Enforce one notification per watched prompt per watcher.
  - Support watcher lookup, completion, and removal.

- [ ] **1.3 Validate watch input**
  - Accept one prompt id or a non-empty array of prompt ids.
  - Resolve every id through the existing prompt registry.
  - Reject unknown, malformed, duplicate, or closed references according to the
    existing lifecycle error conventions.

## Phase 2 — Background observation

- [ ] **2.1 Start non-blocking monitoring**
  - Start monitoring when `shepherd_watch` registers a prompt.
  - Return from the tool without awaiting prompt completion.
  - Deduplicate monitors for prompts watched by multiple watchers.

- [ ] **2.2 Reuse completion detection**
  - Apply completion sidecar and state-transition safeguards.
  - Read the final assistant response from the existing result source.
  - Detect provider errors, blocked states, timeout states, and cancellation.
  - Handle completion before watcher registration.

- [ ] **2.3 Settle and buffer results**
  - Use the existing prompt settlement path exactly once.
  - Preserve artifact/fieldnote callbacks.
  - Keep results available after watcher delivery.
  - Ensure a simultaneous existing `shepherd_wait` receives the same result.

- [ ] **2.4 Clean monitoring resources**
  - Stop monitors after all watched prompts settle.
  - Stop monitors on unwatch and parent session shutdown.
  - Avoid timers or callbacks surviving session replacement/reload.

## Phase 3 — Parent notifications

- [ ] **3.1 Add notification callback boundary**
  - Inject a narrow parent notification callback into the watcher service.
  - Keep core lifecycle code independent of a global `pi` object.

- [ ] **3.2 Send custom follow-up messages**
  - Use `pi.sendMessage`, not `pi.sendUserMessage`.
  - Queue as `deliverAs: "followUp"`.
  - Trigger a new parent turn when idle.
  - Suppress new turns during shutdown/reload.

- [ ] **3.3 Define completion payload**
  - Include watcher id, prompt id, agent id, agent name/label, status, `ok`,
    return code, error, and last assistant message.
  - Preserve structured result information for array completions.

- [ ] **3.4 Coalesce notification bursts**
  - Report completions independently as they become available.
  - Coalesce close-together completions into one notification where practical.
  - Ensure coalescing does not lose ordering or individual prompt identity.

## Phase 4 — Tool surface

- [ ] **4.1 Register `shepherd_watch`**
  - Add the direct TypeBox schema for one id or an array of ids.
  - Return watcher id, normalized prompt ids, pending ids, and completed results.
  - Handle already-completed prompts without duplicate notifications.
  - Preserve standard Shepherd call/return/details formatting.

- [ ] **4.2 Register `shepherd_unwatch`**
  - Accept only an opaque watcher id.
  - Stop notifications and release watcher resources.
  - Do not cancel the prompt or close the agent.

- [ ] **4.3 Update model guidance**
  - Add watcher guidance to the umbrella tool and registered tool descriptions.
  - Explain prompt-id arrays and asynchronous completion notifications.
  - Explain that `wait` remains available for deterministic barriers.

## Phase 5 — Documentation and tests

- [ ] **5.1 Add registry tests**
  - Single watcher registration.
  - Array watcher registration.
  - Already-completed prompts.
  - Multiple watchers for one prompt.
  - Duplicate settlement and one-shot cleanup.
  - Unwatch without prompt cancellation.

- [ ] **5.2 Add result-state tests**
  - Successful, failed, blocked, timed-out, and cancelled prompts.
  - Final assistant text and all correlation ids.
  - Concurrent watch and wait observing one shared result.

- [ ] **5.3 Add notification tests**
  - Follow-up delivery while the parent is active.
  - Automatic triggering while the parent is idle.
  - Burst coalescing.
  - Notification delivery failure without lifecycle corruption.
  - Shutdown/reload cleanup.

- [ ] **5.4 Add tool and documentation coverage**
  - Validate schemas and public result formatting.
  - Update README and lifecycle examples.
  - Document the watcher contract and distinction from `wait`.

- [ ] **5.5 Run verification**
  - Run `git diff --check`.
  - Run focused watcher tests.
  - Run `npm test`.
  - Perform live Herdr verification with single and multi-prompt watchers.

## Phase 6 — Completion

- [ ] **6.1 Review against specification**
  - Confirm `shepherd_wait` was not replaced or behaviorally changed.
  - Confirm no raw Herdr pane ids are exposed as watcher ids.
  - Confirm watcher completion does not close agents.
  - Confirm no retained child result or fieldnote resources are deleted.

- [ ] **6.2 Mark the specification complete**
  - Update `spec.md` status after implementation and verification pass.
  - Record any intentional deviations from the specification.
