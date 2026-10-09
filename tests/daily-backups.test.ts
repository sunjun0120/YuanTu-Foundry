import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile, writeFile, symlink, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SessionStore } from '../packages/storage/sqlite.ts';
import { DailyBackups } from '../apps/desktop/daily-backups.ts';
import { databaseBackupAction } from '../apps/desktop/database-backup-worker.ts';

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-daily-backup-'));
  const file = path.join(root, 'sessions.sqlite');
  const store = new SessionStore(file);
  let closed = false;
  const close = () => {
    if (!closed) {
      store.close();
      closed = true;
    }
  };
  t.after(async () => {
    close();
    await rm(root, { recursive: true, force: true });
  });
  const session = store.create(root);
  store.append(session.id, { role: 'user', content: 'Committed in WAL' });
  store.flush();
  const settings = path.join(root, 'backup-settings.json');
  const service = new DailyBackups(settings, async (db, operation, id) =>
    databaseBackupAction(db, operation, id),
  );
  await service.load();
  return { root, file, store, session, service, settings, close };
}

test('daily backups are optional, retain WAL data and skip another snapshot before 24 hours', async (t) => {
  const f = await fixture(t);
  await f.service.tick(f.file);
  assert.equal((await f.service.view(f.file)).backups.length, 0);
  await f.service.configure(true);
  await Promise.all([f.service.tick(f.file), f.service.tick(f.file)]);
  const first = await f.service.view(f.file);
  assert.equal(first.backups.length, 1);
  const snapshot = new SessionStore(path.join(`${f.file}.backups`, first.backups[0]!.id));
  assert.equal(snapshot.messages(f.session.id)[0]?.content, 'Committed in WAL');
  snapshot.close();
  await f.service.tick(f.file, Date.parse(first.backups[0]!.createdAt) + 86_399_999);
  assert.equal((await f.service.view(f.file)).backups.length, 1);
  await f.service.tick(f.file, Date.parse(first.backups[0]!.createdAt) + 86_400_001);
  assert.equal((await f.service.view(f.file)).backups.length, 2);
  const reopened = new DailyBackups(f.settings, async (db, operation, id) =>
    databaseBackupAction(db, operation, id),
  );
  await reopened.load();
  assert.equal((await reopened.view(f.file)).enabled, true);
});

test('backup failures are visible and retention leaves unknown files untouched', async (t) => {
  const f = await fixture(t);
  await writeFile(`${f.file}.backups`, 'Blocking directory');
  await f.service.configure(true);
  await f.service.tick(f.file);
  assert.ok((await f.service.view(f.file)).error);
  assert.equal(f.store.messages(f.session.id)[0]?.content, 'Committed in WAL');
  await rm(`${f.file}.backups`);
  await f.service.create(f.file);
  const unknown = path.join(`${f.file}.backups`, 'notes.txt');
  await writeFile(unknown, 'keep');
  for (let i = 0; i < 6; i++) await f.service.create(f.file);
  assert.equal((await f.service.view(f.file)).backups.length, 5);
  assert.equal(await readFile(unknown, 'utf8'), 'keep');
  assert.equal((await f.service.view(f.file)).error, null);
});

test('restore requires an owned intact snapshot and an offline database, preserving current data', async (t) => {
  const f = await fixture(t);
  const view = await f.service.create(f.file);
  const id = view.backups[0]!.id;
  assert.throws(() => databaseBackupAction(f.file, 'restore', '../sessions.sqlite'));
  assert.throws(() => databaseBackupAction(f.file, 'restore', id), /active reader\/writer/i);
  f.store.append(f.session.id, { role: 'user', content: 'Preserve before restoration' });
  f.close();
  const result = databaseBackupAction(f.file, 'restore', id);
  assert.ok(result.recoveryDirectory);
  const restored = new SessionStore(f.file);
  assert.equal(restored.messages(f.session.id).length, 1);
  restored.close();
  const preserved = new SessionStore(path.join(result.recoveryDirectory!, 'database.sqlite'));
  assert.equal(preserved.messages(f.session.id)[1]?.content, 'Preserve before restoration');
  preserved.close();
  const snapshot = path.join(`${f.file}.backups`, id);
  await writeFile(snapshot, Buffer.concat([await readFile(snapshot), Buffer.from('tamper')]));
  assert.throws(() => databaseBackupAction(f.file, 'verify', id), /checksum|size/i);
});

test('a manual backup waits for a concurrent schedule check and still creates a new snapshot', async (t) => {
  const f = await fixture(t);
  const initial = await f.service.create(f.file);
  let release!: () => void;
  let first = true;
  let creates = 0;
  const service = new DailyBackups(f.settings, async (file, operation, id) => {
    if (operation === 'list' && first) {
      first = false;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { backups: initial.backups };
    }
    if (operation === 'create') creates++;
    return databaseBackupAction(file, operation, id);
  });
  await service.load();
  await service.configure(true);
  const scheduled = service.tick(f.file);
  const manual = service.create(f.file);
  release();
  await Promise.all([scheduled, manual]);
  assert.equal(creates, 1);
  assert.equal((await service.view(f.file)).backups.length, 2);
});

test('backup creation rejects a linked directory before writing or pruning its target', async (t) => {
  const f = await fixture(t);
  const outside = path.join(f.root, 'outside');
  await mkdir(outside);
  await writeFile(path.join(outside, 'notes.txt'), 'untouched');
  await symlink(outside, `${f.file}.backups`, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => databaseBackupAction(f.file, 'create'), /backup directory/i);
  assert.deepEqual(await readdir(outside), ['notes.txt']);
  assert.equal(await readFile(path.join(outside, 'notes.txt'), 'utf8'), 'untouched');
});

test('corrupt optional backup settings disable scheduling and can be repaired without blocking startup', async (t) => {
  const f = await fixture(t);
  await writeFile(f.settings, '{"enabled":');
  const service = new DailyBackups(f.settings, async (file, operation, id) =>
    databaseBackupAction(file, operation, id),
  );
  await service.load();
  const broken = await service.view(f.file);
  assert.equal(broken.enabled, false);
  assert.match(broken.error!, /backup settings/i);
  await service.tick(f.file);
  assert.equal((await service.view(f.file)).backups.length, 0);
  await service.configure(true);
  await service.tick(f.file);
  const repaired = await service.view(f.file);
  assert.equal(repaired.enabled, true);
  assert.equal(repaired.error, null);
  assert.equal(repaired.backups.length, 1);
});
