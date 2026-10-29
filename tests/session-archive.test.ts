/**
 * Archiving a session: it leaves the sidebar's list and nothing it holds changes; unarchiving brings it back.
 *
 * The store answers the list with or without the archived ones (`archived` absent keeps every existing caller —
 * existence checks, recovery — seeing all of them), and the carrier asks for the sidebar's page without them.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { CarrierService } from '../packages/carrier/service.ts';
import { parseCarrierCommand } from '../packages/carrier/contract.ts';
import { storeFixture } from './temp-fixture.ts';

async function fixture(t: test.TestContext) {
  const { root, db: file, store } = await storeFixture(t, 'yuantu-session-archive-');
  return { root, file, store };
}

test('an archived session leaves the filtered list, keeps its messages, and comes back', async (t) => {
  const { root, store } = await fixture(t);
  const kept = store.create(root),
    archived = store.create(root);
  store.append(archived.id, { role: 'user', content: '归档 前的 消息' });
  const answer = store.setArchived(archived.id, true);
  assert.ok(answer.archivedAt, 'the answer says when');
  const ids = (page: { archived?: boolean }) => store.list('', root, page).map((s) => s.id);
  assert.deepEqual(ids({ archived: false }), [kept.id]);
  assert.deepEqual(ids({ archived: true }), [archived.id]);
  assert.equal(ids({}).length, 2, 'absent, the list still holds both');
  assert.equal(store.list('', root, { archived: true })[0]?.archivedAt, answer.archivedAt);
  assert.equal(store.messages(archived.id).length, 1, 'nothing it holds changes');
  assert.equal(store.setArchived(archived.id, false).archivedAt, null);
  assert.deepEqual(ids({ archived: true }), []);
  assert.equal(ids({ archived: false }).length, 2);
});

test('a running session cannot be archived', async (t) => {
  const { root, store } = await fixture(t);
  const session = store.create(root);
  store.beginRun(session.id);
  assert.throws(() => store.setArchived(session.id, true), /running/);
});

test('the carrier command is validated like the other session commands', () => {
  assert.deepEqual(parseCarrierCommand({ type: 'archiveSession', id: 'a', archived: true }), {
    type: 'archiveSession',
    id: 'a',
    archived: true,
  });
  for (const bad of [
    { type: 'archiveSession', id: 'a' },
    { type: 'archiveSession', id: '', archived: true },
    { type: 'archiveSession', id: 'a', archived: 'yes' },
    { type: 'archiveSession', id: 'a', archived: true, extra: 1 },
  ])
    assert.throws(() => parseCarrierCommand(bad));
});

test('archiving through the carrier hides the session from the sidebar and moves off it when open', async (t) => {
  let service: CarrierService | undefined;
  t.after(async () => {
    await service?.stop();
  });
  const { root, file, store } = await fixture(t);
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
  const open = service.snapshot.session.sessionId!;
  // An untouched session is not listed at all; a title is enough to make it one the sidebar shows.
  await service.dispatch({ type: 'rename', id: open, title: 'open' });
  await service.dispatch({ type: 'archiveSession', id: open, archived: true });
  assert.notEqual(service.snapshot.session.sessionId, open, 'the window left the archived session');
  assert.equal(service.snapshot.session.sessionId, older.id);
  assert.deepEqual(
    service.snapshot.sessions.map((s) => s.id),
    [older.id],
  );
  assert.deepEqual(
    (await service.archivedSessions()).map((s) => s.id),
    [open],
  );
  await service.dispatch({ type: 'archiveSession', id: open, archived: false });
  assert.deepEqual(service.snapshot.sessions.map((s) => s.id).sort(), [older.id, open].sort());
  assert.deepEqual(await service.archivedSessions(), []);
});

test('the archived-sessions page is bounded to the newest 500', { timeout: 60000 }, async (t) => {
  let service: CarrierService | undefined;
  t.after(async () => {
    await service?.stop();
  });
  const { root, file, store } = await fixture(t);
  for (let index = 0; index < 501; index++) {
    const session = store.create(root);
    store.setArchived(session.id, true);
  }
  service = new CarrierService({
    nodePath: process.execPath,
    hostPath: path.resolve('apps/agent-host/main.ts'),
    workspace: root,
    db: file,
    startupTimeoutMs: 30_000,
  });
  await service.start();
  const archived = await service.archivedSessions();
  assert.equal(archived.length, 500);
});
