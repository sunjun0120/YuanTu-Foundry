import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Agent } from '../packages/core/agent.ts';
import { SessionStore } from '../packages/storage/sqlite.ts';
import { createTools } from '../packages/tools/index.ts';
import {
  DEFERRED_TOOLS,
  LOAD_TOOLS,
  deferredToolUsage,
  loadedTools,
} from '../packages/tools/deferred-tools.ts';
import { toolMode } from '../packages/tools/run-code.ts';
import { editSnippet } from '../packages/tools/file-change.ts';
import { presentedSchema } from '../packages/tools/presented-schema.ts';
import { ToolRegistry } from '../packages/tools/registry.ts';
import type { Message, ModelRequest, ModelResponse } from '../packages/protocol/index.ts';

const reply = (text = 'Finished'): ModelResponse => ({
  text,
  toolCalls: [],
  finishReason: 'stop',
  usage: { inputTokens: 10, outputTokens: 5 },
});
const call = (id: string, name: string, args: Record<string, unknown>): ModelResponse => ({
  text: '',
  toolCalls: [{ id, name, arguments: args }],
  finishReason: 'tool_calls',
  usage: { inputTokens: 10, outputTokens: 5 },
});
const names = (request: ModelRequest) => request.tools.map((tool) => tool.name);

async function registry(t: test.TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-deferred-'));
  const tools = createTools(root);
  t.after(async () => {
    await tools.close();
    await rm(root, { recursive: true, force: true });
  });
  return { root, tools };
}

test('the product default defers, and an explicit mode still wins', () => {
  assert.equal(toolMode({}), 'deferred');
  assert.equal(toolMode({ YUANTU_TOOL_MODE: 'native' }), 'native');
  assert.equal(toolMode({ YUANTU_TOOL_MODE: 'ptc' }), 'ptc');
});

test('a deferred catalog holds back the listed subsystems and names them in load_tools', async (t) => {
  const { tools } = await registry(t);
  tools.toolMode = 'deferred';
  const full = tools.specs();
  const sent = tools.specs({ loaded: new Set() });
  const sentNames = sent.map((spec) => spec.name);
  const held = full.filter((spec) => DEFERRED_TOOLS.has(spec.name));
  assert.ok(held.length > 20, 'the empty workspace registers the deferred subsystems');
  for (const spec of held) assert.ok(!sentNames.includes(spec.name), spec.name);
  // Memory is always sent: a plain "remember this" reaches it, and a load would cost a whole extra round.
  for (const name of [
    'read_file',
    'edit_file',
    'run_command',
    'search_files',
    'git_diff',
    'save_memory',
    'list_memories',
    'recall_knowledge',
    'forget_memory',
  ])
    assert.ok(sentNames.includes(name), name);
  const loader = sent.find((spec) => spec.name === LOAD_TOOLS);
  assert.ok(loader);
  const listed = new Set(loader.description.split(/[\s,:]+/));
  for (const spec of held) assert.ok(listed.has(spec.name), spec.name);
  // One line per area, not one sentence per tool: the catalog is sent on every request too.
  assert.ok(loader.description.length < 2000, String(loader.description.length));
  assert.ok(JSON.stringify(sent).length < JSON.stringify(full).length * 0.7);

  const widened = tools.specs({ loaded: new Set(['lsp_hover']) }).map((spec) => spec.name);
  assert.ok(widened.includes('lsp_hover'));
  assert.ok(!widened.includes('lsp_definition'));

  const everything = tools.specs({ loaded: new Set(held.map((spec) => spec.name)) });
  assert.deepEqual(
    everything.map((spec) => spec.name).sort(),
    full
      .map((spec) => spec.name)
      .filter((name) => name !== LOAD_TOOLS)
      .sort(),
    'with nothing left to load, load_tools is not sent either',
  );
});

