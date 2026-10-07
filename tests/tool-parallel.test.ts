/**
 * Parallel tool calls inside a real run.
 *
 * The scheduler's own rules are unit-tested in `tool-schedule.test.ts`; what these tests pin is the part that
 * only a real run can show: that the dispatch really overlaps, that an exclusive call still fences the reads
 * around it, that the *record* stays in the model's order however the reads finished, and that turning the
 * limit down to one restores the serial behaviour the loop had before this existed.
 *
 * The tools here are registered extensions rather than real files, because the property under test is the
 * scheduling and not the reading: a tool that sleeps is the only way to observe overlap from outside.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Agent } from '../packages/core/agent.ts';
import { SessionStore } from '../packages/storage/sqlite.ts';
import { createTools } from '../packages/tools/index.ts';
import { PIPELINE_STAGES } from '../packages/tools/pipeline.ts';
import type {
  AgentEvent,
  ModelResponse,
  Provider,
  Tool,
  ToolCall,
  ToolContext,
  ToolResult,
} from '../packages/protocol/index.ts';

const reply = (text = 'Finished'): ModelResponse => ({
  text,
  toolCalls: [],
  finishReason: 'stop',
  usage: { inputTokens: 10, outputTokens: 5 },
});
const calls = (...names: [string, string, number][]): ModelResponse => ({
  text: '',
  finishReason: 'tool_calls',
  toolCalls: names.map(([id, name, ms]) => ({ id, name, arguments: { ms } })),
  usage: { inputTokens: 10, outputTokens: 5 },
});
/**
 * A tool that takes a known amount of time and records when it ran, so overlap is observable without
 * guessing from wall-clock totals alone.
 */
interface Timeline {
  events: string[];
  inFlight: number;
  peak: number;
}
function timedTool(name: string, timeline: Timeline, options: { permission?: 'write' } = {}): Tool {
  return {
    name,
    ...(options.permission ? { permission: options.permission } : {}),
    ...(name.startsWith('read') ? { isConcurrencySafe: () => true } : {}),
    description: `Test tool ${name}`,
    inputSchema: {
      type: 'object',
      properties: { ms: { type: 'integer', minimum: 0 } },
      required: ['ms'],
      additionalProperties: false,
    },
    execute: async (args: { ms: number }, context: ToolContext): Promise<ToolResult> => {
      const callId = String(context.callId);
      timeline.events.push(`start ${callId}`);
      timeline.inFlight++;
      timeline.peak = Math.max(timeline.peak, timeline.inFlight);
      try {
        // A real tool stops on abort rather than holding the group open; that is what makes cancellation a
        // matter of seconds instead of the tool's own timeout.
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, args.ms);
          context.signal.addEventListener(
            'abort',
            () => {
              clearTimeout(timer);
              reject(context.signal.reason ?? new Error('aborted'));
            },
            { once: true },
          );
        });
      } finally {
        timeline.inFlight--;
      }
      timeline.events.push(`end ${callId}`);
      return { isError: false, content: `${callId} slept ${args.ms}ms` };
    },
  };
}
async function fixture(
  t: test.TestContext,
  provider: Provider,
  options: { maxParallelToolCalls?: number } = {},
) {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-parallel-'));
  const store = new SessionStore(path.join(root, 'sessions.sqlite'));
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const session = store.create(root);
  const events: AgentEvent[] = [];
  const timeline: Timeline = { events: [], inFlight: 0, peak: 0 };
  const tools = createTools(root);
  tools.register(timedTool('read_one', timeline));
  tools.register(timedTool('read_two', timeline));
  tools.register(timedTool('read_three', timeline));
  tools.register(timedTool('write_one', timeline, { permission: 'write' }));
  const agent = new Agent({
    store,
    provider,
    tools,
    approve: async () => true,
    onEvent: (event) => events.push(event),
    ...options,
  });
  return { root, store, session, agent, events, timeline, tools };
}
const toolMessages = (store: SessionStore, sessionId: string): string[] =>
  store
    .messages(sessionId)
    .filter((message) => message.role === 'tool')
    .map((message) => String(message.content));

test('independent reads overlap, and their results come back in the order the model wrote them', async (t) => {
  let round = 0;
  const provider: Provider = {
    async complete() {
      round++;
      // The first call is the slowest, so model order and completion order are deliberately different.
      if (round === 1)
        return calls(
          ['slow', 'read_one', 120],
          ['quick-a', 'read_two', 10],
          ['quick-b', 'read_three', 10],
        );
      return reply();
    },
  };
  const { store, session, agent, timeline } = await fixture(t, provider);
  const begun = Date.now();
  const result = await agent.run({ sessionId: session.id, prompt: 'Read three things' });
  const elapsed = Date.now() - begun;
  assert.equal(result.status, 'completed');
  assert.equal(timeline.peak, 3, 'all three reads were in flight together');
  assert.ok(elapsed < 240, `overlapped rather than serialized: ${elapsed}ms`);
  // Output first, in write order, because the tools are known by name `read_*`; ids are the model's.
  assert.deepEqual(toolMessages(store, session.id), [
    'slow slept 120ms',
    'quick-a slept 10ms',
    'quick-b slept 10ms',
  ]);
});

test('an exclusive call fences the reads around it', async (t) => {
  let round = 0;
  const provider: Provider = {
    async complete() {
      round++;
      if (round === 1)
        return calls(
          ['a', 'read_one', 40],
          ['b', 'read_two', 40],
          ['w', 'write_one', 40],
          ['c', 'read_three', 40],
        );
      return reply();
    },
  };
  const { agent, session, timeline } = await fixture(t, provider);
  assert.equal(
    (await agent.run({ sessionId: session.id, prompt: 'Read, write, read' })).status,
    'completed',
  );
  // Two groups: the reads overlap, the write waits for both, and the read after it waits for the write.
  assert.deepEqual(timeline.events, [
    'start a',
    'start b',
    'end a',
    'end b',
    'start w',
    'end w',
    'start c',
    'end c',
  ]);
});

