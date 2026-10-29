import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SessionStore } from '../packages/storage/sqlite.ts';
import { CarrierService } from '../packages/carrier/service.ts';
import { AgentHostClient } from '../packages/client/host-client.ts';
import { storeFixture, tempRoot } from './temp-fixture.ts';

// ---- merged from session-management.test.ts ----

async function fixture(t: test.TestContext) {
  const { root, db: file, store } = await storeFixture(t, 'yuantu-session-management-');
  return { root, file, store };
}
test('session titles and literal message search persist across reopen and old database migration', async (t) => {
  const { root, file, store } = await fixture(t);
  const a = store.create(root),
    b = store.create(root);
  store.append(a.id, { role: 'user', content: '修复 登录 页面' });
  store.append(a.id, { role: 'assistant', content: 'UNIQUE answer 100%_done', toolCalls: [] });
  store.append(b.id, { role: 'user', content: 'other request' });
  assert.equal(store.get(a.id).title, '修复 登录 页面');
  store.rename(a.id, '  登录修复  ');
  assert.equal(store.list('登录修复')[0]?.id, a.id);
  assert.deepEqual(
    store.list('100%_done').map((s) => s.id),
    [a.id],
  );
  assert.deepEqual(
    store.list('unique').map((s) => s.id),
    [a.id],
  );
  assert.deepEqual(store.list('no match'), []);
  assert.throws(() => store.rename(a.id, ' '));
  assert.throws(() => store.rename(a.id, 'x'.repeat(121)));
  const reopened = new SessionStore(file);
  try {
    assert.equal(reopened.get(a.id).title, '登录修复');
  } finally {
    reopened.close();
  }
  const legacyFile = path.join(root, 'legacy.sqlite');
  const legacy = new DatabaseSync(legacyFile);
  legacy.exec(
    'CREATE TABLE sessions(id TEXT PRIMARY KEY,workspace TEXT NOT NULL,created_at TEXT NOT NULL,active_run TEXT); PRAGMA user_version=1;',
  );
  legacy.prepare('INSERT INTO sessions VALUES(?,?,?,NULL)').run('old', root, '2026-01-01');
  legacy.close();
  const migrated = new SessionStore(legacyFile);
  try {
    assert.equal(migrated.get('old').title, '');
    migrated.rename('old', '旧会话');
    assert.equal(migrated.get('old').title, '旧会话');
  } finally {
    migrated.close();
  }
});
test('delete removes only session records and snapshots, preserving files and other sessions', async (t) => {
  const { root, file, store } = await fixture(t);
  const a = store.create(root),
    other = store.create(root);
  store.append(a.id, { role: 'user', content: 'task' });
  store.append(a.id, { role: 'assistant', content: 'done', toolCalls: [] });
  store.applyCompaction(a.id, { coveredMessages: 1, summary: 'summary' });
  const change = store.prepareFileChange(
    a.id,
    { path: 'keep.txt', kind: 'create', patch: 'diff', added: 1, removed: 0, truncated: false },
    null,
    Buffer.from('keep'),
  );
  store.markFileChange(change, 'applied');
  await writeFile(path.join(root, 'keep.txt'), 'keep');
  const completedRun = store.beginRun(a.id);
  store.finishRun({
    runId: completedRun,
    sessionId: a.id,
    status: 'completed',
    text: 'done',
    usage: { inputTokens: 1, outputTokens: 1 },
  });
  store.append(other.id, { role: 'user', content: 'keep other history' });
  store.delete(a.id);
  assert.throws(() => store.get(a.id), /not found/i);
  assert.equal(store.get(other.id).id, other.id);
  assert.equal(store.messages(other.id).length, 1);
  assert.equal(await readFile(path.join(root, 'keep.txt'), 'utf8'), 'keep');
  const db = new DatabaseSync(file);
  try {
    for (const table of ['messages', 'runs', 'file_changes'])
      assert.equal(
        db.prepare(`SELECT count(*) AS n FROM ${table} WHERE session_id=?`).get(a.id)?.n,
        0,
      );
  } finally {
    db.close();
  }
});
test('session mutations reject active runs and ongoing file restoration', async (t) => {
  const { root, store } = await fixture(t);
  const a = store.create(root);
  const runId = store.beginRun(a.id);
  for (const action of [() => store.rename(a.id, 'x'), () => store.delete(a.id)])
    assert.throws(action, /running|busy/i);
  store.finishRun({
    runId,
    sessionId: a.id,
    status: 'completed',
    text: '',
    usage: { inputTokens: 0, outputTokens: 0 },
  });
  const change = store.prepareFileChange(
    a.id,
    { path: 'x', kind: 'create', patch: '', added: 0, removed: 0, truncated: false },
    null,
    Buffer.from('x'),
  );
  store.markFileChange(change, 'undoing');
  for (const action of [() => store.delete(a.id), () => store.rename(a.id, 'x')])
    assert.throws(action, /restor|busy/i);
});
test('Host scopes session management to its workspace and desktop replaces deleted current sessions', async (t) => {
  let service: CarrierService | undefined, client: AgentHostClient | undefined;
  t.after(async () => {
    await service?.stop();
    await client?.stop();
  });
  const { root, file, store } = await fixture(t);
  const a = store.create(root),
    foreign = store.create(path.join(root, 'other'));
  store.append(a.id, { role: 'user', content: 'searchable message' });
  store.append(foreign.id, { role: 'user', content: 'foreign secret message' });
  // Appends are buffered in this process; the Host reads the database.
  store.flush();
  const foreignChange = store.prepareFileChange(
    foreign.id,
    {
      path: 'foreign-secret.txt',
      kind: 'create',
      patch: 'foreign secret patch',
      added: 1,
      removed: 0,
      truncated: false,
    },
    null,
    Buffer.from('foreign secret bytes'),
  );
  store.markFileChange(foreignChange, 'applied');
  const foreignTask = store.createTask(foreign.id, { title: 'foreign task' });
  const options = {
    nodePath: process.execPath,
    hostPath: path.resolve('apps/agent-host/main.ts'),
    workspace: root,
    db: file,
  };
  client = new AgentHostClient(options);
  service = new CarrierService(options);

  await client.start();
  assert.deepEqual(
    (await client.request('session.list', {})).map((s) => s.id),
    [a.id],
  );
  const foreignRequests = [
    ['session.get', { sessionId: foreign.id }],
    ['session.rename', { sessionId: foreign.id, title: 'bad' }],
    ['session.archive', { sessionId: foreign.id, archived: true }],
    ['session.delete', { sessionId: foreign.id }],
    ['session.recover', { sessionId: foreign.id }],
    ['changes.list', { sessionId: foreign.id }],
    ['changes.undo', { sessionId: foreign.id, id: foreignChange }],
    ['task.create', { sessionId: foreign.id, title: 'bad' }],
    ['task.get', { sessionId: foreign.id, taskId: foreignTask.id }],
    ['task.list', { sessionId: foreign.id }],
    ['task.attempts', { sessionId: foreign.id, taskId: foreignTask.id }],
    ['task.history', { sessionId: foreign.id }],
    ['task.verify', { sessionId: foreign.id, taskId: foreignTask.id }],
    ['task.retry', { sessionId: foreign.id, taskId: foreignTask.id, prompt: 'bad' }],
    ['task.update', { sessionId: foreign.id, taskId: foreignTask.id, title: 'bad' }],
    ['run.start', { sessionId: foreign.id, taskId: foreignTask.id, prompt: 'bad' }],
    ['run.enqueue', { sessionId: foreign.id, prompt: 'bad', mode: 'follow-up' }],
    ['run.queue.clear', { sessionId: foreign.id }],
    ['run.cancel', { sessionId: foreign.id }],
  ] as const;
  for (const request of foreignRequests) {
    const [method, params] = request;
    await assert.rejects(client.request(method, params), /workspace/i, method);
  }
  assert.equal(store.get(foreign.id).title, 'foreign secret message');
  assert.equal(store.fileChanges(foreign.id)[0]?.status, 'applied');
  await service.start();
  await service.dispatch({ type: 'rename', id: a.id, title: 'named' });
  assert.equal(service.snapshot.sessions[0]?.title, 'named');
  await service.dispatch({ type: 'searchSessions', query: 'searchable' });
  assert.equal(service.snapshot.sessions.length, 1);
  await Promise.all([
    service.dispatch({ type: 'searchSessions', query: 'searchable' }),
    service.dispatch({ type: 'searchSessions', query: 'no-matching-session' }),
  ]);
  assert.equal(service.snapshot.sessionQuery, 'no-matching-session');
  assert.deepEqual(service.snapshot.sessions, []);
  assert.equal(service.snapshot.currentSession?.id, a.id);
  await service.dispatch({ type: 'searchSessions', query: '' });
  assert.equal(service.snapshot.sessions.length, 1);
  await service.dispatch({ type: 'create' });
  const other = service.snapshot.session.sessionId!;
  await service.dispatch({ type: 'rename', id: a.id, title: 'renamed while inactive' });
  assert.equal(service.snapshot.session.sessionId, other);
  await service.dispatch({ type: 'deleteSession', id: other });
  assert.equal(service.snapshot.session.sessionId, a.id);
  await service.dispatch({ type: 'deleteSession', id: a.id });
  assert.ok(service.snapshot.session.sessionId);
  assert.notEqual(service.snapshot.session.sessionId, a.id);
  // The replacement is a new, untouched session: open, and not listed until something happens in it.
  assert.equal(service.snapshot.sessions.length, 0);
});
test('concurrent store opens migrate one legacy database without duplicate columns or losing sessions', async (t) => {
  const { root } = await fixture(t);
  const file = path.join(root, 'concurrent.sqlite');
  const old = new DatabaseSync(file);
  old.exec(
    'PRAGMA journal_mode=WAL; CREATE TABLE sessions(id TEXT PRIMARY KEY,workspace TEXT NOT NULL,created_at TEXT NOT NULL,active_run TEXT); PRAGMA user_version=1;',
  );
  old.prepare('INSERT INTO sessions VALUES(?,?,?,NULL)').run('kept', root, '2026-01-01');
  old.close();
  const { spawn } = await import('node:child_process');
  await Promise.all(
    Array.from(
      { length: 4 },
      () =>
        new Promise<void>((resolve, reject) => {
          const child = spawn(
            process.execPath,
            [
              '--input-type=module',
              '-e',
              "import {SessionStore} from './packages/storage/sqlite.ts'; const store=new SessionStore(process.argv[1]); if(store.get('kept').title !== '') throw new Error('Lost legacy session'); store.close();",
              file,
            ],
            { cwd: path.resolve('.'), windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] },
          );
          let error = '';
          child.stderr.on('data', (chunk) => (error += chunk.toString()));
          child.once('error', reject);
          child.once('close', (code) => (code === 0 ? resolve() : reject(new Error(error))));
        }),
    ),
  );
  const reopened = new SessionStore(file);
  try {
    assert.equal(reopened.get('kept').workspace, root);
  } finally {
    reopened.close();
  }
});

