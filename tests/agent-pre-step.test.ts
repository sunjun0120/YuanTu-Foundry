/**
 * `agent/pre-step`: the round preamble seam.
 *
 * The agent loop had exactly one place where policy could see a whole round before it happened —
 * `promptSubmit`, and only for the very first round of a run. Everything after that (a long run, a
 * delegated child, a task that resumes) had no seam at all: an extension could police individual tool
 * calls but not "this round, in this state, should not be sent". `preStep` is that seam, and these
 * tests pin down what it may do: observe, refuse, or add logged context — never silently alter what the
 * model sees.
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
} from '../packages/protocol/index.ts';

const reply = (text = 'Done'): ModelResponse => ({
  text,
  toolCalls: [],
  finishReason: 'stop',
  usage: { inputTokens: 10, outputTokens: 5 },
});
const toolCall = (id: string, name: string, args: Record<string, unknown>): ModelResponse => ({
  text: '',
  finishReason: 'tool_calls',
  toolCalls: [{ id, name, arguments: args }],
  usage: { inputTokens: 10, outputTokens: 5 },
});

async function fixture(
  t: test.TestContext,
  provider: Provider,
  hooks: HookRegistry,
): Promise<{ store: SessionStore; sessionId: string; events: AgentEvent[]; agent: Agent }> {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-pre-step-'));
  const store = new SessionStore(path.join(root, 'sessions.sqlite'));
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const session = store.create(root);
  const events: AgentEvent[] = [];
  const agent = new Agent({
    store,
    provider,
    tools: new ToolRegistry(hooks),
    approve: async () => true,
    onEvent: (event) => events.push(event),
  });
  return { store, sessionId: session.id, events, agent };
}

test('the seam sees every round, in order, before the request is built', async (t) => {
  const rounds: number[] = [];
  const requests: ModelRequest[] = [];
  const hooks = new HookRegistry();
  hooks.register({
    preStep: (context: PreStepContext) => {
      rounds.push(context.round);
      assert.equal(context.sessionId.length > 0, true);
      assert.equal(Number.isSafeInteger(context.round) && context.round >= 0, true);
      assert.equal(typeof context.runId, 'string');
    },
  });
  let turn = 0;
  const { agent, sessionId } = await fixture(
    t,
    {
      async complete(request) {
        requests.push(request);
        turn++;
        return turn === 1 ? toolCall('read-1', 'read_file', { path: 'missing.txt' }) : reply();
      },
    },
    hooks,
  );
  const result = await agent.run({ sessionId, prompt: 'Do the work' });
  assert.equal(result.status, 'completed', result.error);
  assert.deepEqual(rounds, [0, 1], 'one preamble per round');
  assert.equal(requests.length, 2);
  assert.equal(rounds.length, requests.length);
});

test('a refusal ends the run before the request is made', async (t) => {
  const requests: ModelRequest[] = [];
  const hooks = new HookRegistry();
  hooks.register({
    preStep: (context) => (context.round === 1 ? { block: 'budget freeze' } : undefined),
  });
  let turn = 0;
  const { agent, sessionId, store } = await fixture(
    t,
    {
      async complete(request) {
        requests.push(request);
        turn++;
        return turn === 1 ? toolCall('read-1', 'read_file', { path: 'missing.txt' }) : reply();
      },
    },
    hooks,
  );
  const result = await agent.run({ sessionId, prompt: 'Do the work' });
  assert.equal(result.status, 'failed');
  assert.match(result.error ?? '', /Run refused by extension pre-step hook: budget freeze/);
  assert.equal(requests.length, 1, 'the refused round never reached the model');
  assert.equal(store.get(sessionId).activeRun, null, 'a refused run still releases the session');
});

test('a hook that throws refuses the run instead of being skipped', async (t) => {
  const hooks = new HookRegistry();
  hooks.register({
    preStep: () => {
      throw new Error('policy engine unreachable');
    },
  });
  const { agent, sessionId } = await fixture(
    t,
    {
      async complete() {
        return reply();
      },
    },
    hooks,
  );
  const result = await agent.run({ sessionId, prompt: 'Do the work' });
  assert.equal(result.status, 'failed');
  assert.match(result.error ?? '', /Extension pre-step hook failed: policy engine unreachable/);
});

test('injected context is persisted, announced and visible to the next request', async (t) => {
  const requests: ModelRequest[] = [];
  const hooks = new HookRegistry();
  hooks.register({
    preStep: (context) =>
      context.round === 0
        ? { inject: ['PRE-STEP-NOTE: this workspace is read-only today.'] }
        : undefined,
  });
  const { agent, sessionId, events, store } = await fixture(
    t,
    {
      async complete(request) {
        requests.push(request);
        return reply();
      },
    },
    hooks,
  );
  const result = await agent.run({ sessionId, prompt: 'Do the work' });
  assert.equal(result.status, 'completed', result.error);
  const messages = store.messages(sessionId);
  const injected = messages.filter((message) => message.content.includes('PRE-STEP-NOTE'));
  assert.equal(injected.length, 1);
  assert.equal(injected[0]!.role, 'user');
  assert.ok(
    requests[0]?.messages.some((message) => message.content.includes('PRE-STEP-NOTE')),
    'the note is part of the very first request it was injected for',
  );
  const announced = events.filter((event) => event.type === 'context.injected');
  assert.equal(announced.length, 1);
  assert.equal(announced[0]!.data.source, 'pre-step');
  assert.equal(announced[0]!.data.notes, 1);
});

test('a disposed pre-step hook stops seeing rounds', async (t) => {
  let seen = 0;
  const hooks = new HookRegistry();
  const dispose = hooks.register({ preStep: () => void seen++ });
  const { agent, sessionId } = await fixture(
    t,
    {
      async complete() {
        return reply();
      },
    },
    hooks,
  );
  await agent.run({ sessionId, prompt: 'one' });
  assert.equal(seen, 1);
  dispose();
  await agent.run({ sessionId, prompt: 'two' });
  assert.equal(seen, 1, 'the disposed hook must not observe the next run');
});
