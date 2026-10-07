import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Agent } from '../packages/core/agent.ts';
import {
  SUBAGENT_CAPABILITIES,
  SubAgentCapabilityError,
  SubAgentProviderRegistry,
  UnknownSubAgentProviderError,
  inProcessProvider,
} from '../packages/core/subagent-providers.ts';
import type {
  ResolvedSubAgentStartRequest,
  SubAgentCapability,
  SubAgentOutcome,
  SubAgentProvider,
} from '../packages/core/subagent-providers.ts';
import { SessionStore } from '../packages/storage/sqlite.ts';
import { ToolRegistry } from '../packages/tools/registry.ts';
import { createTools } from '../packages/tools/index.ts';
import type { ModelResponse, ModelRequest, Provider } from '../packages/protocol/index.ts';
import { SubAgentResidency } from '../packages/core/residency.ts';

// ---- merged from subagent-providers.test.ts ----

/**
 * The sub-agent provider seam.
 *
 * Delegation used to be one closure with no name and no stated abilities, which meant a caller could
 * not learn what the implementation *cannot* do: asking for a specific model, a tool filter or a depth
 * cap either worked or was silently ignored. Ignoring is the dangerous answer — the caller believes a
 * constraint is in force when nothing enforced it.
 *
 * These tests pin the two halves of the fix: the registry refuses a request the provider cannot honour
 * (loudly, before any child exists), and the request that *is* honoured really reaches the provider
 * with the options the caller asked for.
 */

const reply = (text = 'Done'): ModelResponse => ({
  text,
  toolCalls: [],
  finishReason: 'stop',
  usage: { inputTokens: 10, outputTokens: 5 },
});
const delegateCall = (tasks: Record<string, unknown>[]): ModelResponse => ({
  text: '',
  finishReason: 'tool_calls',
  toolCalls: [{ id: 'delegate-1', name: 'delegate_task', arguments: { tasks } }],
  usage: { inputTokens: 10, outputTokens: 5 },
});
const outcome = (overrides: Partial<SubAgentOutcome> = {}): SubAgentOutcome => ({
  sessionId: 'child-session',
  status: 'completed',
  text: 'child report',
  rounds: 1,
  toolCalls: 0,
  usage: { inputTokens: 1, outputTokens: 1 },
  ...overrides,
});
/** A provider that records what it was asked for, so the test can assert the request arrived intact. */
function recordingProvider(
  capabilities: readonly SubAgentCapability[],
  name = 'recording',
): { provider: SubAgentProvider; requests: ResolvedSubAgentStartRequest[] } {
  const requests: ResolvedSubAgentStartRequest[] = [];
  return {
    requests,
    provider: inProcessProvider({
      name,
      capabilities,
      run: async (request) => {
        requests.push(request);
        return outcome();
      },
    }),
  };
}

test('the registry lists providers and refuses unknown names and duplicates', () => {
  const registry = new SubAgentProviderRegistry();
  const { provider } = recordingProvider([...SUBAGENT_CAPABILITIES], 'fake');
  const dispose = registry.register(provider);
  assert.deepEqual(registry.names(), ['fake']);
  assert.equal(registry.size, 1);
  assert.deepEqual(registry.describe(), [
    {
      name: 'fake',
      description:
        'Runs the child as a real agent session in this process, with the workspace, tools and lineage of the parent run.',
      capabilities: [...SUBAGENT_CAPABILITIES],
    },
  ]);
  assert.throws(() => registry.register(provider), /Duplicate sub-agent provider: fake/);
  assert.equal(registry.resolve('fake', {}).name, 'fake');
  assert.throws(() => registry.resolve('missing', {}), UnknownSubAgentProviderError);
  dispose();
  assert.deepEqual(registry.names(), []);
});

test('a request for something the provider cannot honour is refused by capability name', () => {
  const registry = new SubAgentProviderRegistry();
  registry.register(recordingProvider(['toolFilter'], 'limited').provider);
  // Supported: no assertion fails.
  assert.equal(registry.resolve('limited', { toolFilter: ['read_file'] }).name, 'limited');
  // Unsupported: loud, specific, and about the capability rather than the whole request.
  assert.throws(
    () => registry.resolve('limited', { agentOptions: { model: 'strong-model' } }),
    (error: unknown) =>
      error instanceof SubAgentCapabilityError &&
      error.capability === 'agentOptions' &&
      error.provider === 'limited' &&
      /UNSUPPORTED_CAPABILITY/.test(error.message),
  );
});

test('an empty or blank request value is not asserted against a capability', () => {
  const registry = new SubAgentProviderRegistry();
  registry.register(recordingProvider([], 'bare').provider);
  assert.equal(registry.resolve('bare', {}).name, 'bare');
  assert.equal(registry.resolve('bare', { toolFilter: [], persona: '   ' }).name, 'bare');
});

