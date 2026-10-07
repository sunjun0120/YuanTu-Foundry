import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Agent } from '../packages/core/agent.ts';
import { SessionStore } from '../packages/storage/sqlite.ts';
import { ToolRegistry } from '../packages/tools/registry.ts';
import { AnthropicProvider } from '../packages/providers/anthropic.ts';
import { OpenAIProvider } from '../packages/providers/openai.ts';
import { ResponsesProvider } from '../packages/providers/responses.ts';
import { ModelFailure, isContextWindowExceeded } from '../packages/protocol/failure.ts';
import type {
  AgentEvent,
  ModelRequest,
  ModelResponse,
  Provider,
} from '../packages/protocol/index.ts';
import { frames, httpFixture, sendFrames } from './http-fixture.ts';
import { isSummaryRequest } from './summary-request.ts';

// ---- the adapters have to name the overflow, because it is the only place the name exists ----
//
// A context overflow arrives as the same generic 400 as a bad API key, and the adapters deliberately do not
// put an endpoint's error body in a user-visible message. Naming it needs the body to be *read*, which is why
// these two tests exist as a pair: one for what must be recognised, one for what must not.

const reply = (text = 'Finished'): ModelResponse => ({
  text,
  toolCalls: [],
  finishReason: 'stop',
  usage: { inputTokens: 10, outputTokens: 5 },
});
async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-overflow-'));
  const store = new SessionStore(path.join(root, 'session.sqlite'));
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const events: AgentEvent[] = [];
  return { root, store, session: store.create(root), events };
}
const overflowBody = JSON.stringify({
  error: {
    code: 'context_length_exceeded',
    message:
      "This model's maximum context length is 128000 tokens. However, your messages resulted in 140000 tokens.",
  },
});
const request = (): ModelRequest => ({
  system: 'You are YuanTu',
  messages: [{ role: 'user', content: 'Hi' }],
  tools: [],
  maxOutputTokens: 100,
  signal: new AbortController().signal,
  onText: () => {},
});
const providers = (url: string) => [
  new AnthropicProvider({ apiKey: 'test', model: 'fixture-model', baseUrl: url }),
  new OpenAIProvider({ apiKey: 'test', model: 'fixture-model', baseUrl: url }),
  new ResponsesProvider({ apiKey: 'test', model: 'fixture-model', baseUrl: url }),
];

test('every adapter names a context overflow instead of blaming credentials', async (t) => {
  const url = await httpFixture(t, (_body, res) => {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(overflowBody);
  });
  for (const provider of providers(url)) {
    await assert.rejects(
      () => provider.complete(request()),
      (error: unknown) => {
        assert.ok(error instanceof ModelFailure, `${provider.constructor.name} named the failure`);
        assert.equal(error.code, 'context-window-exceeded');
        assert.match(error.message, /context window/i);
        return true;
      },
    );
  }
});

test('an unrelated refusal stays a plain failure with no code to branch on', async (t) => {
  const url = await httpFixture(t, (_body, res) => {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'invalid x-api-key' } }));
  });
  for (const provider of providers(url)) {
    await assert.rejects(
      () => provider.complete(request()),
      (error: unknown) => {
        assert.ok(!(error instanceof ModelFailure));
        assert.match((error as Error).message, /HTTP 401/);
        return true;
      },
    );
  }
});

test("Anthropic's own overflow stop reason survives as more than a length truncation", async (t) => {
  const overflowUrl = await httpFixture(t, (_body, res) => {
    const events = frames('truncated');
    (events.at(-2)!.delta as { stop_reason: string }).stop_reason = 'model_context_window_exceeded';
    sendFrames(res, events);
  });
  const overflow = await new AnthropicProvider({
    apiKey: 'test',
    model: 'fixture-model',
    baseUrl: overflowUrl,
  }).complete(request());
  assert.equal(overflow.finishReason, 'length');
  assert.equal(overflow.truncation, 'context-window');

  // The output limit is the other half of the same shape, and must not be mistaken for it: a full output
  // window is not answered by compressing anything.
  const outputUrl = await httpFixture(t, (_body, res) => {
    const events = frames('truncated');
    (events.at(-2)!.delta as { stop_reason: string }).stop_reason = 'max_tokens';
    sendFrames(res, events);
  });
  const limit = await new AnthropicProvider({
    apiKey: 'test',
    model: 'fixture-model',
    baseUrl: outputUrl,
  }).complete(request());
  assert.equal(limit.finishReason, 'length');
  assert.equal(limit.truncation, undefined);
});

