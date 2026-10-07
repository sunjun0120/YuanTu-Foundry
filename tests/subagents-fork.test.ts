/**
 * Forking a sub-agent, and discovering which models one may be run on.
 *
 * These drive a real `Agent` with a scripted provider, because the property under test is what the child
 * session contains when its first request is built 鈥?which is only observable through the real loop.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Agent } from '../packages/core/agent.ts';
import { forkSeed } from '../packages/core/fork.ts';
import { EXPLORE_TOOLS } from '../packages/core/subagents.ts';
import {
  SubAgentCapabilityError,
  SubAgentProviderRegistry,
  inProcessProvider,
} from '../packages/core/subagent-providers.ts';
import type { SubAgentProvider } from '../packages/core/subagent-providers.ts';
import { SessionStore } from '../packages/storage/sqlite.ts';
import { createTools } from '../packages/tools/index.ts';
import type { Message, ModelRequest, ModelResponse, Provider } from '../packages/protocol/index.ts';

const reply = (text = 'Finished'): ModelResponse => ({
  text,
  toolCalls: [],
  finishReason: 'stop',
  usage: { inputTokens: 10, outputTokens: 5 },
});
const call = (id: string, name: string, args: Record<string, unknown>): ModelResponse => ({
  text: '',
  finishReason: 'tool_calls',
  toolCalls: [{ id, name, arguments: args }],
  usage: { inputTokens: 10, outputTokens: 5 },
});
const submitReport = (id: string): ModelResponse =>
  call(id, 'submit_report', {
    summary: 'Answer',
    findings: [{ statement: 'A statement', evidence: 'The evidence I saw' }],
  });
const forkCall = (id: string, tasks: unknown[], wait?: boolean): ModelResponse =>
  call(id, 'subagent_fork', { tasks, ...(wait === undefined ? {} : { wait }) });
const delegateCall = (id: string, tasks: unknown[]): ModelResponse =>
  call(id, 'delegate_task', { tasks });
const SUBAGENT_MARK = 'You are a sub-agent delegated by a parent agent';
const isChild = (request: ModelRequest): boolean => request.system.includes(SUBAGENT_MARK);
const lastRole = (request: ModelRequest): string => request.messages.at(-1)?.role ?? '';
/** The text of all the tool messages in a request, which is how a scripted provider reads its results. */
const toolText = (request: ModelRequest | Message[]): string =>
  (Array.isArray(request) ? request : request.messages)
    .filter((message) => message.role === 'tool')
    .map((message) => (message.role === 'tool' ? message.content : ''))
    .join('\n');
const body = (messages: readonly Message[]): string =>
  messages.map((message) => ('content' in message ? message.content : '')).join('\n');
async function fixture(
  t: test.TestContext,
  provider: Provider,
  extra: Record<string, unknown> = {},
): Promise<{ store: SessionStore; sessionId: string; agent: Agent }> {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-fork-'));
  const store = new SessionStore(path.join(root, 'sessions.sqlite'));
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const session = store.create(root);
  const agent = new Agent({
    store,
    provider,
    tools: createTools(root),
    approve: async () => true,
    subagents: { enabled: true },
    ...extra,
  });
  return { store, sessionId: session.id, agent };
}
/** The children the parent's own durable log remembers. */
function children(store: SessionStore, parentId: string): string[] {
  return store
    .events(parentId)
    .filter((event) => event.type === 'subagent.assigned')
    .map((event) => String(event.data.childSessionId));
}
/** A parent that forks once and then answers with whatever the tool told it. */
function forkingChild(child: (request: ModelRequest) => ModelResponse): Provider {
  return {
    async complete(request) {
      if (isChild(request)) return child(request);
      if (lastRole(request) === 'tool') return reply(toolText(request));
      return forkCall('fork-1', [{ objective: 'Continue the investigation' }]);
    },
  };
}