// ---- merged from session-search.test.ts ----

/** A real base64 PNG, so the fixture body genuinely carries an image payload. */
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

test('session search uses the text projection and never indexes image payloads', async (t) => {
  // Regression: `list()` ran json_extract + instr over every message body — the same blob that holds
  // base64 image data — for every session on every search. It is an FTS5 index over a text-only
  // projection column now.
  const root = await tempRoot(t, 'yuantu-session-search-');
  const file = path.join(root, 'sessions.sqlite');
  const store = new SessionStore(file);
  const session = store.create(root);
  store.append(session.id, {
    role: 'user',
    content: 'how do I rotate the deploy key',
    images: [{ mimeType: 'image/png', data: PNG, name: 'shot.png' }],
  });
  store.append(session.id, {
    role: 'assistant',
    content: 'Use the keyring command.',
    toolCalls: [],
  });
  store.append(session.id, {
    role: 'tool',
    toolCallId: 'call-1',
    content: 'tool-only-marker',
    isError: false,
  });

  // Message text is searchable for both conversational roles.
  assert.equal(store.list('rotate', root).length, 1);
  assert.equal(store.list('keyring', root).length, 1);
  // All words must be present, and a term only a tool produced must not match.
  assert.equal(store.list('rotate deploy', root).length, 1);
  assert.equal(store.list('rotate missingword', root).length, 0);
  assert.equal(store.list('tool-only-marker', root).length, 0);
  // The title check stays a substring test, so a partial session name still matches.
  assert.equal(store.list('how do I rotate', root).length, 1);
  // FTS5 operators in user input must be inert rather than throwing out of the search box.
  for (const query of ['"', '*', '-', 'NEAR(', 'a:b', 'OR', '"unterminated', '***', '((((']) {
    assert.doesNotThrow(() => store.list(query, root), `query ${JSON.stringify(query)} threw`);
  }
  assert.deepEqual(store.list('"unterminated', root), []);

  // The indexed projection holds conversational text only: no base64 image data reached it.
  const raw = new DatabaseSync(file);
  const indexed = raw
    .prepare('SELECT search_text AS text FROM messages')
    .all()
    .map((row) => String(row.text))
    .join('\n');
  assert.match(indexed, /rotate the deploy key/);
  assert.match(indexed, /keyring command/);
  assert.doesNotMatch(indexed, /iVBORw0KGgo/, 'image data must never be indexed');
  assert.doesNotMatch(indexed, /tool-only-marker/, 'tool output is not searchable');
  // Only the two conversational messages are indexed, so images cannot inflate the index either.
  assert.equal(Number(raw.prepare('SELECT count(*) AS n FROM messages_fts').get()!.n), 2);
  raw.close();

  // Deleting the session must drop its rows from the index too, or search would return ghosts.
  store.delete(session.id);
  assert.equal(store.list('rotate', root).length, 0);
  const after = new DatabaseSync(file);
  assert.equal(Number(after.prepare('SELECT count(*) AS n FROM messages_fts').get()!.n), 0);
  after.close();
  store.close();
});