test('a refused request is compressed once and sent again, against a strictly smaller conversation', async (t) => {
  const { store, session, events } = await fixture(t);
  // Three completed turns give the compression a boundary to cut at, which a single message would not.
  for (let i = 0; i < 3; i++) {
    store.append(session.id, { role: 'user', content: 'history '.repeat(450) });
    store.append(session.id, { role: 'assistant', content: 'Recorded.', toolCalls: [] });
  }
  let summaries = 0;
  let refused = 0;
  const mainCalls: number[] = [];
  const provider: Provider = {
    async complete(call: ModelRequest) {
      if (isSummaryRequest(call)) {
        summaries++;
        return reply('Merged summary of the earlier turns.');
      }
      mainCalls.push(call.messages.length);
      if (refused === 0) {
        refused++;
        throw new ModelFailure(
          'context-window-exceeded',
          "Model API reported that the request exceeds the model's context window (HTTP 400).",
        );
      }
      return reply('Recovered');
    },
  };
  // A window wide enough that nothing compresses on its own: the only compression in this test is the one the
  // refusal causes, which is what keeps the assertion about it meaningful.
  const agent = new Agent({
    store,
    tools: new ToolRegistry(),
    approve: async () => false,
    maxContextChars: 200_000,
    maxContextTokens: 20_000,
    maxOutputTokens: 256,
    provider,
    onEvent: (event) => events.push(event),
  });
  const result = await agent.run({ sessionId: session.id, prompt: 'Continue.' });
  assert.equal(result.status, 'completed', result.error);
  assert.equal(result.text, 'Recovered');
  assert.equal(refused, 1);
  assert.equal(summaries, 1, 'the recovery compressed exactly once');
  assert.equal(mainCalls.length, 2, 'the round was sent again exactly once');
  assert.ok(
    mainCalls[1]! < mainCalls[0]!,
    `the re-sent request must be smaller, not identical (${mainCalls.join(' then ')})`,
  );
  assert.ok(store.contextSurface(session.id)!.coveredMessages > 0);
  const overflow = events.filter((event) => event.type === 'context.overflow');
  assert.deepEqual(
    overflow.map((event) => event.data.recovered),
    [true],
  );
  // The recovery is a decision about the conversation, so it outlives the process that made it: the live event
  // says it happened now, the log says it happened at all.
  const recorded = store.events(session.id).filter((event) => event.type === 'context.overflow');
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0]!.data.recovered, true);
  assert.equal(
    recorded[0]!.data.coveredMessages,
    store.contextSurface(session.id)!.coveredMessages,
  );
});

test('the same overflow reported as a stop reason is recovered the same way', async (t) => {
  const { store, session, events } = await fixture(t);
  for (let i = 0; i < 3; i++) {
    store.append(session.id, { role: 'user', content: 'history '.repeat(450) });
    store.append(session.id, { role: 'assistant', content: 'Recorded.', toolCalls: [] });
  }
  let sends = 0;
  const seen: number[] = [];
  const agent = new Agent({
    store,
    tools: new ToolRegistry(),
    approve: async () => false,
    maxContextChars: 200_000,
    maxContextTokens: 20_000,
    maxOutputTokens: 256,
    provider: {
      async complete(call: ModelRequest) {
        if (isSummaryRequest(call)) return reply('summary');
        sends++;
        seen.push(call.messages.length);
        // No text, and the provider named the window rather than the output limit: the round never reached the
        // model, so nothing was shown and the same compression answer applies.
        if (sends === 1)
          return { ...reply(''), finishReason: 'length', truncation: 'context-window' };
        return reply('Recovered');
      },
    },
    onEvent: (event) => events.push(event),
  });
  const result = await agent.run({ sessionId: session.id, prompt: 'Continue.' });
  assert.equal(result.status, 'completed', result.error);
  assert.equal(result.text, 'Recovered');
  assert.equal(sends, 2);
  assert.ok(seen[1]! < seen[0]!, 'the re-sent request must be smaller');
  assert.deepEqual(
    events
      .filter((event) => event.type === 'context.overflow')
      .map((event) => event.data.recovered),
    [true],
  );
});

