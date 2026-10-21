/**
 * Early tool starts: a read the model has finished writing begins while the rest of its turn is still streaming.
 *
 * Two halves. The adapters must report a call exactly when it is complete, in order, and never one the turn does
 * not end up containing in that form. The run must start only what is safe to start early, adopt only what the
 * final turn confirms, and leave no trace of a start it discards — no tool message, no execution record, no
 * bookkeeping a later call could notice.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Agent } from '../packages/core/agent.ts';
import { SessionStore } from '../packages/storage/sqlite.ts';
import { createTools } from '../packages/catalog/index.ts';
import { fileTools } from '../packages/tools/files.ts';
import { RunFailure } from '../packages/protocol/failure.ts';
import { AnthropicProvider } from '../packages/providers/anthropic.ts';
import { OpenAIProvider } from '../packages/providers/openai.ts';
import { ResponsesProvider } from '../packages/providers/responses.ts';
import type {
  ModelRequest,
  ModelResponse,
  Provider,
  Tool,
  ToolCall,
  ToolContext,
  ToolResult,
} from '../packages/protocol/index.ts';
import { frames, httpFixture, sendFrames } from './http-fixture.ts';
import { storeFixture } from './temp-fixture.ts';

// ---- adapters ----

function request(onToolCall: (call: ToolCall) => void): ModelRequest {
  return {
    system: 'You are YuanTu',
    messages: [{ role: 'user', content: 'Hi' }],
    tools: [],
    maxOutputTokens: 100,
    signal: new AbortController().signal,
    onText: () => {},
    onToolCall,
  };
}

test('Messages reports each tool_use block when it closes, in order', async (t) => {
  const url = await httpFixture(t, (_body, res) =>
    sendFrames(
      res,
      frames('Looking', [
        { id: 'call-1', name: 'read_file', input: { path: 'a.ts' } },
        { id: 'call-2', name: 'search_files', input: { pattern: 'x' } },
      ]),
    ),
  );
  const provider = new AnthropicProvider({ apiKey: 'test', model: 'fixture-model', baseUrl: url });
  const reported: ToolCall[] = [];
  const result = await provider.complete(request((call) => reported.push(call)));
  assert.deepEqual(reported, result.toolCalls, 'every final call was reported, in the same form');
  assert.equal(reported.length, 2);
});

test('Chat Completions reports a call once the next one starts, never the last one early', async (t) => {
  const chunk = (delta: Record<string, unknown>, finish: string | null = null) => ({
    choices: [{ index: 0, delta, finish_reason: finish }],
  });
  const reported: ToolCall[] = [];
  const url = await httpFixture(t, (_body, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const value of [
      chunk({
        tool_calls: [
          {
            index: 0,
            id: 'c1',
            type: 'function',
            function: { name: 'read_file', arguments: '{"pa' },
          },
        ],
      }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: 'th":"a.txt"}' } }] }),
      chunk({
        tool_calls: [
          { index: 1, id: 'c2', type: 'function', function: { name: 'read_file', arguments: '' } },
        ],
      }),
      chunk(
        { tool_calls: [{ index: 1, function: { arguments: '{"path":"b.txt"}' } }] },
        'tool_calls',
      ),
      { choices: [], usage: { prompt_tokens: 12, completion_tokens: 7 } },
    ])
      res.write(`data: ${JSON.stringify(value)}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  const provider = new OpenAIProvider({ apiKey: 'test', model: 'test', baseUrl: url });
  const result = await provider.complete(request((call) => reported.push(call)));
  assert.deepEqual(reported, [{ id: 'c1', name: 'read_file', arguments: { path: 'a.txt' } }]);
  assert.equal(result.toolCalls.length, 2, 'the last call is only known complete at the end');
  assert.deepEqual(result.toolCalls[0], reported[0]);
});

test('Chat Completions reports only whole calls, in order, when a server interleaves fragments', async (t) => {
  const chunk = (delta: Record<string, unknown>, finish: string | null = null) => ({
    choices: [{ index: 0, delta, finish_reason: finish }],
  });
  const reported: ToolCall[] = [];
  const url = await httpFixture(t, (_body, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const value of [
      // Index 0 is not valid JSON until the last chunk, so neither it nor anything after it is reported before
      // then: what is reported is always a prefix of whole calls.
      chunk({
        tool_calls: [
          {
            index: 0,
            id: 'c1',
            type: 'function',
            function: { name: 'read_file', arguments: '{"pa' },
          },
        ],
      }),
      chunk({
        tool_calls: [
          {
            index: 1,
            id: 'c2',
            type: 'function',
            function: { name: 'read_file', arguments: '{}' },
          },
        ],
      }),
      chunk({
        tool_calls: [
          {
            index: 2,
            id: 'c3',
            type: 'function',
            function: { name: 'read_file', arguments: '{}' },
          },
        ],
      }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: 'th":"a"}' } }] }, 'tool_calls'),
      { choices: [], usage: { prompt_tokens: 12, completion_tokens: 7 } },
    ])
      res.write(`data: ${JSON.stringify(value)}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  const provider = new OpenAIProvider({ apiKey: 'test', model: 'test', baseUrl: url });
  const result = await provider.complete(request((call) => reported.push(call)));
  assert.deepEqual(
    reported,
    result.toolCalls.slice(0, 2),
    'the two calls before the latest index, each exactly as the turn ends with it',
  );
});

test('Responses reports a function_call item when it is done', async (t) => {
  const call = {
    type: 'function_call',
    id: 'fc',
    call_id: 'call',
    name: 'read_file',
    arguments: '{"path":"a.ts"}',
    status: 'completed',
  };
  const url = await httpFixture(t, (_body, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(
      [
        { type: 'response.output_item.done', output_index: 0, item: call },
        {
          type: 'response.completed',
          response: {
            status: 'completed',
            output: [call],
            usage: { input_tokens: 10, output_tokens: 5 },
          },
        },
      ]
        .map((event) => 'data: ' + JSON.stringify(event) + '\n\n')
        .join(''),
    );
  });
  const provider = new ResponsesProvider({ apiKey: 'test', model: 'test', baseUrl: url });
  const reported: ToolCall[] = [];
  const result = await provider.complete(request((call) => reported.push(call)));
  assert.deepEqual(reported, result.toolCalls);
  assert.deepEqual(reported, [{ id: 'call', name: 'read_file', arguments: { path: 'a.ts' } }]);
});

// ---- the run ----

interface Timeline {
  starts: string[];
  aborted: string[];
}
/** A read that waits for its gate (or `ms`), and records when it began and whether it was stopped. */
function readTool(
  name: string,
  timeline: Timeline,
  options: { early?: boolean; permission?: 'write'; gate?: (callId: string) => Promise<void> } = {},
): Tool {
  return {
    name,
    ...(options.permission
      ? { permission: options.permission }
      : { isConcurrencySafe: () => true }),
    ...(options.early === false || options.permission ? {} : { earlyStart: true as const }),
    description: `Test tool ${name}`,
    inputSchema: {
      type: 'object',
      properties: { ms: { type: 'integer', minimum: 0 } },
      required: ['ms'],
      additionalProperties: false,
    },
    execute: async (args: { ms: number }, context: ToolContext): Promise<ToolResult> => {
      const callId = String(context.callId);
      timeline.starts.push(callId);
      const aborted = new Promise<never>((_, reject) => {
        const stop = () => {
          timeline.aborted.push(callId);
          reject(context.signal.reason ?? new Error('aborted'));
        };
        if (context.signal.aborted) stop();
        else context.signal.addEventListener('abort', stop, { once: true });
      });
      aborted.catch(() => {});
      const work = options.gate
        ? options.gate(callId)
        : new Promise<void>((resolve) => setTimeout(resolve, args.ms));
      await Promise.race([work, aborted]);
      return { isError: false, content: `${callId} slept ${args.ms}ms` };
    },
  };
}
const turn = (...list: ToolCall[]): ModelResponse => ({
  text: '',
  toolCalls: list,
  finishReason: 'tool_calls',
  usage: { inputTokens: 10, outputTokens: 5 },
});
const reply = (): ModelResponse => ({
  text: 'Finished',
  toolCalls: [],
  finishReason: 'stop',
  usage: { inputTokens: 10, outputTokens: 5 },
});
const call = (id: string, name: string, ms = 0): ToolCall => ({ id, name, arguments: { ms } });
const tick = (ms = 0) => new Promise<void>((resolve) => setTimeout(resolve, ms));
/** Resolves once `predicate` holds, or after `ms` — whichever is first; returns whether it held. */
async function within(ms: number, predicate: () => boolean): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await tick(5);
  }
  return predicate();
}
async function fixture(
  t: test.TestContext,
  provider: Provider,
  options: { earlyToolStarts?: boolean; gate?: (callId: string) => Promise<void> } = {},
) {
  const { root, store, session } = await storeFixture(t, 'yuantu-early-');
  const timeline: Timeline = { starts: [], aborted: [] };
  const tools = createTools(root);
  const gate = options.gate ? { gate: options.gate } : {};
  tools.register(readTool('read_one', timeline, gate));
  tools.register(readTool('read_two', timeline, gate));
  tools.register(readTool('read_plain', timeline, { early: false, ...gate }));
  tools.register(readTool('write_one', timeline, { permission: 'write' }));
  const agent = new Agent({
    store,
    provider,
    tools,
    approve: async () => true,
    earlyToolStarts: options.earlyToolStarts ?? true,
  });
  return { store, session, agent, timeline };
}
const toolMessages = (store: SessionStore, sessionId: string) =>
  store
    .messages(sessionId)
    .filter((message) => message.role === 'tool')
    .map((message) => ({ id: message.toolCallId, content: String(message.content) }));