test('native and folded modes never send load_tools', async (t) => {
  const { tools } = await registry(t);
  tools.toolMode = 'native';
  const native = tools.specs({ loaded: new Set() }).map((spec) => spec.name);
  assert.ok(!native.includes(LOAD_TOOLS));
  assert.ok(native.includes('lsp_hover'));
  tools.toolMode = 'ptc';
  const folded = tools.specs({ loaded: new Set() });
  assert.deepEqual(
    folded.map((spec) => spec.name),
    ['run_code'],
  );
  assert.doesNotMatch(folded[0]!.description, /load_tools/);
});

test('the loaded set is read from the transcript: named loads and direct calls', () => {
  const messages: Message[] = [
    { role: 'user', content: 'go' },
    {
      role: 'assistant',
      content: '',
      toolCalls: [
        { id: '1', name: LOAD_TOOLS, arguments: { names: ['lsp_hover', 'read_file', 'nope'] } },
        { id: '2', name: 'web_fetch', arguments: { url: 'https://example.com' } },
        { id: '3', name: 'read_file', arguments: { path: 'a' } },
      ],
    },
  ];
  assert.deepEqual([...loadedTools(messages, DEFERRED_TOOLS)].sort(), ['lsp_hover', 'web_fetch']);
});

test('load_tools refuses names it cannot load, including ones a restricted run does not offer', async (t) => {
  const { tools } = await registry(t);
  const context = { signal: new AbortController().signal } as never;
  const loader = (registry: typeof tools) =>
    (registry as unknown as { entries: Map<string, { tool: { execute: Function } }> }).entries.get(
      LOAD_TOOLS,
    )!.tool;
  const ok = await loader(tools).execute(
    { names: ['lsp_hover', 'read_file', 'no_such_tool'] },
    context,
  );
  assert.equal(ok.isError, false);
  assert.match(ok.content, /Loaded lsp_hover/);
  assert.match(ok.content, /Already in your tool list, call directly: read_file/);
  assert.match(ok.content, /Not loadable: no_such_tool/);
  // "Loading" a tool that is always sent is not a failure: the model should just call it.
  const sent = await loader(tools).execute({ names: ['read_file'] }, context);
  assert.equal(sent.isError, false);
  assert.match(sent.content, /^Nothing to load\. Already in your tool list/);
  const none = await loader(tools).execute({ names: ['no_such_tool'] }, context);
  assert.equal(none.isError, true);
  const child = tools.forRun({ allow: ['read_file', LOAD_TOOLS] });
  child.toolMode = 'deferred';
  const childSent = child.specs({ loaded: new Set() }).map((spec) => spec.name);
  assert.deepEqual(
    childSent.sort(),
    ['read_file'],
    'a child offered no deferred tool gets no loader',
  );
});

test('a run sends the short catalog, widens it after load_tools, and a later run keeps it', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-deferred-run-'));
  const store = new SessionStore(path.join(root, 'sessions.sqlite'));
  const tools = createTools(root);
  tools.toolMode = 'deferred';
  t.after(async () => {
    store.close();
    await tools.close();
    await rm(root, { recursive: true, force: true });
  });
  const session = store.create(root);
  const seen: string[][] = [];
  let step = 0;
  const agent = new Agent({
    store,
    tools,
    approve: async () => true,
    provider: {
      async complete(request) {
        seen.push(names(request));
        step++;
        if (step === 1) return call('c1', LOAD_TOOLS, { names: ['lsp_servers'] });
        if (step === 2) return call('c2', 'lsp_servers', {});
        return reply();
      },
    },
  });
  const first = await agent.run({ sessionId: session.id, prompt: 'which language servers run?' });
  assert.equal(first.status, 'completed', first.error);
  assert.ok(seen[0]!.includes(LOAD_TOOLS));
  // The run adds session-history and goal tools; with no goal in the session, all of them wait.
  for (const name of [
    'search_sessions',
    'read_session_events',
    'create_goal',
    'get_goal',
    'update_goal',
  ])
    assert.ok(!seen[0]!.includes(name), name);
  assert.ok(!seen[0]!.includes('lsp_servers'));
  assert.ok(seen[1]!.includes('lsp_servers'), 'the round after the load carries the schema');
  const results = store
    .messages(session.id)
    .filter((message) => message.role === 'tool')
    .map((message) => message as { isError?: boolean; content: string });
  assert.equal(results.length, 2);
  assert.ok(
    results.every((result) => !result.isError),
    JSON.stringify(results),
  );

  seen.length = 0;
  step = 2;
  const second = await agent.run({ sessionId: session.id, prompt: 'again' });
  assert.equal(second.status, 'completed', second.error);
  assert.ok(seen[0]!.includes('lsp_servers'), 'a later run starts from what the transcript loaded');
});

