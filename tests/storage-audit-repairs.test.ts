import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SessionStore } from '../packages/storage/sqlite.ts';
import { runCli } from './process-fixture.ts';
import type { FileChange } from '../packages/protocol/index.ts';

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-audit-storage-'));
  const file = path.join(root, 'sessions.sqlite');
  const store = new SessionStore(file);
  const other = new SessionStore(file);
  const db = new DatabaseSync(file);
  t.after(async () => {
    other.close();
    store.close();
    db.close();
    await rm(root, { recursive: true, force: true });
  });
  return { root, file, store, other, db, session: store.create(root) };
}

test('a checkpoint cannot skip an event committed after its projection was folded', async (t) => {
  const { store, other, db, session } = await fixture(t);
  store.recordEvent(session.id, 'todo.written', {
    todos: [{ id: 'before', content: 'before', status: 'pending' }],
  });
  const initialSeq = store.lastSeq(session.id);
  // Place a real second-connection commit in the fold/publication window.
  let injected = false;
  store.projections.register({
    name: 'publication-window',
    initial: () => 0,
    apply: (count, event) => {
      if (!injected && event.seq === initialSeq) {
        injected = true;
        other.recordEvent(session.id, 'todo.written', {
          todos: [{ id: 'after', content: 'after', status: 'pending' }],
        });
      }
      return count + 1;
    },
  });
  assert.ok(store.saveProjectionCheckpoints(session.id) > 0);
  assert.equal(injected, true);
  assert.equal(
    db
      .prepare("SELECT seq FROM projection_checkpoints WHERE session_id=? AND name='todos'")
      .get(session.id)?.seq,
    initialSeq,
  );
  assert.deepEqual(store.todos(session.id), [{ id: 'after', content: 'after', status: 'pending' }]);
});

test('a cache cannot hide a commit between its event read and version sampling', async (t) => {
  const { store, other, session } = await fixture(t);
  store.append(session.id, { role: 'user', content: 'before' });
  store.flush();
  const internal = store as unknown as {
    readEvents: (...args: unknown[]) => unknown;
  };
  const read = internal.readEvents.bind(store);
  let injected = false;
  internal.readEvents = (...args) => {
    const result = read(...args);
    if (!injected) {
      injected = true;
      other.append(session.id, { role: 'user', content: 'after' });
      other.flush();
    }
    return result;
  };
  try {
    // The first read may be the earlier snapshot, but the next read must detect its old version.
    store.messages(session.id);
    assert.deepEqual(
      store.messages(session.id).map((message) => message.content),
      ['before', 'after'],
    );
  } finally {
    internal.readEvents = read;
  }
});

test('generated title and its accounting event roll back together on a write failure', async (t) => {
  const { store, session, db } = await fixture(t);
  store.append(session.id, { role: 'user', content: 'fallback title' });
  store.flush();
  const before = store.get(session.id);
  const record = store.recordEvent.bind(store);
  store.recordEvent = () => {
    throw new Error('injected event write failure');
  };
  try {
    assert.throws(
      () =>
        store.setGeneratedTitle(session.id, 'generated', {
          inputTokens: 5,
          outputTokens: 2,
        }),
      /injected event write failure/,
    );
  } finally {
    store.recordEvent = record;
  }
  assert.equal(store.get(session.id).title, before.title);
  assert.equal(
    db.prepare('SELECT title_source FROM sessions WHERE id=?').get(session.id)?.title_source,
    'fallback',
  );
  assert.equal(
    store.events(session.id).filter((event) => event.type === 'session.title.generated').length,
    0,
  );
  assert.equal(
    store.setGeneratedTitle(session.id, 'generated', { inputTokens: 5, outputTokens: 2 }),
    true,
  );
  assert.equal(store.statistics(session.id).inputTokens, 5);
});

test('CLI startup recovers dead tasks and streamed text once while preserving live owners', async (t) => {
  const { store, other, db, root, file, session } = await fixture(t);
  const task = store.createTask(session.id, { title: 'interrupted work' });
  const run = store.beginRun(session.id);
  store.startTaskAttempt(session.id, task.id, { kind: 'run', runId: run });
  store.checkpointStream(session.id, run, 'partial', 'saved before crash');
  db.prepare('UPDATE runs SET owner_pid=? WHERE id=?').run(2147483647, run);
  const live = other.create(root);
  const liveTask = other.createTask(live.id, { title: 'still working' });
  const liveRun = other.beginRun(live.id);
  other.startTaskAttempt(live.id, liveTask.id, { kind: 'run', runId: liveRun });
  other.checkpointStream(live.id, liveRun, 'live-partial', 'still streaming');
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await runCli(['tasks', session.id, '--db', file, '--workspace', root, '--json']);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(store.getTask(session.id, task.id).status, 'needs_review');
    assert.equal(
      store.messages(session.id).filter((message) => message.content === 'saved before crash')
        .length,
      1,
    );
    assert.equal(other.getTask(live.id, liveTask.id).status, 'in_progress');
    assert.equal(other.messages(live.id).length, 0);
  }
});

