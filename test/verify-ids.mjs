#!/usr/bin/env node
// Unit test for the shared opaque-id codec (src/core/ids.ts) and its wiring
// into LifecycleRegistry. Formats and invalid-handle messages are part of the
// model-facing contract: these assertions must stay byte-identical.
const { mintId, mintMessageId, normalizeHandleId } = await import('../src/core/ids.ts');
const { LifecycleRegistry, LifecycleError } = await import('../src/core/orchestration.ts');

let failures = 0;
function assert(ok, label) {
  if (ok) console.log(`PASS  ${label}`);
  else {
    failures++;
    console.log(`FAIL  ${label}`);
  }
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

// ── mint formats ─────────────────────────────────────────────────────────
for (const kind of ['agent', 'prompt', 'task', 'watch']) {
  const id = mintId(kind, 'sess1234');
  assert(
    new RegExp(`^shepherd-${kind}-sess1234-${UUID}$`).test(id),
    `mintId('${kind}') mints shepherd-${kind}-<session>-<uuid>`
  );
}
assert(
  new RegExp(`^shepherd-message-${UUID}$`).test(mintMessageId()),
  'mintMessageId() mints shepherd-message-<uuid>'
);
assert(mintId('agent', 's') !== mintId('agent', 's'), 'mintId mints a fresh uuid per call');
assert(mintMessageId() !== mintMessageId(), 'mintMessageId mints a fresh uuid per call');
assert(
  mintId('watch', 'session-1').startsWith('shepherd-watch-session-1-'),
  'mintId uses the literal session segment verbatim'
);

// ── normalize accepts the two historical handle inputs ───────────────────
const agentString = normalizeHandleId('shepherd-agent-1', 'AgentHandle');
assert(agentString.ok && agentString.id === 'shepherd-agent-1', 'agent handle string accepted');
const agentObject = normalizeHandleId({ id: 'shepherd-agent-1' }, 'AgentHandle');
assert(agentObject.ok && agentObject.id === 'shepherd-agent-1', 'agent handle object accepted');
const padded = normalizeHandleId('  shepherd-agent-1  ', 'AgentHandle');
assert(padded.ok && padded.id === '  shepherd-agent-1  ', 'handle string is returned untrimmed');
const emptyObjectId = normalizeHandleId({ id: '' }, 'AgentHandle');
assert(
  emptyObjectId.ok && emptyObjectId.id === '',
  'object id remains accepted as-is (historical behavior)'
);
const promptHandle = normalizeHandleId({ id: 'shepherd-prompt-1' }, 'PromptHandle');
assert(promptHandle.ok && promptHandle.id === 'shepherd-prompt-1', 'prompt handle object accepted');
const taskString = normalizeHandleId('shepherd-task-1', 'TaskHandle');
assert(taskString.ok && taskString.id === 'shepherd-task-1', 'task handle string accepted');
const taskObject = normalizeHandleId({ id: 'shepherd-task-1' }, 'TaskHandle');
assert(taskObject.ok && taskObject.id === 'shepherd-task-1', 'task handle object accepted');

// ── normalize rejects with byte-stable messages, never throws ────────────
const AGENT_INVALID =
  'Expected the opaque agent id as a string. Do not pass a quoted JSON object, array, or Herdr pane id. Correct syntax: { id: "shepherd-agent-..." }.';
const PROMPT_INVALID =
  'Expected the opaque prompt id as a string. Do not pass a quoted JSON object, array, or Herdr pane id. Correct syntax: { id: "shepherd-prompt-..." } (or { id: ["prompt-a", "prompt-b"] } for parallel wait).';
// The historical task message ends with a literal trailing space; keep it.
const TASK_INVALID =
  'Expected the opaque TaskHandle id as a string. Do not pass a quoted JSON object, array, agent id, or Herdr pane id. Correct syntax: { id: "shepherd-task-..." }.' +
  ' ';

const badInputs = [undefined, null, 0, false, '', '   ', [], ['id'], {}, { id: 42 }, { id: null }];
for (const [kind, message] of [
  ['AgentHandle', AGENT_INVALID],
  ['PromptHandle', PROMPT_INVALID],
  ['TaskHandle', TASK_INVALID],
]) {
  for (const input of badInputs) {
    const result = normalizeHandleId(input, kind);
    assert(
      result.ok === false && result.message === message,
      `${kind} rejection message is byte-identical (${JSON.stringify(input)})`
    );
  }
}
let threw = false;
try {
  normalizeHandleId(null, 'AgentHandle');
} catch {
  threw = true;
}
assert(!threw, 'normalizeHandleId returns the error instead of throwing');

// ── LifecycleRegistry mints and validates through the codec ──────────────
const registry = new LifecycleRegistry();
const agent = registry.registerAgent({ agent: 'scout', paneId: 'pane-1' });
assert(
  new RegExp(`^shepherd-agent-[0-9a-f]{8}-${UUID}$`).test(agent.id),
  'LifecycleRegistry mints agent ids via mintId'
);
const task = registry.createTask(agent, 'verify ids');
assert(
  new RegExp(`^shepherd-task-[0-9a-f]{8}-${UUID}$`).test(task.id),
  'LifecycleRegistry mints task ids via mintId'
);
const prompt = registry.createPrompt(agent);
assert(
  new RegExp(`^shepherd-prompt-[0-9a-f]{8}-${UUID}$`).test(prompt.id),
  'LifecycleRegistry mints prompt ids via mintId'
);
const roundTrip = normalizeHandleId(agent, 'AgentHandle');
assert(roundTrip.ok && roundTrip.id === agent.id, 'registry handle round-trips through normalize');

function capture(fn) {
  try {
    fn();
    return undefined;
  } catch (error) {
    return error;
  }
}
const agentError = capture(() => registry.getAgent('   '));
assert(
  agentError instanceof LifecycleError &&
    agentError.code === 'invalid_handle' &&
    agentError.message === AGENT_INVALID,
  'getAgent keeps invalid_handle error and exact message'
);
const promptError = capture(() => registry.getPrompt([]));
assert(
  promptError instanceof LifecycleError &&
    promptError.code === 'invalid_handle' &&
    promptError.message === PROMPT_INVALID,
  'getPrompt keeps invalid_handle error and exact message'
);
const taskError = capture(() => registry.getTask(null));
assert(
  taskError instanceof LifecycleError &&
    taskError.code === 'invalid_handle' &&
    taskError.message === TASK_INVALID,
  'getTask keeps invalid_handle error and exact message'
);
registry.close(agent);

if (failures) process.exit(1);
console.log('All id codec assertions passed.');
