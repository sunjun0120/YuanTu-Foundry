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
import { Agent } from '../packages/core/agent.ts';
import { SessionStore } from '../packages/storage/sqlite.ts';
import { createTools } from '../packages/catalog/index.ts';
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
import { storeFixture } from './temp-fixture.ts';

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
function timedTool(
  name: string,
  timeline: Timeline,
  options: { permission?: 'write'; gate?: (callId: string) => Promise<void> } = {},
): Tool {
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
        if (options.gate) await options.gate(callId);
        else
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
  options: { maxParallelToolCalls?: number; onEvent?: (event: AgentEvent) => void } = {},
) {
  const { root, store, session } = await storeFixture(t, 'yuantu-parallel-');
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
    ...options,
    onEvent: (event) => {
      events.push(event);
      options.onEvent?.(event);
    },
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
  const { store, session, agent, timeline, tools } = await fixture(t, provider);
  const releases = new Map<string, () => void>();
  const waits = new Map(
    ['slow', 'quick-a', 'quick-b'].map((id) => [
      id,
      new Promise<void>((resolve) => releases.set(id, resolve)),
    ]),
  );
  let started = 0;
  let allStarted!: () => void;
  let rejectStarted!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    allStarted = resolve;
    rejectStarted = reject;
  });
  for (const name of ['read_one', 'read_two', 'read_three'])
    tools.replace(
      timedTool(name, timeline, {
        gate: async (id) => {
          if (++started === 3) allStarted();
          await waits.get(id);
        },
      }),
    );
  const running = agent.run({ sessionId: session.id, prompt: 'Read three things' });
  const guard = setTimeout(
    () => rejectStarted(new Error('reads did not start concurrently')),
    5000,
  );
  try {
    await ready;
    assert.equal(timeline.peak, 3, 'all three reads started before any result was released');
    releases.get('quick-a')!();
    releases.get('quick-b')!();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert(timeline.events.includes('end quick-a') && timeline.events.includes('end quick-b'));
    assert(
      !timeline.events.includes('end slow'),
      'completion order deliberately differs from model order',
    );
  } finally {
    clearTimeout(guard);
    for (const release of releases.values()) release();
    await running;
  }
  const result = await running;
  assert.equal(result.status, 'completed');
  assert.equal(timeline.peak, 3, 'all three reads were in flight together');
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
  const { session, agent, timeline, tools } = await fixture(t, provider, {
    maxParallelToolCalls: 2,
  });
  const releases = new Map<string, () => void>();
  const announce = new Map<string, () => void>();
  const waits = new Map(
    ['a', 'b', 'c', 'd'].map((id) => [
      id,
      new Promise<void>((resolve) => releases.set(id, resolve)),
    ]),
  );
  const started = new Map(
    ['a', 'b', 'c', 'd'].map((id) => [
      id,
      new Promise<void>((resolve) => announce.set(id, resolve)),
    ]),
  );
  for (const name of ['read_one', 'read_two', 'read_three'])
    tools.replace(
      timedTool(name, timeline, {
        gate: async (id) => {
          announce.get(id)!();
          await waits.get(id);
        },
      }),
    );
  let guard: ReturnType<typeof setTimeout> | undefined;
  const stalled = new Promise<never>((_, reject) => {
    guard = setTimeout(() => reject(new Error('the next tool slot never started')), 5_000);
  });
  const running = agent.run({ sessionId: session.id, prompt: 'Read four things' });
  void running.catch(() => {});
  try {
    await Promise.race([Promise.all([started.get('a'), started.get('b')]), stalled]);
    assert.deepEqual(timeline.events, ['start a', 'start b'], 'later calls wait for a slot');
    releases.get('a')!();
    await Promise.race([started.get('c'), stalled]);
    assert.equal(timeline.inFlight, 2, 'the third call overlaps the still-blocked second');
    releases.get('b')!();
    await Promise.race([started.get('d'), stalled]);
    assert.equal(timeline.inFlight, 2, 'the fourth call fills only the newly freed slot');
    releases.get('c')!();
    releases.get('d')!();
    const result = await running;
    assert.equal(result.status, 'completed', result.error);
    assert.equal(timeline.peak, 2, 'the cap held');
    assert.equal(timeline.inFlight, 0, 'all tool calls joined cleanup');
  } finally {
    clearTimeout(guard);
    for (const release of releases.values()) release();
    await running.catch(() => {});
  }
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