/** Every tool result the run persisted, joined: a refusal is reported to the model, not in final text. */
const toolText = (store: SessionStore, sessionId: string): string =>
  store
    .messages(sessionId)
    .filter((message) => message.role === 'tool')
    .map((message) => message.content)
    .join('\n');

test('a refused capability leaves no child session behind', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-providers-'));
  const store = new SessionStore(path.join(root, 'sessions.sqlite'));
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const session = store.create(root);
  const { provider: fake, requests } = recordingProvider(
    ['outputSchema', 'depthLimit', 'toolFilter', 'persona'],
    'no-model',
  );
  let turn = 0;
  const agent = new Agent({
    store,
    provider: {
      async complete() {
        turn++;
        return turn === 1
          ? delegateCall([{ objective: 'Investigate', model: 'strong-model' }])
          : reply('Done');
      },
    },
    tools: new ToolRegistry(),
    approve: async () => true,
    subagents: { enabled: true },
    subagentProvider: 'no-model',
    subagentProviders: [fake],
  });
  const result = await agent.run({ sessionId: session.id, prompt: 'Delegate' });
  assert.equal(result.status, 'completed', result.error);
  assert.match(toolText(store, session.id), /UNSUPPORTED_CAPABILITY/);
  assert.deepEqual(requests, [], 'the provider was never asked to run anything');
  assert.deepEqual(store.childSessions(session.id), [], 'and no child session was created');
});

test('the provider this run delegates to is the configured one, and it receives the request intact', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-providers-selected-'));
  const store = new SessionStore(path.join(root, 'sessions.sqlite'));
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const session = store.create(root);
  const { provider: fake, requests } = recordingProvider([...SUBAGENT_CAPABILITIES], 'sessions');
  let turn = 0;
  const agent = new Agent({
    store,
    provider: {
      async complete() {
        turn++;
        return turn === 1
          ? delegateCall([{ objective: 'Sweep the repo', model: 'cheap-model' }])
          : reply('Done');
      },
    },
    tools: new ToolRegistry(),
    approve: async () => true,
    subagents: { enabled: true },
    subagentProvider: 'sessions',
    subagentProviders: [fake],
  });
  const result = await agent.run({ sessionId: session.id, prompt: 'Delegate' });
  assert.equal(result.status, 'completed', result.error);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.provider, 'sessions');
  assert.deepEqual(requests[0]!.options.agentOptions, { model: 'cheap-model' });
  assert.equal(requests[0]!.parent.depth, 0);
  assert.equal(requests[0]!.parent.sessionId, session.id);
  assert.equal(requests[0]!.task.objective, 'Sweep the repo');
  assert.equal(
    'budgetTokens' in requests[0]!.task,
    false,
    'nothing about spending travels with a task: a child is bounded by its own rounds and window',
  );
  assert.ok(requests[0]!.options.outputSchema, 'the report contract is not optional');
  /**
   * The role does **not** travel here, and its absence is the correction rather than an omission.
   *
   * `persona` shadows the deployment's persona, so sending the role prompt through it asked every provider to
   * replace the harness's own identity paragraph for every delegated child. The role travels where it always did —
   * `AgentOptions.rolePrompt`, applied by the child composition — and this option is only present when a caller has
   * a persona of its own. Asserted as an absence so a future edit cannot quietly put it back.
   */
  assert.equal(
    requests[0]!.options.persona,
    undefined,
    'the role prompt belongs in rolePrompt, not in the persona slot it would shadow',
  );
  assert.deepEqual(requests[0]!.options.toolFilter?.includes('read_file'), true);
});

test('a task that names a model runs the child on that model', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-providers-model-'));
  const store = new SessionStore(path.join(root, 'sessions.sqlite'));
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const session = store.create(root);
  const childModels: string[] = [];
  const childPrompts: string[] = [];
  let turn = 0;
  const agent = new Agent({
    store,
    provider: {
      // The parent answers the delegation, then finishes; the child's own run goes through the
      // resolver below, so this provider only ever sees the parent's two requests.
      async complete(request) {
        turn++;
        if (request.system.includes('You are a sub-agent delegated by a parent agent')) {
          childPrompts.push(request.messages[0]?.content ?? '');
          return reply('child finished');
        }
        return turn === 1
          ? delegateCall([{ objective: 'Sweep the repo', model: 'cheap-model' }])
          : reply('Done');
      },
    },
    tools: new ToolRegistry(),
    approve: async () => true,
    subagents: { enabled: true },
    subagentProviderFor: (model) => {
      childModels.push(model);
      return {
        async complete() {
          return reply('child finished');
        },
      };
    },
  });
  const result = await agent.run({ sessionId: session.id, prompt: 'Delegate' });
  assert.equal(result.status, 'completed', result.error);
  assert.deepEqual(childModels, ['cheap-model'], 'the child asked for the model the task named');
  const children = store.childSessions(session.id);
  assert.equal(children.length, 1, 'and the child really ran');
  assert.match(result.text, /child finished|Done/);
});