test('session search reads the text projection, not the message body', async (t) => {
  // The decisive property of the projection: search no longer consults `messages.body` at all. The old
  // query ran json_extract over that blob, so rewriting a body changed what search returned — and
  // every search parsed the same blob that carries base64 image data.
  const root = await tempRoot(t, 'yuantu-session-projection-');
  const file = path.join(root, 'sessions.sqlite');
  const store = new SessionStore(file);
  const session = store.create(root);
  store.append(session.id, { role: 'user', content: 'rotate the deploy key', images: [] });
  assert.equal(store.list('rotate', root).length, 1);

  // Rewrite the stored body behind the store's back; the projection column is untouched because the
  // update trigger only fires for `search_text`.
  const raw = new DatabaseSync(file);
  raw
    .prepare('UPDATE messages SET body=? WHERE session_id=?')
    .run(JSON.stringify({ role: 'user', content: 'totally different wording' }), session.id);
  raw.close();

  assert.equal(
    store.list('rotate', root).length,
    1,
    'search must still match, because it reads the indexed projection',
  );
  assert.equal(
    store.list('different wording', root).length,
    0,
    'search must not fall back to parsing the message body',
  );
  store.close();
});

test('session search scopes to one workspace and keeps displayContent precedence', async (t) => {
  const root = await tempRoot(t, 'yuantu-session-scope-');
  const store = new SessionStore(path.join(root, 'sessions.sqlite'));
  const first = store.create(root);
  store.append(first.id, {
    role: 'user',
    content: 'expanded skill prompt that the user never typed',
    displayContent: 'plain question about parsers',
  });
  assert.equal(store.list('parsers', root).length, 1);
  assert.equal(
    store.list('expanded skill prompt', root).length,
    0,
    'the display form is what the operator saw, so it is what search indexes',
  );
  const other = path.join(root, 'elsewhere');
  store.create(other);
  assert.equal(store.list('parsers', root).length, 1, 'another workspace must not leak in');
  assert.equal(store.list('parsers', other).length, 0);
  store.close();
});