test('a forked child starts from the parent transcript, before its own task prompt', async (t) => {
  let childRequest: ModelRequest | undefined;
  const { store, sessionId, agent } = await fixture(
    t,
    forkingChild((request) => {
      childRequest ??= request;
      return submitReport('report-1');
    }),
  );
  // Two exchanges before the fork, so "the prefix" is more than the prompt that triggered it.
  store.append(sessionId, { role: 'user', content: 'First question about the loader' });
  store.append(sessionId, {
    role: 'assistant',
    content: 'Looking',
    toolCalls: [{ id: 'call-a', name: 'read_file', arguments: { path: 'a.ts' } }],
  });
  store.append(sessionId, {
    role: 'tool',
    toolCallId: 'call-a',
    content: 'the loader lives in a.ts',
    isError: false,
  });
  store.append(sessionId, { role: 'assistant', content: 'It lives in a.ts', toolCalls: [] });

  const result = await agent.run({ sessionId, prompt: 'Now fork this and dig deeper' });
  assert.equal(result.status, 'completed', result.error);
  assert.ok(childRequest, 'the child ran');
  assert.deepEqual(
    childRequest.messages.slice(0, 4).map((message) => message.role),
    ['user', 'assistant', 'tool', 'assistant'],
    'the inherited conversation comes first, in order',
  );
  assert.deepEqual(
    childRequest.messages
      .slice(0, 3)
      .map((message) => ('content' in message ? message.content : '')),
    ['First question about the loader', 'Looking', 'the loader lives in a.ts'],
    'the inherited text is the parent own, verbatim',
  );
  // The parent's latest prompt is part of "the conversation so far", and the delegated task comes after
  // everything inherited, never the other way round.
  const all = body(childRequest.messages);
  assert.ok(all.indexOf('the loader lives in a.ts') < all.indexOf('Now fork this and dig deeper'));
  assert.ok(all.indexOf('Now fork this and dig deeper') < all.indexOf('Objective: Continue'));
  assert.match(all, /Objective: Continue the investigation/);
  // The child's session really holds that prefix.
  const childId = children(store, sessionId)[0]!;
  assert.match(body(store.messages(childId)), /First question about the loader/);
});

test('a trimmed fork keeps the newest messages and says what it dropped', async (t) => {
  const { store, sessionId, agent } = await fixture(
    t,
    forkingChild(() => submitReport('r1')),
    {
      forkTranscriptChars: 600,
      forkTranscriptMessages: 50,
    },
  );
  for (let index = 0; index < 8; index++) {
    store.append(sessionId, { role: 'user', content: `Question ${index} ${'x'.repeat(120)}` });
    store.append(sessionId, { role: 'assistant', content: `Answer ${index}`, toolCalls: [] });
  }
  const result = await agent.run({ sessionId, prompt: 'fork now' });
  assert.equal(result.status, 'completed', result.error);
  const childId = children(store, sessionId)[0]!;
  const inherited = store.messages(childId);
  assert.ok(inherited.length > 2, 'the child inherited more than its own task prompt');
  assert.match(body(inherited), /Question 7/, 'the newest messages are the ones kept');
  assert.ok(!body(inherited).includes('Question 0'), 'the oldest messages were dropped');
  // The parent is told, because a parent that assumed the child saw everything it saw would be wrong.
  assert.match(
    toolText(store.messages(sessionId)),
    /\d+ message\(s\) were omitted to fit the fork budget or exclude an incomplete trailing tool batch/,
  );
});

test('the fork budget keeps the newest messages, and never begins with an orphan tool result', () => {
  const messages: Message[] = [
    { role: 'user', content: 'u1' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'read_file', arguments: {} }] },
    { role: 'tool', toolCallId: 'c1', content: 'r1', isError: false },
    { role: 'user', content: 'u2' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'c2', name: 'read_file', arguments: {} }] },
    { role: 'tool', toolCallId: 'c2', content: 'r2', isError: false },
    { role: 'user', content: 'u3' },
  ];
  const roomy = forkSeed(messages, { chars: 100_000, messages: 100 });
  assert.deepEqual(roomy.messages, messages, 'everything fits, so everything is copied');
  assert.equal(roomy.dropped, 0);

  // Room for the last four messages only, which would start at the assistant's call for `c2`.
  const four = messages.slice(3);
  const budget = forkSeed(messages, {
    chars: four.reduce((total, message) => total + JSON.stringify(message).length, 0),
    messages: four.length,
  });
  assert.deepEqual(
    budget.messages.map((message) => ('content' in message ? message.content : '')),
    ['u2', '', 'r2', 'u3'],
    'the cut moves forward to the first user turn, so the copy is a readable conversation',
  );
  assert.equal(budget.dropped, 3);
  assert.ok(
    !budget.messages.some((message) => message.role === 'tool' && message.toolCallId === 'c1'),
    'no tool result survives without the call it answers',
  );

  // A transcript whose tail has no user turn at all can only be copied as nothing.
  assert.deepEqual(
    forkSeed([{ role: 'assistant', content: 'orphan', toolCalls: [] }], {
      chars: 1000,
      messages: 10,
    }).messages,
    [],
  );
  assert.equal(forkSeed([], { chars: 1000, messages: 10 }).dropped, 0);
  // A single message larger than the whole budget leaves nothing, and says so rather than truncating it.
  const nothing = forkSeed([{ role: 'user', content: 'x'.repeat(500) }], {
    chars: 100,
    messages: 10,
  });
  assert.deepEqual(nothing.messages, []);
  assert.equal(nothing.dropped, 1);
});

