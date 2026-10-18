import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createHostState } from '../apps/agent-host/state.ts';
import { spillOwnerExists, type HostServices } from '../apps/agent-host/services.ts';
import { createDispatcher } from '../apps/agent-host/dispatch.ts';
import { HookRegistry } from '../packages/tools/hooks.ts';
import { SPILL_DIRECTORY, removeSpills, sweepSpills } from '../packages/tools/spill.ts';
import { SessionStore } from '../packages/storage/sqlite.ts';
import type { ImageAttachment } from '../packages/protocol/index.ts';

/**
 * What a deleted session leaves behind: nothing it alone owned, and nothing anybody else still needs.
 *
 * - **Spilled output.** Oversized tool results are copied to `.yuantu/spill/<session>/` so the model can read
 *   them back; nothing removed that directory, so every deleted conversation's output stayed in the workspace.
 * - **Image bytes across a session tree.** Deletion removes delegated children with their parent, and the bytes
 *   only that tree named go with it — decided in one pass over the remaining rows rather than one full scan per
 *   address — while a fork, which is someone else's conversation, keeps the bytes it shares.
 */

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);
/** A distinct image per call: the same PNG with trailing padding, so each one has its own content address. */
const image = (name: string, salt: number): ImageAttachment => ({
  name,
  mimeType: 'image/png',
  data: Buffer.concat([PNG, Buffer.alloc(salt)]).toString('base64'),
});
const hashOf = (attachment: ImageAttachment): string =>
  createHash('sha256').update(Buffer.from(attachment.data, 'base64')).digest('hex');

async function hostFixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-delete-cleanup-'));
  const file = path.join(root, 'sessions.sqlite');
  const store = new SessionStore(file);
  const hooks = new HookRegistry();
  t.after(async () => {
    await hooks.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const ctx = createHostState(
    {
      options: { json: false, allowWrite: false, allowCommand: false, help: false },
      workspace: root,
      launchSandbox: { mode: 'host', image: 'node:24' },
      permissionPolicy: undefined,
    },
    {
      store,
      hooks,
      background: { async close() {} },
      terminals: { async closeAllAndWait() {} },
      invariants: {
        async run() {
          return [];
        },
      },
    } as unknown as HostServices,
  );
  return { root, file, store, dispatch: createDispatcher(ctx) };
}
const exists = (target: string) =>
  access(target).then(
    () => true,
    () => false,
  );
async function spill(root: string, sessionId: string): Promise<string> {
  const directory = path.join(root, SPILL_DIRECTORY, sessionId);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'run_command-x.txt'), 'large output');
  return directory;
}

test('deleting a session removes its spilled output and its children’s, and leaves a fork’s alone', async (t) => {
  const { root, file, store, dispatch } = await hostFixture(t);
  const parent = store.create(root);
  const child = store.create(root, parent.id);
  // A fork points at its source too; `fork_message_count` is what tells it apart from a delegated child.
  const fork = store.create(root, parent.id);
  const db = new DatabaseSync(file);
  db.prepare('UPDATE sessions SET fork_message_count=0 WHERE id=?').run(fork.id);
  db.close();
  const parentSpill = await spill(root, parent.id);
  const childSpill = await spill(root, child.id);
  const forkSpill = await spill(root, fork.id);

  await dispatch('session.delete', { sessionId: parent.id });

  assert.equal(await exists(parentSpill), false, 'the session’s own spills are gone');
  assert.equal(
    await exists(childSpill),
    false,
    'a delegated child is deleted with it, spills included',
  );
  assert.equal(
    await exists(forkSpill),
    true,
    'a fork is another conversation and keeps its spills',
  );
  assert.equal(store.get(fork.id).id, fork.id);
});

test('spill removal refuses an id that is not one path segment', async () => {
  for (const id of ['', '.', '..', '../x', 'a/b', 'a\\b'])
    await assert.rejects(removeSpills(tmpdir(), id), /Invalid session id/, JSON.stringify(id));
});

test('deleting a session tree drops the bytes only the tree named, in one pass', async (t) => {
  const { root, file, store } = await hostFixture(t);
  const parent = store.create(root);
  const child = store.create(root, parent.id);
  const other = store.create(root);
  const parentOnly = image('parent.png', 1);
  const childOnly = image('child.png', 2);
  const shared = image('shared.png', 3);
  store.append(parent.id, { role: 'user', content: 'p', images: [parentOnly] });
  store.append(child.id, { role: 'user', content: 'c', images: [childOnly, shared] });
  store.append(other.id, { role: 'user', content: 'o', images: [shared] });
  store.flush();

  store.delete(parent.id);

  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const remaining = db
      .prepare('SELECT hash FROM attachment_blobs ORDER BY hash')
      .all()
      .map((row) => String(row.hash));
    assert.deepEqual(remaining, [hashOf(shared)], 'only the bytes another session names survive');
  } finally {
    db.close();
  }
  assert.throws(() => store.get(child.id), 'the child went with its parent');
  assert.equal(store.messages(other.id)[0]?.role, 'user');
});

test('the startup sweep removes old orphaned spills, keeps live and recent ones, and enforces the budget', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-spill-sweep-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  const age = async (target: string, ms: number) => {
    const at = new Date(now - ms);
    await utimes(target, at, at);
  };
  const live = await spill(root, 'live');
  const staleOrphan = await spill(root, 'gone-long-ago');
  const freshOrphan = await spill(root, 'maybe-another-store');
  await age(live, 10 * day);
  await age(staleOrphan, 2 * day);
  await age(freshOrphan, 60_000);

  const swept = await sweepSpills({
    workspace: root,
    sessionExists: (id) => id === 'live',
    now,
  });
  assert.equal(swept.orphans, 1);
  assert.equal(await exists(staleOrphan), false, 'an orphan past the grace period is removed');
  assert.equal(await exists(freshOrphan), true, 'a recent orphan may belong to another store');
  assert.equal(await exists(live), true, 'a session that exists keeps its spills however old');

  // Budget: three files of 10 bytes against a 25-byte budget lose the oldest one.
  const files = ['old', 'mid', 'new'].map((name) => path.join(live, `${name}.txt`));
  for (const [index, file] of files.entries()) {
    await writeFile(file, '0123456789');
    await age(file, (3 - index) * 60_000);
  }
  await rm(path.join(live, 'run_command-x.txt'));
  await rm(freshOrphan, { recursive: true });
  const trimmed = await sweepSpills({
    workspace: root,
    sessionExists: () => true,
    now,
    maxTotalBytes: 25,
  });
  assert.equal(trimmed.trimmed, 1);
  assert.deepEqual(
    await Promise.all(files.map(exists)),
    [false, true, true],
    'the oldest file goes first',
  );
});

test('the sweep of a workspace with no spill directory is a no-op', async () => {
  assert.deepEqual(
    await sweepSpills({
      workspace: path.join(tmpdir(), 'yuantu-no-such-workspace'),
      sessionExists: () => false,
    }),
    { orphans: 0, trimmed: 0 },
  );
});

test('the startup sweep only treats a definite "no such session" as an orphan', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-spill-owner-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new SessionStore(path.join(root, 'sessions.sqlite'));
  const session = store.create(root);
  const exists = spillOwnerExists(store);
  assert.equal(exists(session.id), true);
  assert.equal(exists('no-such-session'), false);
  // The sweep is not awaited by startup, so it can outlive its store: a closed store must not read as "gone".
  store.close();
  assert.equal(exists('no-such-session'), true);
});
