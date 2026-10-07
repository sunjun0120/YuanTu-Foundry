import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import {
  SessionStore,
  SCHEMA_VERSION,
  SESSION_DATABASE_POLICY,
} from '../packages/storage/sqlite.ts';
import {
  backupDatabase,
  createDatabaseBackup,
  restoreDatabase,
  inspectDatabase,
  recoverDatabase,
} from '../packages/storage/database-maintenance.ts';
import { runCli } from './process-fixture.ts';

function fixture(t: test.TestContext) {
  const root = mkdtempSync(path.join(tmpdir(), 'yuantu-backup-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, file: path.join(root, '会话 data.sqlite') };
}

test('migration creates a verified independent snapshot including committed WAL content', (t) => {
  const { root, file } = fixture(t);
  const store = new SessionStore(file);
  const session = store.create(root);
  store.append(session.id, { role: 'assistant', content: 'before migration', toolCalls: [] });
  store.createTask(session.id, { title: 'durable task' });
  store.close();
  const writer = new DatabaseSync(file);
  writer.exec(
    `PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; PRAGMA user_version=${SCHEMA_VERSION - 1}`,
  );
  writer.prepare('UPDATE sessions SET title=? WHERE id=?').run('committed in WAL', session.id);
  const upgraded = new SessionStore(file);
  upgraded.close();
  const backups = readdirSync(`${file}.backups`).filter((name) => name.endsWith('.sqlite'));
  assert.equal(backups.length, 1);
  const snapshot = new DatabaseSync(path.join(`${file}.backups`, backups[0]!), { readOnly: true });
  try {
    assert.equal(snapshot.prepare('PRAGMA integrity_check').get()?.integrity_check, 'ok');
    assert.equal(
      Number(snapshot.prepare('PRAGMA user_version').get()?.user_version),
      SCHEMA_VERSION - 1,
    );
    assert.equal(
      snapshot.prepare('SELECT title FROM sessions WHERE id=?').get(session.id)?.title,
      'committed in WAL',
    );
    assert.equal(snapshot.prepare('SELECT count(*) AS n FROM tasks').get()?.n, 1);
  } finally {
    snapshot.close();
    writer.close();
  }
});

test('a backup failure refuses migration before changing the original schema or content', (t) => {
  const { root, file } = fixture(t);
  const store = new SessionStore(file);
  store.create(root);
  store.close();
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA user_version=${SCHEMA_VERSION - 1}`);
  db.close();
  writeFileSync(`${file}.backups`, 'directory blocked');
  assert.throws(() => new SessionStore(file), /backup.*migration|migration.*backup/i);
  const original = new DatabaseSync(file, { readOnly: true });
  assert.equal(
    Number(original.prepare('PRAGMA user_version').get()?.user_version),
    SCHEMA_VERSION - 1,
  );
  assert.equal(original.prepare('SELECT count(*) AS n FROM sessions').get()?.n, 1);
  original.close();
});

test('maintenance CLI backs up, verifies and restores without credentials, preserving current data', async (t) => {
  const { root, file } = fixture(t);
  let store = new SessionStore(file);
  const session = store.create(root);
  store.append(session.id, { role: 'user', content: 'original message' });
  store.close();
  const backed = await runCli(['db-backup', '--db', file, '--json']);
  assert.equal(backed.code, 0, backed.stderr);
  const backup = JSON.parse(backed.stdout);
  const verified = await runCli(['db-verify', backup.file, '--json']);
  assert.equal(verified.code, 0, verified.stderr);
  store = new SessionStore(file);
  store.append(session.id, { role: 'user', content: 'after backup' });
  store.close();
  const restored = await runCli(['db-restore', backup.file, '--db', file, '--json']);
  assert.equal(restored.code, 0, restored.stderr);
  const report = JSON.parse(restored.stdout);
  store = new SessionStore(file);
  assert.equal(store.messages(session.id).at(-1)?.content, 'original message');
  store.close();
  const preserved = new SessionStore(path.join(report.recoveryDirectory, 'database.sqlite'));
  assert.equal(preserved.messages(session.id).at(-1)?.content, 'after backup');
  preserved.close();
});

test('restore refuses an active store and rejects corrupt or incompatible candidates without mutation', async (t) => {
  const { root, file } = fixture(t);
  const store = new SessionStore(file);
  store.create(root);
  const backed = await runCli(['db-backup', '--db', file, '--json']);
  assert.equal(backed.code, 0, backed.stderr);
  const candidate = JSON.parse(backed.stdout).file;
  const busy = await runCli(['db-restore', candidate, '--db', file, '--json']);
  assert.notEqual(busy.code, 0);
  assert.match(busy.stderr, /open|active|close/i);
  store.close();
  const original = readFileSync(file);
  const bad = path.join(root, 'bad.sqlite');
  writeFileSync(bad, 'corrupted');
  const corrupt = await runCli(['db-restore', bad, '--db', file]);
  assert.notEqual(corrupt.code, 0);
  assert.deepEqual(readFileSync(file), original);
  const future = new DatabaseSync(candidate);
  future.exec(`PRAGMA user_version=${SCHEMA_VERSION + 1}`);
  future.close();
  const incompatible = await runCli(['db-restore', candidate, '--db', file]);
  assert.notEqual(incompatible.code, 0);
  assert.deepEqual(readFileSync(file), original);
});

test('legacy unmarked databases with FTS shadow tables remain migratable', (t) => {
  const { root, file } = fixture(t);
  const store = new SessionStore(file);
  const session = store.create(root);
  store.append(session.id, { role: 'user', content: 'searchable legacy message' });
  store.close();
  const db = new DatabaseSync(file);
  db.exec(`DROP TABLE application_marker; PRAGMA user_version=${SCHEMA_VERSION - 1}`);
  db.close();
  const reopened = new SessionStore(file);
  assert.equal(reopened.messages(session.id)[0]?.content, 'searchable legacy message');
  reopened.close();
});

test('managed snapshot checksum rejects valid SQLite content tampering before replacement', (t) => {
  const { root, file } = fixture(t);
  const store = new SessionStore(file);
  store.create(root);
  store.close();
  const backup = backupDatabase(file, SESSION_DATABASE_POLICY);
  const db = new DatabaseSync(backup.file);
  db.exec("UPDATE sessions SET title='changed after backup'");
  db.close();
  const before = readFileSync(file);
  assert.throws(() => inspectDatabase(backup.file, SESSION_DATABASE_POLICY), /checksum/i);
  assert.throws(() => restoreDatabase(file, backup.file, SESSION_DATABASE_POLICY), /checksum/i);
  assert.deepEqual(readFileSync(file), before);
});

test('retention bounds count and bytes; insufficient capacity leaves migration unchanged', (t) => {
  const { root, file } = fixture(t);
  const store = new SessionStore(file);
  store.create(root);
  store.close();
  const db = new DatabaseSync(file);
  for (let i = 0; i < 4; i++)
    createDatabaseBackup(db, file, SESSION_DATABASE_POLICY, 'manual', {
      maxCount: 2,
      maxBytes: 1024 * 1024,
    });
  assert.equal(readdirSync(`${file}.backups`).filter((name) => name.endsWith('.sqlite')).length, 2);
  db.exec(`PRAGMA user_version=${SCHEMA_VERSION - 1}`);
  db.close();
  assert.throws(
    () => new SessionStore(file, { backupRetention: { maxCount: 2, maxBytes: 1 } }),
    /capacity/i,
  );
  const original = new DatabaseSync(file);
  assert.equal(
    Number(original.prepare('PRAGMA user_version').get()?.user_version),
    SCHEMA_VERSION - 1,
  );
  original.close();
});

test('restoration preserves attachments, pending approvals, durable tasks and opaque model replay', (t) => {
  const { root, file } = fixture(t);
  let store = new SessionStore(file);
  const session = store.create(root);
  store.append(session.id, {
    role: 'user',
    content: 'image reference',
    images: [
      {
        mimeType: 'image/png',
        data: Buffer.from('attachment bytes').toString('base64'),
        name: 'reference.png',
      },
    ],
  });
  store.append(session.id, {
    role: 'assistant',
    content: 'replay state',
    toolCalls: [],
    providerState: {
      protocol: 'openai-responses',
      model: 'test-model',
      endpoint: 'https://example.test/v1/responses',
      output: [{ type: 'reasoning', encrypted_content: 'opaque encrypted replay' }],
    },
  });
  const task = store.createTask(session.id, {
    title: 'approval task',
    trigger: { kind: 'interval', everyMinutes: 1, enabled: true },
  });
  store.updateTask(session.id, task.id, { status: 'in_progress' });
  store.deferTaskApproval(session.id, task.id, {
    kind: 'write',
    description: 'write after approval',
    toolCall: { id: 'call', name: 'edit_file', arguments: { path: 'a.txt' } },
  });
  const messages = store.messages(session.id);
  const pending = store.getTask(session.id, task.id);
  store.close();
  const backup = backupDatabase(file, SESSION_DATABASE_POLICY);
  writeFileSync(file, 'broken original database');
  const restored = restoreDatabase(file, backup.file, SESSION_DATABASE_POLICY);
  assert.equal(
    readFileSync(path.join(restored.recoveryDirectory, 'database.sqlite'), 'utf8'),
    'broken original database',
  );
  store = new SessionStore(file);
  assert.deepEqual(store.messages(session.id), messages);
  assert.deepEqual(store.getTask(session.id, task.id), pending);
  store.close();
});

test('an interrupted restore blocks opening until rollback returns the preserved original', (t) => {
  const { root, file } = fixture(t);
  let store = new SessionStore(file);
  const session = store.create(root);
  store.append(session.id, { role: 'user', content: 'snapshot' });
  store.close();
  const backup = backupDatabase(file, SESSION_DATABASE_POLICY);
  store = new SessionStore(file);
  store.append(session.id, { role: 'user', content: 'current before restore' });
  store.close();
  const receipt = restoreDatabase(file, backup.file, SESSION_DATABASE_POLICY);
  writeFileSync(`${file}.restore.json`, JSON.stringify({ ...receipt, phase: 'installed' }));
  assert.throws(() => new SessionStore(file), /interrupted|db-recover/i);
  const recovered = recoverDatabase(file);
  assert.equal(recovered.phase, 'rolled-back');
  store = new SessionStore(file);
  assert.equal(store.messages(session.id).at(-1)?.content, 'current before restore');
  store.close();
});

test('migration failure is recoverable from its pre-migration snapshot', (t) => {
  const { root, file } = fixture(t);
  const store = new SessionStore(file);
  const session = store.create(root);
  store.append(session.id, { role: 'user', content: 'survives failed upgrade' });
  store.close();
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA user_version=${SCHEMA_VERSION - 1}`);
  db.close();
  const prototype = SessionStore.prototype as unknown as {
    migrateMachineTitledSessions: (version: number) => void;
  };
  const migrate = prototype.migrateMachineTitledSessions;
  prototype.migrateMachineTitledSessions = () => {
    throw new Error('simulated migration failure');
  };
  try {
    assert.throws(() => new SessionStore(file), /simulated migration failure/);
  } finally {
    prototype.migrateMachineTitledSessions = migrate;
  }
  const snapshot = readdirSync(`${file}.backups`).find((name) => name.endsWith('.sqlite'))!;
  restoreDatabase(file, path.join(`${file}.backups`, snapshot), SESSION_DATABASE_POLICY);
  const reopened = new SessionStore(file);
  assert.equal(reopened.messages(session.id).at(-1)?.content, 'survives failed upgrade');
  reopened.close();
});

test('parallel online backups publish under one retention lock', async (t) => {
  const { root, file } = fixture(t);
  const store = new SessionStore(file);
  store.create(root);
  const results = await Promise.all([
    runCli(['db-backup', '--db', file, '--json']),
    runCli(['db-backup', '--db', file, '--json']),
  ]);
  store.close();
  for (const result of results) {
    assert.equal(result.code, 0, result.stderr);
    assert.equal(
      inspectDatabase(JSON.parse(result.stdout).file, SESSION_DATABASE_POLICY).version,
      SCHEMA_VERSION,
    );
  }
});

test('a stale maintenance lock is refused without deleting another ownership record', (t) => {
  const { root, file } = fixture(t);
  const store = new SessionStore(file);
  store.create(root);
  store.close();
  const lock = `${file}.maintenance-lock`;
  writeFileSync(lock, '2147483647:dead-owner');
  const before = readFileSync(file);
  assert.throws(() => new SessionStore(file), /lock requires inspection/);
  assert.equal(readFileSync(lock, 'utf8'), '2147483647:dead-owner');
  assert.deepEqual(readFileSync(file), before);
});
