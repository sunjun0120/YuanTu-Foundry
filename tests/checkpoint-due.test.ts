import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SessionStore } from '../packages/storage/sqlite.ts';

test('a long session is checkpointed every N events, and a reopened store reads from it', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-checkpoint-due-'));
  const db = path.join(root, 'sessions.sqlite');
  const store = new SessionStore(db);
  const session = store.create(root);
  // The first call only records where the log stands: a short run never writes here.
  assert.equal(store.checkpointIfDue(session.id, 50), false);
  for (let index = 0; index < 49; index++)
    store.append(session.id, { role: 'user', content: `message ${index}` });
  assert.equal(store.checkpointIfDue(session.id, 50), false, 'not due yet');
  store.append(session.id, { role: 'user', content: 'message 49' });
  assert.equal(store.checkpointIfDue(session.id, 50), true, 'due after 50 events');
  assert.equal(store.checkpointIfDue(session.id, 50), false, 'the mark moved with it');
  const expected = store.statistics(session.id);
  // Simulate a crash: the store is abandoned rather than closed, so only the mid-run checkpoint exists.
  const reopened = new SessionStore(db);
  t.after(async () => {
    reopened.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  reopened.resetFoldCounters();
  assert.deepEqual(reopened.statistics(session.id), expected);
  assert.ok(
    reopened.foldStats().checkpointHits > 0,
    'the reopened read started from the checkpoint',
  );
});
