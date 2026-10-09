import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_SEARCH_MATCHES,
  MAX_SEARCH_SESSIONS,
  assertTaskTransition,
  ftsQuery,
  messageSearchText,
  nextTaskTimestamp,
  readSearchCursor,
  resumeSteps,
  writeSearchCursor,
} from '../packages/storage/session-schema.ts';
import {
  hashesIn,
  imageHash,
  sessionTitle,
  storedMessage,
} from '../packages/storage/session-blobs.ts';
import type { Message, TaskStep, TaskStepStatus } from '../packages/protocol/index.ts';

/**
 * The storage layer's pure rules, tested without a database.
 *
 * These functions were lifted out of `sqlite.ts` so that the answers a session's rows have to obey —
 * what a search cursor is, how free text becomes an FTS5 query, what a title may contain, how a stored
 * image is addressed, how a resumed attempt's steps are seeded — can be read and checked on their own.
 * The tests pin the properties that make the split safe: the same refusals, the same strings, and the
 * same stored shape, so a caller cannot tell which module the rule now lives in.
 */

test('a search cursor round-trips as an opaque string and refuses anything it did not write', () => {
  assert.equal(readSearchCursor(writeSearchCursor(0)), 0);
  assert.equal(readSearchCursor(writeSearchCursor(4_096)), 4_096);
  const cursor = writeSearchCursor(7);
  assert.match(cursor, /^[A-Za-z0-9_-]+$/);
  assert.doesNotMatch(cursor, /7/);
  for (const bad of [
    '',
    '   ',
    'not-base64!!',
    Buffer.from('{"v":2,"offset":3}').toString('base64url'),
    Buffer.from('{"v":1}').toString('base64url'),
    Buffer.from('{"v":1,"offset":"3"}').toString('base64url'),
    Buffer.from('{"v":1,"offset":-1}').toString('base64url'),
    Buffer.from('{"v":1,"offset":1.5}').toString('base64url'),
    Buffer.from('[1,2]').toString('base64url'),
  ])
    assert.throws(() => readSearchCursor(bad as string), /Invalid session search cursor/, bad);
});

test('the search window is bounded, which is what keeps a search from walking the whole database', () => {
  assert.equal(MAX_SEARCH_SESSIONS, 10);
  assert.equal(MAX_SEARCH_MATCHES, 5);
});

test('free text becomes a quoted AND query, and unindexable text becomes null', () => {
  assert.equal(ftsQuery('hello'), '"hello"');
  assert.equal(ftsQuery('hello world'), '"hello" AND "world"');
  // Every FTS5 metacharacter is literal once the word is quoted: a search box is not a query language.
  assert.equal(ftsQuery('foo*'), '"foo"');
  assert.equal(ftsQuery('a" OR "b'), '"a" AND "OR" AND "b"');
  assert.equal(ftsQuery('NEAR(a b)'), '"NEAR" AND "a" AND "b"');
  assert.equal(ftsQuery('-x:y'), '"x" AND "y"');
  assert.equal(ftsQuery('中文搜索'), '"中文搜索"');
  assert.equal(ftsQuery('snake_case9'), '"snake_case9"');
  assert.equal(ftsQuery('!!! *** :::'), null);
  assert.equal(ftsQuery(''), null);
});

test('a query is capped at twelve words so one search cannot become an expensive statement', () => {
  const many = Array.from({ length: 30 }, (_, index) => `w${index}`).join(' ');
  assert.equal(ftsQuery(many)!.split(' AND ').length, 12);
});

