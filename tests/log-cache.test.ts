/**
 * The transcript the store keeps folded between reads.
 *
 * Folding the log on every read was the run loop's most repeated cost — the context builder, the pre-step
 * hook and the title path each read the history every round — so the store now keeps the fold and extends
 * it with what it appends. A cache of *the* record is only worth having while it is exactly the record, so
 * these tests are about the ways it could stop being that: a write through the same store, a write through
 * another connection, a transaction that rolls back, and a reader that edits what it was handed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SessionStore } from '../packages/storage/sqlite.ts';
import { foldMessages } from '../packages/storage/events.ts';
import type { Message } from '../packages/protocol/index.ts';

const transcript = (messages: readonly Message[]): string[] =>
  messages.map((message) => String(message.content));

test('a read after a write sees the write, and repeated reads reuse one fold', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-cache-'));
  const store = new SessionStore(path.join(root, 'sessions.sqlite'));
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const session = store.create(root);
  store.append(session.id, { role: 'user', content: 'first' });
  const first = store.messages(session.id);
  assert.deepEqual(transcript(first), ['first']);

  store.append(session.id, { role: 'assistant', content: 'second', toolCalls: [] });
  assert.deepEqual(
    transcript(store.messages(session.id)),
    ['first', 'second'],
    'the write is part of the transcript the next read returns',
  );
  assert.deepEqual(
    transcript(store.messages(session.id)),
    ['first', 'second'],
    'and reading it again does not lose it',
  );
  // Same array twice means the fold was kept rather than rebuilt: that identity is the optimisation.
  assert.equal(
    store.messages(session.id),
    store.messages(session.id),
    'a session that has not changed is folded once',
  );
  assert.deepEqual(foldMessages(store.events(session.id)), store.messages(session.id));
});

test('a write from another connection is visible to a store that already folded the log', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-cache-foreign-'));
  const file = path.join(root, 'sessions.sqlite');
  const reader = new SessionStore(file);
  t.after(async () => {
    reader.close();
    await rm(root, { recursive: true, force: true });
  });
  const session = reader.create(root);
  reader.append(session.id, { role: 'user', content: 'mine' });
  const cold = reader.messages(session.id);
  assert.deepEqual(transcript(cold), ['mine']);

  // A second process — the CLI appending while the desktop has the session open — writes the same log.
  const writer = new SessionStore(file);
  writer.append(session.id, { role: 'user', content: 'theirs' });
  writer.close();

  assert.deepEqual(
    transcript(reader.messages(session.id)),
    ['mine', 'theirs'],
    'the fold is dropped when another connection commits',
  );
  const delta = reader.events(session.id, 1);
  assert.deepEqual(
    delta.map((event) => event.type),
    ['message.user'],
    'a delta read of a log that moved on returns the tail that moved',
  );
  assert.deepEqual(foldMessages(reader.events(session.id)), reader.messages(session.id));
});

test('a batch that fails to write records none of it, and leaves no phantom in the fold', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-cache-rollback-'));
  const store = new SessionStore(path.join(root, 'sessions.sqlite'));
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const session = store.create(root);
  store.append(session.id, { role: 'user', content: 'kept' });
  const before = store.messages(session.id);
  assert.deepEqual(transcript(before), ['kept']);

  // A message for a session that does not exist fails its foreign key when the batch is written, *after*
  // the good message in the same batch has been written: the whole batch has to come back out, or the
  // store would be left holding half a write. (What can be decided without the database — a message that
  // cannot be serialised, a user message with no usable text — is refused by the append instead.)
  store.append('no-such-session', { role: 'user', content: 'never recorded' });
  assert.throws(() => store.flush(), /FOREIGN KEY/);

  assert.deepEqual(
    transcript(store.messages(session.id)),
    ['kept'],
    'the rolled back write is gone',
  );
  assert.deepEqual(
    store.messages(session.id),
    before,
    'and the fold that was already cached is the fold that comes back',
  );
  // A fresh store reads the file rather than the cache, so this is the database's answer, not the fold's.
  const reopened = new SessionStore(path.join(root, 'sessions.sqlite'));
  assert.deepEqual(transcript(reopened.messages(session.id)), ['kept']);
  assert.equal(reopened.events(session.id).length, 1);
  reopened.close();
});

test('a message that cannot be written is refused by the append, not by a later batch', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-cache-bad-'));
  const store = new SessionStore(path.join(root, 'sessions.sqlite'));
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const session = store.create(root);
  store.append(session.id, { role: 'user', content: 'kept' });
  // A user message gives the session its title, and a message whose text is not text has none: the append
  // is where that is discovered, so a bad message never reaches a batch that is written later.
  const broken = {
    role: 'user',
    content: 'never recorded',
    displayContent: 42,
  } as unknown as Message;
  assert.throws(() => store.append(session.id, broken), TypeError);
  assert.deepEqual(transcript(store.messages(session.id)), ['kept']);
  assert.equal(store.events(session.id).length, 1);
});

test('an uncommitted append is visible inside its own transaction, not before it commits', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-cache-transaction-'));
  const file = path.join(root, 'sessions.sqlite');
  const store = new SessionStore(file);
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const session = store.create(root);
  const runId = store.beginRun(session.id);
  store.append(session.id, {
    role: 'assistant',
    content: 'calling a tool',
    toolCalls: [{ id: 'call-1', name: 'read_file', arguments: { path: 'x' } }],
  });
  assert.deepEqual(transcript(store.messages(session.id)), ['calling a tool']);
  const crashed = new DatabaseSync(file);
  crashed.prepare('UPDATE runs SET owner_pid=2147483647 WHERE id=?').run(runId);
  crashed.close();

  // Settling the interrupted run happens inside one transaction that appends the outcome message, so the
  // read that follows it has to see an append made by a transaction that has since committed.
  store.beginRun(session.id);
  const settled = store.messages(session.id);
  assert.equal(settled.length, 2);
  assert.match(String(settled[1]!.content), /outcome is unknown/i);
  assert.deepEqual(foldMessages(store.events(session.id)), settled);
});

test('reads are frozen, because they are the store’s own fold', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-cache-frozen-'));
  const store = new SessionStore(path.join(root, 'sessions.sqlite'));
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const session = store.create(root);
  store.append(session.id, { role: 'user', content: 'immutable' });
  store.append(session.id, { role: 'user', content: 'too' });
  const messages = store.messages(session.id);
  assert.throws(() => messages.push({ role: 'user', content: 'intruder' }), TypeError);
  assert.throws(() => messages.reverse(), TypeError);
  assert.throws(() => store.events(session.id).sort(), TypeError);
  assert.throws(() => store.events(session.id, 1).pop(), TypeError);
  assert.deepEqual(transcript(store.messages(session.id)), ['immutable', 'too']);
});

test('a deleted session leaves nothing in the fold to read', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-cache-delete-'));
  const store = new SessionStore(path.join(root, 'sessions.sqlite'));
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const session = store.create(root);
  store.append(session.id, { role: 'user', content: 'doomed' });
  assert.deepEqual(transcript(store.messages(session.id)), ['doomed']);
  store.delete(session.id);
  assert.deepEqual(store.events(session.id), []);
  assert.throws(() => store.messages(session.id), /Session not found/);
});
