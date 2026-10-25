import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Agent } from '../packages/core/agent.ts';
import { createTools } from '../packages/catalog/index.ts';
import { OpenAIProvider } from '../packages/providers/openai.ts';
import { RunFailure } from '../packages/protocol/failure.ts';
import type { ModelRequest, AgentEvent } from '../packages/protocol/index.ts';
import { storeFixture } from './temp-fixture.ts';
import { AGENT_EVENT_TYPES } from '../packages/protocol/events.ts';
import { SESSION_EVENT_TYPES } from '../packages/storage/events.ts';
import { SessionStore } from '../packages/storage/sqlite.ts';
import { providerDegradedText } from '../apps/desktop/renderer-status.ts';
import { setLocale, translate } from '../apps/desktop/i18n.ts';
import { localizedRunError } from '../apps/desktop/renderer-error-text.ts';

const tools = [
  {
    name: 'read_file',
    description: 'Read',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
  { name: 'edit_file', description: 'Edit', inputSchema: { type: 'object', required: ['path'] } },
  { name: 'list_files', description: 'List', inputSchema: { type: 'object' } },
];
const req = (): ModelRequest => ({
  system: 'fixture',
  messages: [],
  tools,
  maxOutputTokens: 8192,
  signal: new AbortController().signal,
  onText: () => {},
});
const wireCalls = (args: string[], names: string[] = []) =>
  args.map((json, index) => ({
    index,
    id: `call-${index}`,
    type: 'function',
    function: { name: names[index] ?? (index === 3 ? 'list_files' : 'read_file'), arguments: json },
  }));
function sse(args: string[] | null, prefix: Record<string, string> = {}, names: string[] = []) {
  const values = [
    ...(Object.keys(prefix).length ? [{ choices: [{ index: 0, delta: prefix }] }] : []),
    {
      choices: [
        {
          index: 0,
          delta: args ? { tool_calls: wireCalls(args, names) } : { content: 'Finished' },
          finish_reason: args ? 'tool_calls' : 'stop',
        },
      ],
    },
    { choices: [], usage: { prompt_tokens: 11, completion_tokens: 7 } },
  ];
  return new Response(
    values.map((v) => `data: ${JSON.stringify(v)}\n\n`).join('') + 'data: [DONE]\n\n',
    { headers: { 'content-type': 'text/event-stream' } },
  );
}
const provider = () =>
  new OpenAIProvider({
    apiKey: 'fixture-secret',
    model: 'fixture',
    baseUrl: 'https://fixture.invalid',
  });

for (const args of [
  ['', '', '', '{}'],
  ['', ''],
])
  test(`dropped parallel required arguments are rejected: ${args.length}`, async (t) => {
    t.mock.method(globalThis, 'fetch', async () => sse(args));
    await assert.rejects(provider().complete(req()), (error) => {
      assert.ok(error instanceof RunFailure);
      assert.equal(error.code, 'tool-arguments-dropped');
      assert.deepEqual(error.details?.usage, { inputTokens: 11, outputTokens: 7 });
      assert.equal(error.details?.finishReason, 'tool_calls');
      return true;
    });
  });
for (const args of [[''], ['{}'], ['', '{"path":"target.txt"}']])
  test(`ordinary incomplete parameters remain schema errors: ${JSON.stringify(args)}`, async (t) => {
    t.mock.method(globalThis, 'fetch', async () => sse(args));
    const result = await provider().complete(req());
    assert.deepEqual(result.toolCalls[0]?.arguments, {});
  });
test('optional empty parameters and explicit objects are compatible', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => sse(['', '{}']));
  const request = req();
  request.tools = request.tools.map((tool) => ({ ...tool, inputSchema: { type: 'object' } }));
  assert.equal((await provider().complete(request)).toolCalls.length, 2);
});

async function setup(t: test.TestContext, responses: (() => Response)[], extra = {}) {
  const fixture = await storeFixture(t, 'yuantu-tool-arguments-');
  await writeFile(path.join(fixture.root, 'target.txt'), 'source');
  const bodies: Record<string, unknown>[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    const next = responses.shift();
    assert.ok(next, 'unexpected third attempt');
    return next();
  });
  const events: AgentEvent[] = [];
  const modelInfo = { protocol: 'openai', model: 'fixture', connectionId: 'a' };
  const agent = new Agent({
    store: fixture.store,
    provider: provider(),
    tools: createTools(fixture.root),
    approve: async () => true,
    maxModelRetries: 0,
    modelInfo,
    onEvent: (e) => events.push(e),
    ...extra,
  });
  return { ...fixture, bodies, events, agent, modelInfo };
}

