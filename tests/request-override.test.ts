/**
 * Re-aiming a round: which model and how much reasoning the *next* request buys.
 *
 * A run used to have exactly one model and no reasoning knob at all: `provider.complete` read both from the
 * configured endpoint, so "run the cheap rounds cheaply" was not expressible, and the only reasoning the runtime
 * ever saw was whatever the endpoint volunteered. The seam is the round preamble (`preStep`), because that is
 * where the round is already being decided, and these tests hold the four things that make it usable: the
 * override reaches the wire, it is *per round*, a change is recorded once, and nothing about it is silent.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Agent } from '../packages/core/agent.ts';
import { SessionStore } from '../packages/storage/sqlite.ts';
import { HookRegistry, ToolRegistry } from '../packages/tools/registry.ts';
import type { PreStepContext } from '../packages/tools/registry.ts';
import type {
  AgentEvent,
  ModelRequest,
  ModelResponse,
  Provider,
  ReasoningEffort,
} from '../packages/protocol/index.ts';
import { AnthropicProvider } from '../packages/providers/anthropic.ts';
import { OpenAIProvider } from '../packages/providers/openai.ts';
import { ResponsesProvider } from '../packages/providers/responses.ts';
import { anthropicThinkingBudget } from '../packages/providers/effort.ts';
import { httpFixture, sendFrames } from './http-fixture.ts';

const reply = (text = 'Done'): ModelResponse => ({
  text,
  toolCalls: [],
  finishReason: 'stop',
  usage: { inputTokens: 10, outputTokens: 5 },
});
/** A one-tool round first, so the run reaches round 1 where the interesting override happens. */
function toolThenText(name = 'read_file'): Provider {
  let turn = 0;
  return {
    async complete(request) {
      requests.push(request);
      return turn++ === 0
        ? {
            text: '',
            finishReason: 'tool_calls',
            toolCalls: [{ id: `call-${turn}`, name, arguments: { path: 'missing.txt' } }],
            usage: { inputTokens: 10, outputTokens: 5 },
          }
        : reply();
    },
  };
}
const requests: ModelRequest[] = [];
async function fixture(
  t: test.TestContext,
  provider: Provider,
  hooks: HookRegistry,
  extra: Record<string, unknown> = {},
) {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-reaim-'));
  const store = new SessionStore(path.join(root, 'sessions.sqlite'));
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const session = store.create(root);
  const events: AgentEvent[] = [];
  const agent = new Agent({
    store,
    provider,
    tools: new ToolRegistry(hooks),
    approve: async () => true,
    onEvent: (event) => events.push(event),
    // The run's own model: `modelInfo` is what the seam starts from and what a change is measured against.
    modelInfo: { model: 'configured-model', protocol: 'openai' },
    ...extra,
  });
  return { root, store, session, events, agent };
}
const rows = (events: AgentEvent[]) => events.filter((event) => event.type === 'llm.request');

test('a round can be re-aimed, and the override reaches the provider with the round that asked for it', async (t) => {
  requests.length = 0;
  const hooks = new HookRegistry();
  const seen: (string | undefined)[] = [];
  hooks.register({
    preStep: (context: PreStepContext) => {
      // The seam starts from the run's model, so a policy can say "keep it" without naming it.
      assert.equal(context.model, 'configured-model');
      seen.push(context.reasoningEffort);
      return context.round === 1
        ? { model: 'small-model', reasoningEffort: 'low' satisfies ReasoningEffort }
        : undefined;
    },
  });
  const { agent, session, events, store } = await fixture(t, toolThenText(), hooks);
  const result = await agent.run({ sessionId: session.id, prompt: 'Go' });
  assert.equal(result.status, 'completed', result.error);
  // Per round, not per run: round 0 used the configured model and no reasoning parameter at all.
  assert.equal(requests.length, 2);
  assert.equal(requests[0]!.model, undefined);
  assert.equal(requests[0]!.reasoningEffort, undefined);
  assert.equal(requests[1]!.model, 'small-model');
  assert.equal(requests[1]!.reasoningEffort, 'low');
  // The second round's hook context sees the effort the round before it chose: that is what makes the dispatch
  // a waterfall rather than a vote.
  assert.deepEqual(seen, [undefined, undefined]);
  // One row, at the transition, live and durable, and it names the model so it can be read without the config.
  assert.deepEqual(
    rows(events).map((event) => [event.data.round, event.data.model, event.data.reasoningEffort]),
    [[1, 'small-model', 'low']],
  );
  assert.deepEqual(
    store.events(session.id).filter((event) => event.type === 'llm.request').length,
    1,
  );
});

