import test from 'node:test';
import assert from 'node:assert/strict';
import {
  foldMessages,
  assertKnownEvents,
  UnsupportedSessionEventError,
} from '../packages/storage/events.ts';
import type { SessionEvent } from '../packages/storage/events.ts';
import {
  statisticsProjection,
  turnTimingProjection,
  isStatisticsState,
} from '../packages/storage/projections.ts';
import {
  addUsage,
  addStatistics,
  emptyStatistics,
  isSessionStatistics,
} from '../packages/protocol/statistics.ts';
import { foldContextEnvelopes } from '../packages/protocol/context.ts';
import { newGoal, isGoal, GOAL_CEILINGS } from '../packages/protocol/goals.ts';
import { SessionController } from '../packages/client/session-controller.ts';
import type { AgentHostClient } from '../packages/client/host-client.ts';
import type { AgentEvent, Usage } from '../packages/protocol/index.ts';

const event = (type: string, data: Record<string, unknown>, ms = 0): SessionEvent => ({
  type,
  data,
  seq: 7,
  sessionId: 's',
  at: new Date(ms).toISOString(),
});

test('corrupt message required fields are refused with event identity before reaching transcript consumers', () => {
  for (const [type, message] of [
    ['message.user', { role: 'user', content: 42 }],
    ['message.user', { role: 'tool', content: 'x', toolCallId: 't', isError: false }],
    ['message.assistant', { role: 'assistant', content: 'x' }],
    ['message.assistant', { role: 'assistant', content: 'x', toolCalls: [null] }],
    [
      'message.assistant',
      { role: 'assistant', content: 'x', toolCalls: [{ id: 't', name: 'x', arguments: [] }] },
    ],
    ['message.tool', { role: 'tool', content: 'x', toolCallId: 't' }],
  ] as const) {
    assert.throws(() => foldMessages([event(type, { message })]), /message\..*seq 7.*corrupt/);
  }
  assert.deepEqual(
    foldMessages([
      event('message.assistant', {
        message: { role: 'assistant', content: '', toolCalls: [] },
      }),
    ]),
    [{ role: 'assistant', content: '', toolCalls: [] }],
  );
  assert.throws(
    () => assertKnownEvents([event('future.unknown', {})]),
    UnsupportedSessionEventError,
  );
});

test('partial and invalid usage preserves known amounts without poisoning cumulative totals', () => {
  const total = emptyStatistics();
  addUsage(total, { inputTokens: 3 } as Usage);
  assert.equal(total.inputTokens, 3);
  assert.equal(total.outputTokens, 0);
  assert.equal(total.usageComplete, false);
  addUsage(total, { inputTokens: NaN, outputTokens: -5, cachedInputTokens: Infinity });
  assert.equal(total.inputTokens, 3);
  assert.equal(total.outputTokens, 0);
  assert.equal(total.cachedInputTokens, 0);
  const malformed = { ...emptyStatistics(), inputTokens: '4', modelMs: NaN };
  const sum = addStatistics(
    emptyStatistics(),
    malformed as unknown as ReturnType<typeof emptyStatistics>,
  );
  assert.equal(sum.inputTokens, 0);
  assert.equal(sum.modelMs, 0);
  assert.equal(sum.usageComplete, false);
  assert.equal(sum.timingKnown, false);
});

test('an output-only usage record does not erase previously known cache accounting', () => {
  const total = emptyStatistics();
  addUsage(total, { inputTokens: 3, outputTokens: 1, cachedInputTokens: 2 });
  addUsage(total, { inputTokens: 0, outputTokens: 1 });
  assert.equal(total.cacheKnown, true);
});

test('partial compaction usage remains finite across matching run settlement', () => {
  let state = statisticsProjection.initial();
  state = statisticsProjection.apply(
    state,
    event('context.compacted', { runId: 'r', usage: { inputTokens: 3 } }),
  );
  assert.deepEqual(state.pendingCompactions.r, {
    inputTokens: 3,
    outputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
  });
  state = statisticsProjection.apply(
    state,
    event('run.finished', {
      runId: 'r',
      statistics: { ...emptyStatistics(), inputTokens: 3 },
      compactionUsage: { inputTokens: 3 },
    }),
  );
  assert.equal(state.statistics.inputTokens, 3);
  assert.equal(state.statistics.outputTokens, 0);
  assert.equal(state.statistics.usageComplete, false);
});

