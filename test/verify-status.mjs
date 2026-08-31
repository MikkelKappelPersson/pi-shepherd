#!/usr/bin/env node
/**
 * Phase 9 verification — status model.
 *
 * `shepherd_status` now reports process state and task state **independently**:
 * an idle process can own a `waiting` task and a working process a `running`
 * one. The public view carries only opaque ids (no Herdr pane identity); the
 * pane id stays an internal diagnostic. Parent/child separation is enforced
 * one layer up (workers never register the parent control plane — see
 * verify-parent-surface.mjs); this probe covers the status payload itself.
 */
import assert from "node:assert/strict";
import { lifecycleRegistry } from "../src/core/orchestration.ts";
import { statusAgent } from "../src/core/lifecycle.ts";
import { doAction } from "../src/extension/shepherd.ts";
import { withFakeDateNow } from "./helpers/fake-clock.mjs";

const ONE_MIN = 60_000;

await withFakeDateNow(0, async clock => {
  const idle = lifecycleRegistry.registerAgent({ agent: "scout", label: "status-scout" });
  const worker = lifecycleRegistry.registerAgent({ agent: "worker", label: "status-worker" });
  const target = lifecycleRegistry.registerAgent({ agent: "planner", label: "status-planner" });

  // Idle process + waiting task → both independent.
  const waitingTask = lifecycleRegistry.createTask(idle, "Chase the missing retry backoff.");
  lifecycleRegistry.setTaskRunning(waitingTask.id);
  lifecycleRegistry.openPendingRequest(waitingTask.id, {
    messageId: "msg-status-1",
    targetAgentId: target.id,
    text: "What is the retry backoff?",
  });
  clock.advance(65_000);

  const probe = (agentId) => statusAgent({ id: agentId });
  const idleStatus = probe(idle.id);
  // The process is idle (agent_end/turn ended) while its task keeps waiting.
  assert.equal(idleStatus.state, "idle", "process state is idle");
  assert.ok(idleStatus.task, "an idle process still reports its active task");
  assert.equal(idleStatus.task.id, waitingTask.id, "task id is included");
  assert.equal(idleStatus.task.state, "waiting", "task state is reported independently");
  assert.ok(idleStatus.task.waitingSince !== undefined, "waiting origin is included");
  assert.ok(idleStatus.task.waitingMs >= 65_000, "waiting age is included");
  assert.equal(idleStatus.task.pendingRequestMessageId, "msg-status-1", "pending request id is included");
  assert.equal(idleStatus.task.waitingRecipient, "planner: status-planner", "waiting recipient is included");

  // Stale flag appears only after the one-time reminder has been emitted.
  assert.equal(idleStatus.task.stale, undefined, "no stale flag before the reminder");
  lifecycleRegistry.markStaleNotified(waitingTask);
  const staleStatus = probe(idle.id);
  assert.equal(staleStatus.task.stale, true, "stale flag is included when applicable");

  // Working process + running task → both present and consistent.
  const runningTask = lifecycleRegistry.createTask(worker, "Write the rollout plan.");
  lifecycleRegistry.setTaskRunning(runningTask.id);
  lifecycleRegistry.setAgentState(worker, "working");
  const workerStatus = probe(worker.id);
  assert.equal(workerStatus.state, "working", "process state is working");
  assert.equal(workerStatus.task.id, runningTask.id);
  assert.equal(workerStatus.task.state, "running", "running task is reported");
  assert.equal(workerStatus.task.waitingMs, undefined, "no waiting age for a running task");
  assert.equal(workerStatus.task.pendingRequestMessageId, undefined, "no pending request for a running task");

  // A reply resumes the task: waiting fields disappear, the stale flag is gone.
  lifecycleRegistry.resolveReplyForTask(waitingTask.id, "msg-status-1");
  const resumed = probe(idle.id);
  assert.equal(resumed.task.state, "running", "the task returns to running after the reply");
  assert.equal(resumed.task.waitingMs, undefined, "waiting age is cleared on resume");
  assert.equal(resumed.task.stale, undefined, "stale flag is cleared on resume");

  // Completed task → dropped from the task view; the owning process becomes
  // "done" (the agent's work finished). Process and task states were tracked
  // independently up to that point.
  lifecycleRegistry.settleTask(waitingTask.id, { status: "completed", ok: true, text: "resolved" });
  const completed = probe(idle.id);
  assert.equal(completed.state, "done", "the owning process transitions to done");
  assert.equal(completed.task, undefined, "a completed task is removed from the status view");

  // An agent with no task reports process state only (pane id stays internal).
  const plain = probe(target.id);
  assert.equal(plain.task, undefined, "no task field when the agent owns no task");
});

// Public doAction mapping: opaque ids only, pane identity never leaks, and the
// summary text names the process state and the task state independently.
{
  const idle = lifecycleRegistry.registerAgent({ agent: "scout", label: "doaction-scout" });
  const target = lifecycleRegistry.registerAgent({ agent: "planner", label: "doaction-planner" });
  const task = lifecycleRegistry.createTask(idle, "Wait for the mapping test.");
  lifecycleRegistry.setTaskRunning(task.id);
  lifecycleRegistry.openPendingRequest(task.id, {
    messageId: "msg-map-1",
    targetAgentId: target.id,
    text: "ping?",
  });
  lifecycleRegistry.markStaleNotified(task);

  const result = await doAction({ action: "status", id: idle.id }, { cwd: process.cwd() });
  const details = result.details;
  assert.ok(details && typeof details === "object", "status result carries structured details");
  const status = details.status;
  assert.equal(status.id, idle.id, "public result keeps the opaque agent id");
  assert.equal(status.state, "idle", "process state is exposed");
  assert.ok(status.task, "task state is exposed on the public result");
  assert.equal(status.task.id, task.id, "task id is exposed");
  assert.equal(status.task.state, "waiting");
  assert.ok(status.task.waitingMs !== undefined, "waiting age is exposed");
  assert.equal(status.task.pendingRequest, "msg-map-1", "pending request id is exposed");
  assert.equal(status.task.waitingOn, "planner: doaction-planner", "waiting recipient is exposed");
  assert.equal(status.task.stale, true, "stale flag is exposed");
  // Herdr pane identity stays an internal diagnostic, never a public field.
  assert.equal(status.paneId, undefined, "pane id is not in the public status");
  const serialized = JSON.stringify(details);
  assert.ok(!serialized.includes("pane"), "no pane reference leaks into status details");
  const text = result.content.find((c) => c.type === "text").text;
  assert.match(text, /agent idle; task /, "summary names both the process and the task state");
}

console.log("PASS status reports process state and task state independently");
console.log("PASS status includes task id, waiting age, pending request, recipient, and stale flag");
console.log("PASS a reply clears the waiting/stale fields");
console.log("PASS a completed task is removed from the status view");
console.log("PASS the public status result exposes opaque ids only (pane id stays internal)");
console.log("All status model assertions passed.");