test('the searchable projection keeps conversational text and drops the rest', () => {
  assert.equal(
    messageSearchText({ role: 'user', content: 'hello\n\nworld' } as Message),
    'hello world',
  );
  // A machine-written user turn is presented differently but searched as the user's words.
  assert.equal(
    messageSearchText({ role: 'user', content: 'raw', displayContent: 'shown' } as Message),
    'shown',
  );
  assert.equal(
    messageSearchText({ role: 'assistant', content: 'an answer' } as Message),
    'an answer',
  );
  // Non-conversational roles project to nothing, which is what keeps image payloads out of the index.
  assert.equal(
    messageSearchText({ role: 'tool', content: 'x'.repeat(50), toolCallId: 'call' } as Message),
    '',
  );
  assert.equal(messageSearchText({ role: 'system', content: 'rules' } as unknown as Message), '');
});

test('a title cannot carry the whitespace or control characters a stored name must not hold', () => {
  const user = (content: string, displayContent?: string) => ({
    role: 'user' as const,
    content,
    ...(displayContent === undefined ? {} : { displayContent }),
  });
  assert.equal(sessionTitle(user('  Fix   the\n\nbug  ')), 'Fix the bug');
  assert.equal(sessionTitle(user('a'.repeat(400)))!.length, 120);
  // A machine-written first turn is presented differently but still names the session from what was shown.
  assert.equal(sessionTitle(user('raw', 'shown')), 'shown');
  // `<runtime-context …>` is bookkeeping, not a person naming their session.
  assert.equal(sessionTitle(user('<runtime-context source="memory">x</runtime-context>')), null);
});

test('an image is stored as its content address and its bytes are queued beside it', () => {
  const bytes = Buffer.from('a picture');
  const data = bytes.toString('base64');
  const hash = imageHash(bytes);
  const { stored, blobs } = storedMessage({
    role: 'user',
    content: 'look',
    images: [{ data, mimeType: 'image/png', name: 'x.png' }],
  } as unknown as Message);
  assert.equal(blobs.length, 1);
  assert.deepEqual(blobs[0], {
    hash,
    mimeType: 'image/png',
    bytes,
    size: bytes.length,
  });
  // The address takes the bytes' place in the same position, so hydrating reproduces the key order.
  assert.deepEqual(stored, {
    role: 'user',
    content: 'look',
    images: [{ hash, mimeType: 'image/png', name: 'x.png' }],
  });
});

test('a message without images is stored exactly as it came in', () => {
  const message = { role: 'user', content: 'plain' } as Message;
  const { stored, blobs } = storedMessage(message);
  assert.equal(stored, message);
  assert.deepEqual(blobs, []);
  // An assistant turn with nothing to call is completed with an empty call list, and a tool result that does not
  // say it failed is recorded as a success: a reader indexes into both fields, so the store settles the shape
  // once here instead of asking every reader to tolerate a missing key.
  assert.deepEqual(storedMessage({ role: 'assistant', content: 'plain' } as Message).stored, {
    role: 'assistant',
    content: 'plain',
    toolCalls: [],
  });
  assert.deepEqual(
    storedMessage({ role: 'tool', toolCallId: 'call', content: 'ok' } as Message).stored,
    { role: 'tool', toolCallId: 'call', content: 'ok', isError: false },
  );
  // A field that is present keeps the value it was given, including a real error flag.
  const failed = { role: 'tool', toolCallId: 'call', content: 'no', isError: true } as Message;
  assert.equal(storedMessage(failed).stored, failed);
  // An image whose bytes cannot be read is left alone rather than turned into a failed append.
  const odd = { role: 'user', content: 'x', images: [{ data: 42 }] } as unknown as Message;
  assert.deepEqual(storedMessage(odd), { stored: odd, blobs: [] });
});

test('content addresses are collected from a nested stored value', () => {
  const into = new Set<string>();
  hashesIn(
    {
      a: [{ hash: 'h1', mimeType: 'image/png' }],
      // Only a full image reference counts: a bare `hash` key is not evidence that bytes exist to free.
      b: { c: { hash: 'h2' } },
      d: { deeper: [{ hash: 'h3', mimeType: 'image/jpeg', name: 'y.jpg' }] },
      e: 'text',
    },
    into,
  );
  assert.deepEqual([...into].sort(), ['h1', 'h3']);
  hashesIn(undefined, into);
  hashesIn('text', into);
  assert.deepEqual([...into].sort(), ['h1', 'h3']);
});