test('persisted statistics guards refuse null totals and malformed pending usage before checkpoint reuse', () => {
  const statsGuard = isSessionStatistics;
  const stateGuard = isStatisticsState;
  assert.equal(statsGuard(emptyStatistics()), true);
  assert.equal(
    statsGuard({
      ...emptyStatistics(),
      turns: undefined,
      steps: undefined,
      decodeMs: undefined,
      decodeTokens: undefined,
      cacheWriteInputTokens: undefined,
      usageComplete: undefined,
    }),
    true,
  );
  assert.equal(statsGuard({ ...emptyStatistics(), outputTokens: null }), false);
  assert.equal(statsGuard({ ...emptyStatistics(), modelMs: -1 }), false);
  assert.equal(statsGuard({ ...emptyStatistics(), requestTiming: { requests: 1 } }), false);
  assert.equal(stateGuard(statisticsProjection.initial()), true);
  assert.equal(
    stateGuard({
      ...statisticsProjection.initial(),
      pendingCompactions: { r: { inputTokens: null, outputTokens: 2 } },
    }),
    false,
  );
});

test('goal data respects creation ceilings but permits a limit edited below spent rounds', () => {
  const goal = newGoal({ objective: 'finish', maxGoalRounds: 3 }, new Date(0).toISOString());
  assert.equal(isGoal({ ...goal, roundsStarted: 4, maxGoalRounds: 2 }), true);
  for (const change of [
    { roundsStarted: -1 },
    { maxGoalRounds: 0 },
    { maxGoalRounds: GOAL_CEILINGS.maxGoalRounds + 1 },
    { roundsStarted: GOAL_CEILINGS.maxGoalRounds + 1 },
    { objective: ' ' },
    { objective: 'x'.repeat(GOAL_CEILINGS.objectiveChars + 1) },
    { blockedReason: 'x'.repeat(GOAL_CEILINGS.blockedReasonChars + 1) },
  ])
    assert.equal(isGoal({ ...goal, ...change }), false);
});

test('token totals remain safe on overflow and malformed compaction exclusions mark usage incomplete', () => {
  const total = addStatistics(
    { ...emptyStatistics(), inputTokens: Number.MAX_SAFE_INTEGER },
    { ...emptyStatistics(), inputTokens: 1 },
  );
  assert.equal(total.inputTokens, Number.MAX_SAFE_INTEGER);
  assert.equal(total.usageComplete, false);
  const state = statisticsProjection.apply(
    statisticsProjection.initial(),
    event('run.finished', {
      runId: 'r',
      statistics: { ...emptyStatistics(), inputTokens: 10, outputTokens: 5 },
      compactionUsage: { inputTokens: 2 },
    }),
  );
  assert.equal(state.statistics.inputTokens, 8);
  assert.equal(state.statistics.outputTokens, 5);
  assert.equal(state.statistics.usageComplete, false);
});

test('projection settlement preserves timing overflow uncertainty across later known runs', () => {
  let state = statisticsProjection.initial();
  for (const [runId, modelMs] of [
    ['r1', Number.MAX_SAFE_INTEGER],
    ['r2', 1],
  ] as const)
    state = statisticsProjection.apply(
      state,
      event('run.finished', {
        runId,
        statistics: { ...emptyStatistics(), modelMs },
      }),
    );
  assert.equal(state.statistics.modelMs, Number.MAX_SAFE_INTEGER);
  assert.equal(state.statistics.timingKnown, false);
  assert.equal(state.settledTimingKnown, false);
  state = statisticsProjection.apply(
    state,
    event('run.finished', {
      runId: 'r3',
      statistics: emptyStatistics(),
    }),
  );
  assert.equal(state.statistics.timingKnown, false);
});

test('projection settlement preserves usage overflow uncertainty', () => {
  let state = statisticsProjection.initial();
  for (const [runId, inputTokens] of [
    ['r1', Number.MAX_SAFE_INTEGER],
    ['r2', 1],
  ] as const)
    state = statisticsProjection.apply(
      state,
      event('run.finished', {
        runId,
        statistics: { ...emptyStatistics(), inputTokens },
      }),
    );
  assert.equal(state.statistics.inputTokens, Number.MAX_SAFE_INTEGER);
  assert.equal(state.statistics.usageComplete, false);
  state = statisticsProjection.apply(
    state,
    event('run.finished', {
      runId: 'r3',
      statistics: emptyStatistics(),
    }),
  );
  assert.equal(state.statistics.usageComplete, false);
});

