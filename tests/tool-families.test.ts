import test from 'node:test';
import assert from 'node:assert/strict';
import type { Tool } from '../packages/protocol/index.ts';
import {
  TOOL_FAMILIES,
  TOOL_ALIASES,
  resolveToolAlias,
  hookSubjects,
  scopeAllowlist,
} from '../packages/protocol/tool-families.ts';
import { composeFamily } from '../packages/tools/tool-family.ts';

test('the old language server names map to the family and action they became', () => {
  assert.deepEqual(TOOL_ALIASES.get('lsp_hover'), { tool: 'lsp', action: 'hover' });
  assert.deepEqual(TOOL_ALIASES.get('lsp_servers'), { tool: 'lsp', action: 'servers' });
  assert.deepEqual(TOOL_ALIASES.get('lsp_code_action'), { tool: 'lsp', action: 'code_actions' });
  assert.deepEqual(TOOL_ALIASES.get('lsp_rename'), { tool: 'lsp_edit', action: 'rename' });
  assert.equal(TOOL_ALIASES.has('lsp_start'), false);
  assert.equal(TOOL_ALIASES.size, 11);
  // No family keeps an old name, so an old rule can only ever be narrowed, never widened.
  for (const family of TOOL_FAMILIES) assert.equal(TOOL_ALIASES.has(family.name), false);
});

test('a call by an old name is rewritten; a current call is the same object', () => {
  assert.deepEqual(
    resolveToolAlias({
      id: 'c',
      name: 'lsp_definition',
      arguments: { path: 'a', line: 1, character: 1 },
    }),
    {
      id: 'c',
      name: 'lsp',
      arguments: { action: 'definition', path: 'a', line: 1, character: 1 },
    },
  );
  const current = { id: 'r', name: 'read_file', arguments: {} };
  assert.equal(resolveToolAlias(current), current);
});

test('hooks and allowlists read an old name as the one operation it was', () => {
  assert.deepEqual(hookSubjects('lsp', 'hover'), ['lsp_hover', 'lsp']);
  assert.deepEqual(hookSubjects('read_file', undefined), ['read_file']);
  const scoped = scopeAllowlist(['read_file', 'lsp_hover', 'lsp_edit', 'lsp.definition']);
  assert.deepEqual(scoped.tools.sort(), ['lsp', 'lsp_edit', 'read_file']);
  assert.deepEqual([...scoped.actions.get('lsp')!].sort(), ['definition', 'hover']);
  assert.equal(scoped.actions.has('lsp_edit'), false);
});

const signal = new AbortController().signal;
const tool = (
  name: string,
  properties: Record<string, unknown>,
  extra: Partial<Tool> = {},
): Tool => ({
  name,
  description: `does ${name}`,
  inputSchema: {
    type: 'object',
    properties,
    required: Object.keys(properties).slice(0, 1),
    additionalProperties: false,
  },
  execute: async (args) => ({ isError: false, content: `${name}:${JSON.stringify(args)}` }),
  ...extra,
});

test('a family dispatches by action and validates with the member schema', async () => {
  const merged = composeFamily(
    { name: 'thing', actions: { a: 'thing_a', b: 'thing_b' } },
    new Map([
      ['a', tool('thing_a', { path: { type: 'string' }, limit: { type: 'integer', maximum: 5 } })],
      ['b', tool('thing_b', { path: { type: 'string' }, limit: { type: 'integer', maximum: 50 } })],
    ]),
    'Thing operations.',
  );
  const schema = merged.inputSchema as { properties: Record<string, unknown>; required: string[] };
  assert.deepEqual(schema.required, ['action']);
  assert.deepEqual(schema.properties.limit, { type: 'integer' });
  assert.match(merged.description, /- a: does thing_a/);
  const prepared = await merged.prepare!({ action: 'b', path: 'x', limit: 40 }, {
    signal,
  } as never);
  assert.equal(
    (await prepared.execute({ signal } as never)).content,
    'thing_b:{"path":"x","limit":40}',
  );
  await assert.rejects(
    merged.prepare!({ action: 'a', path: 'x', limit: 40 }, { signal } as never),
    /action "a"/,
  );
  await assert.rejects(merged.prepare!({ action: 'zzz' }, { signal } as never), /a, b/);
});

test('members with different permissions, or an argument with two types, are build errors', () => {
  assert.throws(
    () =>
      composeFamily(
        { name: 's', actions: { a: 's_a', b: 's_b' } },
        new Map([
          ['a', tool('s_a', {})],
          ['b', tool('s_b', {}, { permission: 'command' })],
        ]),
        'S',
      ),
    /permission/,
  );
  assert.throws(
    () =>
      composeFamily(
        { name: 'x', actions: { a: 'x_a', b: 'x_b' } },
        new Map([
          ['a', tool('x_a', { id: { type: 'string' } })],
          ['b', tool('x_b', { id: { type: 'integer' } })],
        ]),
        'X',
      ),
    /id/,
  );
});
