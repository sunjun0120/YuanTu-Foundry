import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SessionStore } from '../packages/storage/sqlite.ts';
import { StreamCheckpoints } from '../packages/storage/session-streams.ts';
import { AgentHostClient } from '../packages/client/host-client.ts';
import type { Message } from '../packages/protocol/index.ts';

test('Host restart restores streamed text saved before its process dies', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-stream-recovery-'));
  const db = path.join(root, 'sessions.sqlite');
  let reopened: SessionStore | undefined;
  let client: AgentHostClient | undefined;
  t.after(async () => {
    await client?.stop();
    reopened?.close();
    await rm(root, { recursive: true, force: true });
  });
  const initial = new SessionStore(db);
  const session = initial.create(root);
  initial.close();
  const storeUrl = pathToFileURL(path.resolve('packages/storage/sqlite.ts')).href;
  const agentUrl = pathToFileURL(path.resolve('packages/core/agent.ts')).href;
  const toolsUrl = pathToFileURL(path.resolve('packages/catalog/index.ts')).href;
  const childCode = `
    import { SessionStore } from ${JSON.stringify(storeUrl)};
    import { Agent } from ${JSON.stringify(agentUrl)};
    import { createTools } from ${JSON.stringify(toolsUrl)};
    const store = new SessionStore(${JSON.stringify(db)});
    const agent = new Agent({
      store,
      tools: createTools(${JSON.stringify(root)}),
      approve: async () => true,
      provider: { async complete(request) {
        request.onText('partial before crash');
        process.exit(0);
      } },
    });
    await agent.run({ sessionId: ${JSON.stringify(session.id)}, prompt: 'Hi' });
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', childCode], {
    cwd: path.resolve('.'),
    encoding: 'utf8',
    timeout: 30_000,
  });
  assert.equal(child.status, 0, child.stderr);
  client = new AgentHostClient({
    nodePath: process.execPath,
    hostPath: path.resolve('apps/agent-host/main.ts'),
    workspace: root,
    db,
    env: {
      YUANTU_MODEL: 'fixture',
      YUANTU_MAX_CONTEXT_TOKENS: '128000',
      YUANTU_SESSION_TITLES: '0',
      YUANTU_API_KEY: 'fixture',
    },
  });
  await client.start();
  const page = await client.request('session.get', {
    sessionId: session.id,
    offset: 0,
    view: 'display',
  });
  assert.equal(page.messages.at(-1)?.content, 'partial before crash');
  assert.equal((page.messages.at(-1) as { interrupted?: boolean }).interrupted, true);
  await client.stop();
  client = undefined;
  reopened = new SessionStore(db);
  assert.equal(reopened.recoverInterruptedStreams(root), 0);
  assert.equal(reopened.messages(session.id).length, page.messages.length);
});

/**
 * A minimal store for the checkpoint group.
 *
 * `StreamCheckpoints` is built from a four-member port, so it can be driven directly against an in-memory
 * database instead of through a crashed Host process — the crash path above proves the end-to-end story, and
 * these prove the four writes it is made of. The tables are the ones this module's own SQL reads and writes.
 */
function checkpointFixture() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE runs(id TEXT PRIMARY KEY, session_id TEXT, owner_pid INTEGER, status TEXT, owner_started_at INTEGER);
    CREATE TABLE sessions(id TEXT PRIMARY KEY, workspace TEXT);
    CREATE TABLE run_stream_checkpoints(
      run_id TEXT, session_id TEXT, message_id TEXT, text TEXT, updated_at TEXT,
      PRIMARY KEY(run_id, message_id)
    );
  `);
  const appended: Message[] = [];
  const checkpoints = new StreamCheckpoints({
    db,
    transaction: (fn) => fn(),
    append: (_id, message) => {
      appended.push(message);
    },
    recordEvent: () => {},
  });
  return { db, appended, checkpoints };
}

function addRun(db: DatabaseSync, id: string, sessionId: string, ownerPid: number | null): void {
  db.prepare('INSERT INTO runs(id,session_id,owner_pid,status) VALUES(?,?,?,?)').run(
    id,
    sessionId,
    ownerPid,
    'running',
  );
}

function addCheckpoint(
  db: DatabaseSync,
  runId: string,
  sessionId: string,
  messageId: string,
  text: string,
  updatedAt: string,
): void {
  db.prepare(
    'INSERT INTO run_stream_checkpoints(run_id,session_id,message_id,text,updated_at) VALUES(?,?,?,?,?)',
  ).run(runId, sessionId, messageId, text, updatedAt);
}

function checkpointRows(db: DatabaseSync, runId: string): { messageId: string; text: string }[] {
  return db
    .prepare(
      'SELECT message_id AS messageId,text FROM run_stream_checkpoints WHERE run_id=? ORDER BY updated_at',
    )
    .all(runId) as { messageId: string; text: string }[];
}

