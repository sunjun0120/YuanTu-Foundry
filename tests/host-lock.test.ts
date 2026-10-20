/**
 * The workspace Host markers: several live processes may overlap during a model replacement, a stale marker is
 * repaired, and `workspace-gc` sees every live one.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  acquireHostLock,
  acquireMaintenanceGate,
  hostLockHolders,
  hostPresenceDirectory,
} from '../packages/platform/host-lock.ts';

async function root(t: test.TestContext): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'yuantu-host-lock-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('every live Host publishes a marker, and release removes only its own', async (t) => {
  const workspace = await root(t);
  const first = acquireHostLock(workspace);
  const second = acquireHostLock(workspace);
  assert.deepEqual(
    hostLockHolders(workspace).map((holder) => holder.pid),
    [process.pid, process.pid],
  );
  first.release();
  first.release();
  assert.equal(hostLockHolders(workspace).length, 1);
  second.release();
  assert.equal(hostLockHolders(workspace).length, 0);
});

test('maintenance holds a gate that a starting Host cannot cross', async (t) => {
  const workspace = await root(t);
  const gate = acquireMaintenanceGate(workspace);
  assert.throws(() => acquireHostLock(workspace), /Workspace maintenance is already in progress/);
  gate.release();
  const lock = acquireHostLock(workspace);
  lock.release();
});

test('a marker whose owner is gone is repaired by the next Host', async (t) => {
  const workspace = await root(t);
  await mkdir(hostPresenceDirectory(workspace), { recursive: true });
  const stale = path.join(hostPresenceDirectory(workspace), 'dead.json');
  await writeFile(
    stale,
    JSON.stringify({ version: 1, pid: 2_147_000_000, startedAt: 1, token: 'stale' }),
    { flag: 'w' },
  );
  assert.equal(hostLockHolders(workspace).length, 0);
  const lock = acquireHostLock(workspace);
  assert.equal(hostLockHolders(workspace).length, 1);
  await assert.rejects(access(stale));
  lock.release();
});

test('an unreadable marker does not block the workspace forever', async (t) => {
  const workspace = await root(t);
  await mkdir(hostPresenceDirectory(workspace), { recursive: true });
  await writeFile(path.join(hostPresenceDirectory(workspace), 'broken.json'), '{not json');
  assert.equal(hostLockHolders(workspace).length, 0);
  const lock = acquireHostLock(workspace);
  assert.equal(hostLockHolders(workspace).length, 1);
  lock.release();
});
