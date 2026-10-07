/**
 * Batched appends: what a message costs, and what a reader is promised.
 *
 * A round appends several messages in a row — the assistant message that names the tool calls, then one
 * result per tool — and it used to commit each of them on its own (0.74ms per message, nearly all of it
 * the commit). The store now buffers appends and writes them in one batch, which is only a safe trade if
 * two things stay true: *a reader is never shown less than is recorded*, and *a tool call is on disk
 * before the tool it names runs*. These tests are about those two promises, not about the speed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SessionStore } from '../packages/storage/sqlite.ts';
import { Agent } from '../packages/core/agent.ts';
import { ToolRegistry } from '../packages/tools/registry.ts';
import type { Message, ModelResponse } from '../packages/protocol/index.ts';

/** What a second connection sees: the independent view of what has actually been written. */
const rowsOnDisk = (file: string, sessionId: string): number => {
  const db = new DatabaseSync(file);
  try {
    return Number(
      db.prepare('SELECT COUNT(*) AS n FROM messages WHERE session_id=?').get(sessionId)?.n ?? 0,
    );
  } finally {
    db.close();
  }
};
const contents = (messages: readonly Message[]): string[] =>
  messages.map((message) => String(message.content));

test('a read sees the appends that are still buffered, and its own flush writes them', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-batch-read-'));
  const file = path.join(root, 'sessions.sqlite');
  const store = new SessionStore(file);
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const session = store.create(root);
  store.append(session.id, { role: 'user', content: 'first' });
  store.append(session.id, { role: 'assistant', content: 'second', toolCalls: [] });
  // Nothing has been written yet, but the store already answers with both messages.
  assert.deepEqual(contents(store.messages(session.id)), ['first', 'second']);
  assert.equal(rowsOnDisk(file, session.id), 2, 'the read wrote what it had to show');
  assert.deepEqual(
    store.events(session.id).map((event) => event.type),
    ['message.user', 'message.assistant'],
  );
});

test('a batch is invisible to another process until it is flushed, and complete after', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-batch-flush-'));
  const file = path.join(root, 'sessions.sqlite');
  const store = new SessionStore(file);
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const session = store.create(root);
  for (const index of [1, 2, 3])
    store.append(session.id, { role: 'user', content: `buffered ${index}` });
  assert.equal(rowsOnDisk(file, session.id), 0, 'a buffered append is not yet durable');

  store.flush(session.id);
  assert.equal(rowsOnDisk(file, session.id), 3);
  assert.equal(rowsOnDisk(file, session.id), store.messages(session.id).length);
  store.flush(session.id); // flushing an empty buffer is not an error and writes nothing new
  assert.equal(rowsOnDisk(file, session.id), 3);
});

test('an event never overtakes the appends it is ordered against', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-batch-order-'));
  const store = new SessionStore(path.join(root, 'sessions.sqlite'));
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const session = store.create(root);
  store.append(session.id, { role: 'user', content: 'before the run' });
  // `beginRun` records `run.started`, which must not be logged ahead of a message that was appended first.
  const runId = store.beginRun(session.id);
  assert.deepEqual(
    store.events(session.id).map((event) => event.type),
    ['message.user', 'run.started'],
  );
  store.finishRun({
    runId,
    sessionId: session.id,
    status: 'completed',
    text: '',
    usage: { inputTokens: 0, outputTokens: 0 },
  });
  assert.deepEqual(
    store.events(session.id).map((event) => event.type),
    ['message.user', 'run.started', 'run.finished'],
  );
});

test('a store that closes writes what it was given', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-batch-close-'));
  const file = path.join(root, 'sessions.sqlite');
  const store = new SessionStore(file);
  const session = store.create(root);
  store.append(session.id, { role: 'user', content: 'survives the close' });
  store.close();

  const reopened = new SessionStore(file);
  assert.deepEqual(contents(reopened.messages(session.id)), ['survives the close']);
  assert.equal(
    reopened.list('survives').length,
    1,
    'a buffered message is searchable once written',
  );
  reopened.close();
  await rm(root, { recursive: true, force: true });
});

test('deleting a session drops the appends it had not written', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-batch-delete-'));
  const file = path.join(root, 'sessions.sqlite');
  const store = new SessionStore(file);
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const session = store.create(root);
  store.append(session.id, { role: 'user', content: 'never written' });
  store.delete(session.id);
  // A later flush must not resurrect the session or fail on a missing one.
  store.flush();
  assert.equal(rowsOnDisk(file, session.id), 0);
  assert.deepEqual(store.events(session.id), []);
});

test('the message naming a tool call is durable before the tool runs', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-batch-barrier-'));
  const file = path.join(root, 'sessions.sqlite');
  const store = new SessionStore(file);
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const session = store.create(root);
  let turn = 0;
  const seen: string[][] = [];
  const tools = new ToolRegistry();
  tools.register({
    name: 'probe_disk',
    description: 'Looks at what the session has already written',
    inputSchema: { type: 'object' },
    async execute() {
      const db = new DatabaseSync(file);
      try {
        seen.push(
          db
            .prepare('SELECT body FROM messages WHERE session_id=? ORDER BY seq')
            .all(session.id)
            .map((row) => String((JSON.parse(String(row.body)) as Message).role)),
        );
      } finally {
        db.close();
      }
      return { isError: false, content: 'probed' };
    },
  });
  const reply = (text: string): ModelResponse => ({
    text,
    toolCalls: [],
    finishReason: 'stop',
    usage: { inputTokens: 10, outputTokens: 5 },
  });
  const agent = new Agent({
    store,
    tools,
    approve: async () => true,
    provider: {
      async complete() {
        turn++;
        return turn === 1
          ? {
              text: '',
              finishReason: 'tool_calls',
              toolCalls: [{ id: 'probe-1', name: 'probe_disk', arguments: {} }],
              usage: { inputTokens: 10, outputTokens: 5 },
            }
          : reply('probed');
      },
    },
  });
  assert.equal((await agent.run({ sessionId: session.id, prompt: 'Probe' })).status, 'completed');
  // The tool saw the assistant message that named it, so a crash inside it leaves recovery a record to
  // report as unknown instead of a call that looks like it never happened.
  assert.deepEqual(seen, [['user', 'assistant']]);
});