test('fork seeds omit incomplete trailing tool batches before applying the budget', () => {
  const prefix: Message[] = [{ role: 'user', content: 'Keep this request' }];
  const batch: Message = {
    role: 'assistant',
    content: '',
    toolCalls: ['a', 'b'].map((id) => ({ id, name: 'read_file', arguments: {} })),
  };
  const answer = (id: string): Message => ({
    role: 'tool',
    toolCallId: id,
    content: 'fixture',
    isError: false,
  });
  for (const tail of [[batch], [batch, answer('a')], [batch, answer('b')]]) {
    const result = forkSeed([...prefix, ...tail], { chars: 100000, messages: 100 });
    assert.deepEqual(result.messages, prefix);
    assert.equal(result.dropped, tail.length);
    assert.equal(result.chars, JSON.stringify(prefix[0]).length);
  }
  const complete = [...prefix, batch, answer('a'), answer('b')];
  assert.deepEqual(forkSeed(complete, { chars: 100000, messages: 100 }).messages, complete);
  assert.deepEqual(
    forkSeed([...prefix, batch, answer('a')], { chars: 100000, messages: 1 }).messages,
    prefix,
  );
});

test('a provider that does not declare contextFork refuses subagent_fork and creates no session', async (t) => {
  const fake: SubAgentProvider = inProcessProvider({
    name: 'no-fork',
    capabilities: ['outputSchema', 'depthLimit', 'toolFilter', 'persona'],
    run: async () => {
      throw new Error('this provider must never be reached');
    },
  });
  const provider: Provider = {
    async complete(request) {
      if (lastRole(request) === 'tool') return reply(toolText(request));
      return forkCall('fork-1', [{ objective: 'Continue' }]);
    },
  };
  const { store, sessionId, agent } = await fixture(t, provider, {
    subagentProvider: 'no-fork',
    subagentProviders: [fake],
  });
  const result = await agent.run({ sessionId, prompt: 'fork' });
  assert.equal(result.status, 'completed', result.error);
  const text = toolText(store.messages(sessionId));
  assert.match(text, /UNSUPPORTED_CAPABILITY/);
  assert.match(text, /contextFork/);
  assert.deepEqual(children(store, sessionId), [], 'a refused fork leaves no child behind');
});

test('the capability is asked for only when it is wanted, and false asks for nothing', () => {
  const registry = new SubAgentProviderRegistry();
  let ran = 0;
  registry.register(
    inProcessProvider({
      name: 'forky',
      capabilities: ['contextFork'],
      run: async () => {
        ran++;
        throw new Error('unused');
      },
    }),
  );
  assert.equal(registry.resolve('forky', { contextFork: true }).name, 'forky');
  assert.equal(registry.resolve('forky', { contextFork: false }).name, 'forky');
  assert.equal(registry.resolve('forky', {}).name, 'forky');
  assert.throws(
    () => registry.resolve('forky', { persona: 'x' }),
    (error: unknown) => error instanceof SubAgentCapabilityError && error.capability === 'persona',
  );
  assert.equal(ran, 0);
});

test('delegation is what a read-only child loses, fork included', async (t) => {
  let childTools: string[] = [];
  const provider: Provider = {
    async complete(request) {
      if (isChild(request)) {
        childTools = request.tools.map((tool) => tool.name);
        return submitReport('report-1');
      }
      if (lastRole(request) === 'tool') return reply(toolText(request));
      return delegateCall('delegate-1', [{ objective: 'Look around' }]);
    },
  };
  const { agent, sessionId } = await fixture(t, provider);
  const result = await agent.run({ sessionId, prompt: 'delegate' });
  assert.equal(result.status, 'completed', result.error);
  assert.ok(!childTools.includes('subagent_fork'));
  assert.ok(!childTools.includes('delegate_task'));
  assert.ok(!childTools.includes('list_subagent_models'));
  // The same three names are absent from the read-only allowlist, which is what makes that true.
  for (const name of ['subagent_fork', 'delegate_task', 'list_subagent_models'])
    assert.ok(!(EXPLORE_TOOLS as readonly string[]).includes(name), name);
});