test('the session list pages by keyset, newest first, even when sessions share a timestamp', async (t) => {
  const { root, store } = await fixture(t);
  // Created back to back, many of these share one millisecond: the page boundary must still be exact.
  const ids = Array.from({ length: 7 }, () => store.create(root).id).reverse();
  const child = store.create(root, ids[0]);
  assert.deepEqual(
    store.list('', root).map((session) => session.id),
    ids,
    'the whole list without a page, child sessions hidden as before',
  );
  const pages: string[][] = [];
  for (let before: string | undefined; ;) {
    const page = store.list('', root, { limit: 3, ...(before ? { before } : {}) });
    if (!page.length) break;
    pages.push(page.map((session) => session.id));
    before = page.at(-1)!.id;
  }
  assert.deepEqual(
    pages.map((page) => page.length),
    [3, 3, 1],
  );
  assert.deepEqual(pages.flat(), ids, 'every session exactly once, in list order');
  assert.deepEqual(
    store.list('', root, { id: ids[3] }).map((session) => session.id),
    [ids[3]],
  );
  assert.deepEqual(
    store.list('', root, { id: child.id }),
    [],
    'the id filter keeps the visibility rule',
  );
  assert.deepEqual(store.list('', root, { limit: 3, before: 'no-such-session' }), []);
  for (const page of [{ limit: 0 }, { limit: 501 }, { limit: 1.5 }])
    assert.throws(() => store.list('', root, page), /Invalid session page/);
});

test('the desktop list is a window over the newest sessions that grows on request', async (t) => {
  let service: CarrierService | undefined;
  t.after(async () => {
    await service?.stop();
  });
  const { root, file, store } = await fixture(t);
  // Titled, because the sidebar lists only sessions something has happened in.
  for (let index = 0; index < 105; index++) store.rename(store.create(root).id, `session ${index}`);
  service = new CarrierService({
    nodePath: process.execPath,
    hostPath: path.resolve('apps/agent-host/main.ts'),
    workspace: root,
    db: file,
  });
  await service.start();
  // Starting opens the newest of them, so the workspace holds exactly 105 listed sessions.
  assert.equal(service.snapshot.sessions.length, 100);
  assert.equal(service.snapshot.sessionsHasMore, true);
  const opened = service.snapshot.session.sessionId;
  assert.equal(service.snapshot.currentSession?.id, opened, 'the open session is named');
  const grown = await service.dispatch({ type: 'loadMoreSessions' });
  assert.ok(grown.sessions.length >= 105 && grown.sessions.length <= 200);
  assert.equal(grown.sessionsHasMore, false);
  assert.equal(new Set(grown.sessions.map((session) => session.id)).size, grown.sessions.length);
});
