/**
 * The durable session log and the message projection.
 *
 * The log is only worth having if it is *complete* and *authoritative*: the transcript the model is given
 * has to be the fold of what was recorded, and the write-through rows have to agree with it. These tests
 * check all three views against each other (fold, projection, raw rows), check that an event this build
 * cannot interpret stops *every* derived answer — the transcript and the projected state alike — instead of
 * quietly shrinking them, and check that a database written before the log existed is backfilled rather than
 * reported as empty.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SCHEMA_VERSION, SessionStore } from '../packages/storage/sqlite.ts';
import {
  UnsupportedSessionEventError,
  foldMessages,
  isSessionEventType,
} from '../packages/storage/events.ts';
import type { SessionEvent } from '../packages/storage/events.ts';
import { Agent } from '../packages/core/agent.ts';
import { ToolRegistry } from '../packages/tools/registry.ts';
import { isRuntimeContext } from '../packages/protocol/context.ts';
import type { Message, ModelResponse } from '../packages/protocol/index.ts';

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
/** The rows as they exist on disk, read through a second connection: the independent view. */
const rawRows = (file: string, sessionId: string): Message[] => {
  const db = new DatabaseSync(file);
  try {
    return db
      .prepare('SELECT body FROM messages WHERE session_id=? ORDER BY seq')
      .all(sessionId)
      .map((row) => JSON.parse(String(row.body)) as Message);
  } finally {
    db.close();
  }
};
const eventTypes = (store: SessionStore, sessionId: string): string[] =>
  store.events(sessionId).map((event) => event.type);

test('a real run records its transcript as events, and all three views agree', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-log-'));
  const file = path.join(root, 'sessions.sqlite');
  const store = new SessionStore(file);
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
          ? toolCall('read-1', 'read_file', { path: 'notes.txt' })
          : reply('All done');
      },
    },
    tools: new ToolRegistry(),
    approve: async () => true,
  });
  const result = await agent.run({ sessionId: session.id, prompt: 'Read the notes' });
  assert.equal(result.status, 'completed', result.error);

  const events = store.events(session.id);
  /**
   * The step boundaries bracket each round's work, and the two records that describe the *request* sit inside
   * them: `resources.loaded` once, when the run loads the workspace's instructions and skills, and
   * `context.envelope` per round, written as the round's prompt and catalogue are settled and again if a
   * provider-confirmed overflow makes that round prepare a different envelope.
   *
   * The order is the point of listing these at all — a future change that recorded the envelope *after* the
   * request went out, or lost the second one for a recovered round, moves a line here.
   */
  assert.deepEqual(
    events.map((event) => event.type),
    [
      'run.started',
      'message.user',
      // The runtime's machine-written skills announcement is a user-role message in the log too.
      'message.user',
      'resources.loaded',
      'step.started',
      'context.envelope',
      'provider.request.finished',
      'message.assistant',
      'message.tool',
      'step.finished',
      'step.started',
      'context.envelope',
      'provider.request.finished',
      'message.assistant',
      'step.finished',
      'run.finished',
    ],
  );
  assert.ok(
    events.every((event) => event.seq > 0 && event.sessionId === session.id && event.at),
    'every event carries its identity and timestamp',
  );

  // The three views of the same history: the fold, the projection, and the rows on disk.
  const folded = foldMessages(events);
  assert.deepEqual(folded, store.messages(session.id));
  assert.deepEqual(rawRows(file, session.id), store.messages(session.id));
  const conversation = store
    .messages(session.id)
    .filter((message) => !isRuntimeContext(message.content));
  assert.deepEqual(
    conversation.map((message) => message.role),
    ['user', 'assistant', 'tool', 'assistant'],
  );
  // `run.*` and `step.*` events describe the run, not the transcript: they must not leak into the model's
  // history.
  assert.equal(folded.filter((message) => !isRuntimeContext(message.content)).length, 4);
  assert.ok(!isSessionEventType('run.started' satisfies string) === false);
});

test('the log survives a reopen and is not duplicated by it', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-log-reopen-'));
  const file = path.join(root, 'sessions.sqlite');
  const opened: SessionStore[] = [];
  // One teardown for every connection this test opens: node runs `after` hooks in registration order,
  // so removing the directory before closing the second store is an EBUSY on Windows.
  t.after(async () => {
    for (const store of opened) store.close();
    await rm(root, { recursive: true, force: true });
  });
  const store = new SessionStore(file);
  opened.push(store);
  const session = store.create(root);
  store.append(session.id, { role: 'user', content: 'hello' });
  store.append(session.id, { role: 'assistant', content: 'hi', toolCalls: [] });
  const before = store.events(session.id).length;

  const reopened = new SessionStore(file);
  opened.push(reopened);
  assert.equal(reopened.events(session.id).length, before, 'opening a v14 database adds no events');
  assert.deepEqual(
    reopened.messages(session.id).map((message) => message.content),
    ['hello', 'hi'],
  );
});

