import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { SCHEMA_VERSION, SessionStore } from '../packages/storage/sqlite.ts';
import { Agent } from '../packages/core/agent.ts';
import { createTools } from '../packages/tools/index.ts';
import { projectRoot } from './process-fixture.ts';

test('durable tasks support session-scoped CRUD, filtering, and validation', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-tasks-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'tasks.sqlite');
  const store = new SessionStore(file);
  const session = store.create(root);
  const other = store.create(path.join(root, 'other'));
  const task = store.createTask(session.id, {
    title: '  Ship durable tasks  ',
    description: 'Persist the task model.',
    acceptance: [{ description: 'Survives restart', met: false }],
    steps: [{ description: 'Create schema', status: 'completed' }],
  });
  assert.equal(task.title, 'Ship durable tasks');
  assert.equal(task.status, 'pending');
  assert.equal(task.sessionId, session.id);
  assert.deepEqual(store.listTasks(session.id), [task]);
  assert.deepEqual(store.listTasks(session.id, 'completed'), []);
  assert.throws(() => store.getTask(other.id, task.id), /not found/i);
  store.updateTask(session.id, task.id, { status: 'in_progress' });
  const updated = store.updateTask(session.id, task.id, {
    status: 'completed',
    acceptance: [{ description: 'Survives restart', met: true }],
    steps: [{ description: 'Create schema', status: 'completed' }],
  });
  assert.equal(updated.status, 'completed');
  assert.equal(updated.acceptance[0]?.met, true);
  assert.equal(updated.title, task.title);
  assert.ok(updated.updatedAt >= task.updatedAt);
  assert.deepEqual(store.listTasks(session.id, 'completed'), [updated]);
  assert.throws(() => store.createTask(session.id, { title: ' ' }), /title/i);
  assert.throws(() => store.updateTask(session.id, task.id, {}), /update/i);
  store.close();

  const reopened = new SessionStore(file);
  try {
    assert.deepEqual(reopened.getTask(session.id, task.id), updated);
    reopened.deleteTask(session.id, task.id);
    assert.deepEqual(reopened.listTasks(session.id), []);
    assert.throws(() => reopened.getTask(session.id, task.id), /not found/i);
  } finally {
    reopened.close();
  }
});

test('task attempts are append-only, linked to runs, and enforce status transitions', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-attempts-'));
  const store = new SessionStore(path.join(root, 'sessions.sqlite'));
  t.after(() => {
    store.close();
    return rm(root, { recursive: true, force: true });
  });
  const session = store.create(root);
  const task = store.createTask(session.id, {
    title: 'attempt history',
    acceptance: [{ description: 'done', met: false }],
  });
  assert.throws(
    () => store.updateTask(session.id, task.id, { status: 'completed' }),
    /transition/i,
  );
  const runId = store.beginRun(session.id);
  const first = store.startTaskAttempt(session.id, task.id, {
    kind: 'run',
    runId,
    prompt: 'do it',
    baselines: { protected: { version: 1, state: 'absent', entries: 0, bytes: 0 } },
  });
  assert.equal(first.ordinal, 1);
  assert.equal(store.getTask(session.id, task.id).latestRunId, runId);
  assert.throws(
    () => store.startTaskAttempt(session.id, task.id, { kind: 'verify' }),
    /active attempt|transition/i,
  );
  store.finishTaskAttempt(session.id, task.id, first.id, {
    status: 'needs_review',
    error: 'not done',
  });
  store.finishRun({
    runId,
    sessionId: session.id,
    status: 'needs_review',
    text: '',
    usage: { inputTokens: 0, outputTokens: 0 },
  });
  const second = store.startTaskAttempt(session.id, task.id, { kind: 'verify' });
  store.finishTaskAttempt(session.id, task.id, second.id, { status: 'completed' });
  assert.deepEqual(
    store
      .listTaskAttempts(session.id, task.id)
      .map((attempt) => [attempt.ordinal, attempt.kind, attempt.status]),
    [
      [1, 'run', 'needs_review'],
      [2, 'verify', 'completed'],
    ],
  );
  assert.equal(store.getTask(session.id, task.id).attemptCount, 2);
  assert.deepEqual(store.latestRunAttemptBaselines(session.id, task.id).protected, {
    version: 1,
    state: 'absent',
    entries: 0,
    bytes: 0,
  });
});

test('interrupted task recovery preserves live owners and recovers dead attempts', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-task-recovery-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'sessions.sqlite');
  const store = new SessionStore(file);
  const session = store.create(root);
  const live = store.createTask(session.id, { title: 'live' });
  const liveRun = store.beginRun(session.id);
  store.startTaskAttempt(session.id, live.id, { kind: 'run', runId: liveRun, prompt: 'live' });
  assert.equal(store.recoverInterruptedTasks(root), 0);
  assert.equal(store.getTask(session.id, live.id).status, 'in_progress');
  const db = new DatabaseSync(file);
  db.prepare('UPDATE runs SET owner_pid=? WHERE id=?').run(2147483647, liveRun);
  db.close();
  assert.equal(store.recoverInterruptedTasks(root), 1);
  assert.equal(store.getTask(session.id, live.id).status, 'needs_review');
  assert.match(store.listTaskAttempts(session.id, live.id)[0]!.error!, /inspect workspace/i);
  assert.equal(store.get(session.id).activeRun, null);
  const check = new DatabaseSync(file);
  assert.equal(
    check.prepare('SELECT status FROM runs WHERE id=?').get(liveRun)?.status,
    'interrupted',
  );
  check.close();
  store.close();
});