const executionRecords = (store: SessionStore, sessionId: string, callId: string) =>
  store
    .events(sessionId)
    .filter(
      (event) =>
        (event.type === 'tool.execution.started' || event.type === 'tool.execution.finished') &&
        event.data.callId === callId,
    ).length;

for (const enabled of [true, false])
  test(`a complete read starts before the turn ends only when enabled (${enabled ? 'on' : 'off'})`, async (t) => {
    let round = 0;
    let startedDuringStream = false;
    let timeline!: Timeline;
    const provider: Provider = {
      async complete(request) {
        if (++round > 1) return reply();
        const first = call('c1', 'read_one');
        request.onToolCall?.(first);
        // The rest of the turn is still "streaming": the read either starts now or not at all until it ends.
        startedDuringStream = await within(enabled ? 2000 : 150, () =>
          timeline.starts.includes('c1'),
        );
        return turn(first);
      },
    };
    const fx = await fixture(t, provider, { earlyToolStarts: enabled });
    timeline = fx.timeline;
    const result = await fx.agent.run({ sessionId: fx.session.id, prompt: 'Read' });
    assert.equal(result.status, 'completed');
    assert.equal(startedDuringStream, enabled);
    assert.deepEqual(fx.timeline.starts, ['c1'], 'the call ran exactly once');
    assert.deepEqual(toolMessages(fx.store, fx.session.id), [
      { id: 'c1', content: 'c1 slept 0ms' },
    ]);
    assert.equal(
      executionRecords(fx.store, fx.session.id, 'c1'),
      2,
      'one started and one finished record',
    );
  });