test('a hook that re-aims nothing writes nothing, and a hook that re-aims the same model writes nothing', async (t) => {
  requests.length = 0;
  const hooks = new HookRegistry();
  // Returning the run's own model every round is not a change, so a policy that merely *reads* the seam cannot
  // fill the log with rows that say nothing happened.
  hooks.register({ preStep: () => ({ model: 'configured-model' }) });
  const { agent, session, events, store } = await fixture(t, toolThenText(), hooks);
  await agent.run({ sessionId: session.id, prompt: 'Go' });
  assert.deepEqual(rows(events).length, 0);
  assert.deepEqual(store.events(session.id).filter((e) => e.type === 'llm.request').length, 0);
  // And the request carries no model at all: naming the configured model is the same as not naming one, and
  // the adapter keeps using the model its own configuration names.
  assert.equal(requests[0]!.model, undefined);
});

test('later hooks see earlier choices, and `none` is how one takes a level back', async (t) => {
  requests.length = 0;
  const hooks = new HookRegistry();
  const observed: (string | undefined)[] = [];
  hooks.register({ preStep: () => ({ reasoningEffort: 'high' }) });
  hooks.register({
    preStep: (context) => {
      observed.push(context.reasoningEffort);
      // The second policy disagrees with the first, and says so with `none` rather than by returning nothing
      // (which would mean "no opinion"). Both are in one round, so the run must end up with no parameter.
      return { reasoningEffort: 'none' };
    },
  });
  const { agent, session, events } = await fixture(t, toolThenText(), hooks);
  await agent.run({ sessionId: session.id, prompt: 'Go' });
  assert.deepEqual(
    observed,
    ['high', 'high'],
    'each round starts from what the earlier hook chose',
  );
  assert.equal(requests[0]!.reasoningEffort, undefined, 'none is the absence of the parameter');
  // `none` is the configured state, so the round never stopped being "no reasoning": no row.
  assert.deepEqual(rows(events).length, 0);
});

test('a run that switches back records the switch back', async (t) => {
  requests.length = 0;
  const hooks = new HookRegistry();
  hooks.register({
    preStep: (context) => (context.round === 0 ? { model: 'small-model' } : undefined),
  });
  const { agent, session, events } = await fixture(t, toolThenText(), hooks);
  await agent.run({ sessionId: session.id, prompt: 'Go' });
  assert.deepEqual(
    rows(events).map((event) => [event.data.round, event.data.model]),
    [
      [0, 'small-model'],
      [1, 'configured-model'],
    ],
    'each transition is one row, including the one back to the run’s own model',
  );
  assert.equal(requests[0]!.model, 'small-model');
  // The switch back sends no override: the run's own model is the adapter's business.
  assert.equal(requests[1]!.model, undefined);
});

