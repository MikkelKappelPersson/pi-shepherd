// verify-tool-schemas.mjs
//
// Invariant: every model-facing tool parameter schema must have a root
// "type": "object". Bare anyOf roots break grammar/schema-constrained
// sampling backends, which emit `{}` arguments for every call
// (see docs/plan-tool-surface-split.md §1).
//
// Expected state: FAILS while the union-based `ShepherdParams` is still in
// place; becomes the permanent guard once phases 2–3 land.
import assert from 'node:assert/strict';
import { ShepherdParams } from '../shepherd.ts';

const tools = [
  { name: 'shepherd', parameters: ShepherdParams },
  // Phase 3 additions:
  // { name: 'shepherd_spawn',  parameters: ShepherdSpawnParams },
  // { name: 'shepherd_prompt', parameters: ShepherdPromptParams },
  // { name: 'shepherd_wait',   parameters: ShepherdWaitParams },
  // { name: 'shepherd_status', parameters: ShepherdStatusParams },
  // { name: 'shepherd_close',  parameters: ShepherdCloseParams },
  // { name: 'shepherd_read',   parameters: ShepherdReadParams },
];

let failed = 0;
for (const tool of tools) {
  const schema = tool.parameters;
  try {
    assert.ok(schema && typeof schema === 'object', 'schema missing');
    assert.equal(schema.type, 'object', 'root schema must have type "object"');
    assert.ok(
      schema.properties && typeof schema.properties === 'object',
      'root schema must declare properties'
    );
    console.log(`PASS ${tool.name}: root schema is a flat object`);
  } catch (error) {
    failed++;
    console.log(`FAIL ${tool.name}: ${error.message} (keys: ${Object.keys(schema ?? {}).join(', ')})`);
  }
}

if (failed > 0) {
  console.log(`\n${failed}/${tools.length} tool schemas violate the flat-object invariant.`);
  process.exit(1);
}
console.log('\nAll tool schemas satisfy the flat-object invariant.');