test('an output-limit truncation is still a hard stop, not a compression', async (t) => {
  const { store, session, events } = await fixture(t);
  let sends = 0;
  const agent = new Agent({
    store,
    tools: new ToolRegistry(),
    approve: async () => false,
    maxContextChars: 200_000,
    maxContextTokens: 20_000,
    maxOutputTokens: 256,
    provider: {
      async complete(call: ModelRequest) {
        if (isSummaryRequest(call)) throw new Error('no summary may be attempted');
        sends++;
        return { ...reply('half an answer'), finishReason: 'length' };
      },
    },
    onEvent: (event) => events.push(event),
  });
  const result = await agent.run({ sessionId: session.id, prompt: 'Continue.' });
  assert.equal(result.status, 'limited', result.error);
  assert.match(result.error!, /output limit reached/i);
  assert.equal(result.text, 'half an answer', 'what the user saw is what was stored');
  assert.equal(sends, 1, 'a full output window is not answered by compressing anything');
  assert.equal(
    events.filter((event) => event.type === 'context.overflow').length,
    0,
    'an output limit is not a context overflow',
  );
  assert.equal(store.contextSurface(session.id), null);
});

test('a provider that always refuses fails after one retry instead of looping', async (t) => {
  const { store, session, events } = await fixture(t);
  for (let i = 0; i < 3; i++) {
    store.append(session.id, { role: 'user', content: 'history '.repeat(450) });
    store.append(session.id, { role: 'assistant', content: 'Recorded.', toolCalls: [] });
  }
  let mainCalls = 0;
  const agent = new Agent({
    store,
    tools: new ToolRegistry(),
    approve: async () => false,
    maxContextChars: 200_000,
    maxContextTokens: 20_000,
    maxOutputTokens: 256,
    provider: {
      async complete(call: ModelRequest) {
        if (isSummaryRequest(call)) return reply('summary');
        mainCalls++;
        throw new ModelFailure(
          'context-window-exceeded',
          "Model API reported that the request exceeds the model's context window (HTTP 400).",
        );
      },
    },
    onEvent: (event) => events.push(event),
  });
  const result = await agent.run({ sessionId: session.id, prompt: 'Continue.' });
  assert.equal(result.status, 'limited', result.error);
  assert.match(result.error!, /context window/i);
  assert.equal(mainCalls, 2, 'one retry, then the failure stands');
  assert.deepEqual(
    events
      .filter((event) => event.type === 'context.overflow')
      .map((event) => event.data.recovered),
    [true, false],
  );
});

test('a refusal with nothing left to compress fails at once, and says what really happened', async (t) => {
  const { store, session, events } = await fixture(t);
  let mainCalls = 0;
  const agent = new Agent({
    store,
    tools: new ToolRegistry(),
    approve: async () => false,
    maxContextChars: 200_000,
    maxContextTokens: 20_000,
    maxOutputTokens: 256,
    provider: {
      async complete(call: ModelRequest) {
        if (isSummaryRequest(call)) throw new Error('no summary may be attempted');
        mainCalls++;
        throw new ModelFailure(
          'context-window-exceeded',
          "Model API reported that the request exceeds the model's context window (HTTP 400).",
        );
      },
    },
    onEvent: (event) => events.push(event),
  });
  const result = await agent.run({ sessionId: session.id, prompt: 'Hi' });
  // The provider's own refusal is what the user sees, not the compression's inability to find a boundary: the
  // second is an implementation detail of a recovery that was never possible.
  assert.equal(result.status, 'limited', result.error);
  assert.match(result.error!, /context window/i);
  assert.doesNotMatch(result.error!, /summary/i);
  assert.equal(mainCalls, 1, 'a conversation with one message has no boundary to compress at');
  assert.deepEqual(
    events
      .filter((event) => event.type === 'context.overflow')
      .map((event) => event.data.recovered),
    [false],
  );
  assert.equal(store.contextSurface(session.id), null);
});

test('prose from an endpoint that only describes the overflow is still recognised', () => {
  assert.equal(
    isContextWindowExceeded(new Error('prompt is too long: 210000 tokens > 200000 maximum')),
    true,
  );
  assert.equal(isContextWindowExceeded(new Error('Model API returned HTTP 400.')), false);
  assert.equal(
    isContextWindowExceeded(new ModelFailure('context-window-exceeded', 'anything at all')),
    true,
  );
});