test('the three protocols put the level where each of them expects it', async (t) => {
  const bodies: Record<string, any>[] = [];
  const url = await httpFixture(t, (body, res) => {
    bodies.push(body);
    sendFrames(res, [
      { type: 'message_start', message: { usage: { input_tokens: 1, output_tokens: 1 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
      { type: 'message_stop' },
    ]);
  });
  const base: ModelRequest = {
    system: 's',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [],
    maxOutputTokens: 8_000,
    signal: new AbortController().signal,
    onText: () => {},
  };
  await new AnthropicProvider({ apiKey: 'k', model: 'm', baseUrl: url }).complete({
    ...base,
    model: 'override-model',
    reasoningEffort: 'medium',
  });
  // Anthropic has no levels: it gets a budget, from our documented share of the request's own output limit.
  assert.equal(bodies[0]!.model, 'override-model');
  assert.deepEqual(bodies[0]!.thinking, { type: 'enabled', budget_tokens: 4_000 });
  assert.equal(anthropicThinkingBudget('medium', 8_000), 4_000);
  assert.equal(anthropicThinkingBudget('low', 8_000), 2_000);
  assert.equal(anthropicThinkingBudget('high', 8_000), 6_000);
  // `none` is the absence of the parameter, not a small budget.
  assert.equal(anthropicThinkingBudget('none', 8_000), undefined);
  // Both of Anthropic's constraints, refused before anything is sent: the budget cannot be below its floor,
  // and it cannot be as large as the limit it comes out of.
  assert.throws(
    () => anthropicThinkingBudget('high', 1_100),
    /does not fit in this request's output limit/,
  );

  const openai = new OpenAIProvider({ apiKey: 'k', model: 'm', baseUrl: url });
  await openai
    .complete({ ...base, model: 'override-model', reasoningEffort: 'high' })
    .catch(() => {});
  const responses = new ResponsesProvider({ apiKey: 'k', model: 'm', baseUrl: url });
  await responses.complete({ ...base, reasoningEffort: 'low' }).catch(() => {});
  const openaiBody = bodies.find((body) => body.reasoning_effort !== undefined);
  assert.equal(openaiBody?.model, 'override-model');
  assert.equal(openaiBody?.reasoning_effort, 'high');
  assert.deepEqual(bodies.find((body) => body.reasoning !== undefined)?.reasoning, {
    effort: 'low',
  });
});

test('an effort that cannot fit the request is refused before anything is sent', async (t) => {
  requests.length = 0;
  let calls = 0;
  const url = await httpFixture(t, (_body, res) => {
    calls++;
    sendFrames(res, []);
  });
  const hooks = new HookRegistry();
  hooks.register({ preStep: () => ({ reasoningEffort: 'high' }) });
  const { agent, session } = await fixture(
    t,
    new AnthropicProvider({ apiKey: 'k', model: 'm', baseUrl: url }),
    hooks,
    // Anthropic needs at least 1024 thinking tokens, which this limit leaves no room for.
    { maxOutputTokens: 1_000, modelInfo: { model: 'm', protocol: 'anthropic' } },
  );
  const result = await agent.run({ sessionId: session.id, prompt: 'Go' });
  assert.equal(result.status, 'failed');
  assert.equal(result.code, 'unsupported');
  assert.match(result.error!, /thinking budget of at least 1024 tokens/);
  assert.match(result.error!, /output limit of 1000/);
  // Nothing was sent: the answer was already known, so a request would only have been a wasted round trip. A
  // plain provider cannot know this — the refusal has to happen in the adapter, before `fetch`.
  assert.equal(calls, 0);
});

test('Anthropic reasoning is shown on its own channel now that the run can ask for it', async (t) => {
  // Enabling thinking streams `thinking` blocks; before this, the parser refused any block that was not text or
  // tool use, so asking for thinking would have broken the run at the first delta.
  const url = await httpFixture(t, (_body, res) => {
    sendFrames(res, [
      { type: 'message_start', message: { usage: { input_tokens: 1, output_tokens: 1 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: 'Weighing options' },
      },
      // The signature is only useful for sending thinking back, which this runtime never does.
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'signature_delta', signature: 'sig' },
      },
      { type: 'content_block_stop', index: 0 },
      // A redacted block has no text at all; it must read as closed rather than as a missing block.
      {
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'redacted_thinking', data: 'x' },
      },
      { type: 'content_block_stop', index: 1 },
      { type: 'content_block_start', index: 2, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: 'The answer' } },
      { type: 'content_block_stop', index: 2 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } },
      { type: 'message_stop' },
    ]);
  });
  const reasoning: string[] = [];
  const response = await new AnthropicProvider({ apiKey: 'k', model: 'm', baseUrl: url }).complete({
    system: 's',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [],
    maxOutputTokens: 8_000,
    reasoningEffort: 'medium',
    signal: new AbortController().signal,
    onText: () => {},
    onReasoning: (text) => reasoning.push(text),
  });
  assert.deepEqual(reasoning, ['Weighing options']);
  // The answer is the answer: reasoning must never end up in the text that gets stored as it.
  assert.equal(response.text, 'The answer');
  // The redacted block contributed nothing to either channel: it exists so the stream stays well formed.
});
