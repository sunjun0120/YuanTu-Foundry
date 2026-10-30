/**
 * A resident child outlives the parent run that created it. Its next turn must publish through the run that
 * asked for it, or the client filters every delta and tool frame as a different run's event.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRunEmit, type RunEmit } from '../packages/core/run/emit.ts';
import { createChildTurns } from '../packages/core/run/child-turns.ts';
import { createResidentMessageTool } from '../packages/core/run/residency.ts';
import { emptyStatistics } from '../packages/protocol/statistics.ts';
import type { AgentEvent } from '../packages/protocol/index.ts';
import type { SessionStatistics } from '../packages/protocol/statistics.ts';
import { storeFixture } from './temp-fixture.ts';

test('a resident child turn is rebound to the current parent run', async () => {
  const frames: AgentEvent[] = [];
  const store = {
    lastSeq: () => 0,
    statistics: () => ({ inputTokens: 0, outputTokens: 0 }),
    turnTiming: () => ({ settledMs: 0, runningSince: undefined }),
    recordEvent: () => {},
  };
  const state = () => ({
    statistics: {} as SessionStatistics,
    emittedTypes: new Set<string>(),
    toolCalls: new Map<string, number>(),
    toolSpanStarted: undefined,
    toolActivityStartedAt: undefined,
    childOutputTokens: new Map<string, number>(),
  });
  const emit1 = createRunEmit({
    store: store as never,
    sessionId: 'parent',
    runId: 'parent-run-1',
    state: state(),
    onEvent: (event) => frames.push(event),
  });
  const emit2 = createRunEmit({
    store: store as never,
    sessionId: 'parent',
    runId: 'parent-run-2',
    state: state(),
    onEvent: (event) => frames.push(event),
  });

  let onEvent: ((event: { type: string; data: Record<string, unknown> }) => void) | undefined;
  const childTurns = createChildTurns({
    store: store as never,
    // Every child registry is narrowed (memory writes are denied to children), so the stub answers `restrict`.
    tools: { forRun: () => ({ close: () => {}, restrict: () => () => {} }) } as never,
    emit: emit1,
    sessionId: 'parent',
    taskEffectScope: undefined,
    createAgent: ((options: { onEvent: typeof onEvent }) => {
      onEvent = options.onEvent;
      return {
        run: async () => {
          onEvent?.({ type: 'message.delta', data: { text: 'live frame' } });
          return {
            usage: { inputTokens: 1, outputTokens: 1 },
            text: 'answer',
            status: 'completed',
          };
        },
        enqueue: () => true,
      };
    }) as never,
    agent: {
      approve: Object.assign(async () => true, { decisionSource: undefined }),
      subagents: { enabled: true },
    } as never,
  });

  const task = { id: 'child-1', role: 'general' as const, objective: 'work' };
  const tag = { id: 'child-1', role: 'general' as const, objective: 'work' };
  const child = childTurns({ task, childSession: { id: 'child' } as never, depth: 0, tag });
  await child.turn('first', new AbortController().signal, true);
  assert.ok(child.setEmit, 'a resident activation exposes the emitter rebinding');
  child.setEmit(emit2);
  await child.turn('second', new AbortController().signal, true);

  assert.deepEqual(
    frames.map((frame) => ({ type: frame.type, runId: frame.runId })),
    [
      { type: 'subagent.delta', runId: 'parent-run-1' },
      { type: 'subagent.delta', runId: 'parent-run-2' },
    ],
  );
});

test('send_message rebinds an existing activation before it starts the follow-up turn', async (t) => {
  const { root, store } = await storeFixture(t, 'yuantu-run-rebind-');
  const parent = store.create(root);
  const child = store.create(root, parent.id);
  const emit: RunEmit = () => {};
  let rebound: RunEmit | undefined;
  const activation = {
    id: 'child-1',
    childSessionId: child.id,
    parentSessionId: parent.id,
    objective: 'work',
    depth: 1,
    deliver: async () => ({ delivered: false }),
    snapshot: () => ({ status: 'running' }),
    setEmit: (next: typeof emit) => {
      rebound = next;
    },
    run: async () => ({
      usage: { inputTokens: 1, outputTokens: 1 },
      text: 'answer',
      status: 'completed' as const,
      rounds: 1,
      toolCalls: 0,
    }),
    interrupt: () => {},
  };
  const tool = createResidentMessageTool({
    store,
    parentSessionId: parent.id,
    depth: 0,
    residency: {
      get: (id: string) => (id === child.id ? activation : undefined),
      open: () => assert.fail('the live activation must be reused'),
    } as never,
    childTurns: (() => assert.fail('a live activation must not be rebuilt')) as never,
    emit,
    statistics: emptyStatistics(),
    usage: { inputTokens: 0, outputTokens: 0 },
    nextMessageId: () => 1,
  });

  const result = await tool.execute(
    { childSessionId: child.id, message: 'continue' },
    { signal: new AbortController().signal, approve: async () => true },
  );
  assert.equal(result.isError, false, result.content);
  assert.equal(rebound, emit, 'the follow-up turn is pointed at the current run emitter');
});
