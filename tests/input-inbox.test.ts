/**
 * The input inbox: what a person queued for a running session, recorded durably enough to survive the process.
 *
 * The queue used to be memory only. An input a run never folded into a turn — because the run ended first,
 * because the person pressed Stop, or because the process died holding it — left no trace, so "I typed a
 * follow-up and it was never sent" was unanswerable from the log and unreproducible from the session. These
 * tests pin the three records that replace that silence (`input.queued`, `input.consumed`, `input.discarded`)
 * and the fold that reads them: what is left over, in the order it was queued. Two of the properties are the
 * ones that matter most and are easy to lose again — the acceptance is written *before* the input can be
 * delivered, and the message that consumes an input is written in the same transaction as the record that
 * settles it, so neither can exist without the other.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Agent } from '../packages/core/agent.ts';
import { SessionStore } from '../packages/storage/sqlite.ts';
import { ToolRegistry, HookRegistry } from '../packages/tools/registry.ts';
import { SESSION_EVENT_TYPES, foldPendingInputs } from '../packages/storage/events.ts';
import type { ModelResponse, Provider } from '../packages/protocol/index.ts';

const projectRoot = path.resolve(import.meta.dirname, '..');
const reply = (text = 'Done'): ModelResponse => ({
  text,
  toolCalls: [],
  finishReason: 'stop',
  usage: { inputTokens: 10, outputTokens: 5 },
});

async function fixture(t: test.TestContext, provider: Provider) {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-inbox-'));
  const store = new SessionStore(path.join(root, 'sessions.sqlite'));
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const session = store.create(root);
  const agent = new Agent({
    store,
    provider,
    tools: new ToolRegistry(new HookRegistry()),
    approve: async () => true,
  });
  return { root, store, session, agent };
}

const inputEvents = (store: SessionStore, sessionId: string) =>
  store
    .events(sessionId)
    .filter((event) => event.type.startsWith('input.'))
    .map((event) => ({ type: event.type, data: event.data }));

test('the inbox is a durable event vocabulary, not a live-only one', () => {
  for (const type of ['input.queued', 'input.consumed', 'input.discarded'])
    assert.ok(
      (SESSION_EVENT_TYPES as readonly string[]).includes(type),
      `${type} has to be readable back out of the log, not only off the wire`,
    );
});

test('a consumed input is recorded as accepted before it is recorded as delivered', async (t) => {
  let release!: (value: ModelResponse) => void;
  let started!: () => void;
  let calls = 0;
  const running = new Promise<void>((resolve) => (started = resolve));
  const { agent, store, session } = await fixture(t, {
    complete: async () => {
      if (calls++ > 0) return reply('answered the follow-up');
      started();
      return new Promise<ModelResponse>((resolve) => (release = resolve));
    },
  });
  const run = agent.run({ sessionId: session.id, prompt: 'first' });
  await running;
  agent.enqueue(session.id, { prompt: 'queued follow-up' }, 'follow-up');
  // The acceptance is durable while the input is still only queued: this is the record a crash reads.
  assert.deepEqual(
    inputEvents(store, session.id).map((event) => event.type),
    ['input.queued'],
  );
  assert.deepEqual(
    store.pendingInputs(session.id).map((item) => item.prompt),
    ['queued follow-up'],
  );
  release(reply('answered first'));
  assert.equal((await run).status, 'completed');
  assert.deepEqual(
    inputEvents(store, session.id).map((event) => event.type),
    ['input.queued', 'input.consumed'],
  );
  // Settled, so nothing is offered again — and the transcript holds the message exactly once.
  assert.deepEqual(store.pendingInputs(session.id), []);
  assert.deepEqual(
    store
      .messages(session.id)
      .filter((message) => message.role === 'user')
      .map((message) => message.content),
    ['first', 'queued follow-up'],
  );
});

test('an input the run never delivered is settled with a reason instead of vanishing', async (t) => {
  let started!: () => void;
  const running = new Promise<void>((resolve) => (started = resolve));
  const { agent, store, session } = await fixture(t, {
    complete: ({ signal }) => {
      started();
      return new Promise<ModelResponse>((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
      );
    },
  });
  const aborter = new AbortController();
  const run = agent.run({ sessionId: session.id, prompt: 'first', signal: aborter.signal });
  await running;
  agent.enqueue(session.id, { prompt: 'never sent' }, 'follow-up');
  aborter.abort();
  assert.equal((await run).status, 'cancelled');
  const events = inputEvents(store, session.id);
  assert.deepEqual(
    events.map((event) => event.type),
    ['input.queued', 'input.discarded'],
  );
  assert.equal(events[1]!.data.reason, 'cancelled');
  assert.deepEqual(events[1]!.data.ids, [(events[0]!.data.item as { id: string }).id]);
  assert.deepEqual(store.pendingInputs(session.id), []);
});

test('clearing the inbox works with no run holding the session', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-inbox-clear-'));
  const store = new SessionStore(path.join(root, 'sessions.sqlite'));
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const session = store.create(root);
  const agent = new Agent({
    store,
    provider: { complete: async () => reply() },
    tools: new ToolRegistry(new HookRegistry()),
    approve: async () => true,
  });
  store.recordEvent(session.id, 'input.queued', {
    item: {
      id: 'leftover',
      mode: 'follow-up',
      prompt: 'from a run that is gone',
      createdAt: '2026-10-02T00:00:00.000Z',
      imageCount: 0,
    },
  });
  assert.equal(store.pendingInputs(session.id).length, 1);
  // No live run: the queue array is empty and the log is the only thing that knows about the leftover.
  assert.deepEqual(agent.inboxOf(session.id), {
    running: false,
    items: [
      {
        id: 'leftover',
        mode: 'follow-up',
        prompt: 'from a run that is gone',
        imageCount: 0,
        createdAt: '2026-10-02T00:00:00.000Z',
      },
    ],
  });
  agent.clearQueue(session.id);
  assert.deepEqual(store.pendingInputs(session.id), []);
  const settled = inputEvents(store, session.id).at(-1)!;
  assert.equal(settled.type, 'input.discarded');
  assert.equal(settled.data.reason, 'user');
  assert.deepEqual(settled.data.ids, ['leftover']);
});

test('a process that dies holding a follow-up leaves it readable as undelivered', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-inbox-crash-'));
  let store: SessionStore | undefined;
  t.after(async () => {
    store?.close();
    await rm(root, { recursive: true, force: true });
  });
  const db = path.join(root, 'sessions.sqlite');
  const child = spawn(
    process.execPath,
    [path.join(projectRoot, 'tests/inbox-crash-worker.ts'), db, root],
    {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => (stdout += chunk));
  child.stderr.on('data', (chunk) => (stderr += chunk));
  assert.equal(await new Promise((resolve) => child.on('exit', resolve)), 74, stderr);
  const id = stdout.trim();
  store = new SessionStore(db);
  // Nothing settled the entry, so it is still waiting — and that is what a reader has to be able to see.
  assert.deepEqual(
    store.pendingInputs(id).map((item) => ({ mode: item.mode, prompt: item.prompt })),
    [{ mode: 'follow-up', prompt: 'queued follow-up' }],
  );
  // Converging the dead run says how many inputs it was holding, next to the calls it never answered.
  assert.equal(store.reconcileInterruptedRuns(root), 1);
  const interrupted = store.events(id).find((event) => event.type === 'run.interrupted')!;
  assert.equal(interrupted.data.undeliveredInputs, 1);
  // And the fold is the same answer the record counted, so the two cannot drift apart.
  assert.deepEqual(
    foldPendingInputs(store.events(id)).map((item) => item.prompt),
    ['queued follow-up'],
  );
  assert.equal(store.discardPendingInputs(id, 'user'), 1);
  assert.deepEqual(store.pendingInputs(id), []);
});
