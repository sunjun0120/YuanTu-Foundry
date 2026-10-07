import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { OpenAIProvider } from '../packages/providers/openai.ts';
import { ResponsesProvider } from '../packages/providers/responses.ts';
import { readSse } from '../packages/providers/sse.ts';
import { Agent } from '../packages/core/agent.ts';
import { AgentHostClient } from '../packages/client/host-client.ts';
import { SessionController } from '../packages/client/session-controller.ts';
import { SessionStore } from '../packages/storage/sqlite.ts';
import { createTools } from '../packages/tools/index.ts';
import { httpFixture } from './http-fixture.ts';

test('OpenAI stream can exceed 4 MB of discarded reasoning and still deliver a short answer', async (t) => {
  const url = await httpFixture(t, (_, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const frame =
      'data: ' +
      JSON.stringify({
        choices: [
          { index: 0, delta: { reasoning_content: 'r'.repeat(50_000) }, finish_reason: null },
        ],
      }) +
      '\n\n';
    for (let index = 0; index < 100; index++) res.write(frame);
    res.write(
      'data: ' +
        JSON.stringify({
          choices: [{ index: 0, delta: { content: 'Ready' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 100_000 },
        }) +
        '\n\n',
    );
    res.end('data: [DONE]\n\n');
  });
  const provider = new OpenAIProvider({ apiKey: 'fixture', model: 'fixture', baseUrl: url });
  let streamed = '';
  const result = await provider.complete({
    system: 'Test',
    messages: [{ role: 'user', content: 'Hi' }],
    tools: [],
    maxOutputTokens: 256_000,
    signal: new AbortController().signal,
    onText: (delta) => (streamed += delta),
  });
  assert.equal(streamed, 'Ready');
  assert.equal(result.text, 'Ready');
  assert.equal(result.outputDiagnostics?.reasoningChars, 5_000_000);
});

test('Agent persists visible text when a model stream fails after a delta', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-partial-response-'));
  const store = new SessionStore(path.join(root, 'sessions.sqlite'));
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const session = store.create(root);
  const agent = new Agent({
    store,
    tools: createTools(root),
    approve: async () => true,
    provider: {
      async complete(request) {
        request.onText('Partial answer');
        throw new Error('Model stream frame exceeds limit');
      },
    },
  });
  const result = await agent.run({ sessionId: session.id, prompt: 'Hi' });
  assert.equal(result.status, 'failed');
  assert.equal(result.text, 'Partial answer');
  assert.equal(store.messages(session.id).at(-1)?.content, 'Partial answer');
});

test('Host persists and returns a visible reply larger than 4 MB', async (t) => {
  const url = await httpFixture(t, (_, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const frame =
      'data: ' +
      JSON.stringify({
        choices: [{ index: 0, delta: { content: 'V'.repeat(65_000) }, finish_reason: null }],
      }) +
      '\n\n';
    for (let index = 0; index < 80; index++) res.write(frame);
    res.write(
      'data: ' +
        JSON.stringify({
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 200_000 },
        }) +
        '\n\n',
    );
    res.end('data: [DONE]\n\n');
  });
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-large-response-'));
  const client = new AgentHostClient({
    nodePath: process.execPath,
    hostPath: path.resolve('apps/agent-host/main.ts'),
    workspace: root,
    db: path.join(root, 'sessions.sqlite'),
    env: {
      YUANTU_PROTOCOL: 'openai',
      YUANTU_API_KEY: 'fixture',
      YUANTU_MODEL: 'fixture',
      YUANTU_MAX_CONTEXT_TOKENS: '128000',
      YUANTU_SESSION_TITLES: '0',
      YUANTU_BASE_URL: url,
    },
  });
  t.after(async () => {
    await client.stop();
    await rm(root, { recursive: true, force: true });
  });
  await client.start();
  const session = await client.request('session.create', {});
  const result = await client.run(session.id, 'Generate a long reply');
  assert.equal(result.status, 'completed');
  assert.equal(result.text.length, 5_200_000);
  const page = await client.request('session.get', { sessionId: session.id });
  assert.equal(page.messages.at(-1)?.content.length, 5_200_000);
});
test('one oversized SSE frame is still rejected before parsing', async () => {
  const bytes = new TextEncoder().encode(
    'data: ' + JSON.stringify({ value: 'x'.repeat(16_100_000) }) + '\n\n',
  );
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
  await assert.rejects(async () => {
    for await (const _event of readSse(body, new AbortController().signal)) {
      // The one oversized event must not become a model event.
    }
  }, /frame exceeds 16MB/);
});