test('a read-only parent may not fork a writer, and the refusal names the reason', async (t) => {
  const provider: Provider = {
    async complete(request) {
      if (lastRole(request) === 'tool') return reply(toolText(request));
      return forkCall('fork-1', [{ objective: 'Write it', role: 'general' }]);
    },
  };
  const { store, sessionId, agent } = await fixture(t, provider);
  const result = await agent.run({ sessionId, prompt: 'fork a writer', readOnly: true });
  assert.equal(result.status, 'completed', result.error);
  assert.match(result.text, /read-only/);
  assert.match(toolText(store.messages(sessionId)), /read-only/);
  assert.deepEqual(children(store, sessionId), []);
});

test('list_subagent_models answers with the declared list, and is absent when the host has none', async (t) => {
  const offered: string[] = [];
  const provider: Provider = {
    async complete(request) {
      if (lastRole(request) === 'tool') return reply(toolText(request));
      offered.push(...request.tools.map((tool) => tool.name));
      return call('list-1', 'list_subagent_models', {});
    },
  };
  const withSeam = await fixture(t, provider, {
    subagentModels: () => [{ model: 'strong-model', note: 'declared' }, { model: 'cheap-model' }],
  });
  const result = await withSeam.agent.run({
    sessionId: withSeam.sessionId,
    prompt: 'which models?',
  });
  assert.equal(result.status, 'completed', result.error);
  assert.ok(offered.includes('list_subagent_models'));
  assert.ok(offered.includes('subagent_fork'), 'the fork tool is offered beside it');
  const rendered = toolText(withSeam.store.messages(withSeam.sessionId));
  assert.match(rendered, /strong-model/);
  assert.match(rendered, /declared/);
  assert.match(rendered, /cheap-model/);
  assert.match(rendered, /refused/);

  const plainOffered: string[] = [];
  const without = await fixture(t, {
    async complete(request) {
      plainOffered.push(...request.tools.map((tool) => tool.name));
      return reply('done');
    },
  });
  const plain = await without.agent.run({ sessionId: without.sessionId, prompt: 'hello' });
  assert.equal(plain.status, 'completed', plain.error);
  assert.ok(!plainOffered.includes('list_subagent_models'), 'no seam, no tool');
});

test('a run whose first prompt is the whole history forks that one message', async (t) => {
  const { store, sessionId, agent } = await fixture(
    t,
    forkingChild(() => submitReport('r1')),
  );
  const result = await agent.run({ sessionId, prompt: 'only prompt' });
  assert.equal(result.status, 'completed', result.error);
  const childId = children(store, sessionId)[0]!;
  const inherited = store.messages(childId);
  assert.equal(inherited[0]?.role, 'user');
  assert.match(body(inherited), /only prompt/);
  assert.match(body(inherited), /Objective: Continue the investigation/);
  assert.ok(body(inherited).indexOf('only prompt') < body(inherited).indexOf('Objective:'));
});

test('a forked child is recorded in the parent log and shows up as a card', async (t) => {
  const { store, sessionId, agent } = await fixture(
    t,
    forkingChild(() => submitReport('r1')),
  );
  const result = await agent.run({ sessionId, prompt: 'fork' });
  assert.equal(result.status, 'completed', result.error);
  const [childId] = children(store, sessionId);
  assert.ok(childId, 'the assignment is durable, so a restart can still find the child');
  const assigned = store.events(sessionId).find((event) => event.type === 'subagent.assigned');
  assert.equal(
    assigned?.data.forked,
    true,
    'the log distinguishes a fork from an ordinary delegation',
  );
  const snapshot = store.snapshot(sessionId) as {
    subagents?: { children?: Record<string, { sessionId?: string }> };
  };
  assert.ok(
    Object.values(snapshot.subagents?.children ?? {}).some((child) => child.sessionId === childId),
    'the forked child appears as a card',
  );
});
