/**
 * The runtime invariant seam.
 *
 * `tests/invariants.test.ts` holds the project's promises as one test file; this file holds the machinery
 * that lets *any* package publish one — plus the three built-ins, and the proof that they are checked in a
 * process that is really doing the work rather than in the test that wrote them. Each built-in lives beside
 * the code it checks: `packages/protocol/invariants.ts`, `packages/storage/invariants.ts`, and
 * `packages/tools/pipeline.ts`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Agent } from '../packages/core/agent.ts';
import { InvariantRegistry, InvariantViolationError } from '../packages/core/invariants.ts';
import { SessionStore } from '../packages/storage/sqlite.ts';
import { createTools } from '../packages/tools/index.ts';
import { AGENT_EVENT_TYPES } from '../packages/protocol/index.ts';
import { emittedEventTypesInvariant } from '../packages/protocol/invariants.ts';
import { logTablesAgreeInvariant } from '../packages/storage/invariants.ts';
import type { LogTableReader } from '../packages/storage/invariants.ts';
import { pipelineStagesInvariant } from '../packages/tools/pipeline.ts';
import type { Invariant } from '../packages/protocol/invariants.ts';
import type { ModelResponse, Provider } from '../packages/protocol/index.ts';
import { AgentHostClient } from '../packages/client/host-client.ts';
import { httpFixture, frames, sendFrames } from './http-fixture.ts';
import { projectRoot } from './process-fixture.ts';

const reply = (text = 'Finished'): ModelResponse => ({
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
const invariant = (over: Partial<Invariant> = {}): Invariant => ({
  name: 'test.holds',
  owner: 'tests',
  description: 'a test invariant',
  scope: 'run-end',
  check: () => {},
  ...over,
});
async function fixture(
  t: test.TestContext,
  provider: Provider,
  extra: Record<string, unknown> = {},
) {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-runtime-invariants-'));
  const store = new SessionStore(path.join(root, 'sessions.sqlite'));
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const session = store.create(root);
  const invariants = new InvariantRegistry({ timeoutMs: 200 });
  invariants.register(logTablesAgreeInvariant(store));
  invariants.register(emittedEventTypesInvariant());
  invariants.register(pipelineStagesInvariant());
  const agent = new Agent({
    store,
    provider,
    tools: createTools(root),
    approve: async () => true,
    invariants,
    ...extra,
  });
  return { root, store, session, agent, invariants };
}

test('a name is owned, an unattributable invariant is refused, and disposal is per-registration', () => {
  const registry = new InvariantRegistry();
  const remove = registry.register(invariant());
  assert.deepEqual(registry.names(), ['test.holds']);
  assert.throws(
    () => registry.register(invariant({ owner: 'somebody-else' })),
    /Duplicate invariant/,
  );
  assert.throws(() => registry.register(invariant({ name: '  ' })), /needs a name/);
  assert.throws(() => registry.register(invariant({ name: 'x', owner: '' })), /needs an owner/);
  remove();
  assert.deepEqual(registry.names(), []);
  // Re-registering after disposal is a fresh registration, not a resurrection of the first one.
  const second = invariant({ description: 'the second one' });
  const removeSecond = registry.register(second);
  remove();
  assert.deepEqual(
    registry.describe(),
    [
      {
        name: 'test.holds',
        owner: 'tests',
        description: 'the second one',
        scope: 'run-end',
      },
    ],
    'a stale disposer must not delete the registration that replaced it',
  );
  removeSecond();
});

test('a check that throws, rejects or hangs is a violation, and never stops the others', async () => {
  const registry = new InvariantRegistry({ timeoutMs: 30 });
  registry.register(invariant({ name: 'a.throws', check: () => assert.fail('broken') }));
  registry.register(
    invariant({ name: 'b.rejects', check: () => Promise.reject(new Error('async broken')) }),
  );
  registry.register(invariant({ name: 'c.hangs', check: () => new Promise<void>(() => {}) }));
  let ran = false;
  registry.register(
    invariant({
      name: 'd.holds',
      check: () => {
        ran = true;
      },
    }),
  );
  registry.register(invariant({ name: 'e.other-scope', scope: 'session-close' }));

  const violations = await registry.run('run-end');
  assert.equal(violations.length, 3, 'all three broken promises are reported, not just the first');
  assert.deepEqual(
    violations.map((violation) => violation.name),
    ['a.throws', 'b.rejects', 'c.hangs'],
  );
  assert.match(violations[0]!.detail, /broken/);
  assert.match(violations[1]!.detail, /async broken/);
  assert.match(violations[2]!.detail, /did not finish within 30ms/);
  assert.equal(
    violations[2]!.owner,
    'tests',
    'a timeout is attributable to the invariant that hung',
  );
  assert.ok(ran, 'a broken promise must not stop a later check from running');
  // An empty scope is not an error: nothing was registered for it.
  assert.deepEqual(await registry.run('tool-execution'), []);
  await assert.rejects(registry.assert('run-end'), InvariantViolationError);
  await assert.rejects(
    registry.assert('run-end'),
    /a\.throws \(tests\): broken/,
    'the error names the promise and its owner',
  );
});

test('the protocol invariant refuses an event type no client would deliver', async () => {
  const registry = new InvariantRegistry();
  registry.register(emittedEventTypesInvariant());
  await registry.assert('run-end', { emittedTypes: [...AGENT_EVENT_TYPES] });
  await registry.assert('run-end', { emittedTypes: [] });
  const violations = await registry.run('run-end', {
    emittedTypes: ['run.finished', 'made.up'],
  });
  assert.equal(violations.length, 1);
  assert.match(violations[0]!.detail, /made\.up/);
  // A check that cannot see its subject reports a violation rather than passing.
  assert.match((await registry.run('run-end'))[0]!.detail, /no event types/);
});

test('the pipeline invariant reports the order a call actually took', async () => {
  const registry = new InvariantRegistry();
  registry.register(pipelineStagesInvariant());
  await registry.assert('tool-execution', { pipeline: { violations: [] } });
  const violations = await registry.run('tool-execution', {
    pipeline: {
      violations: [
        { execution: 'write_file#1', stage: 'execute', detail: 'requires guards first' },
      ],
    },
  });
  assert.equal(violations.length, 1);
  assert.equal(violations[0]!.name, 'tools.pipeline-stages');
  assert.match(violations[0]!.detail, /write_file#1 ended at execute: requires guards first/);
  assert.match((await registry.run('tool-execution'))[0]!.detail, /needs the trace/);
});

test('the storage invariant compares the log fold, the transcript read and the rows on disk', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-invariants-storage-'));
  const store = new SessionStore(path.join(root, 'sessions.sqlite'));
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const session = store.create(root);
  store.append(session.id, { role: 'user', content: 'hello' });
  store.append(session.id, { role: 'assistant', content: 'hi', toolCalls: [] });
  const registry = new InvariantRegistry();
  registry.register(logTablesAgreeInvariant(store));
  await registry.assert('run-end', { sessionId: session.id });
  // A session with no history is a valid state, not a violation.
  await registry.assert('run-end', { sessionId: store.create(root).id });
  // A check with nothing to inspect must not report success.
  assert.match((await registry.run('run-end'))[0]!.detail, /needs a session/);

  const divergent = (over: Partial<LogTableReader>): LogTableReader => ({
    events: () => store.events(session.id),
    messages: () => store.messages(session.id),
    messagesFromTable: () => store.messagesFromTable(session.id),
    childSessions: () => [],
    ...over,
  });
  const detect = async (reader: LogTableReader) => {
    const one = new InvariantRegistry();
    one.register(logTablesAgreeInvariant(reader));
    return (await one.run('run-end', { sessionId: session.id }))[0]?.detail ?? '';
  };
  assert.match(
    await detect(divergent({ messagesFromTable: () => [] })),
    /write-through rows are not the fold of the log/,
  );
  assert.match(
    await detect(
      divergent({
        events: () => store.events(session.id).filter((event) => event.type !== 'message.user'),
      }),
    ),
    /transcript read is not the fold of the log/,
  );
  assert.match(
    await detect(
      divergent({ events: () => [...store.events(session.id), store.events(session.id)[0]!] }),
    ),
    /messages from 3 message events/,
    'a message event that contributes no message is caught by the count',
  );
});

test('a real run satisfies every built-in invariant the host registers', async (t) => {
  let turns = 0;
  const provider: Provider = {
    async complete(request) {
      if (request.messages.some((message) => message.role === 'tool')) return reply('Done');
      if (turns++ === 0) return toolCall('w1', 'write_file', { path: 'a.txt', content: 'a' });
      return reply('Done');
    },
  };
  const { session, agent, invariants } = await fixture(t, provider);
  const result = await agent.run({ sessionId: session.id, prompt: 'Write a file' });
  assert.equal(result.status, 'completed', result.error);
  assert.deepEqual(
    invariants.describe().map((entry) => entry.name),
    ['storage.log-tables-agree', 'protocol.emitted-event-types', 'tools.pipeline-stages'],
  );
  assert.deepEqual(
    await invariants.run('run-end', { sessionId: session.id, emittedTypes: [] }),
    [],
  );
});

test('a broken invariant fails the run, names itself, and says so on the event stream', async (t) => {
  const provider: Provider = {
    async complete() {
      return reply('Done');
    },
  };
  const diagnostics: string[] = [];
  // The fixture's own `onEvent` is replaced here, because the diagnostic is the thing under test.
  const { session, agent, invariants } = await fixture(t, provider, {
    onEvent: (event: { type: string; data: Record<string, unknown> }) => {
      if (event.type === 'invariant.violated') diagnostics.push(JSON.stringify(event.data));
    },
  });
  invariants.register(
    invariant({
      name: 'tests.always-broken',
      owner: 'tests',
      description: 'breaks on purpose',
      check: () => {
        throw new Error('the promise does not hold');
      },
    }),
  );
  const result = await agent.run({ sessionId: session.id, prompt: 'Say done' });
  assert.equal(result.status, 'failed', 'a broken promise must not be reported as a completed run');
  assert.match(String(result.error), /tests\.always-broken \(tests\): the promise does not hold/);
  assert.equal(diagnostics.length, 1, 'the run reports the violation once');
  assert.match(diagnostics[0]!, /the promise does not hold/);
});

test('the Host registers the built-ins, and a real run holds them', async (t) => {
  const url = await httpFixture(t, (_, res) => sendFrames(res, frames('Created')));
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-invariants-host-'));
  const client = new AgentHostClient({
    nodePath: process.execPath,
    hostPath: path.join(projectRoot, 'apps/agent-host/main.ts'),
    workspace: root,
    env: {
      YUANTU_MODEL: 'fixture',
      YUANTU_MAX_CONTEXT_TOKENS: '128000',
      YUANTU_SESSION_TITLES: '0',
      YUANTU_API_KEY: 'test',
      YUANTU_BASE_URL: url,
    },
  });
  t.after(async () => {
    await client.stop();
    await rm(root, { recursive: true, force: true });
  });
  await client.start();
  const before = await client.request('invariants.list', {});
  assert.deepEqual(
    before.invariants.map((entry) => entry.name).sort(),
    ['protocol.emitted-event-types', 'storage.log-tables-agree', 'tools.pipeline-stages'],
    'the Host registers one invariant per publishing package',
  );
  assert.ok(
    before.invariants.every((entry) => entry.owner.startsWith('packages/') && entry.description),
    'describe() is what an operator prints, so every entry has to be attributable and readable',
  );
  const session = await client.request('session.create', {});
  const result = await client.run(session.id, 'Say hello');
  assert.equal(result.status, 'completed', result.error);
  const after = await client.request('invariants.list', {});
  assert.deepEqual(after.violations, [], 'a real run must satisfy every registered promise');
});