test('a held-back tool called without loading still runs and is loaded from then on', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-deferred-direct-'));
  const store = new SessionStore(path.join(root, 'sessions.sqlite'));
  const tools = createTools(root);
  tools.toolMode = 'deferred';
  t.after(async () => {
    store.close();
    await tools.close();
    await rm(root, { recursive: true, force: true });
  });
  const session = store.create(root);
  const seen: string[][] = [];
  const agent = new Agent({
    store,
    tools,
    approve: async () => true,
    provider: {
      async complete(request) {
        seen.push(names(request));
        return seen.length === 1 ? call('d1', 'lsp_servers', {}) : reply();
      },
    },
  });
  const result = await agent.run({ sessionId: session.id, prompt: 'servers' });
  assert.equal(result.status, 'completed', result.error);
  const tool = store.messages(session.id).find((message) => message.role === 'tool') as
    { isError?: boolean; content: string } | undefined;
  assert.ok(tool && !tool.isError, JSON.stringify(tool));
  assert.ok(!seen[0]!.includes('lsp_servers'));
  assert.ok(seen[1]!.includes('lsp_servers'));
});

test('an edit reports the region it produced, numbered and bounded', () => {
  const source = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n');
  const index = source.indexOf('line 5');
  const after = source.slice(0, index) + 'five\nfive-b' + source.slice(index + 'line 5'.length);
  assert.equal(
    editSnippet(after, index, 'five\nfive-b'),
    [
      '2: line 2',
      '3: line 3',
      '4: line 4',
      '5: five',
      '6: five-b',
      '7: line 6',
      '8: line 7',
      '9: line 8',
    ].join('\n'),
  );
  const big = Array.from({ length: 200 }, (_, i) => `x${i}`).join('\n');
  const snippet = editSnippet(big, 0, big);
  assert.match(snippet, /^1: x0\n/);
  assert.match(snippet, /lines not shown/);
  assert.match(snippet, /200: x199$/);
  assert.ok(snippet.split('\n').length <= 25);
});

test('edit_file returns the edited region so the model need not read the file back', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-edit-snippet-'));
  const store = new SessionStore(path.join(root, 'sessions.sqlite'));
  const tools = createTools(root);
  t.after(async () => {
    store.close();
    await tools.close();
    await rm(root, { recursive: true, force: true });
  });
  await writeFile(path.join(root, 'calc.js'), 'export function add(a, b) {\n  return a - b;\n}\n');
  const session = store.create(root);
  let step = 0;
  const agent = new Agent({
    store,
    tools,
    approve: async () => true,
    provider: {
      async complete() {
        step++;
        if (step === 1) return call('r', 'read_file', { path: 'calc.js' });
        if (step === 2)
          return call('e', 'edit_file', { path: 'calc.js', old_text: 'a - b', new_text: 'a + b' });
        return reply();
      },
    },
  });
  const result = await agent.run({ sessionId: session.id, prompt: 'fix add' });
  assert.equal(result.status, 'completed', result.error);
  const edit = store
    .messages(session.id)
    .filter((message) => message.role === 'tool')
    .map((message) => (message as { content: string }).content)
    .at(-1)!;
  assert.equal(
    edit,
    'Updated calc.js. The edited region now reads:\n' +
      '1: export function add(a, b) {\n2:   return a + b;\n3: }\n4: ',
  );
});

