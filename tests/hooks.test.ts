import test from 'node:test';
import assert from 'node:assert/strict';
import { ToolRegistry, HookRegistry } from '../packages/tools/registry.ts';
import { registerExtension } from '../packages/resources/extensions.ts';
import type {
  ToolContext,
  AgentEvent,
  ModelRequest,
  ModelResponse,
  Provider,
} from '../packages/protocol/index.ts';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Agent } from '../packages/core/agent.ts';
import { SessionStore } from '../packages/storage/sqlite.ts';
import { createTools } from '../packages/tools/index.ts';
import { AgentHostClient } from '../packages/client/host-client.ts';
import { parseArgs } from '../apps/shared/args.ts';
import { loadHookRegistry } from '../apps/shared/hooks.ts';
import { projectRoot } from './process-fixture.ts';
import { httpFixture, frames, sendFrames } from './http-fixture.ts';

// ---- merged from extension-hooks.test.ts ----

const call = { id: '1', name: 'effect', arguments: { value: 'original' } };
const ctx = (allow = true): ToolContext => ({
  signal: new AbortController().signal,
  approve: async () => allow,
});
const tool = (run: (args: Record<string, unknown>) => void) => ({
  name: 'effect',
  description: 'effect',
  permission: 'command' as const,
  inputSchema: {
    type: 'object',
    properties: { value: { type: 'string' } },
    required: ['value'],
    additionalProperties: false,
  },
  execute: async (args: Record<string, unknown>) => {
    run(args);
    return { isError: false, content: 'done' };
  },
});
test('extension veto runs before approval and cannot grant denied permission', async () => {
  let effects = 0,
    approvals = 0;
  const registry = new ToolRegistry();
  registerExtension(registry, {
    apiVersion: 1,
    name: 'veto',
    tools: [tool(() => effects++)],
    hooks: { beforeTool: () => false },
  });
  const result = await registry.execute(call, {
    ...ctx(),
    approve: async () => {
      approvals++;
      return true;
    },
  });
  assert.equal(result.isError, true);
  assert.equal(effects, 0);
  assert.equal(approvals, 0);
  const denied = new ToolRegistry();
  registerExtension(denied, {
    apiVersion: 1,
    name: 'allow',
    tools: [tool(() => effects++)],
    hooks: { beforeTool: () => true },
  });
  assert.equal((await denied.execute(call, ctx(false))).isError, true);
  assert.equal(effects, 0);
});
test('extension receives isolated copies and observer failure does not fail completed effect', async () => {
  let value = '',
    closed = 0;
  const registry = new ToolRegistry();
  registerExtension(registry, {
    apiVersion: 1,
    name: 'observer',
    tools: [
      tool((args) => {
        value = String(args.value);
      }),
    ],
    hooks: {
      beforeTool: (call) => {
        call.arguments.value = 'modified';
      },
      afterTool: (_call, result) => {
        result.content = 'modified';
        throw new Error('private extension details');
      },
      close: async () => {
        closed++;
      },
    },
  });
  const result = await registry.execute(call, ctx());
  assert.equal(value, 'original');
  assert.equal(result.isError, false);
  assert.match(result.content, /done/);
  assert.doesNotMatch(result.content, /private|modified/);
  assert.match(result.content, /observer/i);
  await registry.close();
  assert.equal(closed, 1);
});
test('invalid extension hooks leave no partially registered tools', async () => {
  const registry = new ToolRegistry();
  assert.throws(() =>
    registerExtension(registry, {
      apiVersion: 1,
      name: 'invalid',
      tools: [tool(() => {})],
      hooks: { invalid: () => {} } as never,
    }),
  );
  const result = await registry.execute(call, ctx());
  assert.equal(result.isError, true);
  assert.match(result.content, /Unknown tool/);
});

test('hook cancellation waits for cooperative cleanup before returning', async () => {
  let cleaned = false;
  const registry = new ToolRegistry();
  const controller = new AbortController();
  registerExtension(registry, {
    apiVersion: 1,
    name: 'cleanup',
    tools: [tool(() => {})],
    hooks: {
      beforeTool: async (_call, signal) => {
        await new Promise<void>((resolve) => {
          signal.addEventListener(
            'abort',
            () =>
              setTimeout(() => {
                cleaned = true;
                resolve();
              }, 20),
            { once: true },
          );
        });
      },
    },
  });
  const pending = registry.execute(call, { ...ctx(), signal: controller.signal });
  setTimeout(() => controller.abort(new Error('abort requested')), 10);
  await assert.rejects(pending, /abort/i);
  assert.equal(cleaned, true);
});
test('abort while extension awaits prevents tool effects', async () => {
  let effects = 0;
  const registry = new ToolRegistry();
  const controller = new AbortController();
  registerExtension(registry, {
    apiVersion: 1,
    name: 'wait',
    tools: [tool(() => effects++)],
    hooks: {
      beforeTool: async (_call, signal) => {
        controller.abort();
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else signal.addEventListener('abort', () => resolve(), { once: true });
        });
      },
    },
  });
  await assert.rejects(registry.execute(call, { ...ctx(), signal: controller.signal }), /abort/i);
  assert.equal(effects, 0);
});

