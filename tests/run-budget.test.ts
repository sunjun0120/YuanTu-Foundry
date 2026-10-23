/**
 * A run's total budget: the backstop on how much one run may spend when nobody is there to press Stop.
 *
 * The round loop has no round count of its own, and the goal's budget only counts rounds a goal asked for, so an
 * ordinary run that kept calling tools used to go on for as long as the endpoint answered.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Agent, runBudgetExhausted } from '../packages/core/agent.ts';
import { ToolRegistry } from '../packages/tools/registry.ts';
import { RUN_DEFAULTS, resolveRunLimits } from '../packages/protocol/settings.ts';
import type { AgentOptions } from '../packages/core/agent-options.ts';
import type { ModelResponse } from '../packages/protocol/index.ts';
import { storeFixture } from './temp-fixture.ts';

async function loopingRun(
  t: test.TestContext,
  budget: Partial<AgentOptions>,
  shape: { tokensPerRound?: number } = {},
) {
  const { store, session } = await storeFixture(t, 'yuantu-run-budget-');
  const tools = new ToolRegistry();
  let executed = 0;
  tools.register({
    name: 'probe',
    description: 'Does nothing, forever if asked',
    inputSchema: { type: 'object', properties: {} },
    async execute() {
      executed++;
      return { isError: false, content: 'again' };
    },
  });
  let requests = 0;
  // A model that never stops asking for one more tool call.
  const result = await new Agent({
    store,
    tools,
    approve: async () => true,
    ...budget,
    provider: {
      async complete(): Promise<ModelResponse> {
        requests++;
        const input = (shape.tokensPerRound ?? 1_010) - 10;
        return {
          text: '',
          finishReason: 'tool_calls',
          toolCalls: [{ id: `call-${requests}`, name: 'probe', arguments: {} }],
          usage: { inputTokens: input, outputTokens: 10 },
        };
      },
    },
  }).run({ sessionId: session.id, prompt: 'Keep going.' });
  return { result, requests, executed };
}

test('a run that never stops calling tools ends limited at its round budget', async (t) => {
  const { result, requests, executed } = await loopingRun(t, { maxRunRounds: 3 });
  assert.equal(result.status, 'limited', result.error);
  assert.match(result.error ?? '', /budget of 3 model rounds/);
  assert.equal(requests, 3);
  // The stop is at a round boundary: every call the model was given an answer for actually ran.
  assert.equal(executed, 3);
});

test('the token budget counts every round, input and output', async (t) => {
  // 1,010 tokens a round: the third round's start sees 2,020 and the fourth's 3,030.
  const { result, requests } = await loopingRun(t, { maxRunRounds: 0, maxRunTokens: 3_000 });
  assert.equal(result.status, 'limited', result.error);
  assert.match(result.error ?? '', /3000 model tokens/);
  assert.equal(requests, 3);
});

test('budgets default on, generous, and zero turns one off', () => {
  assert.deepEqual(
    [RUN_DEFAULTS.maxRunRounds, RUN_DEFAULTS.maxRunMs, RUN_DEFAULTS.maxRunTokens],
    [0, 7_200_000, 20_000_000],
  );
  const off = resolveRunLimits({ maxRunRounds: 0, maxRunMs: 0, maxRunTokens: 0 });
  assert.equal(runBudgetExhausted(off, { rounds: 1e6, elapsedMs: 1e9, tokens: 1e12 }), undefined);
  const limits = resolveRunLimits();
  assert.match(
    runBudgetExhausted(limits, { rounds: 0, elapsedMs: 7_200_000, tokens: 0 }) ?? '',
    /120 minutes/,
  );
  assert.throws(() => resolveRunLimits({ maxRunRounds: -1 }), /Invalid maxRunRounds/);
});

test('with the default budget, a runaway run is stopped by its tokens rather than a round count', async (t) => {
  // The other half — a long run that keeps changing the project is not cut by rounds — is the 300-round run in
  // `tests/failure-codes.test.ts`, which runs with these same defaults.
  // A run that bills 6M tokens a round meets the default 20M budget at the start of its fourth round.
  const runaway = await loopingRun(t, {}, { tokensPerRound: 6_000_000 });
  assert.equal(runaway.result.status, 'limited', runaway.result.error);
  assert.match(runaway.result.error ?? '', /20000000 model tokens/);
  assert.equal(runaway.requests, 4);
});