test('update_goal is sent while the session has an unfinished goal, and not before', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-deferred-goal-'));
  const store = new SessionStore(path.join(root, 'sessions.sqlite'));
  const tools = createTools(root);
  tools.toolMode = 'deferred';
  t.after(async () => {
    store.close();
    await tools.close();
    await rm(root, { recursive: true, force: true });
  });
  const session = store.create(root);
  const seen: string[][] = [];
  const agent = new Agent({
    store,
    tools,
    approve: async () => true,
    provider: {
      async complete(request) {
        seen.push(names(request));
        return seen.length === 1
          ? call('g1', 'create_goal', { objective: 'Ship the parser' })
          : reply();
      },
    },
  });
  const result = await agent.run({ sessionId: session.id, prompt: 'set a goal: ship the parser' });
  assert.ok(store.goal(session.id), JSON.stringify(result));
  assert.ok(!seen[0]!.includes('update_goal'), 'no goal yet, so nothing to update');
  assert.ok(seen[1]!.includes('update_goal'), 'the round after the goal exists can update it');
  // A later run in the same session starts with it, without a load: the goal is still unfinished.
  seen.length = 0;
  const agent2 = new Agent({
    store,
    tools,
    approve: async () => true,
    provider: {
      async complete(request) {
        seen.push(names(request));
        return reply();
      },
    },
  });
  await agent2.run({ sessionId: session.id, prompt: 'continue' });
  assert.ok(seen[0]!.includes('update_goal'));
});

test('usage counts loads, calls and calls made without a load, per session', () => {
  const assistant = (calls: [string, Record<string, unknown>][]): Message => ({
    role: 'assistant',
    content: '',
    toolCalls: calls.map(([name, args], index) => ({ id: String(index), name, arguments: args })),
  });
  const report = deferredToolUsage([
    [
      assistant([[LOAD_TOOLS, { names: ['lsp_hover', 'read_file'] }]]),
      assistant([['lsp_hover', {}]]),
      assistant([['web_fetch', { url: 'x' }]]),
    ],
    [assistant([['lsp_hover', {}]]), assistant([['read_file', { path: 'a' }]])],
  ]);
  assert.equal(report.sessions, 2);
  assert.equal(report.loadCalls, 1);
  assert.deepEqual(report.tools, [
    { name: 'lsp_hover', loads: 1, calls: 2, direct: 1, sessions: 2 },
    { name: 'web_fetch', loads: 0, calls: 1, direct: 1, sessions: 1 },
  ]);
});

test('the sent schema drops validator-only bounds, and the validator still enforces them', async () => {
  const inputSchema = {
    type: 'object',
    properties: {
      text: { type: 'string', minLength: 1, maxLength: 4096 },
      count: { type: 'integer', minimum: 1, maximum: 100000 },
      kind: { type: 'string', enum: ['a', 'b'] },
      tag: { type: 'string', maxLength: 32, pattern: '^[a-z]+$' },
      maximum: { type: 'string', minLength: 1 },
    },
    required: ['text'],
    additionalProperties: false,
  };
  assert.deepEqual(presentedSchema(inputSchema), {
    type: 'object',
    properties: {
      text: { type: 'string' },
      count: { type: 'integer', minimum: 1, maximum: 100000 },
      kind: { type: 'string', enum: ['a', 'b'] },
      tag: { type: 'string', maxLength: 32, pattern: '^[a-z]+$' },
      maximum: { type: 'string' },
    },
    required: ['text'],
    additionalProperties: false,
  });
  const registry = new ToolRegistry();
  registry.register({
    name: 'echo',
    description: 'Echo.',
    inputSchema,
    execute: async (args) => ({ isError: false, content: String(args.text) }),
  });
  assert.deepEqual(registry.specs()[0]!.inputSchema, presentedSchema(inputSchema));
  const context = { signal: new AbortController().signal } as never;
  const tooLong = await registry.execute(
    { id: '1', name: 'echo', arguments: { text: 'x'.repeat(5000) } },
    context,
  );
  assert.equal(tooLong.isError, true, 'the registered maxLength is still enforced');
  const empty = await registry.execute({ id: '2', name: 'echo', arguments: { text: '' } }, context);
  assert.equal(empty.isError, true, 'the registered minLength is still enforced');
});