// ---- merged from hook-lifecycle.test.ts ----

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const reply = (text = 'Finished'): ModelResponse => ({
  text,
  toolCalls: [],
  finishReason: 'stop',
  usage: { inputTokens: 10, outputTokens: 5 },
});
/** An agent wired to a shared host-level hook registry, as the real host wires it. */
async function fixture(t: test.TestContext, provider: Provider, hooks?: HookRegistry) {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-hooks-'));
  const store = new SessionStore(path.join(root, 'sessions.sqlite'));
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const session = store.create(root);
  const events: AgentEvent[] = [];
  const tools = createTools(root, undefined, 'standalone', hooks);
  const agent = new Agent({
    store,
    provider,
    tools,
    approve: async () => true,
    onEvent: (event) => events.push(event),
  });
  return { root, store, session, agent, events, tools };
}

test('hook validation derives from one list, so lifecycle hooks are accepted', () => {
  const registry = new HookRegistry();
  // Regression: validation used a hand-written ['beforeTool','afterTool','close'] allow-list, so
  // every lifecycle hook declared in the types was rejected as "Invalid extension hooks".
  registry.register({
    sessionStart: () => undefined,
    sessionEnd: () => undefined,
    promptSubmit: () => undefined,
    stop: () => undefined,
  });
  assert.equal(registry.size, 1);
  assert.throws(
    () => registry.register({ notAHook: () => undefined } as never),
    /Invalid extension hooks/,
  );
});

test('prompt hook can refuse a run before any row or provider call exists', async (t) => {
  let calls = 0;
  const hooks = new HookRegistry();
  hooks.register({ promptSubmit: () => ({ block: 'spending freeze' }) });
  const { store, session, agent, events } = await fixture(
    t,
    {
      async complete() {
        calls++;
        return reply();
      },
    },
    hooks,
  );
  await assert.rejects(
    agent.run({ sessionId: session.id, prompt: 'do work' }),
    /Prompt rejected by extension: spending freeze/,
  );
  assert.equal(calls, 0, 'a refused prompt must not reach the provider');
  assert.deepEqual(store.messages(session.id), [], 'a refused prompt must persist nothing');
  assert.equal(events.length, 0, 'a refused prompt must not emit run events');
});

test('prompt hook rewrites the prompt that runs and is persisted', async (t) => {
  let seen = '';
  const hooks = new HookRegistry();
  hooks.register({
    promptSubmit: (context) => ({ prompt: `${context.prompt} (reviewed)` }),
  });
  const { store, session, agent } = await fixture(
    t,
    {
      async complete(request: ModelRequest) {
        seen = request.messages.map((message) => message.content).join('\n');
        return reply();
      },
    },
    hooks,
  );
  const result = await agent.run({ sessionId: session.id, prompt: 'ship it' });
  assert.equal(result.status, 'completed');
  assert.match(seen, /ship it \(reviewed\)/);
  const user = store.messages(session.id).find((message) => message.role === 'user');
  assert.equal((user as { content: string }).content, 'ship it (reviewed)');
});

test('prompt hooks chain and a broken prompt hook fails closed', async (t) => {
  const order: string[] = [];
  const chained = new HookRegistry();
  chained.register({
    promptSubmit: (context) => (order.push('a'), { prompt: `${context.prompt}A` }),
  });
  chained.register({
    promptSubmit: (context) => (order.push('b'), { prompt: `${context.prompt}B` }),
  });
  const submitted = await chained.promptSubmit(
    { sessionId: 's', prompt: 'x' },
    new AbortController().signal,
  );
  assert.deepEqual(order, ['a', 'b']);
  assert.equal(submitted.prompt, 'xAB', 'each hook sees the previous hook rewrite');

  const broken = new HookRegistry();
  broken.register({
    promptSubmit: () => {
      throw new Error('policy service down');
    },
  });
  const { session, agent } = await fixture(
    t,
    {
      async complete() {
        return reply();
      },
    },
    broken,
  );
  await assert.rejects(
    agent.run({ sessionId: session.id, prompt: 'run anyway' }),
    /Prompt hook failed, so the run was not started: policy service down/,
  );
});

