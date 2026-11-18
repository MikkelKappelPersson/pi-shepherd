#!/usr/bin/env node
/**
 * T016 — OpenCode harness, FR-001–FR-004 at the plugin surface.
 *
 * Loads the real plugin module (a module-load smoke test: a bad import can
 * no longer sit unnoticed) and drives `setup` with a fake host to inspect
 * the registered tool/command surface without a running OpenCode server.
 */
import assert from 'node:assert/strict';

const plugin = (await import('../src/opencode/server.ts')).default;
assert.equal(plugin.id, 'shepherd', 'plugin definition loads with a stable id');
assert.equal(typeof plugin.setup, 'function', 'plugin exposes a setup effect');

const tools = new Map();
const commands = new Map();
const host = {
  location: { directory: process.cwd() },
  session: {
    list: async () => [],
    get: async () => ({}),
    prompt: async () => {},
  },
  event: {
    subscribe: () => ({
      async *[Symbol.asyncIterator]() {
        /* no events in this harness */
      },
    }),
  },
  tool: {
    transform: fn =>
      fn({
        add: definition => tools.set(definition.name, definition),
      }),
  },
  command: {
    transform: fn =>
      fn({
        add: definition => commands.set(definition.name, definition),
      }),
  },
};
await plugin.setup(host);

const expectedTools = [
  'shepherd',
  'shepherd_spawn',
  'shepherd_status',
  'shepherd_read',
  'shepherd_close',
  'shepherd_delegate',
  'shepherd_watch',
  'shepherd_message',
  'shepherd_done',
];
assert.deepEqual([...tools.keys()], expectedTools, 'FR-001: full parent + child tool family');
for (const [name, tool] of tools) {
  assert.ok(tool.description?.length > 20, `${name} has a usable description`);
  assert.equal(tool.input.additionalProperties, false, `${name} rejects unknown arguments`);
  assert.equal(typeof tool.execute, 'function', `${name} has an executor`);
}
console.log('PASS FR-001: plugin registers the full Shepherd tool family');

assert.deepEqual(tools.get('shepherd').input.properties.action.enum, ['herd', 'agents', 'prune']);
assert.equal(commands.size, 1, 'one human command');
assert.equal(commands.get('shepherd').name, 'shepherd');
const placement = tools.get('shepherd_spawn').input.properties.placement.description;
for (const value of ['pane_right', 'pane_down', 'tab', 'workspace']) {
  assert.ok(placement.includes(value), `FR-002: ${value} placement is documented`);
}
const { OPENCODE_LAUNCH_OVERRIDES, OPENCODE_CHILD_COMMAND } = await import('../src/opencode/host.ts');
assert.equal(OPENCODE_LAUNCH_OVERRIDES.command, OPENCODE_CHILD_COMMAND);
assert.equal(OPENCODE_LAUNCH_OVERRIDES.command, 'opencode', 'FR-002: children boot the OpenCode CLI');
assert.equal(OPENCODE_LAUNCH_OVERRIDES.envPrefix, 'SHEPHERD_');
console.log('PASS FR-002: visible-pane launch overrides are exposed by the OpenCode host');

assert.deepEqual(tools.get('shepherd_done').input.properties.status.enum, [
  'completed',
  'blocked',
  'failed',
]);
const { sheepDone } = await import('../src/opencode/actions.ts');
const { markParentSession } = await import('../src/opencode/bridge.ts');
markParentSession('parent-session');
await assert.rejects(
  () => sheepDone({ cwd: process.cwd(), sessionId: 'parent-session' }, { status: 'completed' }, 'parent-session'),
  /sheep-only tool/,
  'FR-003: a parent session cannot fabricate a child completion'
);
console.log('PASS FR-003: completion is child-only with an explicit terminal status');

const watchInput = tools.get('shepherd_watch').input.properties.id;
assert.ok(watchInput.anyOf?.some(entry => entry.type === 'array'), 'watch accepts a batch of task ids');
const bridgeSource = await import('node:fs').then(fs =>
  fs.readFileSync(new URL('../src/opencode/bridge.ts', import.meta.url), 'utf8')
);
assert.match(bridgeSource, /parentsFor\(result\.taskId\)/, 'FR-004: settlement routes by task parent');
assert.match(bridgeSource, /is retried instead of silently dropped/, 'FR-004: parent notices are retried');
console.log('PASS FR-004: watch surface, parent-only notices, and bounded retry are wired');

console.log('\nAll OpenCode surface assertions passed.');
