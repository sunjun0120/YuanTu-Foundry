import test from 'node:test';
import assert from 'node:assert/strict';
import { OpenAIProvider } from '../packages/providers/openai.ts';
import { AnthropicProvider } from '../packages/providers/anthropic.ts';
import { readConfig } from '../packages/providers/config.ts';
import type { Message, ModelRequest, ModelResponse } from '../packages/protocol/index.ts';
import { httpFixture, frames, sendFrames } from './http-fixture.ts';
import type { ServerResponse } from 'node:http';
import { storeFixture } from './temp-fixture.ts';
import { deepseekCapabilities } from '../packages/providers/native-history.ts';

const tools = [{ name: 'read_file', description: 'Read', inputSchema: { type: 'object' } }];
const request = (
  messages: Message[] = [{ role: 'user', content: 'Read the file.' }],
): ModelRequest => ({
  system: 'Original instructions.',
  messages,
  tools,
  maxOutputTokens: 256,
  signal: new AbortController().signal,
  onText() {},
});
const assistant = (response: ModelResponse): Message => ({
  role: 'assistant',
  content: response.text,
  toolCalls: response.toolCalls,
  ...(response.providerState ? { providerState: response.providerState } : {}),
});
function chat(
  res: ServerResponse,
  usage: Record<string, unknown> = {
    prompt_tokens: 100,
    completion_tokens: 10,
    prompt_tokens_details: { cached_tokens: 90 },
  },
  finishReason = 'stop',
): void {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const frame of [
    { choices: [{ index: 0, delta: { reasoning_content: 'native private thought' } }] },
    { choices: [{ index: 0, delta: { content: 'Done.' }, finish_reason: finishReason }] },
    { choices: [], usage },
  ])
    res.write(`data: ${JSON.stringify(frame)}\n\n`);
  res.end('data: [DONE]\n\n');
}

test('DeepSeek Chat replays native reasoning only to its original model and endpoint', async (t) => {
  const bodies: Record<string, any>[] = [];
  const url = await httpFixture(t, (body, res) => {
    bodies.push(body);
    chat(res);
  });
  const provider = new OpenAIProvider({
    apiKey: 'fixture',
    model: 'deepseek-flash',
    baseUrl: url,
    deepseekCompatibility: 'on',
  });
  const first = await provider.complete(request());
  const history = [
    ...request().messages,
    assistant(first),
    { role: 'user' as const, content: 'Continue.' },
  ];
  await provider.complete(request(history));
  assert.equal(bodies[1]!.messages[2].reasoning_content, 'native private thought');
  await provider.complete({ ...request(history), model: 'other-model' });
  assert.ok(!JSON.stringify(bodies[2]).includes('native private thought'));
  const changed = structuredClone(history);
  const recorded = changed[1]!;
  assert.equal(recorded.role, 'assistant');
  if (recorded.role === 'assistant') recorded.content = 'Edited answer.';
  await provider.complete(request(changed));
  assert.ok(!JSON.stringify(bodies[3]).includes('native private thought'));
  const elsewhere = new OpenAIProvider({
    apiKey: 'fixture',
    model: 'deepseek-flash',
    baseUrl: url + '/other',
    deepseekCompatibility: 'on',
  });
  await elsewhere.complete(request(history));
  assert.ok(!JSON.stringify(bodies[4]).includes('native private thought'));
});

test('DeepSeek Messages retains ordered thinking signatures without changing generic Anthropic', async (t) => {
  const bodies: Record<string, any>[] = [];
  const url = await httpFixture(t, (body, res) => {
    bodies.push(body);
    const stream = frames('Done.');
    stream.splice(
      1,
      0,
      { type: 'content_block_start', index: 1, content_block: { type: 'thinking', thinking: '' } },
      {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'thinking_delta', thinking: 'signed thought' },
      },
      {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'signature_delta', signature: 'sig-' },
      },
      {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'signature_delta', signature: 'complete' },
      },
      { type: 'content_block_stop', index: 1 },
    );
    sendFrames(res, stream);
  });
  const provider = new AnthropicProvider({
    apiKey: 'fixture',
    model: 'deepseek-flash',
    baseUrl: url,
    deepseekCompatibility: 'on',
  });
  const first = await provider.complete({ ...request(), reasoningEffort: 'high' });
  const history = [
    ...request().messages,
    assistant(first),
    { role: 'user' as const, content: 'Continue.' },
  ];
  await provider.complete(request(history));
  const blocks = bodies[1]!.messages.find((message: any) => message.role === 'assistant').content;
  assert.deepEqual(
    blocks.find((block: any) => block.type === 'thinking'),
    { type: 'thinking', thinking: 'signed thought', signature: 'sig-complete' },
  );
  assert.deepEqual(bodies[0]!.output_config, { effort: 'high' });
  assert.equal(bodies[0]!.thinking.budget_tokens, undefined);
  const generic = new AnthropicProvider({
    apiKey: 'fixture',
    model: 'deepseek-flash',
    baseUrl: url,
  });
  await generic.complete(request(history));
  assert.ok(!JSON.stringify(bodies[2]).includes('signed thought'));
});