test('stop hook annotates a finished run without changing its outcome', async (t) => {
  const hooks = new HookRegistry();
  hooks.register({
    stop: (context) => ({
      block: `saw ${context.status} for ${context.runId ? 'a run' : 'nothing'}`,
    }),
  });
  const { store, session, agent } = await fixture(
    t,
    {
      async complete() {
        return reply('Done');
      },
    },
    hooks,
  );
  const result = await agent.run({ sessionId: session.id, prompt: 'hello' });
  assert.equal(result.status, 'completed', 'a stop hook never vetoes a finished run');
  assert.match(result.text, /\[Extension stop hook\] saw completed for a run/);
  // The notice belongs to the run result, not the transcript: assistant history stays exactly what
  // the model produced, so an operator note cannot leak into the next turn's context.
  const assistant = store
    .messages(session.id)
    .filter((message) => message.role === 'assistant')
    .map((message) => (message as { content: string }).content);
  assert.deepEqual(assistant, ['Done']);
});

test('a slow but successful close hook no longer fails a completed run', async (t) => {
  // Regression: close shared the 5s tool-hook budget. An extension that needed 6 seconds to shut
  // down successfully was aborted, its rejection was read as "Tool resource cleanup failed", and a
  // fully completed run was recorded as failed.
  const tools = new ToolRegistry();
  let closed = false;
  tools.registerHooks({
    close: async () => {
      await sleep(5200);
      closed = true;
    },
  });
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-hooks-slow-'));
  const store = new SessionStore(path.join(root, 'sessions.sqlite'));
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const session = store.create(root);
  const agent = new Agent({
    store,
    provider: {
      async complete() {
        return reply('Done');
      },
    },
    tools,
    approve: async () => true,
    onEvent: () => undefined,
  });
  const result = await agent.run({ sessionId: session.id, prompt: 'hello' });
  assert.equal(closed, true, 'the close hook must be allowed to finish');
  assert.equal(result.status, 'completed');
  assert.equal(result.error, undefined);
});

test('a shared host hook registry survives each run closing its tool registry', async (t) => {
  // Regression risk introduced by sharing hooks across runs: every run closes its tool registry, so
  // closing the shared hook set there would tear the host's hooks down after the first run.
  const hooks = new HookRegistry();
  let closed = 0;
  let prompts = 0;
  hooks.register({
    close: async () => {
      closed++;
    },
    promptSubmit: (context) => {
      prompts++;
      return { prompt: context.prompt };
    },
  });
  const { session, agent } = await fixture(
    t,
    {
      async complete() {
        return reply();
      },
    },
    hooks,
  );
  assert.equal((await agent.run({ sessionId: session.id, prompt: 'one' })).status, 'completed');
  assert.equal((await agent.run({ sessionId: session.id, prompt: 'two' })).status, 'completed');
  assert.equal(prompts, 2, 'hooks must still fire on the second run');
  assert.equal(closed, 0, 'a per-run registry must not close the shared hook set');
  assert.deepEqual(await hooks.close(), []);
  assert.equal(closed, 1, 'the owner closes the shared set exactly once');
});

test('session hooks receive their context and report failures without throwing', async () => {
  const hooks = new HookRegistry();
  const seen: unknown[] = [];
  hooks.register({
    sessionStart: (context) => {
      seen.push(context);
      throw new Error('warm-up failed');
    },
    sessionEnd: (context) => {
      seen.push(context);
    },
  });
  const failures = await hooks.sessionStart(
    { sessionId: 's1', workspace: '/w', resumed: false },
    new AbortController().signal,
  );
  assert.deepEqual(failures, ['warm-up failed'], 'a failing start hook is reported, not thrown');
  assert.deepEqual(
    await hooks.sessionEnd({ sessionId: 's1', reason: 'delete' }, new AbortController().signal),
    [],
  );
  assert.deepEqual(seen, [
    { sessionId: 's1', workspace: '/w', resumed: false },
    { sessionId: 's1', reason: 'delete' },
  ]);
});

