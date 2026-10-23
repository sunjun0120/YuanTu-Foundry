/**
 * Space a deleted session frees goes back to the disk while the database is open.
 *
 * SQLite keeps a deleted record's pages on a free list and the file at its historical peak; a workspace measured
 * during the audit held 14 MB of sessions in a 58 MB file, and the only way back was an offline maintainer command.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SessionStore } from '../packages/storage/sqlite.ts';
import { startIdleReclaim } from '../apps/agent-host/space-reclaim.ts';
import { storeFixture, tempRoot } from './temp-fixture.ts';

const autoVacuum = (file: string): number => {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return Number(db.prepare('PRAGMA auto_vacuum').get()?.auto_vacuum);
  } finally {
    db.close();
  }
};

async function databaseFile(t: test.TestContext): Promise<string> {
  return path.join(await tempRoot(t, 'yuantu-db-space-'), 'sessions.sqlite');
}

test('a new session database is created in incremental vacuum mode', async (t) => {
  const file = await databaseFile(t);
  new SessionStore(file).close();
  assert.equal(autoVacuum(file), 2);
});

test('an existing database is converted at open, unless another process has it open', async (t) => {
  const file = await databaseFile(t);
  new SessionStore(file).close();
  // What a database written by an older build looks like: no auto vacuum.
  const legacy = new DatabaseSync(file);
  legacy.exec('PRAGMA auto_vacuum=NONE; VACUUM;');
  legacy.close();
  assert.equal(autoVacuum(file), 0);

  // Another live process holds it: converting would need the file to itself, so it is left as it is.
  mkdirSync(`${file}.users`, { recursive: true });
  const other = path.join(`${file}.users`, `${process.ppid}-other-process`);
  writeFileSync(other, '');
  new SessionStore(file).close();
  assert.equal(autoVacuum(file), 0);

  // The next open that has it alone converts it.
  const { rmSync } = await import('node:fs');
  rmSync(other);
  new SessionStore(file).close();
  assert.equal(autoVacuum(file), 2);
});

test('deleted sessions are reclaimed in bounded batches until the file is compact', async (t) => {
  const { db: file, store } = await storeFixture(t, 'yuantu-db-space-');
  const root = path.dirname(file);
  const doomed: string[] = [];
  for (let index = 0; index < 4; index++) {
    const session = store.create(root);
    for (let turn = 0; turn < 40; turn++)
      store.append(session.id, { role: 'user', content: `${index}:${turn} ${'x'.repeat(8_000)}` });
    doomed.push(session.id);
  }
  store.flush();
  for (const id of doomed) store.delete(id);
  const freed = store.freePages();
  assert.ok(freed > 64, `expected free pages after the delete, found ${freed}`);

  // One pass gives back at most its batch, so a big delete never stalls the Host in one go.
  assert.equal(store.reclaimFreePages(64), 64);
  let passes = 1;
  while (store.reclaimFreePages(64) > 0) passes++;
  assert.ok(passes > 1, 'a large delete takes more than one bounded pass');
  assert.equal(store.freePages(), 0);
  assert.equal(store.reclaimFreePages(64), 0, 'nothing left to reclaim is a no-op');
});

test('a database still in its old mode is left alone by a reclaim pass', async (t) => {
  const { db: file, store } = await storeFixture(t, 'yuantu-db-space-');
  // Simulate one the conversion skipped (another process had it open at this open).
  (store as unknown as { db: DatabaseSync }).db.exec('PRAGMA auto_vacuum=NONE; VACUUM;');
  const session = store.create(path.dirname(file));
  store.append(session.id, { role: 'user', content: 'x'.repeat(50_000) });
  store.flush();
  store.delete(session.id);
  assert.ok(store.freePages() > 0);
  assert.equal(store.reclaimFreePages(), 0);
});

test('the idle reclaim waits while a run is active and stops when asked', async () => {
  let calls = 0;
  const active = new Map<string, unknown>([['session-1', {}]]);
  const ctx = {
    store: { reclaimFreePages: () => (calls++, 0) },
    active,
    closing: false,
  } as unknown as Parameters<typeof startIdleReclaim>[0];
  const stop = startIdleReclaim(ctx, 5);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(calls, 0, 'a run is active, so nothing is reclaimed');
  active.clear();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.ok(calls > 0, 'idle again, so the batches resume');
  stop();
  const stopped = calls;
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(calls, stopped);
});

test('the file itself shrinks once reclaimed pages are checkpointed', async (t) => {
  const file = await databaseFile(t);
  const store = new SessionStore(file);
  const root = path.dirname(file);
  const session = store.create(root);
  for (let turn = 0; turn < 200; turn++)
    store.append(session.id, { role: 'user', content: `${turn} ${'y'.repeat(8_000)}` });
  store.flush();
  store.close();
  const full = statSync(file).size;
  const reopened = new SessionStore(file);
  try {
    reopened.delete(session.id);
    while (reopened.reclaimFreePages() > 0);
    (reopened as unknown as { db: DatabaseSync }).db
      .prepare('PRAGMA wal_checkpoint(TRUNCATE)')
      .all();
    assert.ok(statSync(file).size < full / 2, `${statSync(file).size} is not well below ${full}`);
  } finally {
    reopened.close();
  }
});