test('DeepSeek compatibility is explicit for gateways and validated in environment settings', () => {
  const env = {
    YUANTU_API_KEY: 'fixture',
    YUANTU_MODEL: 'deepseek-flash',
    YUANTU_PROTOCOL: 'openai',
  };
  assert.equal(readConfig({ ...env, YUANTU_DEEPSEEK_COMPAT: 'on' }).deepseekCompatibility, 'on');
  assert.equal(readConfig({ ...env, YUANTU_DEEPSEEK_COMPAT: 'off' }).deepseekCompatibility, 'off');
  assert.throws(() => readConfig({ ...env, YUANTU_DEEPSEEK_COMPAT: 'maybe' }), /auto|on|off/);
});

test('DeepSeek system updates preserve the preceding wire history across restored providers', async (t) => {
  const bodies: Record<string, any>[] = [];
  const url = await httpFixture(t, (body, res) => {
    bodies.push(body);
    chat(res);
  });
  const provider = () =>
    new OpenAIProvider({
      apiKey: 'fixture',
      model: 'deepseek-flash',
      baseUrl: url,
      deepseekCompatibility: 'on',
    });
  const { store, root } = await storeFixture(t, 'yuantu-system-replay-');
  const sessionId = store.create(root).id;
  store.append(sessionId, request().messages[0]!);
  const first = await provider().complete(request(store.messages(sessionId)));
  store.append(sessionId, assistant(first));
  store.append(sessionId, { role: 'user', content: 'Continue.' });
  const second = await provider().complete({
    ...request(store.messages(sessionId)),
    system: 'Updated instructions.',
  });
  assert.deepEqual(bodies[1]!.messages.slice(0, bodies[0]!.messages.length), bodies[0]!.messages);
  assert.deepEqual(bodies[1]!.messages.at(-1), {
    role: 'system',
    content: 'Updated instructions.',
  });
  store.append(sessionId, assistant(second));
  store.append(sessionId, { role: 'user', content: 'Third input.' });
  await provider().complete({
    ...request(store.messages(sessionId)),
    system: 'Updated instructions.',
  });
  assert.deepEqual(bodies[2]!.messages.slice(0, bodies[1]!.messages.length), bodies[1]!.messages);
  assert.equal(bodies[2]!.messages.filter((message: any) => message.role === 'system').length, 2);
  // Losing the initial snapshot is a compaction boundary, not permission to restore an older prompt.
  await provider().complete({
    ...request(store.messages(sessionId).slice(2)),
    system: 'Current instructions.',
  });
  assert.deepEqual(bodies[3]!.messages[0], { role: 'system', content: 'Current instructions.' });
  assert.equal(bodies[3]!.messages.filter((message: any) => message.role === 'system').length, 1);
  await provider().complete({ ...request(store.messages(sessionId)), system: '', tools: [] });
  assert.equal(bodies[4]!.messages[0].content, '');
  assert.ok(
    !JSON.stringify(bodies[4]).includes('Original instructions.') &&
      !JSON.stringify(bodies[4]).includes('Updated instructions.'),
  );
  await provider().complete({
    ...request(store.messages(sessionId)),
    system: 'New tool policy.',
    tools: [],
  });
  assert.equal(bodies[5]!.messages[0].content, 'New tool policy.');
  assert.equal(bodies[5]!.messages.filter((message: any) => message.role === 'system').length, 1);
});

