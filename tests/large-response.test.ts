import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { OpenAIProvider } from '../packages/providers/openai.ts';
import { ResponsesProvider } from '../packages/providers/responses.ts';
import { readSse } from '../packages/providers/sse.ts';
import { RunFailure } from '../packages/protocol/failure.ts';
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

test('a chunked first history page still carries the session steps a plain first page carries', async (t) => {
  /**
   * The session-level half of a history page — the statistics and the step record — describes the session, not the
   * window of history that happens to be loaded, so it travels with the first page. A first page whose single
   * message is too large to fit the transport bound is delivered as a `messageChunk`, and that branch attached the
   * statistics while dropping the steps: the same page, answered by the same handler, promised two different
   * shapes depending on how big its message was. A continuation chunk is the rest of a message this page already
   * started, so it is not a first page and repeats neither field.
   */
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-chunked-steps-'));
  const db = path.join(root, 'sessions.sqlite');
  const store = new SessionStore(db);
  const session = store.create(root);
  const reply = 'S'.repeat(16_000_000);
  store.append(session.id, { role: 'assistant', content: reply, toolCalls: [] });
  store.recordEvent(session.id, 'step.started', { runId: 'run-chunk', step: 0 });
  store.recordEvent(session.id, 'step.finished', { runId: 'run-chunk', step: 0, reason: 'final' });
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
  t.after(async () => {
    await client.stop();
    await rm(root, { recursive: true, force: true });
  });
  await client.start();
  const page = await client.request('session.get', {
    sessionId: session.id,
    view: 'display',
    offset: 0,
  });
  assert.ok(page.messageChunk, 'the oversized first message is still delivered as a chunk');
  assert.ok(page.statistics, 'the statistics travel with the first page');
  assert.deepEqual(
    page.steps?.map((record) => ({ step: record.step, reason: record.reason })),
    [{ step: 0, reason: 'final' }],
    'and so do the steps, whether or not the first page had to be chunked',
  );
  const rest = await client.request('session.get', {
    sessionId: session.id,
    view: 'display',
    offset: 0,
    chunkOffset: page.messageChunk.nextChunkOffset,
  });
  assert.ok(rest.messageChunk, 'the continuation is the same message');
  assert.equal('steps' in rest, false, 'a continuation chunk is not a new first page');
  assert.equal('statistics' in rest, false);
});

/**
 * The SSE reader's own frame semantics, driven directly.
 *
 * The tests above reach `readSse` through an adapter, so they say "a large response arrives whole" and nothing
 * about the reader's edges: what counts as a frame, what a heartbeat is, when `[DONE]` ends the stream, what
 * happens to a half frame at the end, which failures keep their name, and what a byte boundary in the middle of
 * a character does. It takes a `ReadableStream`, so all of that is reachable with synthetic chunks — no endpoint,
 * no Host, no timing.
 */
function streamOf(chunks: readonly (string | Uint8Array)[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      if (index >= chunks.length) {
        controller.close();
        return;
      }
      const chunk = chunks[index++]!;
      controller.enqueue(typeof chunk === 'string' ? encoder.encode(chunk) : chunk);
    },
  });
}

async function readAll(
  body: ReadableStream<Uint8Array>,
  options: { signal?: AbortSignal; allowDone?: boolean } = {},
): Promise<Record<string, unknown>[]> {
  const events: Record<string, unknown>[] = [];
  for await (const event of readSse(
    body,
    options.signal ?? new AbortController().signal,
    options.allowDone ?? false,
  ))
    events.push(event);
  return events;
}

test('a stream frame is a data line, and only an object is an event', async () => {
  // A comment or heartbeat frame carries no data at all: it is not an event, and it must not become one by
  // being parsed as the empty string.
  assert.deepEqual(await readAll(streamOf([': keep-alive\n\n', 'data: {"a":1}\n\n'])), [{ a: 1 }]);
  // `data:` with a space is the same field; multi-line data is joined with a newline, as the format says.
  assert.deepEqual(await readAll(streamOf(['data: {"a":\n', 'data: 2}\n\n'])), [{ a: 2 }]);
  // Anything that is not an object is refused rather than handed to an adapter that would read fields off it.
  for (const payload of ['[1,2]', 'null', '42', '"text"'])
    await assert.rejects(
      readAll(streamOf([`data: ${payload}\n\n`])),
      /Invalid stream event/,
      payload,
    );
  // and a frame that is not JSON at all says so
  await assert.rejects(readAll(streamOf(['data: {oops\n\n'])), /Invalid JSON in model stream/);
});