test('schema v3 migrates to the current schema with an empty durable task journal', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-v3-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'legacy.sqlite');
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA user_version=3;
    CREATE TABLE sessions(id TEXT PRIMARY KEY,workspace TEXT NOT NULL,created_at TEXT NOT NULL,active_run TEXT,title TEXT NOT NULL DEFAULT '',parent_session_id TEXT,fork_message_count INTEGER);
  `);
  db.prepare('INSERT INTO sessions(id,workspace,created_at) VALUES(?,?,?)').run(
    's',
    root,
    '2026-01-01',
  );
  db.close();
  const store = new SessionStore(file);
  try {
    assert.deepEqual(store.listTasks('s'), []);
    const created = store.createTask('s', { title: 'Migrated' });
    assert.equal(created.title, 'Migrated');
    // The migration must leave a task with no trigger and no schedule obligation.
    assert.equal(created.trigger, undefined);
    assert.equal(created.nextRunAt, undefined);
    const check = new DatabaseSync(file);
    assert.equal(check.prepare('PRAGMA user_version').get()?.user_version, SCHEMA_VERSION);
    const columns = check
      .prepare('PRAGMA table_info(tasks)')
      .all()
      .map((row) => row.name);
    for (const column of ['trigger', 'next_run_at', 'last_run_at', 'last_trigger_error'])
      assert.ok(columns.includes(column), `missing migrated column ${column}`);
    assert.ok(
      check
        .prepare('PRAGMA table_info(task_attempts)')
        .all()
        .map((row) => row.name)
        .includes('resume'),
    );
    assert.equal(
      check
        .prepare(
          "SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='task_step_checkpoints'",
        )
        .get()?.n,
      1,
    );
    check.close();
  } finally {
    store.close();
  }
});

test('reopening crashed run records unknown outcome and never repeats an operation', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-recover-'));
  let store: SessionStore | undefined;
  t.after(async () => {
    store?.close();
    await rm(root, { recursive: true, force: true });
  });
  const db = path.join(root, 'sessions.sqlite'),
    marker = path.join(root, 'marker.txt');
  const child = spawn(
    process.execPath,
    [path.join(projectRoot, 'tests/crash-worker.ts'), db, root, marker],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let stdout = '',
    stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  assert.equal(await new Promise((resolve) => child.on('exit', resolve)), 73, stderr);
  const id = stdout.trim();
  store = new SessionStore(db);
  const agent = new Agent({
    store,
    tools: createTools(root),
    approve: async () => true,
    provider: {
      async complete({ messages }) {
        const recovered = messages.find((m) => m.role === 'tool' && m.toolCallId === 'uncertain');
        assert.ok(recovered?.role === 'tool' && recovered.isError);
        assert.match(recovered.content, /unknown/i);
        return {
          text: 'Inspected recovered state',
          toolCalls: [],
          finishReason: 'stop',
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    },
  });
  assert.equal(
    (await agent.run({ sessionId: id, prompt: 'continue after inspection' })).status,
    'completed',
  );
  assert.equal(await readFile(marker, 'utf8'), 'once');
  assert.equal(store.get(id).activeRun, null);
});

test('schema v2 journal migrates to the current schema without losing legacy snapshots', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-v2-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'legacy.sqlite');
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA user_version=2;
    CREATE TABLE sessions(id TEXT PRIMARY KEY,workspace TEXT NOT NULL,created_at TEXT NOT NULL,active_run TEXT,title TEXT NOT NULL DEFAULT '',parent_session_id TEXT,fork_message_count INTEGER);
    CREATE TABLE messages(seq INTEGER PRIMARY KEY AUTOINCREMENT,session_id TEXT NOT NULL REFERENCES sessions(id),body TEXT NOT NULL);
    CREATE TABLE runs(id TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES sessions(id),owner_pid INTEGER NOT NULL,status TEXT NOT NULL,started_at TEXT NOT NULL,result TEXT);
    CREATE TABLE context_checkpoints(session_id TEXT PRIMARY KEY REFERENCES sessions(id),covered_messages INTEGER NOT NULL,summary TEXT NOT NULL);
    CREATE TABLE file_changes(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,session_id TEXT NOT NULL REFERENCES sessions(id),run_id TEXT,change TEXT NOT NULL,before_bytes BLOB,after_bytes BLOB NOT NULL,status TEXT NOT NULL,created_at TEXT NOT NULL);
  `);
  db.prepare('INSERT INTO sessions(id,workspace,created_at) VALUES(?,?,?)').run(
    's',
    root,
    new Date().toISOString(),
  );
  db.prepare(
    "INSERT INTO file_changes(id,session_id,change,before_bytes,after_bytes,status,created_at) VALUES(?,?,?,?,?,'applied',?)",
  ).run(
    'c',
    's',
    JSON.stringify({
      path: 'a.txt',
      kind: 'edit',
      patch: '',
      added: 1,
      removed: 1,
      truncated: false,
    }),
    Buffer.from('before'),
    Buffer.from('after'),
    new Date().toISOString(),
  );
  db.close();
  const store = new SessionStore(file);
  try {
    const snapshots = store.fileChangeSnapshots('s', 'c');
    assert.equal(Buffer.from(snapshots[0]!.before!).toString(), 'before');
    assert.equal(Buffer.from(snapshots[0]!.after!).toString(), 'after');
    const check = new DatabaseSync(file);
    assert.equal(check.prepare('PRAGMA user_version').get()?.user_version, SCHEMA_VERSION);
    check.close();
  } finally {
    store.close();
  }
});
test('opening an unsupported database version refuses without downgrading the schema', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-schema-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'future.sqlite');
  const db = new DatabaseSync(file);
  db.exec('PRAGMA user_version=99');
  db.close();
  assert.throws(() => new SessionStore(file), /version/i);
  const check = new DatabaseSync(file);
  assert.equal(check.prepare('PRAGMA user_version').get()?.user_version, 99);
  check.close();
});
