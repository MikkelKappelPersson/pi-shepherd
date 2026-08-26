// verify-tool-schemas.mjs
//
// Invariant: every model-facing tool parameter schema must have a root
// "type": "object". Bare anyOf roots break grammar/schema-constrained
// sampling backends, which emit `{}` arguments for every call
// (see docs/plan-tool-surface-split.md §1).
//
// This is the permanent guard for the flat-object schema invariant introduced
// during phases 2–3; every registered model-facing tool is listed below.
import assert from 'node:assert/strict';
import { Type } from 'typebox';
import { ShepherdParams, SourceSchema } from '../shepherd.ts';
import {
  SpawnParams,
  LifecyclePromptParams,
  WaitParams,
  LifecycleStatusParams,
  LifecycleCloseParams,
} from '../types.ts';

const tools = [
  { name: 'shepherd', parameters: ShepherdParams },
  { name: 'shepherd_spawn', parameters: Type.Omit(SpawnParams, ['action']) },
  { name: 'shepherd_prompt', parameters: Type.Omit(LifecyclePromptParams, ['action']) },
  { name: 'shepherd_wait', parameters: Type.Omit(WaitParams, ['action']) },
  { name: 'shepherd_status', parameters: Type.Omit(LifecycleStatusParams, ['action']) },
  { name: 'shepherd_close', parameters: Type.Omit(LifecycleCloseParams, ['action']) },
  { name: 'shepherd_read', parameters: Type.Object({ name: Type.String(), lines: Type.Optional(Type.Integer({ default: 40 })), source: Type.Optional(SourceSchema) }) },
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