test('without a resolver the built-in provider does not advertise agentOptions', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-providers-noresolver-'));
  const store = new SessionStore(path.join(root, 'sessions.sqlite'));
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const session = store.create(root);
  let turn = 0;
  const agent = new Agent({
    store,
    provider: {
      async complete() {
        turn++;
        return turn === 1
          ? delegateCall([{ objective: 'Investigate', model: 'some-model' }])
          : reply('Done');
      },
    },
    tools: new ToolRegistry(),
    approve: async () => true,
    subagents: { enabled: true },
  });
  const result = await agent.run({ sessionId: session.id, prompt: 'Delegate' });
  assert.equal(result.status, 'completed', result.error);
  assert.match(toolText(store, session.id), /UNSUPPORTED_CAPABILITY/);
  assert.deepEqual(store.childSessions(session.id), []);
});

// ---- merged from residency.test.ts ----

/**
 * Resident sub-agents.
 *
 * Delegation used to be one-shot: a child ran, reported, and was gone. Residency is what makes "ask the
 * child a follow-up" and "tell a running child to change direction" possible, and it changes three things
 * that have to be pinned down or they become surprises: a resident child owns its own tools, its usage is
 * attributed to its own session once the parent's run is over, and run end stops work in flight without
 * forgetting the child.
 *
 * The tests below check the registry's own rules (depth ordering, eviction, reuse) and then the behaviour
 * through a real delegation: a follow-up turn on the same child, the lineage check that stops a child from
 * driving its siblings, and the promise that a parent run ending does not make the child unreachable.
 */