test('hooks module is named explicitly and must live outside the workspace', async (t) => {
  const base = await mkdtemp(path.join(tmpdir(), 'yuantu-hooks-module-'));
  t.after(async () => rm(base, { recursive: true, force: true }));
  const workspace = path.join(base, 'workspace');
  const outside = path.join(base, 'shared');
  await mkdir(workspace, { recursive: true });
  await mkdir(outside, { recursive: true });
  const source = `export const hooks = { sessionStart: (context) => { globalThis.__hooked = context; } };\n`;
  const outsideModule = path.join(outside, 'hooks.mjs');
  const insideModule = path.join(workspace, 'hooks.mjs');
  await writeFile(outsideModule, source);
  await writeFile(insideModule, source);

  // The whole point of the flag: production had no way to register hooks at all.
  const loaded = await loadHookRegistry(outsideModule, workspace);
  assert.equal(loaded.size, 1);

  await assert.rejects(
    loadHookRegistry(insideModule, workspace),
    /inside the workspace; hooks are trusted code and must live outside it/,
  );

  // A function export lets a module build state before its hooks are used.
  const factory = path.join(outside, 'factory.mjs');
  await writeFile(factory, 'export default async () => ({ stop: () => undefined });\n');
  assert.equal((await loadHookRegistry(factory, workspace)).size, 1);

  await assert.rejects(
    loadHookRegistry(path.join(outside, 'missing.mjs'), workspace),
    /Cannot load hooks module/,
  );
  const empty = path.join(outside, 'empty.mjs');
  await writeFile(empty, 'export const nothing = 1;\n');
  await assert.rejects(
    loadHookRegistry(empty, workspace),
    /must export "hooks" or a default export/,
  );
  // No module means no hooks, which is the default for every existing caller.
  assert.equal((await loadHookRegistry(undefined, workspace)).size, 0);
});

test('the CLI accepts a hooks module by flag and by environment', () => {
  assert.equal(parseArgs(['--hooks', '/tmp/h.mjs']).options.hooks, '/tmp/h.mjs');
  assert.equal(parseArgs([], { YUANTU_HOOKS_MODULE: '/tmp/e.mjs' }).options.hooks, '/tmp/e.mjs');
  assert.equal(parseArgs([]).options.hooks, undefined);
});

test('a hooks module loaded by the host drives session, prompt and stop hooks', async (t) => {
  const moduleDir = await mkdtemp(path.join(tmpdir(), 'yuantu-hooked-host-'));
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-hooked-ws-'));
  const log = path.join(moduleDir, 'hooks.log');
  await writeFile(log, '');
  // The module runs inside the Host process, so it reads the log path from the environment.
  await writeFile(
    path.join(moduleDir, 'hooks.mjs'),
    [
      "import { appendFileSync } from 'node:fs';",
      'const record = (name, extra) =>',
      '  appendFileSync(process.env.HOOK_LOG, JSON.stringify({ name, ...extra }) + "\\n");',
      'export const hooks = {',
      "  sessionStart: (context) => record('sessionStart', { resumed: context.resumed }),",
      "  sessionEnd: (context) => record('sessionEnd', { reason: context.reason }),",
      "  promptSubmit: (context) => { record('promptSubmit', {}); return { prompt: context.prompt + ' [hooked]' }; },",
      "  stop: (context) => { record('stop', { status: context.status }); },",
      '};',
      '',
    ].join('\n'),
  );
  const url = await httpFixture(t, (_body, res) => sendFrames(res, frames('Hooked reply')));
  const client = new AgentHostClient({
    nodePath: process.execPath,
    hostPath: path.join(projectRoot, 'apps/agent-host/main.ts'),
    workspace: root,
    env: {
      YUANTU_MODEL: 'fixture',
      YUANTU_MAX_CONTEXT_TOKENS: '128000',
      YUANTU_SESSION_TITLES: '0',
      YUANTU_API_KEY: 'test',
      YUANTU_PROTOCOL: 'anthropic',
      YUANTU_BASE_URL: url,
      YUANTU_HOOKS_MODULE: path.join(moduleDir, 'hooks.mjs'),
      HOOK_LOG: log,
    },
  });
  t.after(async () => {
    await client.stop();
    await rm(moduleDir, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  });
  await client.start();
  const session = (await client.request('session.create', {})) as { id: string };
  const events: string[] = [];
  client.subscribe((event) => {
    if (event.type === 'message.delta') events.push(String(event.data.text));
  });
  const result = (await client.request('run.start', {
    sessionId: session.id,
    prompt: 'hook me',
  })) as { status: string; text: string };
  assert.equal(result.status, 'completed');
  assert.equal(events.join(''), 'Hooked reply');
  const history = (await client.request('session.get', { sessionId: session.id })) as {
    messages: { role: string; content: string }[];
  };
  const user = history.messages.find((message) => message.role === 'user');
  assert.equal(
    user?.content,
    'hook me [hooked]',
    'the rewritten prompt is what the run used and persisted',
  );
  await client.request('session.delete', { sessionId: session.id });

  const names = (await readFile(log, 'utf8'))
    .trim()
    .split('\n')
    .map(
      (line) =>
        JSON.parse(line) as { name: string; status?: string; reason?: string; resumed?: boolean },
    );
  assert.deepEqual(
    names.map((entry) => entry.name),
    ['sessionStart', 'promptSubmit', 'stop', 'sessionEnd'],
  );
  assert.equal(names[0]!.resumed, false);
  assert.equal(names[2]!.status, 'completed');
  assert.equal(names[3]!.reason, 'delete');
});