test('recovery is independent of retries, preserves wire input, usage and remembers only its route', async (t) => {
  const ctx = await setup(t, [
    () => sse(['', ''], { reasoning_content: 'discard this thought' }),
    () => sse(['{"path":"target.txt"}']),
    () => sse(null),
    () => sse(null),
    () => sse(null),
  ]);
  const result = await ctx.agent.run({ sessionId: ctx.session.id, prompt: 'Read target.txt' });
  assert.equal(result.status, 'completed', result.error);
  assert.equal(ctx.bodies.length, 3);
  assert.deepEqual(ctx.bodies[1], { ...ctx.bodies[0], parallel_tool_calls: false });
  assert.equal(ctx.bodies[2]?.parallel_tool_calls, false);
  assert.equal(result.usage.inputTokens, 33);
  assert.equal(result.usage.outputTokens, 21);
  assert.equal(result.statistics?.inputTokens, 33);
  const logged = ctx.store.events(ctx.session.id);
  assert.equal(logged.filter((e) => e.type === 'llm.retry').length, 0);
  assert.equal(logged.filter((e) => e.type === 'provider.degraded').length, 1);
  const measurements = logged.filter((e) => e.type === 'provider.request.finished');
  assert.equal(measurements[0]?.data.discarded, 'tool-arguments-dropped');
  assert.equal(measurements[1]?.data.degradedFrom, measurements[0]?.data.requestId);
  assert.ok(ctx.events.some((e) => e.type === 'message.reasoning' && e.data.reset === true));
  assert.ok(AGENT_EVENT_TYPES.includes('provider.degraded'));
  assert.ok(SESSION_EVENT_TYPES.includes('provider.degraded'));
  assert.equal(ctx.store.stateOf<boolean>('providerDegraded', ctx.session.id), true);
  const reopened = new SessionStore(ctx.db);
  ctx.cleanup(() => reopened.close());
  assert.equal(reopened.stateOf<boolean>('providerDegraded', ctx.session.id), true);
  await ctx.agent.run({ sessionId: ctx.session.id, prompt: 'Next' });
  assert.equal(ctx.bodies[3]?.parallel_tool_calls, false);
  ctx.modelInfo.connectionId = 'b';
  await ctx.agent.run({ sessionId: ctx.session.id, prompt: 'Other route' });
  assert.equal(ctx.bodies[4]?.parallel_tool_calls, undefined);
});
for (const args of [[''], ['', '']])
  test(`one recovery only even for ${args.length} empty calls`, async (t) => {
    const ctx = await setup(t, [() => sse(['', '']), () => sse(args)]);
    const result = await ctx.agent.run({ sessionId: ctx.session.id, prompt: 'Read target.txt' });
    assert.equal(result.status, 'failed');
    assert.match(result.error ?? '', /parallel tool calls disabled.*still missing/i);
    assert.equal(ctx.bodies.length, 2);
    assert.equal(ctx.events.filter((e) => e.type === 'tool.started').length, 0);
    assert.equal(
      ctx.store.events(ctx.session.id).filter((e) => e.type === 'provider.degraded').length,
      0,
    );
    assert.ok(localizedRunError(result.error ?? '', false)?.includes('已关闭并行调用重发一次'));
  });
test('serial recovery success does not reinterpret later single omissions', async (t) => {
  const ctx = await setup(t, [
    () => sse(['', '']),
    () => sse(['{"path":"target.txt"}']),
    () => sse(['']),
    () => sse(null),
  ]);
  const result = await ctx.agent.run({ sessionId: ctx.session.id, prompt: 'Read target.txt' });
  assert.equal(result.status, 'completed', result.error);
  const failures = ctx.store.messages(ctx.session.id).filter((m) => m.role === 'tool' && m.isError);
  assert.ok(failures.some((m) => m.content.includes("required property 'path'")));
});
test('visible text prevents recovery and is saved exactly once', async (t) => {
  const ctx = await setup(t, [() => sse(['', ''], { content: 'Partial answer' })]);
  const result = await ctx.agent.run({ sessionId: ctx.session.id, prompt: 'Read target.txt' });
  assert.equal(result.status, 'failed');
  assert.match(result.error ?? '', /partial answer.*not re-sent/i);
  assert.equal(ctx.bodies.length, 1);
  assert.equal(ctx.events.filter((e) => e.type === 'tool.started').length, 0);
  assert.equal(
    ctx.store
      .messages(ctx.session.id)
      .filter((m) => m.role === 'assistant' && m.content === 'Partial answer').length,
    1,
  );
  assert.ok(localizedRunError(result.error ?? '', false)?.includes('已经输出了部分回答'));
});
test('field rejection ends recovery with safe explicit diagnostics', async (t) => {
  const ctx = await setup(t, [
    () => sse(['', '']),
    () =>
      new Response(
        JSON.stringify({ error: { message: 'fixture-secret rejected parallel_tool_calls' } }),
        { status: 400 },
      ),
  ]);
  const result = await ctx.agent.run({ sessionId: ctx.session.id, prompt: 'Read target.txt' });
  assert.equal(result.status, 'failed');
  assert.match(result.error ?? '', /does not accept.*parallel tool calls/i);
  assert.ok(!result.error?.includes('fixture-secret'));
  assert.equal(ctx.bodies.length, 2);
  assert.ok(localizedRunError(result.error ?? '', false)?.includes('端点不接受'));
});