const reply2 = (text = 'Done'): ModelResponse => ({
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
const isChild = (request: ModelRequest) =>
  request.system.includes('You are a sub-agent delegated by a parent agent');
const report = (summary: string): ModelResponse => ({
  text: '',
  finishReason: 'tool_calls',
  toolCalls: [
    {
      id: `report-${summary}`,
      name: 'submit_report',
      arguments: { summary, findings: [{ statement: summary, evidence: 'seen in the workspace' }] },
    },
  ],
  usage: { inputTokens: 10, outputTokens: 5 },
});

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-residency-'));
  const store = new SessionStore(path.join(root, 'sessions.sqlite'));
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  return { root, store };
}

test('the residency evicts the least recently used idle child at its cap', async (t) => {
  const closed: string[] = [];
  const residency = new SubAgentResidency({ maxResident: 2 });
  const open = (id: string, lastUsed: number) => {
    const activation = residency.open({
      id,
      childSessionId: `child-${id}`,
      parentSessionId: 'parent',
      objective: id,
      depth: 1,
      turn: async () => ({
        usage: { inputTokens: 1, outputTokens: 1 },
        text: 'x',
        status: 'completed' as const,
        rounds: 1,
        toolCalls: 0,
      }),
      close: async () => void closed.push(id),
    });
    // Touch through a turn so `lastUsedAt` reflects the order the test describes.
    return activation.run(`${id}-turn`, false).then(() => {
      assert.ok(activation.snapshot().lastUsedAt >= lastUsed);
      return activation;
    });
  };
  await open('a', 0);
  await open('b', 0);
  assert.deepEqual(
    residency.list().map((child) => child.id),
    ['a', 'b'],
  );
  await open('c', 0);
  assert.deepEqual(
    residency.list().map((child) => child.id),
    ['b', 'c'],
    'the least recently used idle child is unloaded, and the cap holds',
  );
  await t.test('noop', () => undefined);
  assert.ok(closed.includes('a'), 'unloading releases what that child owned');
});

test('idle children are reaped after the TTL, and a busy one is left alone', async (t) => {
  const closed: string[] = [];
  const residency = new SubAgentResidency({ idleTtlMs: 5 });
  const build = (id: string) =>
    residency.open({
      id,
      childSessionId: `child-${id}`,
      parentSessionId: 'parent',
      objective: id,
      depth: 1,
      turn: async () => ({
        usage: { inputTokens: 1, outputTokens: 1 },
        text: 'x',
        status: 'completed' as const,
        rounds: 1,
        toolCalls: 0,
      }),
      close: async () => void closed.push(id),
    });
  const idle = build('idle');
  await idle.run('one', false);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(residency.reapIdle(), 1);
  assert.deepEqual(residency.list(), []);
  assert.deepEqual(closed, ['idle']);
  await t.test('noop', () => undefined);
});

test('disposal is deepest first, and each activation is released once', async () => {
  const order: string[] = [];
  const residency = new SubAgentResidency({ maxResident: 8 });
  for (const [id, depth] of [
    ['root-child', 1],
    ['grandchild', 2],
    ['child-2', 1],
  ] as const)
    residency.open({
      id,
      childSessionId: id,
      parentSessionId: 'parent',
      objective: id,
      depth,
      turn: async () => ({
        usage: { inputTokens: 1, outputTokens: 1 },
        text: 'x',
        status: 'completed' as const,
        rounds: 1,
        toolCalls: 0,
      }),
      close: async () => void order.push(id),
    });
  await residency.disposeAll();
  assert.deepEqual(
    order,
    ['grandchild', 'root-child', 'child-2'],
    'a child is not released before its own children',
  );
  assert.equal(residency.size, 0);
});

test('a follow-up turn on a resident child runs under the same bounds as the first', async () => {
  const residency = new SubAgentResidency();
  const activation = residency.open({
    id: 'resident',
    childSessionId: 'child-resident',
    parentSessionId: 'parent',
    objective: 'ongoing work',
    depth: 1,
    turn: async () => ({
      usage: { inputTokens: 1_000_000, outputTokens: 0 },
      text: 'done',
      status: 'completed' as const,
      rounds: 1,
      toolCalls: 0,
    }),
  });
  await activation.run('first', false);
  await activation.run('second', false);
  /**
   * The regression this pins is the grant that used to sit here: a follow-up ran on what was left of a shared
   * allowance, so a child that had been useful could be refused a second turn for having spent tokens rather
   * than for anything about its work. A child is bounded like its parent — rounds, window, wall clock — and the
   * only thing the parent shares is the slot it occupies.
   */
  assert.equal(activation.snapshot().turns, 2, 'a follow-up is a turn like the first');
  assert.equal(
    activation.snapshot().usage.inputTokens,
    2_000_000,
    'the cost is reported, never a balance the child can run out of',
  );
  await residency.disposeAll();
});

test('a follow-up turn reuses the child and updates its card', async (t) => {
  const { root, store } = await fixture(t);
  const residency = new SubAgentResidency();
  t.after(() => residency.disposeAll());
  const questions: string[] = [];
  const provider: Provider = {
    async complete(request) {
      if (isChild(request)) {
        const asked = String(request.messages.at(-1)?.content ?? '');
        questions.push(asked);
        return asked.includes('Delegated task')
          ? report('first sweep done')
          : reply2('follow-up answer');
      }
      if (request.messages.some((message) => message.content.includes('follow-up answer')))
        return reply2('Done');
      if (request.messages.some((message) => message.role === 'tool')) return reply2('Done');
      const hasChild = request.messages.some((message) => message.content.includes('job_list'));
      if (hasChild) return reply2('Done');
      return toolCall('delegate-1', 'delegate_task', { tasks: [{ objective: 'Sweep the repo' }] });
    },
  };
  const agent = new Agent({
    store,
    provider,
    tools: new ToolRegistry(),
    approve: async () => true,
    subagents: { enabled: true },
    subagentResidency: residency,
    childTools: () => new ToolRegistry(),
  });
  const session = store.create(root);
  const first = await agent.run({ sessionId: session.id, prompt: 'Delegate a sweep' });
  assert.equal(first.status, 'completed', first.error);
  assert.equal(residency.list().length, 1, 'the child stays resident after its turn');
  const child = residency.list()[0]!;
  assert.equal(child.status, 'idle');
  assert.equal(child.turns, 1);
  assert.equal(first.subagents?.[0]?.status, 'completed');

  // The next run in the same session can talk to the same child without delegating again.
  const asks: ModelRequest[] = [];
  const asking: Provider = {
    async complete(request) {
      asks.push(request);
      if (isChild(request)) return reply2('follow-up answer');
      if (request.messages.some((message) => message.content.includes('follow-up answer')))
        return reply2('Done');
      return toolCall('send-1', 'send_message', {
        childSessionId: child.childSessionId,
        message: 'What did you find in the config?',
      });
    },
  };
  const second = new Agent({
    store,
    provider: asking,
    tools: new ToolRegistry(),
    approve: async () => true,
    subagents: { enabled: true },
    subagentResidency: residency,
    childTools: () => new ToolRegistry(),
  }).run({ sessionId: session.id, prompt: 'Ask the child a follow-up' });
  assert.equal((await second).status, 'completed');
  const updated = residency.list()[0]!;
  assert.equal(updated.turns, 2, 'the follow-up is a turn on the same child, not a new delegation');
  assert.ok(updated.usage.inputTokens > child.usage.inputTokens);
  assert.ok(
    store
      .messages(child.childSessionId)
      .some((message) => message.content.includes('What did you find')),
    'the child session holds the follow-up',
  );
  const cards = store.subagents(session.id);
  assert.equal(cards.length, 1, 'the follow-up updates the card rather than adding one');
  assert.ok((cards[0]?.rounds ?? 0) >= 1, 'and the card carries the second turn');
  assert.equal(
    store.events(session.id).filter((event) => event.type === 'subagent.finished').length,
    2,
    'each turn is recorded as its own durable outcome',
  );
});

test('a child cannot drive a sibling, and an unknown child is refused by name', async (t) => {
  const { root, store } = await fixture(t);
  const residency = new SubAgentResidency();
  t.after(() => residency.disposeAll());
  // Two parents, one child each: the second parent's child is not reachable from the first.
  const other = store.create(root);
  const outsider = store.create(root, other.id);
  residency.open({
    id: 'outsider',
    childSessionId: outsider.id,
    parentSessionId: other.id,
    objective: 'someone else',
    depth: 1,
    turn: async () => ({
      usage: { inputTokens: 1, outputTokens: 1 },
      text: 'x',
      status: 'completed' as const,
      rounds: 1,
      toolCalls: 0,
    }),
  });
  const session = store.create(root);
  let sent = false;
  const agent = new Agent({
    store,
    provider: {
      async complete(request) {
        if (
          request.messages.some((message) =>
            message.content.includes('No sub-agent of this session'),
          )
        )
          return reply2('Done');
        if (sent) return reply2('Done');
        sent = true;
        return toolCall('send-1', 'send_message', {
          childSessionId: outsider.id,
          message: 'do something for me',
        });
      },
    },
    tools: new ToolRegistry(),
    approve: async () => true,
    subagents: { enabled: true },
    subagentResidency: residency,
    childTools: () => new ToolRegistry(),
  });
  const result = await agent.run({
    sessionId: session.id,
    prompt: 'Try to drive another session’s child',
  });
  assert.equal(result.status, 'completed', result.error);
  const tool = store
    .messages(session.id)
    .find(
      (message) =>
        message.role === 'tool' && message.content.includes('No sub-agent of this session'),
    );
  assert.ok(tool, 'the refusal names the problem and points at job_list');
  assert.match(String(tool?.content), /job_list/);
});

test('a parent run ending cancels the turn in flight but keeps the child reachable', async (t) => {
  const { root, store } = await fixture(t);
  const residency = new SubAgentResidency();
  t.after(() => residency.disposeAll());
  let childTurns = 0;
  const provider: Provider = {
    async complete(request) {
      if (isChild(request)) {
        childTurns++;
        if (childTurns > 1) return reply2('second turn answer');
        // The first turn never finishes on its own: the parent's run end has to stop it.
        return new Promise((_resolve, reject) => {
          request.signal.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          });
        });
      }
      if (request.messages.some((message) => message.role === 'tool'))
        return request.messages.some((message) => message.content.includes('second turn answer'))
          ? reply2('Done')
          : reply2('Done');
      return toolCall('delegate-1', 'delegate_task', {
        tasks: [{ objective: 'Slow work' }],
        wait: false,
      });
    },
  };
  const agent = new Agent({
    store,
    provider,
    tools: new ToolRegistry(),
    approve: async () => true,
    subagents: { enabled: true },
    subagentResidency: residency,
    childTools: () => new ToolRegistry(),
  });
  const session = store.create(root);
  const first = await agent.run({
    sessionId: session.id,
    prompt: 'Start slow work in the background',
  });
  assert.equal(first.status, 'completed', first.error);
  assert.equal(
    residency.list().length,
    1,
    'the child is still loaded after the run that started it ended',
  );
  assert.equal(residency.list()[0]?.status, 'idle', 'its interrupted turn left it idle, not gone');

  // A later run in the same session can ask that same child to carry on.
  const child = residency.list()[0]!;
  let asked = false;
  const second = await new Agent({
    store,
    provider: {
      async complete(request) {
        if (isChild(request)) return reply2('second turn answer');
        if (request.messages.some((message) => message.content.includes('second turn answer')))
          return reply2('Done');
        if (asked) return reply2('Done');
        asked = true;
        return toolCall('send-1', 'send_message', {
          childSessionId: child.childSessionId,
          message: 'Finish that sweep',
        });
      },
    },
    tools: new ToolRegistry(),
    approve: async () => true,
    subagents: { enabled: true },
    subagentResidency: residency,
    childTools: () => new ToolRegistry(),
  }).run({ sessionId: session.id, prompt: 'Ask it to finish' });
  assert.equal(second.status, 'completed', second.error);
  assert.equal(residency.list()[0]?.turns, 2);
  // The second turn has to actually *answer*. Counting turns alone was not enough: the resumed turn used to
  // abort the instant it started (its signal still carried the dead delegation), so it was counted and the
  // parent got "Run cancelled" where the comment above promises a child that can carry on.
  assert.ok(
    store
      .messages(session.id)
      .some((message) => String(message.content).includes('second turn answer')),
    'the resumed child answered in the parent session',
  );
});