const envelope = {
  runId: 'r',
  round: 0,
  model: null,
  maxOutputTokens: 10,
  systemHash: 's',
  systemBytes: 0,
  toolsHash: 't',
  toolsBytes: 0,
  toolsCount: 0,
};
test('envelope rejects corrupt numeric fields and catalogues while reading older absent catalogues', () => {
  for (const change of [
    { round: 'abc' },
    { round: -1 },
    { maxOutputTokens: NaN },
    { systemBytes: Infinity },
    { toolsCount: -1 },
    { maxContextTokens: '42' },
    { tools: {} },
    { tools: [null] },
    { tools: [{ name: 'x', description: 'x', inputSchema: [] }] },
  ])
    assert.throws(
      () => foldContextEnvelopes([event('context.envelope', { ...envelope, ...change })]),
      /context\.envelope.*corrupt/,
    );
  assert.equal(foldContextEnvelopes([event('context.envelope', envelope)])[0]!.tools, undefined);
  assert.deepEqual(
    foldContextEnvelopes([
      event('context.envelope', {
        ...envelope,
        tools: [{ name: 'x', description: '', inputSchema: {} }],
      }),
    ])[0]!.tools,
    [{ name: 'x', description: '', inputSchema: {} }],
  );
});

test('malformed run ends and duplicate starts cannot lose measured turn elapsed time', () => {
  const open = turnTimingProjection.apply(
    turnTimingProjection.initial(),
    event('run.started', { runId: 'r' }, 10),
  );
  for (const runId of [undefined, null, 0, {}])
    assert.deepEqual(turnTimingProjection.apply(open, event('run.finished', { runId }, 30)), open);
  const duplicate = turnTimingProjection.apply(open, event('run.started', { runId: 'r' }, 20));
  assert.equal(
    turnTimingProjection.apply(duplicate, event('run.finished', { runId: 'r' }, 30)).settledMs,
    20,
  );
  const replacement = turnTimingProjection.apply(open, event('run.started', { runId: 'next' }, 20));
  assert.equal(
    turnTimingProjection.apply(replacement, event('run.finished', { runId: 'next' }, 30)).settledMs,
    20,
  );
});

test('live malformed todo and deliverable frames keep a usable state matching reload guards', async (t) => {
  let listener!: (event: AgentEvent) => void;
  const client = {
    subscribe: (next: typeof listener) => {
      listener = next;
      return () => {};
    },
    subscribeStatus: () => () => {},
    request: async (method: string) =>
      method === 'session.get'
        ? { messages: [] }
        : method === 'todos.get'
          ? { todos: [], change: null }
          : method === 'subagents.list' || method === 'deliverables.get'
            ? []
            : null,
  };
  const controller = new SessionController(client as unknown as AgentHostClient);
  t.after(() => controller.dispose());
  await controller.load('s');
  const emit = (type: string, data: Record<string, unknown>) =>
    listener({ ...event(type, data), runId: 'r' } as AgentEvent);
  emit('run.started', {});
  emit('todo.written', { todos: [{ id: '1', content: 'done', status: 'pending' }, null] });
  assert.deepEqual(controller.snapshot.todos, [{ id: '1', content: 'done', status: 'pending' }]);
  emit('todo.written', { todos: {} });
  assert.equal(controller.snapshot.todos.length, 1);
  emit('deliverable.presented', { files: [null, { path: 'x', bytes: 1, sha256: 'h', at: 'now' }] });
  assert.deepEqual(controller.snapshot.deliverables, [
    { path: 'x', bytes: 1, sha256: 'h', at: 'now' },
  ]);
  emit('deliverable.presented', { files: {} });
  assert.equal(controller.snapshot.deliverables.length, 1);
  const goal = newGoal({ objective: 'finish' }, new Date(0).toISOString());
  emit('goal.changed', { goal });
  emit('goal.changed', { goal: { ...goal, maxGoalRounds: -1 } });
  assert.deepEqual(controller.snapshot.goal, goal);
});