for (const kind of ['text', 'optional'] as const)
  test(`recovery accepts ${kind} output`, async (t) => {
    const ctx = await setup(t, [
      () => sse(['', '']),
      () => (kind === 'text' ? sse(null) : sse([''], {}, ['list_files'])),
      () => sse(null),
    ]);
    // An optional-argument tool may intentionally send no argument fragments.
    const result = await ctx.agent.run({ sessionId: ctx.session.id, prompt: 'Read target.txt' });
    assert.equal(result.status, 'completed', result.error);
    assert.equal(
      ctx.store.events(ctx.session.id).filter((e) => e.type === 'provider.degraded').length,
      1,
    );
  });

test('recovery has no ordinary retry even when its transport fails and retry budget remains', async (t) => {
  const ctx = await setup(
    t,
    [
      () => sse(['', '']),
      () => {
        throw Error('fixture disconnected');
      },
    ],
    { maxModelRetries: 2 },
  );
  const result = await ctx.agent.run({ sessionId: ctx.session.id, prompt: 'Read target.txt' });
  assert.equal(result.status, 'failed');
  assert.match(result.error ?? '', /Tool argument recovery failed/);
  assert.equal(ctx.bodies.length, 2);
  assert.equal(ctx.store.events(ctx.session.id).filter((e) => e.type === 'llm.retry').length, 0);
});

test('desktop downgrade note and all failure variants have both translations', (t) => {
  t.after(() => setLocale('zh-CN'));
  for (const language of ['zh-CN', 'en-US'] as const) {
    setLocale(language);
    assert.equal(providerDegradedText(false), '');
    assert.equal(providerDegradedText(true), translate('ui.providerDegraded', language));
    for (const key of [
      'ui.providerDegraded',
      'ui.toolArgumentsPartial',
      'ui.toolArgumentsUnsupported',
      'ui.toolArgumentsRecoveryFailed',
    ]) {
      const value = translate(key, language);
      assert.notEqual(value, key);
      assert.ok(value.length > 10);
      if (language === 'en-US') assert.ok(!/\p{Script=Han}/u.test(value));
    }
  }
});

test('unrelated recovery HTTP refusal keeps its actual diagnosis', async (t) => {
  const ctx = await setup(t, [
    () => sse(['', '']),
    () =>
      new Response(JSON.stringify({ error: { message: 'fixture refused the model' } }), {
        status: 400,
      }),
  ]);
  const result = await ctx.agent.run({ sessionId: ctx.session.id, prompt: 'Read target.txt' });
  assert.equal(result.status, 'failed');
  assert.match(result.error ?? '', /Tool argument recovery failed:.*HTTP 400/);
  assert.ok(!result.error?.includes('does not accept disabling'));
});
test('fallback route uses provider protocol and model when modelInfo is absent', async (t) => {
  const ctx = await setup(t, [() => sse(['', '']), () => sse(null), () => sse(null)], {
    modelInfo: undefined,
  });
  assert.equal(
    (await ctx.agent.run({ sessionId: ctx.session.id, prompt: 'Read target.txt' })).status,
    'completed',
  );
  assert.equal(
    (await ctx.agent.run({ sessionId: ctx.session.id, prompt: 'Next' })).status,
    'completed',
  );
  assert.equal(ctx.bodies[2]?.parallel_tool_calls, false);
  const degraded = ctx.store.events(ctx.session.id).find((e) => e.type === 'provider.degraded');
  assert.equal(degraded?.data.route, JSON.stringify(['openai', 'fixture', '']));
});