test('a resumed attempt keeps completed steps and reopens the first unfinished one', () => {
  const steps: TaskStep[] = [
    { description: 'one', status: 'completed' },
    { description: 'two', status: 'blocked' },
    { description: 'three', status: 'in_progress' },
  ];
  const checkpointed = new Map<number, TaskStepStatus>([
    [0, 'completed'],
    [1, 'completed'],
  ]);
  assert.deepEqual(resumeSteps(steps, checkpointed), [
    { description: 'one', status: 'completed' },
    { description: 'two', status: 'completed' },
    { description: 'three', status: 'in_progress' },
  ]);
  // Without checkpoints a fresh run reseeds everything, so a previous cycle's marks cannot leak in.
  assert.deepEqual(resumeSteps(steps, new Map()), [
    { description: 'one', status: 'in_progress' },
    { description: 'two', status: 'pending' },
    { description: 'three', status: 'pending' },
  ]);
  assert.deepEqual(resumeSteps([], new Map()), []);
});

test('task status transitions are refused by name', () => {
  assert.doesNotThrow(() => assertTaskTransition('pending', 'in_progress'));
  assert.doesNotThrow(() => assertTaskTransition('completed', 'completed'));
  assert.throws(
    () => assertTaskTransition('cancelled', 'completed'),
    /Invalid task status transition/,
  );
  assert.throws(() => assertTaskTransition('pending', 'completed'), /pending -> completed/);
});

test('a persisted task revision always moves forward even when the clock does not', () => {
  const future = new Date(Date.now() + 60_000).toISOString();
  assert.ok(Date.parse(nextTaskTimestamp(future)) > Date.parse(future));
  assert.ok(Date.parse(nextTaskTimestamp()) > Date.now() - 1);
  assert.throws(() => nextTaskTimestamp('not a date'), /Invalid persisted task timestamp/);
});

/**
 * The store's own audit read: the pagination contract a caller cannot check from the outside.
 *
 * The page is filtered *by the query*, so a diagnostic reader never loads — or fails on — the message payloads
 * it was never going to show, and the bounds are refused by name rather than clamped.
 */
test('audit pages are filtered by the query and refuse a cursor they cannot honour', async (t) => {
  const { SessionStore } = await import('../packages/storage/sqlite.ts');
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const { DatabaseSync } = await import('node:sqlite');
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-audit-rules-'));
  const file = path.join(root, 'sessions.sqlite');
  const store = new SessionStore(file);
  const db = new DatabaseSync(file);
  t.after(async () => {
    db.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const session = store.create(root);
  store.recordEvent(session.id, 'approval.required', { id: 'first' });
  const firstSeq = store.lastSeq(session.id);
  // A message row this build cannot parse: an audit page must not read it, so it must not fail on it either.
  db.prepare('INSERT INTO session_events(session_id,type,data,at) VALUES(?,?,?,?)').run(
    session.id,
    'message.user',
    '{',
    new Date().toISOString(),
  );
  store.recordEvent(session.id, 'question.required', { id: 'second' });
  assert.deepEqual(
    store.auditEvents(session.id, 0, 1).map((event) => event.type),
    ['approval.required'],
  );
  assert.deepEqual(
    store.auditEvents(session.id, firstSeq, 1).map((event) => event.type),
    ['question.required'],
  );
  // The log itself still refuses to pretend: a whole-log reader is told the payload is damaged.
  assert.throws(() => store.events(session.id), SyntaxError);
  for (const [afterSeq, limit] of [
    [-1, 10],
    [1.5, 10],
    [0, 0],
    [0, 501],
    [0, 1.5],
  ])
    assert.throws(() => store.auditEvents(session.id, afterSeq!, limit!), /Invalid audit cursor/);
});