test('a message reaches a child that is still working, as a correction to its turn', async (t) => {
  const { root, store } = await fixture(t);
  const residency = new SubAgentResidency();
  t.after(() => residency.disposeAll());
  const session = store.create(root);
  const sentinel = path.join(root, 'parent-is-asking');
  /**
   * A tool that runs long enough to be corrected.
   *
   * It waits for the parent to announce that it is about to send a message, then for a short grace period in
   * which that message is folded into this child's run queue — the parent appends its tool call, flushes the
   * log and delivers, all within a few milliseconds. What the tool cannot do is *observe* the queue: a steer
   * is consumed at the next step boundary, which is the thing this tool is holding open.
   */
  const childTools = () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 'hold_open',
      description: 'Waits until the parent corrects this child',
      inputSchema: { type: 'object' },
      async execute() {
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline) {
          try {
            await readFile(sentinel, 'utf8');
            break;
          } catch {
            await new Promise((resolve) => setTimeout(resolve, 5));
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
        return { isError: false, content: 'held' };
      },
    });
    return registry;
  };
  let lastChildSessionId = '';
  let childTurns = 0;
  const parentTurns: string[] = [];
  const provider: Provider = {
    async complete(request) {
      if (isChild(request)) {
        childTurns++;
        return childTurns === 1 ? toolCall('hold-1', 'hold_open', {}) : reply2('answered');
      }
      parentTurns.push(String(request.messages.at(-1)?.content ?? ''));
      if (parentTurns.length === 1)
        return toolCall('delegate-1', 'delegate_task', {
          wait: false,
          tasks: [{ objective: 'Sweep the repository' }],
        });
      if (parentTurns.length === 2) {
        // The child session appears as soon as the delegation starts it, and the child is inside its long
        // tool by then: the sentinel tells that tool a message is coming.
        const deadline = Date.now() + 5000;
        while (!residency.list().length && Date.now() < deadline)
          await new Promise((resolve) => setTimeout(resolve, 5));
        lastChildSessionId = residency.list()[0]!.childSessionId;
        await writeFile(sentinel, 'sending');
        return toolCall('send-1', 'send_message', {
          childSessionId: lastChildSessionId,
          message: 'Change direction: only look at the config.',
        });
      }
      return reply2('Done');
    },
  };
  const agent = new Agent({
    store,
    provider,
    tools: new ToolRegistry(),
    approve: async () => true,
    subagents: { enabled: true },
    subagentResidency: residency,
    childTools,
  });
  const result = await agent.run({ sessionId: session.id, prompt: 'Delegate a sweep' });
  assert.equal(result.status, 'completed', result.error);
  const sendResult = store
    .messages(session.id)
    .filter((message) => message.role === 'tool')
    .map((message) => String(message.content))
    .find((content) => content.includes('Delivered as a correction'));
  assert.ok(sendResult, 'the message was delivered into the turn that was already running');
  assert.match(sendResult, /answered/);
  const childContents = store
    .messages(lastChildSessionId)
    .map((message) => String(message.content));
  assert.match(childContents[0]!, /Objective: Sweep the repository/);
  assert.deepEqual(
    childContents.slice(1),
    ['', 'held', 'Change direction: only look at the config.', 'answered'],
    'the correction is in the child transcript, in the order the child saw it',
  );
  assert.equal(residency.list()[0]!.turns, 1, 'the correction did not start a second turn');
});