test('a limit of one keeps every call serial, whatever the tools declare', async (t) => {
  let round = 0;
  const provider: Provider = {
    async complete() {
      round++;
      if (round === 1)
        return calls(['a', 'read_one', 20], ['b', 'read_two', 20], ['c', 'read_three', 20]);
      return reply();
    },
  };
  const { agent, session, timeline } = await fixture(t, provider, { maxParallelToolCalls: 1 });
  assert.equal(
    (await agent.run({ sessionId: session.id, prompt: 'Read three things' })).status,
    'completed',
  );
  assert.equal(timeline.peak, 1);
  assert.deepEqual(timeline.events, ['start a', 'end a', 'start b', 'end b', 'start c', 'end c']);
});

test('a limit of two bounds a group of four', async (t) => {
  let round = 0;
  const provider: Provider = {
    async complete() {
      round++;
      if (round === 1)
        return calls(
          ['a', 'read_one', 30],
          ['b', 'read_two', 30],
          ['c', 'read_three', 30],
          ['d', 'read_one', 30],
        );
      return reply();
    },
  };
  const { session, agent, timeline } = await fixture(t, provider, { maxParallelToolCalls: 2 });
  const begun = Date.now();
  const result = await agent.run({ sessionId: session.id, prompt: 'Read four things' });
  assert.ok(Date.now() - begun < 200, 'two waves of 30ms, not four serial calls');
  assert.equal(result.status, 'completed');
  assert.equal(timeline.peak, 2, 'the cap held');
  /**
   * Rolling, not fixed windows: the third call starts the moment *one* slot frees, so exactly one call has
   * ended by then — and the fourth waits for the second slot.
   */
  const thirdStart = timeline.events.indexOf('start c');
  const fourthStart = timeline.events.indexOf('start d');
  assert.equal(
    timeline.events.slice(0, thirdStart).filter((event) => event.startsWith('end')).length,
    1,
    'a free slot is used immediately',
  );
  assert.equal(
    timeline.events.slice(0, fourthStart).filter((event) => event.startsWith('end')).length,
    2,
    'and the next start again waits for a slot',
  );
  assert.equal(timeline.events.length, 8);
});

test('every call still walks the whole pipeline, and every stage trace is complete', async (t) => {
  let round = 0;
  const provider: Provider = {
    async complete() {
      round++;
      if (round === 1) return calls(['a', 'read_one', 15], ['b', 'read_two', 15]);
      return reply();
    },
  };
  const { agent, session, events, tools } = await fixture(t, provider);
  assert.equal(
    (await agent.run({ sessionId: session.id, prompt: 'Read two things' })).status,
    'completed',
  );
  const history = tools.pipelineInvariant.history;
  assert.equal(history.length, 2, 'one trace per dispatched call');
  for (const trace of history)
    assert.deepEqual(
      trace.stages,
      // The `approval` stage is absent rather than skipped: a tool that declares no permission has nothing to
      // ask about, and that is true whether or not it overlaps a sibling.
      PIPELINE_STAGES.filter((stage) => stage !== 'approval'),
      'overlapping two calls did not let either one skip or reorder a stage',
    );
  // The live events keep the model's order too: started in write order, finished in write order.
  const startedIds = events
    .filter((event) => event.type === 'tool.started')
    .map((event) => String((event.data.call as ToolCall).id));
  const finishedIds = events
    .filter((event) => event.type === 'tool.finished')
    .map((event) => event.data.callId);
  assert.deepEqual(startedIds, ['a', 'b']);
  assert.deepEqual(finishedIds, ['a', 'b']);
});

test('a tool that declares nothing never overlaps its own siblings', async (t) => {
  let round = 0;
  const provider: Provider = {
    async complete() {
      round++;
      if (round === 1) return calls(['a', 'write_one', 20], ['b', 'write_one', 20]);
      return reply();
    },
  };
  const { agent, session, timeline } = await fixture(t, provider);
  assert.equal(
    (await agent.run({ sessionId: session.id, prompt: 'Write twice' })).status,
    'completed',
  );
  assert.equal(timeline.peak, 1);
  assert.deepEqual(timeline.events, ['start a', 'end a', 'start b', 'end b']);
});

test('a cancelled run still records the sibling that had already finished', async (t) => {
  let round = 0;
  const provider: Provider = {
    async complete() {
      round++;
      if (round === 1) return calls(['quick', 'read_one', 5], ['stuck', 'read_two', 5_000]);
      return reply();
    },
  };
  const { store, session, agent } = await fixture(t, provider);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 120);
  const result = await agent.run({
    sessionId: session.id,
    prompt: 'One quick, one stuck',
    signal: controller.signal,
  });
  assert.equal(result.status, 'cancelled');
  // The quick call's result is real and is written before the run ends. The stuck call produced no result at
  // all, so the run's teardown answers it with uncertainty — which is the point: an outcome nobody observed
  // must never be reported as one that did not happen.
  assert.deepEqual(toolMessages(store, session.id), [
    'quick slept 5ms',
    'Run cancelled. A tool may already have had effects; inspect state before retrying.',
  ]);
  const pending = store
    .messages(session.id)
    .filter((message) => message.role === 'tool' && message.isError)
    .map((message) => (message as { toolCallId: string }).toolCallId);
  assert.deepEqual(pending, ['stuck']);
});