test('adopted early results keep model order beside calls the batch started', async (t) => {
  let round = 0;
  const releases = new Map<string, () => void>();
  const gate = (id: string) => new Promise<void>((resolve) => releases.set(id, resolve));
  let timeline!: Timeline;
  const provider: Provider = {
    async complete(request) {
      if (++round > 1) return reply();
      request.onToolCall?.(call('a', 'read_one'));
      await within(2000, () => timeline.starts.includes('a'));
      // `b` is never reported early (as the last call of a Chat Completions turn would not be).
      return turn(call('a', 'read_one'), call('b', 'read_two'));
    },
  };
  const fx = await fixture(t, provider, { gate });
  timeline = fx.timeline;
  const running = fx.agent.run({ sessionId: fx.session.id, prompt: 'Read two' });
  assert(await within(2000, () => releases.has('b')), 'the batch started the second read');
  releases.get('b')!();
  await tick(20);
  releases.get('a')!();
  assert.equal((await running).status, 'completed');
  assert.deepEqual(
    toolMessages(fx.store, fx.session.id).map((message) => message.id),
    ['a', 'b'],
    'the early call is recorded first because the model wrote it first, not because it started first',
  );
});

test('nothing after a call that may not start early starts early', async (t) => {
  for (const blocker of ['write_one', 'read_plain']) {
    let round = 0;
    let earlyStarts: string[] = [];
    let timeline!: Timeline;
    const provider: Provider = {
      async complete(request) {
        if (++round > 1) return reply();
        const calls = [call('r1', 'read_one'), call('x', blocker), call('r2', 'read_two')];
        for (const each of calls) request.onToolCall?.(each);
        await within(2000, () => timeline.starts.includes('r1'));
        await tick(50);
        earlyStarts = [...timeline.starts];
        return turn(...calls);
      },
    };
    const fx = await fixture(t, provider);
    timeline = fx.timeline;
    assert.equal(
      (await fx.agent.run({ sessionId: fx.session.id, prompt: 'Mixed' })).status,
      'completed',
    );
    assert.deepEqual(
      earlyStarts,
      ['r1'],
      `${blocker} ends early starting for the rest of the turn`,
    );
    assert.deepEqual(
      toolMessages(fx.store, fx.session.id).map((message) => message.id),
      ['r1', 'x', 'r2'],
    );
  }
});