test('overlapping calls contribute the wall clock union of their spans', async (t) => {
  /**
   * A guard, not the failure: it passed before the fix too, and that is a property of the emit order rather than a
   * sign the accounting was right.
   *
   * The statistic answers "how long did this run wait on tools", so two calls that overlap cost the *union* of
   * their spans: 30 ms and 60 ms at the same time is 60 ms of waiting, not 90. Until the accounting tracked calls
   * by identity it was a single scalar — the time the last `tool.started` arrived — which is exactly why this run
   * cannot show the defect: the loop announces the whole group's starts up front and emits every finish of the
   * group together once the group resolves, so the first finish *is* the last one here and the scalar happened to
   * land on the union. What this test still holds is that the union is what a run reports: not the sum of two
   * spans, and not the short call's span with the long one dropped.
   */
  let round = 0;
  const provider: Provider = {
    async complete() {
      round++;
      if (round === 1) return calls(['short', 'read_one', 30], ['long', 'read_two', 60]);
      return reply();
    },
  };
  const { agent, session, timeline } = await fixture(t, provider);
  const result = await agent.run({ sessionId: session.id, prompt: 'Read two things at once' });
  assert.equal(result.status, 'completed', result.error);
  assert.equal(timeline.peak, 2, 'the fixture has to overlap for this to say anything');
  assert.ok(
    result.statistics!.toolMs >= 55,
    `the union of a 30 ms and a 60 ms call is about 60 ms, saw ${result.statistics!.toolMs}`,
  );
  assert.ok(
    result.statistics!.toolMs < 150,
    `and it is not the sum of the two spans, saw ${result.statistics!.toolMs}`,
  );
});

test('calls that do not overlap still add up, one span each', async (t) => {
  // The other half of the union, and a guard besides: two 30 ms calls that never run at the same time are 60 ms of
  // waiting, and the fix must not turn the overlap rule into "the longest call wins".
  let round = 0;
  const provider: Provider = {
    async complete() {
      round++;
      if (round === 1) return calls(['a', 'read_one', 30], ['b', 'read_two', 30]);
      return reply();
    },
  };
  const { agent, session, timeline } = await fixture(t, provider, { maxParallelToolCalls: 1 });
  const result = await agent.run({ sessionId: session.id, prompt: 'Read one after the other' });
  assert.equal(result.status, 'completed', result.error);
  assert.equal(timeline.peak, 1, 'the cap serialized them');
  assert.ok(
    result.statistics!.toolMs >= 55,
    `two 30 ms spans back to back are about 60 ms, saw ${result.statistics!.toolMs}`,
  );
  assert.ok(result.statistics!.toolMs < 150, 'and neither of them was counted twice');
});

test('a cancelled run charges the tool span it was still waiting on, exactly once', async (t) => {
  /**
   * A cancelled call never produces a `tool.finished`, so the span it opened is settled by the run's own
   * teardown. That settlement has two ways to be wrong and both are asserted here: charging nothing (the wall
   * time a person spent waiting disappears) and charging twice (the run's total grows by a span that was already
   * closed, which is how a summary of runs stops adding up). Like the union test above this is a guard — the
   * scalar settled the one open call here too — and it is kept because the settled span is the part of the
   * accounting a run can still get wrong after the union rule is in place.
   */
  let round = 0;
  const provider: Provider = {
    async complete() {
      round++;
      if (round === 1) {
        // Startup/model time is deliberately longer than the cancellation window. Only time
        // spent waiting for the actual tool belongs to toolMs.
        await new Promise((resolve) => setTimeout(resolve, 150));
        return calls(['stuck', 'read_two', 5_000]);
      }
      return reply();
    },
  };
  const controller = new AbortController();
  let cancelledAt: ReturnType<typeof setTimeout> | undefined;
  const { agent, session, timeline } = await fixture(t, provider, {
    onEvent: (event) => {
      if (event.type === 'tool.started' && !cancelledAt)
        cancelledAt = setTimeout(() => controller.abort(), 100);
    },
  });
  t.after(() => clearTimeout(cancelledAt));
  const result = await agent.run({
    sessionId: session.id,
    prompt: 'One stuck call',
    signal: controller.signal,
  });
  assert.equal(result.status, 'cancelled');
  assert.ok(cancelledAt, 'cancellation is armed by the tool starting, not by run initialization');
  assert.deepEqual(timeline.events, ['start stuck']);
  assert.equal(timeline.inFlight, 0, 'the cancelled tool joins cleanup');
  assert.ok(
    result.statistics!.toolMs >= 80,
    `the span the run was waiting on is charged, saw ${result.statistics!.toolMs}`,
  );
  assert.ok(
    result.statistics!.toolMs < 1_000,
    `and only once: a 5 s tool cancelled after 100 ms is not 5 s, saw ${result.statistics!.toolMs}`,
  );
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
  const controller = new AbortController();
  let cancelledAt: ReturnType<typeof setTimeout> | undefined;
  const { store, session, agent, timeline } = await fixture(t, provider, {
    onEvent: (event) => {
      // Transcript tool.finished is published after the whole group settles. Use the actual
      // execution event and let its result finish the pipeline before cancelling its sibling.
      if (event.type === 'tool.execution.finished' && event.data.callId === 'quick')
        cancelledAt = setTimeout(() => controller.abort(), 0);
    },
  });
  t.after(() => clearTimeout(cancelledAt));
  const result = await agent.run({
    sessionId: session.id,
    prompt: 'One quick, one stuck',
    signal: controller.signal,
  });
  assert.equal(result.status, 'cancelled');
  assert.equal(timeline.peak, 2, 'both siblings actually started');
  assert.equal(timeline.inFlight, 0, 'cancellation waits for the stuck sibling to stop');
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