test('DeepSeek Messages appends system updates after the complete tool-result batch', async (t) => {
  const bodies: Record<string, any>[] = [];
  const url = await httpFixture(t, (body, res) => {
    bodies.push(body);
    sendFrames(res, frames('', [{ id: 'call1', name: 'read_file', input: {} }]));
  });
  const provider = new AnthropicProvider({
    apiKey: 'fixture',
    model: 'deepseek-flash',
    baseUrl: url,
    deepseekCompatibility: 'on',
  });
  const first = await provider.complete(request());
  const history = [
    ...request().messages,
    assistant(first),
    { role: 'tool' as const, toolCallId: 'call1', content: 'result', isError: false },
  ];
  await provider.complete({ ...request(history), system: 'New system policy.' });
  assert.equal(bodies[1]!.system, 'Original instructions.');
  assert.deepEqual(bodies[1]!.messages.at(-1), {
    role: 'system',
    content: [{ type: 'text', text: 'New system policy.' }],
  });
  assert.equal(bodies[1]!.messages.at(-2).content[0].type, 'tool_result');
});

test('Chat cache usage accepts DeepSeek fields while retaining standard precedence and unknown values', async (t) => {
  let usage: Record<string, unknown> = {
    prompt_tokens: 100,
    completion_tokens: 10,
    prompt_cache_hit_tokens: 99,
    prompt_cache_miss_tokens: 1,
  };
  const url = await httpFixture(t, (_body, res) => chat(res, usage));
  const provider = new OpenAIProvider({ apiKey: 'fixture', model: 'deepseek-flash', baseUrl: url });
  assert.equal((await provider.complete(request())).usage.cachedInputTokens, 99);
  usage = { ...usage, prompt_tokens_details: { cached_tokens: 98 } };
  assert.equal((await provider.complete(request())).usage.cachedInputTokens, 98);
  usage = { prompt_tokens: 100, completion_tokens: 10 };
  assert.equal((await provider.complete(request())).usage.cachedInputTokens, undefined);
  usage = { ...usage, prompt_cache_hit_tokens: 0 };
  assert.equal((await provider.complete(request())).usage.cachedInputTokens, 0);
  usage = { prompt_tokens: 100, completion_tokens: 10, prompt_cache_miss_tokens: 2 };
  assert.equal((await provider.complete(request())).usage.cachedInputTokens, 98);
  for (const malformed of [-1, 1.5, '90', 101]) {
    usage = { prompt_tokens: 100, completion_tokens: 10, prompt_cache_hit_tokens: malformed };
    await assert.rejects(provider.complete(request()), /token|usage/i);
  }
});

