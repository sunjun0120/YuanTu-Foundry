import test from 'node:test';
import assert from 'node:assert/strict';
import { strictSchema, strictTools } from '../packages/providers/strict-tools.ts';
import { anthropicTools } from '../packages/providers/cache.ts';
import type { ToolSpec } from '../packages/protocol/index.ts';

const spec = (name: string, inputSchema: Record<string, unknown>): ToolSpec => ({
  name,
  description: name,
  inputSchema,
});
const object = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});

test('a strict schema drops the bounds the grammar lacks and refuses what it cannot express', () => {
  const converted = strictSchema(
    object(
      {
        path: { type: 'string', minLength: 1, maxLength: 4096, pattern: '^a' },
        limit: { type: 'integer', minimum: 1, maximum: 100 },
        files: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 20 },
        when: { type: 'string', format: 'date-time' },
        mode: { type: ['string', 'null'] },
      },
      ['path'],
    ),
  );
  assert.deepEqual(converted?.schema.properties, {
    path: { type: 'string' },
    limit: { type: 'integer' },
    files: { type: 'array', items: { type: 'string' }, minItems: 1 },
    when: { type: 'string', format: 'date-time' },
    mode: { type: ['string', 'null'] },
  });
  assert.equal(converted?.optional, 4);
  assert.equal(converted?.unions, 1);
  assert.equal(strictSchema({ type: 'object', properties: {} }), undefined, 'open object');
  assert.equal(strictSchema(object({ a: { oneOf: [{ type: 'string' }] } })), undefined);
  assert.equal(strictSchema(object({ a: { $ref: '#/x' } })), undefined);
  // Cached by schema object: the same schema gives the same copy.
  const schema = object({ a: { type: 'string' } });
  assert.equal(strictSchema(schema), strictSchema(schema));
});

test('strict tools are chosen by priority within the per-request budget', () => {
  const optional = (count: number) =>
    object(
      Object.fromEntries(Array.from({ length: count }, (_, i) => [`p${i}`, { type: 'string' }])),
    );
  const tools = [
    spec('zeta', optional(20)),
    spec('edit_file', optional(0)),
    spec('read_file', optional(5)),
    spec('open', { type: 'object', properties: {} }),
    ...Array.from({ length: 30 }, (_, i) => spec(`t${String(i).padStart(2, '0')}`, optional(0))),
  ];
  const chosen = [...strictTools(tools).keys()];
  assert.equal(chosen.length, 20);
  assert.deepEqual(chosen.slice(0, 2), ['edit_file', 'read_file']);
  assert.ok(!chosen.includes('zeta'), '5 + 20 optional parameters would pass the budget of 24');
  assert.ok(!chosen.includes('open'));

  const sent = anthropicTools(tools.slice(1, 4), false, false, strictTools(tools.slice(1, 4)));
  assert.equal(sent[0]!.strict, true);
  assert.equal(sent[2]!.strict, undefined);
  assert.equal(sent[2]!.input_schema, tools[3]!.inputSchema);
  assert.equal(
    anthropicTools(tools.slice(1, 2), false)[0]!.strict,
    undefined,
    'off unless asked for',
  );
});