test('a start the final turn does not confirm is discarded without a trace', async (t) => {
  let round = 0;
  let timeline!: Timeline;
  const provider: Provider = {
    async complete(request) {
      if (++round > 1) return reply();
      request.onToolCall?.(call('c1', 'read_one', 5000));
      await within(2000, () => timeline.starts.includes('c1'));
      // Same id, different arguments: the stream's early report is not what the turn ended up asking for.
      return turn(call('c1', 'read_one', 1));
    },
  };
  const fx = await fixture(t, provider);
  timeline = fx.timeline;
  assert.equal(
    (await fx.agent.run({ sessionId: fx.session.id, prompt: 'Read' })).status,
    'completed',
  );
  assert.deepEqual(fx.timeline.starts, ['c1', 'c1'], 'the discarded start, then the real one');
  assert.deepEqual(fx.timeline.aborted, ['c1'], 'the discarded start was stopped');
  assert.deepEqual(toolMessages(fx.store, fx.session.id), [{ id: 'c1', content: 'c1 slept 1ms' }]);
  assert.equal(
    executionRecords(fx.store, fx.session.id, 'c1'),
    2,
    'only the adopted execution is in the log',
  );
});

test('a truncated turn discards what it started early', async (t) => {
  let timeline!: Timeline;
  const provider: Provider = {
    async complete(request) {
      request.onToolCall?.(call('c1', 'read_one'));
      await within(2000, () => timeline.starts.includes('c1'));
      return {
        text: '',
        toolCalls: [],
        finishReason: 'length',
        usage: { inputTokens: 10, outputTokens: 100 },
      };
    },
  };
  const fx = await fixture(t, provider, { gate: () => new Promise<void>(() => {}) });
  timeline = fx.timeline;
  const result = await fx.agent.run({ sessionId: fx.session.id, prompt: 'Read' });
  assert.notEqual(result.status, 'completed');
  assert.deepEqual(fx.timeline.aborted, ['c1'], 'the early read was stopped, not left running');
  assert.deepEqual(toolMessages(fx.store, fx.session.id), []);
  assert.equal(executionRecords(fx.store, fx.session.id, 'c1'), 0);
});

