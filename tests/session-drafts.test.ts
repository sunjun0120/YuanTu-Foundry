/**
 * A new session is a draft until something happens in it, the way Claude Code and Codex treat one.
 *
 * The store tells untouched sessions apart (`started`), the sidebar lists only the started ones, "New session" on an
 * untouched session stays on it, and leaving a draft that is still untouched deletes it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { CarrierService } from '../packages/carrier/service.ts';
import { storeFixture } from './temp-fixture.ts';

test('the store lists started and untouched sessions apart', async (t) => {
  const { root, store } = await storeFixture(t, 'yuantu-session-drafts-');
  const empty = store.create(root),
    written = store.create(root),
    titled = store.create(root);
  store.append(written.id, { role: 'user', content: 'hello' });
  store.rename(titled.id, 'named');
  // Run history alone is enough: a parent whose subagent ran was used, even without a message of its own.
  const delegated = store.create(root);
  store.recordEvent(delegated.id, 'run.finished', { runId: 'earlier' });
  const ids = (started?: boolean) =>
    store
      .list('', root, started === undefined ? {} : { started })
      .map((s) => s.id)
      .sort();
  assert.deepEqual(ids(true), [written.id, titled.id, delegated.id].sort());
  assert.deepEqual(ids(false), [empty.id]);
  assert.equal(ids().length, 4, 'absent, every session is still listed');
  assert.throws(
    () => store.list('', root, { started: 'yes' as unknown as boolean }),
    /Invalid session page/,
  );
});

test('the carrier keeps a new session out of the sidebar and discards it when left untouched', async (t) => {
  let service: CarrierService | undefined;
  t.after(async () => {
    await service?.stop();
  });
  const { root, db: file, store } = await storeFixture(t, 'yuantu-session-drafts-');
  const older = store.create(root);
  store.append(older.id, { role: 'user', content: 'older' });
  // Appends are buffered in this process; the Host reads the database.
  store.flush();
  service = new CarrierService({
    nodePath: process.execPath,
    hostPath: path.resolve('apps/agent-host/main.ts'),
    workspace: root,
    db: file,
  });
  await service.start();
  await service.dispatch({ type: 'create' });
  const draft = service.snapshot.session.sessionId!;
  assert.notEqual(draft, older.id);
  assert.deepEqual(
    service.snapshot.sessions.map((s) => s.id),
    [older.id],
    'the draft is not listed',
  );
  await service.dispatch({ type: 'create' });
  assert.equal(service.snapshot.session.sessionId, draft, 'New session again stays on the draft');
  await service.dispatch({ type: 'load', id: older.id });
  assert.deepEqual(
    store.list('', root, { id: draft }),
    [],
    'leaving the untouched draft deleted it',
  );
  assert.deepEqual(
    service.snapshot.sessions.map((s) => s.id),
    [older.id],
  );
});
