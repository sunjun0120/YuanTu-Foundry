import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Agent } from '../packages/core/agent.ts';
import { SessionStore } from '../packages/storage/sqlite.ts';
import { createTools } from '../packages/tools/index.ts';
import { ResponsesProvider } from '../packages/providers/responses.ts';
import { AnthropicProvider } from '../packages/providers/anthropic.ts';
import { OpenAIProvider } from '../packages/providers/openai.ts';
import { ModelFailure } from '../packages/protocol/failure.ts';
import { estimateInputTokens } from '../packages/core/budget.ts';
import type {
  AgentEvent,
  Message,
  ModelRequest,
  ModelResponse,
  Provider,
} from '../packages/protocol/index.ts';
import { httpFixture } from './http-fixture.ts';
import { isSummaryRequest } from './summary-request.ts';

// ---- reasoning is a channel of its own, all the way to the message that gets stored ----
//
// What the model thought used to arrive, be counted, and be thrown away: the user saw "正在推理…" and a
// character count, and a reopened session had nothing to show because nothing was ever written. The two
// things this file holds down are that the text now travels — and that it never becomes the answer, never
// goes back to a provider, and never inflates the context estimate.

const reply = (text: string, extra: Partial<ModelResponse> = {}): ModelResponse => ({
  text,
  toolCalls: [],
  finishReason: 'stop',
  usage: { inputTokens: 10, outputTokens: 5 },
  ...extra,
});

test('a Responses endpoint reports its reasoning summary on the reasoning channel', async (t) => {
  const url = await httpFixture(t, (_body, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (value: unknown) => res.write('data: ' + JSON.stringify(value) + '\n\n');
    send({ type: 'response.reasoning_summary_text.delta', delta: 'weighing ' });
    send({ type: 'response.reasoning_text.delta', delta: 'the options' });
    send({ type: 'response.output_text.delta', delta: 'Answer' });
    send({
      type: 'response.completed',
      response: {
        status: 'completed',
        usage: { input_tokens: 9, output_tokens: 4 },
        output: [
          {
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: 'Answer' }],
          },
        ],
      },
    });
    res.end();
  });
  const reasoning: string[] = [];
  const text: string[] = [];
  const result = await new ResponsesProvider({
    apiKey: 'test',
    model: 'fixture',
    baseUrl: url,
  }).complete({
    system: 'You are YuanTu',
    messages: [{ role: 'user', content: 'Hi' }],
    tools: [],
    maxOutputTokens: 50,
    signal: new AbortController().signal,
    onText: (delta) => text.push(delta),
    onReasoning: (delta) => reasoning.push(delta),
  });
  assert.equal(result.text, 'Answer');
  assert.deepEqual(text, ['Answer'], 'the summary must not arrive as the answer');
  assert.equal(reasoning.join(''), 'weighing the options');
});

test('reasoning travels on its own event, is stored with its turn, and is never sent back', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-reasoning-'));
  const store = new SessionStore(path.join(root, 'sessions.sqlite'));
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  await writeFile(path.join(root, 'a.txt'), 'hello\n');
  const session = store.create(root);
  const events: AgentEvent[] = [];
  const sent: string[] = [];
  let calls = 0;
  const provider: Provider = {
    async complete(call: ModelRequest) {
      sent.push(JSON.stringify(call.messages));
      if (calls++ === 0) {
        call.onReasoning?.('the user wants ');
        call.onReasoning?.('a.txt');
        call.onText('Reading it.');
        return reply('Reading it.', {
          finishReason: 'tool_calls',
          toolCalls: [{ id: 'read-1', name: 'read_file', arguments: { path: 'a.txt' } }],
        });
      }
      call.onReasoning?.('now I know');
      call.onText('It says hello.');
      return reply('It says hello.');
    },
  };
  const agent = new Agent({
    store,
    provider,
    tools: createTools(root),
    approve: async () => true,
    onEvent: (event) => events.push(event),
  });
  const result = await agent.run({ sessionId: session.id, prompt: 'Read a.txt' });

  assert.equal(result.status, 'completed', result.error);
  assert.equal(result.text, 'It says hello.');
  assert.equal(calls, 2);
  assert.deepEqual(
    events.filter((event) => event.type === 'message.reasoning').map((event) => event.data.text),
    ['the user wants ', 'a.txt', 'now I know'],
  );
  // The event carries the slice; the message carries the whole thought, turn by turn.
  assert.deepEqual(
    store
      .messages(session.id)
      .filter((message) => message.role === 'assistant')
      .map((message) => ({ content: message.content, reasoning: message.reasoning })),
    [
      { content: 'Reading it.', reasoning: 'the user wants a.txt' },
      { content: 'It says hello.', reasoning: 'now I know' },
    ],
  );
  // The second request replays the first turn — the answer and the tool call, which is what the model needs.
  assert.match(sent[1]!, /Reading it\./);
});

