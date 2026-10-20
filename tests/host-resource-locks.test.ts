import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SessionStore } from '../packages/storage/sqlite.ts';
import { ResourceLocks } from '../apps/agent-host/resource-locks.ts';
import {
  acquireLocks,
  acquireModelSlot,
  admissionRefusal,
  fileClaims,
  hostClaim,
  lockConflict,
  runSlotFree,
  sessionCanRun,
  sessionClaim,
  type HostContext,
} from '../apps/agent-host/state.ts';
import { sessionHandlers } from '../apps/agent-host/handlers/sessions.ts';

test('shared claims coexist, an exclusive one stands alone, and acquiring is all or nothing', () => {
  const locks = new ResourceLocks();
  const reader = locks.tryAcquire([{ key: 'root:a', mode: 'shared' }])!;
  assert.ok(locks.tryAcquire([{ key: 'root:a', mode: 'shared' }]));
  assert.equal(locks.tryAcquire([{ key: 'root:a', mode: 'exclusive' }]), undefined);
  // The free key is not taken when another key in the same request is refused.
  assert.equal(
    locks.tryAcquire([
      { key: 'root:b', mode: 'exclusive' },
      { key: 'root:a', mode: 'exclusive' },
    ]),
    undefined,
  );
  assert.ok(locks.tryAcquire([{ key: 'root:b', mode: 'exclusive' }]));
  // Claims passed in from outside the table count as held.
  assert.ok(locks.conflict([{ key: 'session:x', mode: 'exclusive' }], [sessionClaim('x')]));
  reader.release();
  reader.release();
  assert.equal(locks.claims().filter((claim) => claim.key === 'root:a').length, 1);
});

async function host(t: test.TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-locks-'));
  const store = new SessionStore(':memory:');
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const [a, b, c] = [store.create(root).id, store.create(root).id, store.create(root).id];
  const ctx = {
    workspace: root,
    store,
    active: new Map(),
    maxActiveRuns: 2,
    locks: new ResourceLocks(),
    manualOperations: new Set(),
  } as unknown as HostContext;
  return { root, ctx, a: a!, b: b!, c: c! };
}

test('a running session no longer blocks another session’s own edits', async (t) => {
  const { ctx, a, b } = await host(t);
  ctx.active.set(a, { controller: new AbortController() });
  const renamed = (await sessionHandlers['session.rename']!(ctx, {
    sessionId: b,
    title: 'renamed while A runs',
  })) as { title: string };
  assert.equal(renamed.title, 'renamed while A runs');
  await assert.rejects(
    sessionHandlers['session.rename']!(ctx, { sessionId: a, title: 'no' }),
    /Host is busy/,
  );
});

test('work that writes the project directory waits for runs there, and holds runs back while it works', async (t) => {
  const { root, ctx, a, b, c } = await host(t);
  ctx.active.set(a, { controller: new AbortController() });
  // A run holds the directory shared: verification for another session there has to wait.
  assert.ok(lockConflict(ctx, fileClaims(b, root)));
  // A run whose session works in a directory of its own does not.
  ctx.active.set(a, { controller: new AbortController(), root: path.join(root, 'elsewhere') });
  assert.equal(lockConflict(ctx, fileClaims(b, root)), undefined);
  ctx.active.clear();

  const undo = acquireLocks(ctx, fileClaims(b, root), 'busy');
  assert.match(admissionRefusal(ctx, b)!, /This session already has an active run/);
  assert.match(admissionRefusal(ctx, c)!, /This Host already has an active run \(an exclusive/);
  assert.equal(sessionCanRun(ctx, c), false);
  undo.release();
  assert.equal(admissionRefusal(ctx, c), undefined);
});

test('only an operation holding the Host alone stops every run', async (t) => {
  const { ctx, a } = await host(t);
  const sessionOnly = acquireLocks(ctx, [hostClaim('shared'), sessionClaim(a)], 'busy');
  assert.equal(runSlotFree(ctx), true);
  sessionOnly.release();
  const orphan = acquireLocks(ctx, [hostClaim('exclusive')], 'busy');
  assert.equal(runSlotFree(ctx), false);
  orphan.release();
  assert.equal(runSlotFree(ctx), true);
});

test('model requests outside a run occupy the same slots', async (t) => {
  const { ctx, a, b, c } = await host(t);
  const first = acquireModelSlot(ctx, a);
  assert.equal(runSlotFree(ctx), true);
  const second = acquireModelSlot(ctx, b);
  assert.equal(runSlotFree(ctx), false);
  assert.match(admissionRefusal(ctx, c)!, /run slot/);
  assert.throws(() => acquireModelSlot(ctx, c), /run slot/);
  first();
  first();
  assert.equal(runSlotFree(ctx), true);
  second();
  assert.equal(admissionRefusal(ctx, c), undefined);
});