test('DeepSeek Chat preserves original tool argument spelling in native replay', async (t) => {
  const raw = '{ "path" : "a.txt", "n":1.0 }';
  const bodies: Record<string, any>[] = [];
  const url = await httpFixture(t, (body, res) => {
    bodies.push(body);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { reasoning_content: 'read it', tool_calls: [{ index: 0, id: 'call1', type: 'function', function: { name: 'read_file', arguments: raw } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 10 } })}\n\ndata: [DONE]\n\n`,
    );
  });
  const provider = new OpenAIProvider({
    apiKey: 'fixture',
    model: 'deepseek-flash',
    baseUrl: url,
    deepseekCompatibility: 'on',
  });
  const first = await provider.complete(request());
  await provider.complete(
    request([
      ...request().messages,
      assistant(first),
      { role: 'tool', toolCallId: 'call1', content: 'result', isError: false },
    ]),
  );
  assert.equal(
    bodies[1]!.messages.find((message: any) => message.role === 'assistant').tool_calls[0].function
      .arguments,
    raw,
  );
});

test('automatic native capabilities require the exact official endpoint and a known model', () => {
  const config = { apiKey: 'fixture', model: 'deepseek-flash' };
  assert.deepEqual(
    deepseekCapabilities(config, 'https://api.deepseek.com/v1/chat/completions', 'deepseek-flash'),
    { reasoning: true, systemUpdates: true },
  );
  assert.deepEqual(
    deepseekCapabilities(
      config,
      'https://api.deepseek.com/anthropic/v1/messages',
      'deepseek-v4-pro',
    ),
    { reasoning: true, systemUpdates: false },
  );
  for (const [endpoint, model] of [
    ['https://api.deepseek.com.evil.example/v1/chat/completions', 'deepseek-flash'],
    ['https://gateway.example/v1/chat/completions', 'deepseek-flash'],
    ['https://api.deepseek.com/v1/chat/completions', 'unknown-model'],
  ])
    assert.deepEqual(deepseekCapabilities(config, endpoint!, model!), {
      reasoning: false,
      systemUpdates: false,
    });
  assert.deepEqual(
    deepseekCapabilities(
      { ...config, deepseekCompatibility: 'off' },
      'https://api.deepseek.com/v1/chat/completions',
      'deepseek-flash',
    ),
    { reasoning: false, systemUpdates: false },
  );
});

test('interrupted, truncated and filtered DeepSeek replies do not supply native replay', async (t) => {
  let finishReason = 'stop';
  const bodies: Record<string, any>[] = [];
  const url = await httpFixture(t, (body, res) => {
    bodies.push(body);
    chat(res, undefined, finishReason);
  });
  const provider = new OpenAIProvider({
    apiKey: 'fixture',
    model: 'deepseek-flash',
    baseUrl: url,
    deepseekCompatibility: 'on',
  });
  const first = await provider.complete(request());
  const interrupted = assistant(first);
  if (interrupted.role === 'assistant') interrupted.interrupted = true;
  await provider.complete(
    request([...request().messages, interrupted, { role: 'user', content: 'next' }]),
  );
  assert.ok(!JSON.stringify(bodies[1]).includes('native private thought'));
  for (const reason of ['length', 'content_filter']) {
    finishReason = reason;
    assert.equal((await provider.complete(request())).providerState, undefined);
  }
});

test('legacy or foreign assistants supply an empty native reasoning field without replaying display text', async (t) => {
  let body: Record<string, any> | undefined;
  const url = await httpFixture(t, (input, res) => {
    body = input;
    chat(res);
  });
  const provider = new OpenAIProvider({
    apiKey: 'fixture',
    model: 'deepseek-flash',
    baseUrl: url,
    deepseekCompatibility: 'on',
  });
  await provider.complete(
    request([
      { role: 'user', content: 'Earlier input' },
      {
        role: 'assistant',
        content: 'Earlier answer',
        toolCalls: [],
        reasoning: 'display-only untrusted reasoning',
      },
      { role: 'user', content: 'Continue.' },
    ]),
  );
  assert.equal(
    body!.messages.find((message: any) => message.role === 'assistant').reasoning_content,
    '',
  );
  assert.ok(!JSON.stringify(body).includes('display-only untrusted reasoning'));
});

test('Messages reconstructs multiple system snapshots and clears them at a new tool series', async (t) => {
  const bodies: Record<string, any>[] = [];
  const url = await httpFixture(t, (body, res) => {
    bodies.push(body);
    sendFrames(res, frames('Done.'));
  });
  const provider = () =>
    new AnthropicProvider({
      apiKey: 'fixture',
      model: 'deepseek-flash',
      baseUrl: url,
      deepseekCompatibility: 'on',
    });
  const first = await provider().complete({ ...request(), cacheKey: 'fixture-cache' });
  const history = [
    ...request().messages,
    assistant(first),
    { role: 'user' as const, content: 'second' },
  ];
  const second = await provider().complete({
    ...request(history),
    system: 'Second policy.',
    cacheKey: 'fixture-cache',
  });
  history.push(assistant(second), { role: 'user', content: 'third' });
  const third = await provider().complete({
    ...request(history),
    system: 'Third policy.',
    cacheKey: 'fixture-cache',
  });
  history.push(assistant(third), { role: 'user', content: 'fourth' });
  await provider().complete({
    ...request(history),
    system: 'Third policy.',
    cacheKey: 'fixture-cache',
  });
  assert.equal(bodies[3]!.system[0].text, 'Original instructions.');
  assert.deepEqual(
    bodies[3]!.messages
      .filter((message: any) => message.role === 'system')
      .map((message: any) => message.content[0].text),
    ['Second policy.', 'Third policy.'],
  );
  await provider().complete({ ...request(history), system: 'Current policy.', tools: [] });
  assert.equal(bodies[4]!.system, 'Current policy.');
  assert.equal(bodies[4]!.messages.filter((message: any) => message.role === 'system').length, 0);
  await provider().complete({ ...request(history.slice(2)), system: 'Compacted policy.' });
  assert.equal(bodies[5]!.system, 'Compacted policy.');
  assert.equal(bodies[5]!.messages.filter((message: any) => message.role === 'system').length, 0);
});
