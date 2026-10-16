import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SessionStore } from '../packages/storage/sqlite.ts';
import { DatabaseSync } from 'node:sqlite';
import { collectTurnChanges } from '../apps/desktop/turn-changes.ts';
import type { StoredFileChange } from '../packages/storage/session-schema.ts';
import type { FileChange, Message } from '../packages/protocol/index.ts';

const file = (path: string, added = 1): FileChange => ({
  path,
  kind: 'edit',
  patch: '+line',
  added,
  removed: 0,
  truncated: false,
});
const row = (
  id: string,
  runId: string,
  endMessageIndex: number | undefined,
  change = file('a.ts'),
): StoredFileChange => ({
  id,
  sessionId: 's',
  runId,
  ...(endMessageIndex === undefined ? {} : { endMessageIndex }),
  status: 'applied',
  createdAt: '',
  change,
});
const conversation: Message[] = [
  { role: 'user', content: 'first' },
  { role: 'assistant', content: 'answer one', toolCalls: [] },
  { role: 'user', content: 'second' },
  { role: 'assistant', content: 'answer two', toolCalls: [] },
];

test('completed runs stay separate and a live run does not publish its partial changes', () => {
  const turns = collectTurnChanges(
    [row('live', 'r3', undefined), row('two', 'r2', 3), row('one', 'r1', 1)],
    conversation,
    0,
    true,
  );
  assert.deepEqual(
    turns.map((turn) => [turn.key, turn.afterIndex, turn.files[0]?.entries[0]?.record.id]),
    [
      ['r1', 1, 'one'],
      ['r2', 3, 'two'],
    ],
  );
});

test('file counts deduplicate repeated edits and flatten batch children including child attribution', () => {
  const batch = {
    ...file('batch'),
    kind: 'batch' as const,
    changes: [file('a.ts', 2), file('b.ts', 3)],
  };
  const turns = collectTurnChanges(
    [row('later', 'r1', 1, file('a.ts', 4)), row('batch', 'r1', 1, batch)],
    conversation,
    0,
    false,
  );
  assert.deepEqual(
    turns[0]?.files.map((file) => [file.path, file.added, file.entries.length]),
    [
      ['a.ts', 6, 2],
      ['b.ts', 3, 1],
    ],
  );
});

test('history paging does not move old-run cards to the start of the current page', () => {
  const records = [row('two', 'r2', 3), row('one', 'r1', 1)];
  assert.deepEqual(
    collectTurnChanges(records, conversation.slice(2), 2, false).map((turn) => turn.key),
    ['r2'],
  );
  assert.deepEqual(
    collectTurnChanges(records, conversation, 0, false).map((turn) => turn.key),
    ['r1', 'r2'],
  );
});

test('legacy receipts are displayed at their question end without duplicating journaled changes', () => {
  const modern = { ...file('modern.ts'), id: 'modern' };
  const messages: Message[] = [
    { role: 'user', content: 'question' },
    { role: 'tool', toolCallId: 'legacy', content: '', isError: false, change: file('legacy.ts') },
    { role: 'tool', toolCallId: 'modern', content: '', isError: false, change: modern },
    { role: 'assistant', content: 'answer', toolCalls: [] },
  ];
  const turns = collectTurnChanges([row('modern', 'r1', 3, modern)], messages, 0, false);
  assert.equal(turns.length, 1);
  assert.deepEqual(turns.flatMap((turn) => turn.files.map((file) => file.path)).sort(), [
    'legacy.ts',
    'modern.ts',
  ]);
  assert.equal(collectTurnChanges([], messages.slice(0, 2), 0, true).length, 0);
});

