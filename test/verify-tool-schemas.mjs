// verify-tool-schemas.mjs
//
// Invariant: every model-facing tool parameter schema must have a root
// "type": "object". Bare anyOf roots break grammar/schema-constrained
// sampling backends, which emit `{}` arguments for every call
// (see docs/plans/tool-surface-split.md §1).
//
// This is the permanent guard for the flat-object schema invariant introduced
// during phases 2–3. It probes the real registrations produced by
// registerShepherdTools() through a mock ExtensionAPI instead of duplicating
// the schemas by hand.
import assert from 'node:assert/strict';
import { registerShepherdTools } from '../src/extension/shepherd.ts';

const registered = [];
registerShepherdTools({
  registerTool(tool) {
    registered.push(tool);
  },
  registerMessageRenderer() {},
});

const expectedNames = [
  'shepherd',
  'shepherd_spawn',
  'shepherd_delegate',
  'shepherd_message',
  'shepherd_prompt',
  'shepherd_wait',
  'shepherd_watch',
  'shepherd_status',
  'shepherd_close',
  'shepherd_read',
];
assert.deepEqual(
  registered.map(tool => tool.name),
  expectedNames,
  'registerShepherdTools must register the ten shepherd tools'
);

let failed = 0;
for (const tool of registered) {
  const schema = tool.parameters;
  try {
    assert.ok(schema && typeof schema === 'object', 'schema missing');
    assert.equal(schema.type, 'object', 'root schema must have type "object"');
    assert.ok(
      schema.properties && typeof schema.properties === 'object',
      'root schema must declare properties'
    );
    if (['shepherd_prompt', 'shepherd_wait', 'shepherd_watch', 'shepherd_status', 'shepherd_close'].includes(tool.name)) {
      assert.ok('id' in schema.properties, `${tool.name} must expose a top-level id`);
      assert.ok(!('handle' in schema.properties), `${tool.name} must not expose a public handle`);
    }
    if (tool.name === 'shepherd_delegate') {
      assert.deepEqual(schema.required, ['target', 'task'], 'shepherd_delegate requires target and task');
      assert.deepEqual(
        Object.keys(schema.properties).sort(),
        ['target', 'task', 'timeout'],
        'shepherd_delegate exposes only the public delegation arguments'
      );
    }
    if (tool.name === 'shepherd_message') {
      assert.deepEqual(schema.required, ['target', 'message'], 'shepherd_message requires target and message');
      assert.deepEqual(
        Object.keys(schema.properties).sort(),
        ['delivery', 'expectsReply', 'message', 'replyTo', 'target', 'taskId', 'threadId'],
        'shepherd_message exposes only the public message arguments'
      );
    }
    if (tool.name === 'shepherd_spawn') {
      assert.deepEqual(schema.required, ['agent', 'label'], 'shepherd_spawn requires only agent and label');
      assert.deepEqual(
        Object.keys(schema.properties).sort(),
        ['agent', 'cwd', 'label', 'model', 'placement'],
        'shepherd_spawn exposes only the public spawn arguments'
      );
      for (const removed of ['agentScope', 'direction', 'confirmProjectAgents', 'omitSystemPrompt']) {
        assert.ok(!(removed in schema.properties), `shepherd_spawn must not expose ${removed}`);
      }
      assert.deepEqual(schema.properties.placement.enum, ['pane_right', 'pane_down', 'tab', 'workspace']);
    }
    console.log(`PASS ${tool.name}: root is a flat object with the intended fields`);
  } catch (error) {
    failed++;
    console.log(`FAIL ${tool.name}: ${error.message} (keys: ${Object.keys(schema ?? {}).join(', ')})`);
  }
}

if (failed > 0) {
  console.log(`\n${failed}/${registered.length} tool schemas violate the flat-object invariant.`);
  process.exit(1);
}
console.log('\nAll tool schemas satisfy the flat-object invariant.');