test('[DONE] ends the stream only where the protocol says it may', async () => {
  // Without permission it is not a terminal marker; it is a payload that is not JSON, and saying so is better
  // than silently ending a stream the caller did not know could end that way.
  await assert.rejects(readAll(streamOf(['data: [DONE]\n\n'])), /Invalid JSON/);
  // With permission it ends the stream, and what follows it is not parsed: a provider that keeps talking after
  // its own terminator must not have those frames delivered.
  assert.deepEqual(
    await readAll(streamOf(['data: {"a":1}\n\n', 'data: [DONE]\n\n', 'data: {"b":2}\n\n']), {
      allowDone: true,
    }),
    [{ a: 1 }, { type: 'stream.done' }],
  );
});

test('a half frame at the end of the body is an error, not a truncation', async () => {
  // The connection closed mid-frame. Dropping it silently would hand the caller a stream that looks complete.
  await assert.rejects(
    readAll(streamOf(['data: {"a":1}\n\n', 'data: {"b":'])),
    /Incomplete model stream frame/,
  );
  // A trailing blank line is not a half frame.
  assert.deepEqual(await readAll(streamOf(['data: {"a":1}\n\n'])), [{ a: 1 }]);
});

test('a named failure keeps its name, and a cancel is reported as the cancel', async () => {
  // The retry policy decides from the code, so a failure that already has one must not be re-wrapped as an
  // anonymous transport error.
  const named = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.error(new RunFailure('timeout', 'idle'));
    },
  });
  await assert.rejects(readAll(named), (error: unknown) => {
    assert.equal((error as RunFailure).code, 'timeout');
    return true;
  });
  // Aborting the request errors the body, so a Stop arrives through the same path: it must surface as the
  // caller's own reason rather than as weather worth re-sending.
  const controller = new AbortController();
  const cancelled = new ReadableStream<Uint8Array>({
    pull(inner) {
      controller.abort(new Error('the user stopped this run'));
      inner.error(new Error('socket closed'));
    },
  });
  await assert.rejects(
    readAll(cancelled, { signal: controller.signal }),
    /the user stopped this run/,
  );
  // Everything else that arrives from the body is the connection, and it is named as such.
  const broken = new ReadableStream<Uint8Array>({
    pull(inner) {
      inner.error(new Error('socket closed'));
    },
  });
  await assert.rejects(readAll(broken), (error: unknown) => {
    assert.equal((error as RunFailure).code, 'transport');
    return true;
  });
});

test('a frame boundary split across chunks is still a boundary', async () => {
  // The `\r\n\r\n` arrives in three pieces. A reader that only searched the newly appended text would miss the
  // boundary and glue two frames together, and the glued payload is not JSON.
  assert.deepEqual(
    await readAll(streamOf(['data: {"a":1}\r', '\n\r', '\ndata: {"b":2}\r\n\r\n'])),
    [{ a: 1 }, { b: 2 }],
  );
});

test('an unfinished frame is bounded, and a character split across chunks survives', async () => {
  // One frame with no boundary and no end: the bound is what stops a runaway tool from filling memory.
  await assert.rejects(
    readAll(streamOf([`data: ${'x'.repeat(17_000_000)}`])),
    /exceeds 16MB limit/,
  );
  // The three bytes of a CJK character arrive in two chunks. Decoding each chunk on its own would put a
  // replacement character in the payload — and in an answer a person then reads.
  const bytes = new TextEncoder().encode('data: {"a":"中"}\n\n');
  const cut = bytes.indexOf(0xe4);
  assert.ok(cut > 0);
  assert.deepEqual(await readAll(streamOf([bytes.slice(0, cut + 1), bytes.slice(cut + 1)])), [
    { a: '中' },
  ]);
});