test('a checkpoint belongs to a run that is still running, and empty text is not one', () => {
  const { db, checkpoints } = checkpointFixture();
  addRun(db, 'run-live', 's1', null);
  checkpoints.checkpointStream('s1', 'run-live', 'msg-1', 'partial text');
  assert.equal(checkpointRows(db, 'run-live').length, 1);
  // Empty text carries nothing a reader could show, so it is not a recovery point at all.
  checkpoints.checkpointStream('s1', 'run-live', 'msg-2', '');
  assert.equal(checkpointRows(db, 'run-live').length, 1);
  // A finished run has nothing left to recover. The refusal is the SELECT itself — the INSERT names the status
  // — so there is no check that could drift away from the write it guards.
  db.prepare(
    "INSERT INTO runs(id,session_id,owner_pid,status) VALUES('run-done','s1',NULL,'completed')",
  ).run();
  assert.throws(
    () => checkpoints.checkpointStream('s1', 'run-done', 'msg-3', 'late text'),
    /inactive stream/i,
  );
  assert.equal(checkpointRows(db, 'run-done').length, 0);
});

test('recovery folds the non-empty checkpoints in the order they were written', () => {
  const { db, appended, checkpoints } = checkpointFixture();
  addRun(db, 'run-1', 's1', null);
  // The message ids deliberately run against the clock, so ordering by id and ordering by time disagree.
  addCheckpoint(db, 'run-1', 's1', 'zzz', 'second half', '2026-01-01T00:00:01.000Z');
  addCheckpoint(db, 'run-1', 's1', 'aaa', 'first half', '2026-01-01T00:00:02.000Z');
  addCheckpoint(db, 'run-1', 's1', 'mmm', '', '2026-01-01T00:00:03.000Z');
  const last = checkpoints.persistStreamCheckpoint('s1', 'run-1');
  assert.deepEqual(
    appended.map((message) => message.content),
    ['second half', 'first half'],
  );
  // A recovered fragment is not a finished answer, and a reader has to be able to tell.
  assert.deepEqual(
    appended.map((message) => (message as { interrupted?: boolean }).interrupted),
    [true, true],
  );
  assert.equal(last, 'first half');
  assert.equal(checkpointRows(db, 'run-1').length, 0);
});

test('committing a streamed message removes only its own recovery point', () => {
  const { db, checkpoints } = checkpointFixture();
  addRun(db, 'run-1', 's1', null);
  addCheckpoint(db, 'run-1', 's1', 'msg-1', 'one', '2026-01-01T00:00:01.000Z');
  addCheckpoint(db, 'run-1', 's1', 'msg-2', 'two', '2026-01-01T00:00:02.000Z');
  checkpoints.appendStreamMessage('s1', 'run-1', 'msg-1', {
    role: 'assistant',
    content: 'one',
    toolCalls: [],
  });
  // A checkpoint left behind would be folded in again by the next recovery pass, and the same text would appear
  // twice in the transcript.
  assert.deepEqual(
    checkpointRows(db, 'run-1').map((row) => row.messageId),
    ['msg-2'],
  );
});

test('recovery converges only streams whose owning process is gone, in the workspace it was asked about', () => {
  const { db, checkpoints } = checkpointFixture();
  db.prepare('INSERT INTO sessions(id,workspace) VALUES(?,?)').run('s-mine', '/ws/mine');
  db.prepare('INSERT INTO sessions(id,workspace) VALUES(?,?)').run('s-other', '/ws/other');
  addRun(db, 'run-alive', 's-mine', process.pid);
  addRun(db, 'run-dead', 's-mine', null);
  addRun(db, 'run-elsewhere', 's-other', null);
  addCheckpoint(
    db,
    'run-alive',
    's-mine',
    'msg-live',
    'from a live host',
    '2026-01-01T00:00:01.000Z',
  );
  addCheckpoint(
    db,
    'run-dead',
    's-mine',
    'msg-dead',
    'from a dead host',
    '2026-01-01T00:00:02.000Z',
  );
  addCheckpoint(
    db,
    'run-elsewhere',
    's-other',
    'msg-other',
    'from another tree',
    '2026-01-01T00:00:03.000Z',
  );
  // A live Host keeps writing its own rows, and another workspace's streams are not this caller's business.
  // The count is how a caller learns something happened, so it has to be the real one.
  assert.equal(checkpoints.recoverInterruptedStreams('/ws/mine'), 1);
  assert.equal(checkpointRows(db, 'run-alive').length, 1);
  assert.equal(checkpointRows(db, 'run-dead').length, 0);
  assert.equal(checkpointRows(db, 'run-elsewhere').length, 1);
});