test('an event this build cannot interpret stops every derived answer, not just the transcript', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-log-unknown-'));
  const file = path.join(root, 'sessions.sqlite');
  const store = new SessionStore(file);
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const session = store.create(root);
  store.append(session.id, { role: 'user', content: 'first' });

  // Exactly what a newer writer would leave behind for this build to read.
  const writer = new DatabaseSync(file);
  writer
    .prepare(
      "INSERT INTO session_events(session_id,type,data,at) VALUES(?,'message.reasoning','{}',?)",
    )
    .run(session.id, new Date().toISOString());
  writer.close();

  assert.throws(
    () => store.messages(session.id),
    (error: unknown) =>
      error instanceof UnsupportedSessionEventError && error.eventType === 'message.reasoning',
  );
  assert.throws(() => foldMessages(store.events(session.id)), UnsupportedSessionEventError);
  /**
   * And every *derived* answer refuses, which the fold alone did not do.
   *
   * The checklist, the goal, the statistics, the compaction surface and the whole snapshot are derived from this
   * same log, and an event whose meaning this build does not know could have changed any of them. Answering as if
   * it changed nothing is the "plausible but incomplete" answer this module's header forbids, and it is worse than
   * refusing: nobody reading a checklist has any way to tell it is short.
   */
  for (const read of [
    () => store.todos(session.id),
    () => store.goal(session.id),
    () => store.deliverables(session.id),
    () => store.statistics(session.id),
    () => store.contextSurface(session.id),
    () => store.snapshot(session.id),
  ])
    assert.throws(read, UnsupportedSessionEventError);
  // The raw log is still readable, which is why the refusal sits in the readers rather than at the read boundary:
  // diagnosing a session written by a newer build is exactly when somebody needs to look at the events.
  assert.equal(store.events(session.id).length, 2);
});

test('a database written before the log existed is backfilled on open', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-log-backfill-'));
  const file = path.join(root, 'sessions.sqlite');
  // A v13 database: messages, no events, no session_events table at all.
  const legacy = new DatabaseSync(file);
  const now = new Date().toISOString();
  legacy.exec(`
    CREATE TABLE sessions(id TEXT PRIMARY KEY, workspace TEXT NOT NULL, created_at TEXT NOT NULL, active_run TEXT);
    CREATE TABLE messages(seq INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, body TEXT NOT NULL, search_text TEXT NOT NULL DEFAULT '');
    PRAGMA user_version=13;
  `);
  legacy
    .prepare('INSERT INTO sessions(id,workspace,created_at) VALUES(?,?,?)')
    .run('old', root, now);
  const insert = legacy.prepare('INSERT INTO messages(session_id,body,search_text) VALUES(?,?,?)');
  const history: Message[] = [
    { role: 'user', content: 'legacy question' },
    { role: 'assistant', content: 'legacy answer', toolCalls: [] },
    { role: 'tool', toolCallId: 'call-1', content: 'legacy tool output', isError: false },
  ];
  for (const message of history) insert.run('old', JSON.stringify(message), '');
  legacy.close();

  const store = new SessionStore(file);
  const opened: SessionStore[] = [store];
  t.after(async () => {
    for (const handle of opened) handle.close();
    await rm(root, { recursive: true, force: true });
  });
  assert.deepEqual(store.messages('old'), history, 'the transcript is what it always was');
  assert.deepEqual(eventTypes(store, 'old'), ['message.user', 'message.assistant', 'message.tool']);
  assert.equal(
    Number(
      (() => {
        const db = new DatabaseSync(file);
        try {
          return db.prepare('PRAGMA user_version').get()?.user_version;
        } finally {
          db.close();
        }
      })(),
    ),
    SCHEMA_VERSION,
    'the upgrade stamps the new version',
  );
  const count = store.events('old').length;
  const again = new SessionStore(file);
  opened.push(again);
  assert.equal(again.events('old').length, count, 'the backfill does not run twice');
});