test('no protocol encoder puts stored reasoning on the wire', async (t) => {
  // The message keeps the field — it is the shared shape, and a provider may read it — so the guarantee has to
  // be held where the wire format is built: every encoder selects the fields it sends, and this is what says so
  // for all three at once. An endpoint that produces `reasoning_content` rejects it on the way back in.
  const hidden = 'deliberation that must not travel';
  const bodies: string[] = [];
  const url = await httpFixture(t, (body, res) => {
    bodies.push(JSON.stringify(body));
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'stop here' } }));
  });
  const messages: Message[] = [
    { role: 'user', content: 'Read a.txt' },
    {
      role: 'assistant',
      content: 'Reading it.',
      toolCalls: [{ id: 'read-1', name: 'read_file', arguments: { path: 'a.txt' } }],
      reasoning: hidden,
    },
    { role: 'tool', toolCallId: 'read-1', isError: false, content: 'hello' },
  ];
  for (const provider of [
    new AnthropicProvider({ apiKey: 'test', model: 'fixture', baseUrl: url }),
    new OpenAIProvider({ apiKey: 'test', model: 'fixture', baseUrl: url }),
    new ResponsesProvider({ apiKey: 'test', model: 'fixture', baseUrl: url }),
  ])
    await assert.rejects(() =>
      provider.complete({
        system: 'You are YuanTu',
        messages,
        tools: [],
        maxOutputTokens: 50,
        signal: new AbortController().signal,
        onText: () => {},
      }),
    );
  assert.equal(bodies.length, 3, 'every protocol has to be exercised, not just the first');
  for (const body of bodies) {
    assert.doesNotMatch(body, /deliberation that must not travel/);
    assert.match(body, /Reading it\./, 'and the turn it belongs to still has to travel');
  }
});

test('reasoning is not part of the prompt, so it cannot inflate the estimate', () => {
  const messages: Message[] = [
    { role: 'user', content: 'Read a.txt' },
    { role: 'assistant', content: 'It says hello.', toolCalls: [], reasoning: 'x'.repeat(400_000) },
  ];
  const withoutReasoning: Message[] = [
    { role: 'user', content: 'Read a.txt' },
    { role: 'assistant', content: 'It says hello.', toolCalls: [] },
  ];
  assert.equal(
    estimateInputTokens('You are YuanTu', messages, []),
    estimateInputTokens('You are YuanTu', withoutReasoning, []),
    'a thought the provider never receives must not buy a compression',
  );
});

test('a discarded attempt takes its reasoning with it, and says so', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-reasoning-reset-'));
  const store = new SessionStore(path.join(root, 'sessions.sqlite'));
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const session = store.create(root);
  const events: AgentEvent[] = [];
  let sends = 0;
  const agent = new Agent({
    store,
    tools: createTools(root),
    approve: async () => true,
    maxContextChars: 200_000,
    maxContextTokens: 20_000,
    onEvent: (event) => events.push(event),
    provider: {
      async complete(call: ModelRequest) {
        if (isSummaryRequest(call)) return reply('summary');
        // The first attempt thinks out loud and is then refused for the window; the second answers.
        if (sends++ === 0) {
          call.onReasoning?.('first attempt');
          throw new ModelFailure(
            'context-window-exceeded',
            "Model API reported that the request exceeds the model's context window (HTTP 400).",
          );
        }
        call.onReasoning?.('second attempt');
        call.onText('Done.');
        return reply('Done.');
      },
    },
  });
  for (let i = 0; i < 3; i++) {
    store.append(session.id, { role: 'user', content: 'history '.repeat(450) });
    store.append(session.id, { role: 'assistant', content: 'Recorded.', toolCalls: [] });
  }
  const result = await agent.run({ sessionId: session.id, prompt: 'Continue.' });
  assert.equal(result.status, 'completed', result.error);
  const reasoning = events.filter((event) => event.type === 'message.reasoning');
  assert.deepEqual(
    reasoning.map((event) => [event.data.text, event.data.reset === true]),
    [
      ['first attempt', false],
      ['', true],
      ['second attempt', false],
    ],
  );
  // What is stored is the reasoning of the attempt whose answer was stored — not both of them run together.
  const last = store
    .messages(session.id)
    .filter((message) => message.role === 'assistant')
    .at(-1);
  assert.equal(last?.reasoning, 'second attempt');
});
