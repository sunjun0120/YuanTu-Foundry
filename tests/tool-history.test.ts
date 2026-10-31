import test from 'node:test';
import assert from 'node:assert/strict';
import type { ServerResponse } from 'node:http';
import { AnthropicProvider } from '../packages/providers/anthropic.ts';
import { OpenAIProvider } from '../packages/providers/openai.ts';
import { ResponsesProvider } from '../packages/providers/responses.ts';
import type { Message, ModelRequest, ModelResponse } from '../packages/protocol/index.ts';
import { httpFixture, frames, sendFrames } from './http-fixture.ts';

/**
 * A session recorded before the language server tools were merged holds calls by their old names, with the
 * native output that produced them. Each protocol's adapter rewrites the calls to the current names on the way
 * out, and must hand the reasoning that came with them back unchanged: a tool loop resumed mid-turn needs it.
 */
const tools = [{ name: 'lsp', description: 'Language server', inputSchema: { type: 'object' } }];
const request = (messages: Message[]): ModelRequest => ({
  system: 'Instructions.',
  messages,
  tools,
  maxOutputTokens: 256,
  signal: new AbortController().signal,
  onText() {},
});
const ask: Message = { role: 'user', content: 'What is the type here?' };
const assistant = (response: ModelResponse): Message => ({
  role: 'assistant',
  content: response.text,
  toolCalls: response.toolCalls,
  ...(response.providerState ? { providerState: response.providerState } : {}),
});
const result: Message = { role: 'tool', toolCallId: 'c1', content: 'number', isError: false };
const args = { path: 'a.ts', line: 1, character: 1 };

function assertRewritten(body: unknown, reasoning: string[]): void {
  const wire = JSON.stringify(body);
  for (const text of reasoning) assert.ok(wire.includes(text), `kept ${text}`);
  assert.ok(!wire.includes('lsp_hover'), 'the old name is not sent');
  assert.ok(wire.includes('"lsp"'), 'the current name is sent');
  assert.ok(wire.includes('hover'), 'with the action it became');
}

test('Responses replays reasoning and sends an old call under its current name', async (t) => {
  const bodies: Record<string, unknown>[] = [];
  const url = await httpFixture(t, (body, res: ServerResponse) => {
    bodies.push(body);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const output = [
      { id: 'rs', type: 'reasoning', summary: [], encrypted_content: 'ENCRYPTED-THOUGHT' },
      {
        id: 'fc',
        type: 'function_call',
        call_id: 'c1',
        name: 'lsp_hover',
        arguments: JSON.stringify(args),
        status: 'completed',
      },
    ];
    res.end(
      'data: ' +
        JSON.stringify({
          type: 'response.completed',
          response: { status: 'completed', output, usage: { input_tokens: 10, output_tokens: 5 } },
        }) +
        '\n\n',
    );
  });
  const provider = new ResponsesProvider({ apiKey: 'fixture', model: 'model-a', baseUrl: url });
  const first = await provider.complete(request([ask]));
  assert.equal(first.toolCalls[0]!.name, 'lsp_hover', 'the fixture recorded the old name');
  await provider.complete(request([ask, assistant(first), result]));
  assertRewritten(bodies[1], ['ENCRYPTED-THOUGHT']);
});

test('Anthropic replays thinking and sends an old call under its current name', async (t) => {
  const bodies: Record<string, unknown>[] = [];
  const url = await httpFixture(t, (body, res) => {
    bodies.push(body);
    const stream = frames('', [{ id: 'c1', name: 'lsp_hover', input: args }]);
    stream.splice(
      1,
      0,
      { type: 'content_block_start', index: 9, content_block: { type: 'thinking', thinking: '' } },
      {
        type: 'content_block_delta',
        index: 9,
        delta: { type: 'thinking_delta', thinking: 'SIGNED-THOUGHT' },
      },
      {
        type: 'content_block_delta',
        index: 9,
        delta: { type: 'signature_delta', signature: 'SIGNATURE' },
      },
      { type: 'content_block_stop', index: 9 },
    );
    sendFrames(res, stream);
  });
  const provider = new AnthropicProvider({
    apiKey: 'fixture',
    model: 'deepseek-flash',
    baseUrl: url,
    deepseekCompatibility: 'on',
  });
  const first = await provider.complete({ ...request([ask]), reasoningEffort: 'high' });
  assert.equal(first.toolCalls[0]!.name, 'lsp_hover');
  assert.ok(first.providerState, 'the fixture produced native state');
  await provider.complete(request([ask, assistant(first), result]));
  assertRewritten(bodies[1], ['SIGNED-THOUGHT', 'SIGNATURE']);
});

test('OpenAI-compatible replays reasoning_content and sends an old call under its current name', async (t) => {
  const bodies: Record<string, unknown>[] = [];
  const url = await httpFixture(t, (body, res) => {
    bodies.push(body);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const delta = {
      reasoning_content: 'PRIVATE-THOUGHT',
      tool_calls: [
        {
          index: 0,
          id: 'c1',
          type: 'function',
          function: { name: 'lsp_hover', arguments: JSON.stringify(args) },
        },
      ],
    };
    res.end(
      `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 10 } })}\n\ndata: [DONE]\n\n`,
    );
  });
  const provider = new OpenAIProvider({
    apiKey: 'fixture',
    model: 'deepseek-flash',
    baseUrl: url,
    deepseekCompatibility: 'on',
  });
  const first = await provider.complete(request([ask]));
  assert.equal(first.toolCalls[0]!.name, 'lsp_hover');
  assert.ok(first.providerState, 'the fixture produced native state');
  await provider.complete(request([ask, assistant(first), result]));
  assertRewritten(bodies[1], ['PRIVATE-THOUGHT']);
});

test('history by current names is sent exactly as before', async (t) => {
  const bodies: Record<string, unknown>[] = [];
  const url = await httpFixture(t, (body, res) => {
    bodies.push(body);
    const stream = frames('', [{ id: 'c1', name: 'lsp', input: { action: 'hover', ...args } }]);
    sendFrames(res, stream);
  });
  const provider = new AnthropicProvider({
    apiKey: 'fixture',
    model: 'deepseek-flash',
    baseUrl: url,
    deepseekCompatibility: 'on',
  });
  const first = await provider.complete(request([ask]));
  await provider.complete(request([ask, assistant(first), result]));
  const replayed = JSON.stringify(
    (bodies[1] as { messages: { role: string; content: unknown }[] }).messages.find(
      (message) => message.role === 'assistant',
    ),
  );
  assert.ok(replayed.includes('"name":"lsp"'));
  assert.ok(replayed.includes('"action":"hover"'));
});