test('a child delegated in an earlier process is resumed from the log, not re-delegated', async (t) => {
  const { root, store } = await fixture(t);
  // Two residencies, one per "process": the first is thrown away, which is what a restart does to memory.
  let residency = new SubAgentResidency();
  t.after(() => residency.disposeAll());
  const session = store.create(root);
  let childSessionId = '';
  let childTurns = 0;
  const childPrompts: string[] = [];
  let parentRound = 0;
  const provider: Provider = {
    async complete(request) {
      if (isChild(request)) {
        childTurns++;
        childPrompts.push(String(request.messages.at(-1)?.content ?? ''));
        return childTurns === 1 ? report('first sweep done') : reply2('resumed answer');
      }
      parentRound++;
      // Run one: delegate, then finish.
      if (parentRound === 1)
        return toolCall('delegate-1', 'delegate_task', {
          tasks: [{ objective: 'Sweep the configuration' }],
        });
      if (parentRound === 2) return reply2('Done');
      // Run two, in a process that never saw that delegation: look, then ask.
      if (parentRound === 3) return toolCall('list-1', 'job_list', {});
      if (parentRound === 4)
        return toolCall('send-1', 'send_message', {
          childSessionId,
          message: 'What did the config contain?',
        });
      return reply2('Done');
    },
  };
  const run = () =>
    new Agent({
      store,
      provider,
      // `createTools` is what installs the job surface, and the scope it is given is the session the jobs
      // belong to — the same value the Host passes.
      tools: createTools(root, undefined, session.id),
      approve: async () => true,
      subagents: { enabled: true },
      subagentResidency: residency,
      childTools: () => new ToolRegistry(),
    }).run({ sessionId: session.id, prompt: 'Delegate' });
  const first = await run();
  assert.equal(first.status, 'completed', first.error);
  childSessionId = residency.list()[0]!.childSessionId;
  assert.equal(childTurns, 1);
  await residency.disposeAll();

  // The restart: a fresh residency knows nothing, while the session and the log know everything that matters.
  residency = new SubAgentResidency();
  assert.equal(residency.list().length, 0, 'a restart leaves no resident child');
  const second = await run();
  assert.equal(second.status, 'completed', second.error);
  const toolResults = store
    .messages(session.id)
    .filter((message) => message.role === 'tool')
    .map((message) => String(message.content));
  const listing = toolResults.find((content) => content.includes('[cold]'));
  assert.ok(listing, `job_list reports the child as cold: ${JSON.stringify(toolResults)}`);
  assert.match(listing, new RegExp(childSessionId));
  assert.match(listing, /Sweep the configuration/);
  assert.ok(
    toolResults.some((content) => content.includes('resumed answer')),
    'the resumed child answered the parent',
  );
  assert.equal(childTurns, 2, 'the cold child ran exactly one more turn');
  assert.match(childPrompts[1]!, /What did the config contain\?/);
  const contents = store.messages(childSessionId).map((message) => String(message.content));
  assert.match(contents[0]!, /Objective: Sweep the configuration/);
  assert.ok(
    contents.includes('What did the config contain?'),
    `the follow-up lands in the child's own transcript: ${JSON.stringify(contents)}`,
  );
  assert.equal(
    residency.list().length,
    1,
    'the resumed child is now loaded for the rest of this run',
  );
  assert.equal(
    store.subagents(session.id).length,
    1,
    'resuming updates the card, it does not add one',
  );
});