test('pre-log migrated runs use their receipts instead of stacking every card at the history end', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-legacy-turn-changes-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const database = path.join(root, 'sessions.sqlite');
  const legacy = new DatabaseSync(database);
  legacy.exec(`
    CREATE TABLE sessions(id TEXT PRIMARY KEY, workspace TEXT NOT NULL, created_at TEXT NOT NULL, active_run TEXT);
    CREATE TABLE messages(seq INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, body TEXT NOT NULL, search_text TEXT NOT NULL DEFAULT '');
    CREATE TABLE runs(id TEXT PRIMARY KEY, session_id TEXT NOT NULL, owner_pid INTEGER NOT NULL, status TEXT NOT NULL, started_at TEXT NOT NULL, result TEXT);
    CREATE TABLE file_changes(seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, session_id TEXT NOT NULL, run_id TEXT, change TEXT NOT NULL, before_bytes BLOB, after_bytes BLOB NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL);
    PRAGMA user_version=13;
  `);
  legacy
    .prepare('INSERT INTO sessions VALUES(?,?,?,NULL)')
    .run('old', root, new Date().toISOString());
  for (let index = 1; index <= 2; index++) {
    const runId = `r${index}`;
    const change = { ...file(`${index}.ts`), id: runId };
    for (const message of [
      { role: 'user', content: `question ${index}` },
      { role: 'tool', toolCallId: runId, content: '', isError: false, change },
      { role: 'assistant', content: `answer ${index}`, toolCalls: [] },
    ])
      legacy
        .prepare('INSERT INTO messages(session_id,body) VALUES(?,?)')
        .run('old', JSON.stringify(message));
    legacy
      .prepare('INSERT INTO runs VALUES(?,?,?,?,?,?)')
      .run(
        runId,
        'old',
        0,
        'completed',
        `2020-01-0${index}T00:00:00Z`,
        JSON.stringify({ usage: { inputTokens: 0, outputTokens: 0 } }),
      );
    legacy
      .prepare(
        'INSERT INTO file_changes(id,session_id,run_id,change,before_bytes,after_bytes,status,created_at) VALUES(?,?,?,?,?,?,?,?)',
      )
      .run(runId, 'old', runId, JSON.stringify(change), null, Buffer.from('line'), 'applied', '');
  }
  legacy.close();
  const store = new SessionStore(database);
  try {
    const records = store.fileChanges('old');
    assert.deepEqual(
      collectTurnChanges(records, store.messages('old'), 0, false).map((turn) => [
        turn.key,
        turn.afterIndex,
      ]),
      [
        ['r1', 2],
        ['r2', 5],
      ],
    );
  } finally {
    store.close();
  }
});

test('file changes retain their finished run boundary across reload, independent of later questions', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-turn-changes-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const database = path.join(root, 'sessions.sqlite');
  const store = new SessionStore(database);
  const session = store.create(root);
  const runId = store.beginRun(session.id);
  store.append(session.id, { role: 'user', content: 'first question' });
  const id = store.prepareFileChange(
    session.id,
    { path: 'a.ts', kind: 'create', patch: '+one', added: 1, removed: 0, truncated: false },
    null,
    Buffer.from('one'),
  );
  store.markFileChange(id, 'applied');
  assert.equal(
    (store.fileChanges(session.id)[0] as { endMessageIndex?: number }).endMessageIndex,
    undefined,
    'running changes have no finished position',
  );
  store.append(session.id, { role: 'assistant', content: 'first answer', toolCalls: [] });
  store.finishRun({
    sessionId: session.id,
    runId,
    status: 'completed',
    text: 'first answer',
    usage: { inputTokens: 0, outputTokens: 0 },
  });
  store.append(session.id, { role: 'user', content: 'second question' });
  store.close();
  const reopened = new SessionStore(database);
  try {
    const change = reopened.fileChanges(session.id)[0] as {
      runId?: string;
      endMessageIndex?: number;
    };
    assert.equal(change.runId, runId);
    assert.equal(
      change.endMessageIndex,
      1,
      'the card belongs after the first answer, before a later question',
    );
  } finally {
    reopened.close();
  }
});
