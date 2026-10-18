import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { TestContext } from 'node:test';
import { SessionStore } from '../packages/storage/sqlite.ts';
type Session = ReturnType<SessionStore['create']>;

/**
 * A fresh directory under the worker's temporary root, removed when the test ends.
 *
 * `t.after` hooks run in the order they were registered, so anything a test registers after this call is torn
 * down *after* the directory is gone — the same order the hand-written `t.after(() => rm(root, …))` gave.
 */
export async function tempRoot(t: TestContext, prefix = 'yuantu-test-'): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

/**
 * A temporary workspace holding a session store and one session in it.
 *
 * The store is closed before the directory is removed, in one hook: on Windows an open SQLite file cannot be
 * deleted, so the two must not be left to separate hooks a test could interleave. The store is always closed
 * here, so a test that closes or reopens it itself keeps its own cleanup instead.
 *
 * `session` is created on first read, so a test that destructures only `{ root, store }` leaves the store
 * empty — tests that count sessions see exactly the ones they made.
 */
export async function storeFixture(
  t: TestContext,
  prefix = 'yuantu-test-',
  file = 'sessions.sqlite',
): Promise<{ root: string; db: string; store: SessionStore; readonly session: Session }> {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  const db = path.join(root, file);
  const store = new SessionStore(db);
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  let session: Session | undefined;
  return {
    root,
    db,
    store,
    get session() {
      return (session ??= store.create(root));
    },
  };
}