test('Responses accepts a multi-megabyte terminal event containing the completed answer', async (t) => {
  const answer = 'R'.repeat(5_200_000);
  const url = await httpFixture(t, (_, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(
      'data: ' +
        JSON.stringify({
          type: 'response.completed',
          response: {
            status: 'completed',
            output: [
              {
                type: 'message',
                id: 'msg-large',
                role: 'assistant',
                status: 'completed',
                content: [{ type: 'output_text', text: answer, annotations: [] }],
              },
            ],
            usage: { input_tokens: 10, output_tokens: 200_000 },
          },
        }) +
        '\n\n',
    );
  });
  const provider = new ResponsesProvider({ apiKey: 'fixture', model: 'fixture', baseUrl: url });
  const result = await provider.complete({
    system: 'Test',
    messages: [{ role: 'user', content: 'Hi' }],
    tools: [],
    maxOutputTokens: 256_000,
    signal: new AbortController().signal,
    onText: () => {},
  });
  assert.equal(result.text.length, answer.length);
  assert.equal(result.text, answer);
});
test('Host can reload a large Responses turn with its opaque continuation state', async (t) => {
  const answer = 'R'.repeat(9_000_000);
  const url = await httpFixture(t, (_, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(
      'data: ' +
        JSON.stringify({
          type: 'response.completed',
          response: {
            status: 'completed',
            output: [
              {
                type: 'message',
                id: 'msg-large',
                role: 'assistant',
                status: 'completed',
                content: [{ type: 'output_text', text: answer, annotations: [] }],
              },
            ],
            usage: { input_tokens: 10, output_tokens: 200_000 },
          },
        }) +
        '\n\n',
    );
  });
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-large-responses-host-'));
  const client = new AgentHostClient({
    nodePath: process.execPath,
    hostPath: path.resolve('apps/agent-host/main.ts'),
    workspace: root,
    db: path.join(root, 'sessions.sqlite'),
    env: {
      YUANTU_PROTOCOL: 'openai-responses',
      YUANTU_API_KEY: 'fixture',
      YUANTU_MODEL: 'fixture',
      YUANTU_MAX_CONTEXT_TOKENS: '128000',
      YUANTU_SESSION_TITLES: '0',
      YUANTU_BASE_URL: url,
    },
  });
  t.after(async () => {
    await client.stop();
    await rm(root, { recursive: true, force: true });
  });
  await client.start();
  const session = await client.request('session.create', {});
  const result = await client.run(session.id, 'Generate a long reply');
  assert.equal(result.status, 'completed');
  assert.equal(result.text.length, answer.length);
  const page = await client.request('session.get', { sessionId: session.id });
  assert.equal(page.messages.at(-1)?.content.length, answer.length);
  const controller = new SessionController(client);
  t.after(() => controller.dispose());
  await controller.load(session.id);
  assert.equal(controller.snapshot.messages.at(-1)?.content.length, answer.length);
  const displayed = controller.snapshot.messages.at(-1);
  assert.equal(displayed?.role, 'assistant');
  if (displayed?.role === 'assistant') assert.equal(displayed.providerState, undefined);
});

test('desktop history reconstructs one reply larger than its transport page', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-chunked-history-'));
  const db = path.join(root, 'sessions.sqlite');
  const store = new SessionStore(db);
  const session = store.create(root);
  const reply = 'L'.repeat(16_000_000);
  store.append(session.id, { role: 'assistant', content: reply, toolCalls: [] });
  store.close();
  const client = new AgentHostClient({
    nodePath: process.execPath,
    hostPath: path.resolve('apps/agent-host/main.ts'),
    workspace: root,
    db,
    env: {
      YUANTU_MODEL: 'fixture',
      YUANTU_MAX_CONTEXT_TOKENS: '128000',
      YUANTU_SESSION_TITLES: '0',
      YUANTU_API_KEY: 'fixture',
    },
  });
  const controller = new SessionController(client);
  t.after(async () => {
    controller.dispose();
    await client.stop();
    await rm(root, { recursive: true, force: true });
  });
  await client.start();
  await controller.load(session.id);
  assert.equal(controller.snapshot.messages[0]?.content, reply);
});