test('a damaged row is skipped rather than bricking every session in the database', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-log-damaged-'));
  const file = path.join(root, 'sessions.sqlite');
  /**
   * The failure this guards against is not "one message is lost" but "the database never opens again".
   *
   * The upgrade is a single transaction that stamps `PRAGMA user_version` at its end, so a row that throws
   * while being backfilled rolls the version back with it: every later open re-runs the same migration and
   * fails the same way, for *every* session in the file rather than only the damaged one. A write that was cut
   * short is exactly how a body like this arrives, so the row is skipped and the rest of the upgrade lands.
   */
  const legacy = new DatabaseSync(file);
  const now = new Date().toISOString();
  legacy.exec(`
    CREATE TABLE sessions(id TEXT PRIMARY KEY, workspace TEXT NOT NULL, created_at TEXT NOT NULL, active_run TEXT);
    CREATE TABLE messages(seq INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, body TEXT NOT NULL, search_text TEXT NOT NULL DEFAULT '');
    CREATE TABLE runs(id TEXT PRIMARY KEY, session_id TEXT NOT NULL, owner_pid INTEGER NOT NULL, status TEXT NOT NULL, started_at TEXT NOT NULL, result TEXT);
    PRAGMA user_version=13;
  `);
  legacy
    .prepare('INSERT INTO sessions(id,workspace,created_at) VALUES(?,?,?)')
    .run('old', root, now);
  const insert = legacy.prepare('INSERT INTO messages(session_id,body,search_text) VALUES(?,?,?)');
  const history: Message[] = [
    { role: 'user', content: 'legacy question' },
    { role: 'assistant', content: 'legacy answer', toolCalls: [] },
  ];
  insert.run('old', JSON.stringify(history[0]), '');
  insert.run('old', '{"role":"assistant","content":', '');
  insert.run('old', JSON.stringify(history[1]), '');
  legacy
    .prepare(
      'INSERT INTO runs(id,session_id,owner_pid,status,started_at,result) VALUES(?,?,?,?,?,?)',
    )
    .run('run-1', 'old', process.pid, 'completed', now, '{"usage":');
  legacy.close();
  const read = <T>(sql: string, ...params: (string | number)[]): T | undefined => {
    const db = new DatabaseSync(file);
    try {
      return db.prepare(sql).get(...params) as T | undefined;
    } finally {
      db.close();
    }
  };

  const store = new SessionStore(file);
  const opened: SessionStore[] = [store];
  t.after(async () => {
    for (const handle of opened) handle.close();
    await rm(root, { recursive: true, force: true });
  });
  assert.deepEqual(
    store.messages('old'),
    history,
    'the readable messages are still the transcript',
  );
  assert.deepEqual(
    eventTypes(store, 'old'),
    ['message.user', 'message.assistant', 'run.started', 'run.finished'],
    'the run still closes: a status column is not part of the result that could not be read',
  );
  assert.equal(
    Number(read<{ user_version: number }>('PRAGMA user_version')?.user_version),
    SCHEMA_VERSION,
    'the version advances, which is what stops the next open from re-running the upgrade',
  );
  assert.equal(
    Number(read<{ n: number }>('SELECT count(*) AS n FROM messages WHERE session_id=?', 'old')?.n),
    3,
    'the damaged row is left where it was, so a later repair can still find it',
  );
  const again = new SessionStore(file);
  opened.push(again);
  assert.deepEqual(again.messages('old'), history, 'the second open is not another migration');
});

test('settling an interrupted run records the uncertainty inside the same log', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-log-interrupted-'));
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
    content: 'running a tool',
    toolCalls: [{ id: 'call-9', name: 'read_file', arguments: { path: 'x' } }],
  });
  // The owning process is gone: reopening the session must settle the unfinished call.
  const crashed = new DatabaseSync(file);
  crashed.prepare('UPDATE runs SET owner_pid=2147483647 WHERE id=?').run(runId);
  crashed.close();

  const nextRun = store.beginRun(session.id);
  assert.notEqual(nextRun, runId);
  const events = store.events(session.id);
  const types = events.map((event) => event.type);
  assert.deepEqual(types, [
    'run.started',
    'message.assistant',
    'message.tool',
    // The run's own end is a record too: "there was a run in flight" is the wrong thing to conclude from a
    // process that no longer exists, and the runs table is not what a reader of the log can see.
    'run.interrupted',
    'run.started',
  ]);
  const settled = events[2]!;
  assert.equal((settled.data.message as Message).role, 'tool');
  assert.match(String((settled.data.message as Message).content), /outcome is unknown/i);
  assert.deepEqual(events[3]!.data, {
    runId,
    pendingCalls: 1,
    reason:
      'Previous run was interrupted. Execution outcome is unknown; inspect current state before retrying.',
  });
  assert.deepEqual(foldMessages(events), store.messages(session.id));
});

test('deleting a session deletes its log', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-log-delete-'));
  const store = new SessionStore(path.join(root, 'sessions.sqlite'));
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const session = store.create(root);
  store.append(session.id, { role: 'user', content: 'doomed' });
  assert.equal(store.events(session.id).length, 1);
  store.delete(session.id);
  assert.deepEqual(store.events(session.id), []);
});

test('foldMessages is total over the declared types and loud about the rest', () => {
  const event = (type: string, seq: number, data: Record<string, unknown> = {}): SessionEvent => ({
    seq,
    sessionId: 's',
    type,
    data,
    at: new Date().toISOString(),
  });
  const message: Message = { role: 'user', content: 'x' };
  assert.deepEqual(foldMessages([event('message.user', 1, { message })]), [message]);
  for (const type of ['run.started', 'run.finished', 'context.compacted'])
    assert.deepEqual(foldMessages([event(type, 2)]), [], `${type} is not transcript content`);
  assert.throws(
    () => foldMessages([event('message.tool_call_delta', 3)]),
    UnsupportedSessionEventError,
  );
  assert.throws(() => foldMessages([event('message.user', 4)]), /has no message payload/);
});
