import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createTools } from '../packages/catalog/index.ts';
import { ToolProgressGuard } from '../packages/core/tool-progress.ts';
import { toolMisuse } from '../packages/core/tool-misuse.ts';
import { DEFERRED_TOOLS } from '../packages/tools/deferred-tools.ts';
import { RUN_SCOPED_TOOLS, ToolRegistry } from '../packages/tools/registry.ts';
import { TOOL_CLASSES, classifyTool } from '../packages/tools/tool-categories.ts';
import type { Tool } from '../packages/protocol/index.ts';

async function catalog(t: test.TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-categories-'));
  const tools = createTools(root);
  t.after(async () => {
    await tools.close();
    await rm(root, { recursive: true, force: true });
  });
  return tools;
}
const entries = (tools: ToolRegistry) =>
  [...(tools as unknown as { entries: Map<string, { tool: Tool }> }).entries.values()].map(
    ({ tool }) => tool,
  );

test('every product tool is classified, wherever it is registered', async (t) => {
  const tools = await catalog(t);
  const unclassified = entries(tools)
    .map((tool) => tool.name)
    .filter((name) => tools.classify(name).category === 'other');
  assert.deepEqual(unclassified, [], 'add the new tool to tools/tool-categories.ts');
  for (const name of [...RUN_SCOPED_TOOLS, ...DEFERRED_TOOLS])
    assert.notEqual(classifyTool({ name }).category, 'other', name);
});

test('the classification agrees with what each tool declares', async (t) => {
  const tools = await catalog(t);
  for (const tool of entries(tools)) {
    const { category, query } = tools.classify(tool.name);
    // A query changes nothing, so it can never need a write or command approval. `external` it may: reaching the
    // network is approved for where the data goes, not for what the call changes (`web_search`, `web_fetch`).
    if (query)
      assert.ok(
        tool.permission === undefined || tool.permission === 'external',
        `${tool.name} is a query with a ${tool.permission} permission`,
      );
    if (tool.effect === 'workspace-file') {
      assert.equal(category, 'files', tool.name);
      assert.equal(query, false, tool.name);
    }
    if (tool.effect === 'workspace-read') assert.equal(query, true, tool.name);
  }
  // Polling a job changes nothing but is supposed to change its answer: the one read that is not a query.
  assert.equal(TOOL_CLASSES.get('job_output')?.query, undefined);
});

test('a tool from elsewhere classifies itself, and the guard counts it as the run says', () => {
  const registry = new ToolRegistry();
  registry.register({
    name: 'mcp_docs_lookup',
    description: 'Look up docs',
    category: 'web',
    query: true,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    execute: async () => ({ isError: false, content: 'same' }),
  });
  assert.deepEqual(registry.classify('mcp_docs_lookup'), { category: 'web', query: true });
  assert.deepEqual(registry.classify('no_such_tool'), { category: 'other', query: false });
  // The table is the default; a declaration wins over it.
  assert.deepEqual(classifyTool({ name: 'read_file', query: false }), {
    category: 'files',
    query: false,
  });

  const round = () => [
    {
      call: { id: '1', name: 'mcp_docs_lookup', arguments: {} },
      result: { isError: false, content: 'same' },
    },
  ];
  const told = new ToolProgressGuard({ isQuery: (name) => registry.classify(name).query });
  const actions = [
    told.observeRound(round()),
    told.observeRound(round()),
    told.observeRound(round()),
  ];
  assert.deepEqual(actions, ['continue', 'continue', 'warn']);
  // Without the registry's answer only the product table counts, and an unknown tool resets the comparison.
  const untold = new ToolProgressGuard();
  assert.equal(untold.observeRound(round()), 'continue');
  assert.equal(untold.observeRound(round()), 'continue');
  assert.equal(untold.observeRound(round()), 'continue');
});

test('misuse is also summed per subsystem', () => {
  const report = toolMisuse([
    [
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          { id: '1', name: 'git_diff', arguments: { nope: 1 } },
          { id: '2', name: 'git_log', arguments: {} },
          { id: '3', name: 'gitDiff', arguments: {} },
        ],
      },
      { role: 'tool', toolCallId: '1', isError: true, content: 'Invalid arguments: x.' },
      { role: 'tool', toolCallId: '2', isError: false, content: 'ok' },
      { role: 'tool', toolCallId: '3', isError: true, content: 'Unknown tool: gitDiff.' },
    ],
  ]);
  assert.deepEqual(report.categories, [
    { category: 'git', calls: 2, failures: 1 },
    { category: 'other', calls: 1, failures: 1 },
  ]);
});

/**
 * What every request pays for the tool list, held to a budget.
 *
 * The always-sent catalogue is in every request's prefix, so a sentence added to one description is paid on every
 * round of every run. The budget is not a target to fill: it is the size measured when it was set plus a little
 * room, so growth is a decision someone makes — raise it here, with the reason — rather than drift. A description
 * longer than the per-tool cap is usually explaining the implementation instead of when to use the tool.
 */
const ALWAYS_SENT_BYTES = 20_000;
const DESCRIPTION_CHARS = 1_300;

test('the tool catalogue stays within its size budget', async (t) => {
  const tools = await catalog(t);
  const sent = tools.specs({ mode: 'deferred', loaded: new Set() });
  const bytes = JSON.stringify(sent).length;
  assert.ok(
    bytes <= ALWAYS_SENT_BYTES,
    `the always-sent tools are ${bytes} bytes, over the ${ALWAYS_SENT_BYTES}-byte budget`,
  );
  const long = tools
    .specs({ mode: 'native' })
    .filter((spec) => spec.description.length > DESCRIPTION_CHARS)
    .map((spec) => `${spec.name} (${spec.description.length})`);
  assert.deepEqual(long, [], `descriptions over ${DESCRIPTION_CHARS} characters`);
});