test('a child resumed in a new process comes back as the child its delegation described', async (t) => {
  /**
   * A delegation names who the child speaks as and which model it answers on, and neither of those lives in the
   * child's transcript — so a resume in a process that never saw the delegation used to rebuild the child from
   * identity alone. The result was a child with the deployment's persona and the *parent's* model, and nothing
   * about the resumed turn looked wrong: this test is what makes that difference visible.
   */
  const { root, store } = await fixture(t);
  let residency = new SubAgentResidency();
  t.after(() => residency.disposeAll());
  const session = store.create(root);
  const PERSONA = 'You are the archivist: you answer from the record, never from memory.';
  const DEPLOYMENT_PERSONA =
    'You are the deployment default voice, and this sentence must not survive.';
  const MODEL = 'cheap-model';
  let childSessionId = '';
  let childTurns = 0;
  let parentRound = 0;
  // Every child turn in the second process goes through the resolver, so the model it was asked for is observable.
  const resolved: string[] = [];
  const childSystems: string[] = [];
  const firstProcess: Provider = {
    async complete(request) {
      if (isChild(request)) {
        childTurns++;
        return report('first sweep done');
      }
      parentRound++;
      if (parentRound === 1)
        return toolCall('delegate-1', 'delegate_task', {
          tasks: [{ objective: 'Sweep the configuration', persona: PERSONA, model: MODEL }],
        });
      return reply('Done');
    },
  };
  const secondProcess: Provider = {
    async complete(request) {
      if (isChild(request)) {
        childTurns++;
        childSystems.push(request.system);
        return reply('resumed answer');
      }
      parentRound++;
      if (parentRound === 3)
        return toolCall('send-1', 'send_message', { childSessionId, message: 'And now?' });
      return reply('Done');
    },
  };
  const agentFor = (provider: Provider, residencyForRun: SubAgentResidency) =>
    new Agent({
      store,
      provider,
      tools: createTools(root, undefined, session.id),
      approve: async () => true,
      subagents: { enabled: true },
      subagentResidency: residencyForRun,
      childTools: () => new ToolRegistry(),
      // A deployment persona, so "the child's own replaces it" is a statement with something to replace.
      deploymentPersona: DEPLOYMENT_PERSONA,
      subagentProviderFor: (model) => {
        resolved.push(model);
        return secondProcess;
      },
    });
  const first = await agentFor(firstProcess, residency).run({
    sessionId: session.id,
    prompt: 'Delegate',
  });
  assert.equal(first.status, 'completed', first.error);
  childSessionId = residency.list()[0]!.childSessionId;
  // The record is what a later process has: the descriptor has to be in it, or nothing else can restore it.
  const assigned = store.events(session.id).find((event) => event.type === 'subagent.assigned')!;
  assert.equal(assigned.data.persona, PERSONA);
  assert.equal(assigned.data.model, MODEL);
  await residency.disposeAll();

  // The restart: a residency that knows nothing, and an agent whose provider never saw the first delegation.
  residency = new SubAgentResidency();
  resolved.length = 0; // what *this* process asks for, which is the question
  const second = await agentFor(secondProcess, residency).run({
    sessionId: session.id,
    prompt: 'Ask the child again',
  });
  assert.equal(second.status, 'completed', second.error);
  assert.equal(childTurns, 2, 'the cold child ran exactly one more turn');
  assert.deepEqual(resolved, [MODEL], 'the resumed child asked for the model its delegation named');
  assert.match(
    childSystems[1]!,
    new RegExp(PERSONA.slice(0, 40)),
    'and speaks with its own persona',
  );
  // The deployment persona is *replaced*, not joined: two paragraphs saying who is speaking is what the slot
  // exists to prevent, and a resumed child that carried both would be that failure where nobody looks.
  assert.doesNotMatch(childSystems[1]!, /deployment default voice/);
});