test('a scoped retry count ignores malformed retry events from another session', async (t) => {
  const { store, db, session, root } = await fixture(t);
  const unrelated = store.create(root);
  store.recordEvent(session.id, 'llm.retry', { runId: 'known', round: 0 });
  db.prepare('INSERT INTO session_events(session_id,type,data,at) VALUES(?,?,?,?)').run(
    unrelated.id,
    'llm.retry',
    '{',
    new Date().toISOString(),
  );
  const scoped = store.retryCount.bind(store) as (
    runId: string,
    round: number,
    sessionId: string,
  ) => number;
  assert.equal(scoped('known', 0, session.id), 1);
});

test('audit pagination reads only the requested audit records', async (t) => {
  const { store, db, session } = await fixture(t);
  store.recordEvent(session.id, 'approval.required', { id: 'first' });
  const firstSeq = store.lastSeq(session.id);
  // Diagnostic-only readers should not load or parse unrelated message payloads.
  db.prepare('INSERT INTO session_events(session_id,type,data,at) VALUES(?,?,?,?)').run(
    session.id,
    'message.user',
    '{',
    new Date().toISOString(),
  );
  store.recordEvent(session.id, 'question.required', { id: 'second' });
  const audit = store as unknown as {
    auditEvents(id: string, afterSeq: number, limit: number): { seq: number; type: string }[];
  };
  assert.deepEqual(
    audit.auditEvents(session.id, 0, 1).map((event) => event.type),
    ['approval.required'],
  );
  assert.deepEqual(
    audit.auditEvents(session.id, firstSeq, 1).map((event) => event.type),
    ['question.required'],
  );
});

test('legacy file snapshots do not parse unrelated file change rows', async (t) => {
  const { store, db, session } = await fixture(t);
  const change: FileChange = {
    path: 'one.txt',
    kind: 'create',
    patch: 'one',
    added: 1,
    removed: 0,
    truncated: false,
  };
  const id = store.prepareFileChange(session.id, change, null, Buffer.from('one'));
  const otherId = store.prepareFileChange(
    session.id,
    { ...change, path: 'two.txt' },
    null,
    Buffer.from('two'),
  );
  db.prepare('DELETE FROM file_change_files WHERE change_id=?').run(id);
  db.prepare('UPDATE file_changes SET change=? WHERE id=?').run('{', otherId);
  const snapshots = store.fileChangeSnapshots(session.id, id);
  assert.equal(snapshots[0]?.path, 'one.txt');
  assert.equal(snapshots[0]?.after?.toString(), 'one');
});

test('editing a damaged task reports its invalid persisted timestamp without changing its definition', async (t) => {
  const { store, db, session } = await fixture(t);
  const task = store.createTask(session.id, { title: 'original' });
  db.prepare('UPDATE tasks SET updated_at=? WHERE id=?').run('invalid-date', task.id);
  assert.throws(
    () =>
      store.replaceTaskDefinition(session.id, task.id, {
        title: 'replacement',
        steps: [{ description: 'work' }],
        acceptance: [{ description: 'review' }],
      }),
    /Invalid persisted task timestamp/,
  );
  assert.equal(store.getTask(session.id, task.id).title, 'original');
});

test('invalid persisted statistics are rebuilt from valid authoritative usage events', async (t) => {
  const { store, db, session } = await fixture(t);
  store.recordEvent(session.id, 'session.title.generated', {
    title: 'generated',
    usage: { inputTokens: 9, outputTokens: 3 },
  });
  store.saveProjectionCheckpoints(session.id);
  const row = db
    .prepare("SELECT state FROM projection_checkpoints WHERE session_id=? AND name='statistics'")
    .get(session.id);
  const state = JSON.parse(String(row?.state));
  state.statistics.inputTokens = null;
  db.prepare(
    "UPDATE projection_checkpoints SET state=? WHERE session_id=? AND name='statistics'",
  ).run(JSON.stringify(state), session.id);
  assert.equal(store.statistics(session.id).inputTokens, 9);
});

test('a legacy invalid goal checkpoint cannot bypass the current goal guard', async (t) => {
  const { store, db, session } = await fixture(t);
  const goal = {
    objective: 'valid goal',
    status: 'active',
    roundsStarted: 0,
    maxGoalRounds: 2,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  store.recordEvent(session.id, 'goal.changed', { goal });
  store.recordEvent(session.id, 'todo.written', { todos: [] });
  store.saveProjectionCheckpoints(session.id);
  db.prepare("UPDATE projection_checkpoints SET state=? WHERE session_id=? AND name='goal'").run(
    JSON.stringify({ ...goal, maxGoalRounds: -1 }),
    session.id,
  );
  assert.deepEqual(store.goal(session.id), goal);
});

test('schedule admission does not parse unrelated transcript events', async (t) => {
  const { store, db, session } = await fixture(t);
  const task = store.createTask(session.id, {
    title: 'scheduled',
    trigger: { kind: 'interval', enabled: true, everyMinutes: 60 },
  });
  store.scheduleImmediateRun(session.id, task.id);
  db.prepare('INSERT INTO session_events(session_id,type,data,at) VALUES(?,?,?,?)').run(
    session.id,
    'message.user',
    '{',
    new Date().toISOString(),
  );
  assert.equal(store.claimTaskSchedule(store.getTask(session.id, task.id), 'interval'), true);
});