test('a re-sent attempt discards what the abandoned attempt started', async (t) => {
  let attempt = 0;
  let timeline!: Timeline;
  const provider: Provider = {
    async complete(request) {
      attempt++;
      if (attempt === 1) {
        request.onToolCall?.(call('lost', 'read_one'));
        await within(2000, () => timeline.starts.includes('lost'));
        throw new RunFailure('transport', 'Model stream interrupted');
      }
      return reply();
    },
  };
  const fx = await fixture(t, provider, { gate: () => new Promise<void>(() => {}) });
  timeline = fx.timeline;
  const result = await fx.agent.run({ sessionId: fx.session.id, prompt: 'Read' });
  assert.equal(result.status, 'completed');
  assert.equal(attempt, 2, 'the round was re-sent');
  assert.deepEqual(fx.timeline.aborted, ['lost']);
  assert.deepEqual(toolMessages(fx.store, fx.session.id), []);
  assert.equal(executionRecords(fx.store, fx.session.id, 'lost'), 0);
});

test('a steer reports an early call that already ran, and retires only the rest', async (t) => {
  let round = 0;
  let fx!: Awaited<ReturnType<typeof fixture>>;
  const releases = new Map<string, () => void>();
  const gate = (id: string) => new Promise<void>((resolve) => releases.set(id, resolve));
  const provider: Provider = {
    async complete(request) {
      if (++round > 1) return reply();
      request.onToolCall?.(call('a', 'read_one'));
      await within(2000, () => releases.has('a'));
      fx.agent.enqueue(fx.session.id, { prompt: 'Stop and explain instead.' }, 'steer');
      releases.get('a')!();
      return turn(call('a', 'read_one'), call('b', 'read_two'));
    },
  };
  fx = await fixture(t, provider, { gate });
  assert.equal(
    (await fx.agent.run({ sessionId: fx.session.id, prompt: 'Read' })).status,
    'completed',
  );
  assert.deepEqual(fx.timeline.starts, ['a'], 'the pending call never started');
  assert.deepEqual(toolMessages(fx.store, fx.session.id), [
    { id: 'a', content: 'a slept 0ms' },
    { id: 'b', content: 'Not executed: a new user instruction superseded this pending tool call.' },
  ]);
});

// ---- deferred bookkeeping ----

test('read_file defers "instructions shown" until its result is delivered', async (t) => {
  const { root } = await storeFixture(t, 'yuantu-early-files-');
  await mkdir(path.join(root, 'pkg'), { recursive: true });
  await writeFile(path.join(root, 'pkg', 'AGENTS.md'), 'Scoped rule: use tabs.');
  await writeFile(path.join(root, 'pkg', 'a.ts'), 'export {};\n');
  const readFile = fileTools(root).find((tool) => tool.name === 'read_file')!;
  assert.equal(readFile.earlyStart, true);
  const context = (deferEffect?: (effect: () => void) => void): ToolContext => ({
    signal: new AbortController().signal,
    approve: async () => true,
    ...(deferEffect ? { deferEffect } : {}),
  });
  const read = async (ctx: ToolContext) =>
    (await readFile.execute({ path: 'pkg/a.ts' }, ctx)).content;
  // A start that is discarded: its effects are collected and never applied.
  assert.match(await read(context(() => {})), /Scoped rule/);
  assert.match(
    await read(context()),
    /Scoped rule/,
    'a discarded read did not use up the instructions',
  );
  assert.doesNotMatch(await read(context()), /Scoped rule/, 'a delivered read did');
});