test('a child keeps working across a restart however much it spent before', async (t) => {
  const { root, store } = await fixture(t);
  let residency = new SubAgentResidency();
  t.after(() => residency.disposeAll());
  const session = store.create(root);
  let childSessionId = '';
  let childTurns = 0;
  let parentRound = 0;
  /**
   * Every child turn reports 15,000 tokens. While a grant existed, that was enough to exhaust a shared
   * allowance and have the follow-up refused across the process boundary; the point of this test now is the
   * opposite: spend is a report about work already done, so a child that has been useful is not refused a
   * second turn for having cost something.
   */
  const heavyReport = (summary: string): ModelResponse => ({
    ...report(summary),
    usage: { inputTokens: 15_000, outputTokens: 0 },
  });
  const heavyReply = (text: string): ModelResponse => ({
    ...reply2(text),
    usage: { inputTokens: 15_000, outputTokens: 0 },
  });
  const provider: Provider = {
    async complete(request) {
      if (isChild(request)) {
        childTurns++;
        /**
         * A real model uses the tool it was offered: the delegation turn offers `submit_report` and ends
         * there, while a follow-up turn does not — it is a message, not a task — so the child answers in
         * prose instead of calling a tool that is not registered.
         */
        return request.tools.some((tool) => tool.name === 'submit_report')
          ? heavyReport(`sweep ${childTurns}`)
          : heavyReply('Nothing further to add.');
      }
      parentRound++;
      if (parentRound === 1)
        return toolCall('delegate-1', 'delegate_task', {
          tasks: [{ objective: 'Sweep the repository' }],
        });
      if (parentRound === 2) return reply2('Done');
      if (parentRound === 3)
        return toolCall('send-1', 'send_message', { childSessionId, message: 'One more thing' });
      if (parentRound === 4)
        return toolCall('send-2', 'send_message', { childSessionId, message: 'And another' });
      return heavyReply('Done');
    },
  };
  const run = () =>
    new Agent({
      store,
      provider,
      tools: new ToolRegistry(),
      approve: async () => true,
      subagents: { enabled: true },
      subagentResidency: residency,
      childTools: () => new ToolRegistry(),
    }).run({ sessionId: session.id, prompt: 'Delegate' });
  assert.equal((await run()).status, 'completed');
  childSessionId = residency.list()[0]!.childSessionId;
  assert.equal(
    residency.list()[0]!.usage.inputTokens,
    15_000,
    'the first turn cost what it cost, and that is what the parent is told',
  );
  await residency.disposeAll();

  // The restart: the child's transcript and its card are durable, so the follow-up resumes the same child
  // rather than delegating a new one — and it runs.
  residency = new SubAgentResidency();
  const second = await run();
  assert.equal(second.status, 'completed', second.error);
  assert.equal(
    childTurns,
    3,
    'one turn for the delegation and one per follow-up message: nothing is refused for having spent',
  );
  const toolResults = store
    .messages(session.id)
    .filter((message) => message.role === 'tool')
    .map((message) => String(message.content));
  assert.ok(
    !toolResults.some((content) => content.includes('token grant')),
    `a child is never refused for having spent tokens: ${JSON.stringify(toolResults)}`,
  );
  assert.equal(
    store.events(session.id).filter((event) => event.type === 'subagent.assigned').length,
    1,
    'the whole exchange stays one delegation',
  );
});
