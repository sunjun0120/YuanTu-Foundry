/**
 * What the workspace service leaves in a repository is reclaimed once nothing can use it.
 *
 * A killed freeze left its staging directory — up to a whole tree of bytes — forever, and a deleted session left
 * every result manifest and the ref that keeps its tree from being collected.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rm, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { sweepAbandonedStaging } from '../packages/workspaces/snapshot.ts';
import {
  removeResultArtifacts,
  resultMetadataPath,
  resultRef,
} from '../packages/workspaces/result-files.ts';

import { SessionStore } from '../packages/storage/sqlite.ts';
import { WorkspaceManager } from '../packages/workspaces/manager.ts';
import { acquireHostLock, hostPresenceDirectory } from '../packages/platform/host-lock.ts';
import { releaseSnapshotsIfIdle } from '../apps/agent-host/snapshot-release.ts';
import { ResourceLocks } from '../apps/agent-host/resource-locks.ts';
import type { HostContext } from '../apps/agent-host/state.ts';
import { runCli } from './process-fixture.ts';
import { storeFixture, tempRoot } from './temp-fixture.ts';

const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
};

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' }).trim();
}

/** A pid nothing is running as: far above any pid a test machine hands out. */
const DEAD_PID = 2_147_000_000;

test('staging is swept when its freeze died or is too old to be running, and never this process’s', async (t) => {
  const root = await tempRoot(t, 'yuantu-reclaim-');
  const directory = path.join(root, '.yuantu', 'workspace-snapshots');
  const staging = (pid: number, name: string) => path.join(directory, `.staging-${pid}-${name}`);
  const live = process.ppid;
  for (const target of [
    staging(DEAD_PID, 'dead'),
    staging(process.pid, 'mine'),
    staging(live, 'fresh'),
    staging(live, 'stale'),
    path.join(directory, 'a'.repeat(64)),
  ]) {
    await mkdir(target, { recursive: true });
    await writeFile(path.join(target, 'blob'), 'bytes');
  }
  // A live pid with a two-day-old staging directory: that pid is no longer the freeze that made it.
  const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
  await utimes(staging(live, 'stale'), old, old);
  assert.equal(await sweepAbandonedStaging(root), 2);
  assert.equal(existsSync(staging(DEAD_PID, 'dead')), false);
  assert.equal(existsSync(staging(live, 'stale')), false);
  assert.equal(
    existsSync(staging(process.pid, 'mine')),
    true,
    'a freeze of this process was swept',
  );
  assert.equal(existsSync(staging(live, 'fresh')), true, 'a running freeze was swept');
  assert.equal(
    existsSync(path.join(directory, 'a'.repeat(64))),
    true,
    'a published snapshot was swept',
  );
});

test('a repository with no snapshots has nothing to sweep', async (t) => {
  assert.equal(await sweepAbandonedStaging(await tempRoot(t, 'yuantu-reclaim-')), 0);
});

test('a removed result loses its manifest and the ref that kept its tree', async (t) => {
  const root = await tempRoot(t, 'yuantu-reclaim-');
  git(root, ['init', '-q']);
  await writeFile(path.join(root, 'a.txt'), 'a\n');
  git(root, ['add', 'a.txt']);
  git(root, ['commit', '-q', '-m', 'base']);
  const tree = git(root, ['rev-parse', 'HEAD^{tree}']);
  const resultId = '11111111-2222-3333-4444-555555555555';
  git(root, ['update-ref', resultRef(resultId), tree]);
  await mkdir(path.dirname(resultMetadataPath(root, resultId)), { recursive: true });
  await writeFile(resultMetadataPath(root, resultId), '{}\n');
  await removeResultArtifacts(root, resultId);
  assert.equal(existsSync(resultMetadataPath(root, resultId)), false);
  assert.equal(git(root, ['for-each-ref', 'refs/yuantu/results']), '');
  // Idempotent: a second removal of what is already gone is not an error.
  await removeResultArtifacts(root, resultId);
});

test('a release keeps what any removal record names, and stops when one cannot be read', async (t) => {
  const { root, store } = await storeFixture(t, 'yuantu-reclaim-', '.yuantu/sessions.sqlite');
  git(root, ['init', '-q']);
  await writeFile(path.join(root, 'a.txt'), 'a\n');
  git(root, ['add', 'a.txt']);
  git(root, ['commit', '-q', '-m', 'base']);
  const manager = new WorkspaceManager({ store });
  const session = store.create(root);
  const signal = new AbortController().signal;
  // Frozen and recorded, but no binding was ever built from it: this database no longer needs it.
  const snapshot = await manager.freeze({
    parentSessionId: session.id,
    sourceBinding: manager.resolve(session.id),
    signal,
  });
  const removals = path.join(root, '.yuantu', 'workspace-removals');
  await mkdir(removals, { recursive: true });
  // A removal record of some database names it: that database may restore from it, so it stays.
  await writeFile(path.join(removals, 'other.json'), JSON.stringify({ snapshotId: snapshot.id }));
  assert.equal(await manager.releaseUnusedSnapshots(signal), 0);
  assert.ok(store.workspaceSnapshot(snapshot.id));
  // A record that cannot be read could name anything: nothing in this repository is released.
  await writeFile(path.join(removals, 'other.json'), '{not json');
  assert.equal(await manager.releaseUnusedSnapshots(signal), 0);
  assert.ok(store.workspaceSnapshot(snapshot.id));
  // With no record naming it, the share is released and, as the only owner, the snapshot goes.
  await writeFile(
    path.join(removals, 'other.json'),
    JSON.stringify({ snapshotId: 'f'.repeat(32) }),
  );
  assert.equal(await manager.releaseUnusedSnapshots(signal), 1);
  assert.equal(store.workspaceSnapshot(snapshot.id), null);
  assert.equal(git(root, ['for-each-ref', `refs/yuantu/snapshot-owners/${snapshot.id}/`]), '');
});

test('workspace-gc reports with --dry-run and releases without it', async (t) => {
  const root = await tempRoot(t, 'yuantu-reclaim-cli-');
  git(root, ['init', '-q']);
  await writeFile(path.join(root, 'a.txt'), 'a\n');
  git(root, ['add', 'a.txt']);
  git(root, ['commit', '-q', '-m', 'base']);
  const db = path.join(root, '.yuantu', 'sessions.sqlite');
  const store = new SessionStore(db);
  const manager = new WorkspaceManager({ store });
  const session = store.create(root);
  const snapshot = await manager.freeze({
    parentSessionId: session.id,
    sourceBinding: manager.resolve(session.id),
    signal: new AbortController().signal,
  });
  const owner = store.snapshotOwner();
  store.close();
  const report = async (dryRun: boolean) => {
    const result = await runCli([
      'workspace-gc',
      '--db',
      db,
      '--workspace',
      root,
      ...(dryRun ? ['--dry-run'] : []),
      '--json',
    ]);
    assert.equal(result.code, 0, result.stderr);
    return JSON.parse(result.stdout) as {
      owner: string;
      released?: number;
      snapshots: { id: string; format: number; owners: string[]; recordedHere: boolean }[];
    };
  };
  const listed = await report(true);
  assert.equal(listed.owner, owner);
  assert.equal(listed.released, undefined, 'a dry run released something');
  const entry = listed.snapshots.find((candidate) => candidate.id === snapshot.id)!;
  assert.deepEqual(
    { format: entry.format, owners: entry.owners, recordedHere: entry.recordedHere },
    { format: 4, owners: [owner], recordedHere: true },
  );
  // A live workspace Host is the one thing that must never be released beside: refuse instead of racing it.
  const lock = acquireHostLock(root);
  const refused = await runCli(['workspace-gc', '--db', db, '--workspace', root, '--json']);
  assert.notEqual(refused.code, 0);
  assert.match(refused.stderr, /Host is running in this workspace/);
  lock.release();
  // Nothing names it — no binding was built from it — so a real run releases the only share and the snapshot goes.
  const applied = await report(false);
  assert.equal(applied.released, 1);
  assert.equal(
    applied.snapshots.some((candidate) => candidate.id === snapshot.id),
    false,
  );
});

test('an idle Host can release an unused snapshot without waiting for the next start', async (t) => {
  const { root, store } = await storeFixture(t, 'yuantu-reclaim-idle-', '.yuantu/sessions.sqlite');
  git(root, ['init', '-q']);
  await writeFile(path.join(root, 'a.txt'), 'a\n');
  git(root, ['add', 'a.txt']);
  git(root, ['commit', '-q', '-m', 'base']);
  const manager = new WorkspaceManager({ store });
  const session = store.create(root);
  const snapshot = await manager.freeze({
    parentSessionId: session.id,
    sourceBinding: manager.resolve(session.id),
    signal: new AbortController().signal,
  });
  const ctx = {
    workspace: root,
    store,
    active: new Map(),
    locks: new ResourceLocks(),
    manualOperations: new Set(),
  } as unknown as HostContext;
  assert.equal(await releaseSnapshotsIfIdle(ctx), 1);
  assert.equal(store.workspaceSnapshot(snapshot.id), null);
});

test('a second live Host marker defers the release until that Host is gone', async (t) => {
  const { root, store } = await storeFixture(
    t,
    'yuantu-reclaim-other-host-',
    '.yuantu/sessions.sqlite',
  );
  git(root, ['init', '-q']);
  await writeFile(path.join(root, 'a.txt'), 'a\n');
  git(root, ['add', 'a.txt']);
  git(root, ['commit', '-q', '-m', 'base']);
  const manager = new WorkspaceManager({ store });
  const session = store.create(root);
  const snapshot = await manager.freeze({
    parentSessionId: session.id,
    sourceBinding: manager.resolve(session.id),
    signal: new AbortController().signal,
  });
  const directory = hostPresenceDirectory(root);
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, 'other.json'),
    JSON.stringify({ version: 1, pid: process.ppid, startedAt: null, token: 'other-host' }),
  );
  const ctx = {
    workspace: root,
    store,
    active: new Map(),
    locks: new ResourceLocks(),
    manualOperations: new Set(),
  } as unknown as HostContext;
  assert.equal(await releaseSnapshotsIfIdle(ctx), 0);
  assert.ok(store.workspaceSnapshot(snapshot.id));
  await rm(directory, { recursive: true, force: true });
  assert.equal(await releaseSnapshotsIfIdle(ctx), 1);
  assert.equal(store.workspaceSnapshot(snapshot.id), null);
});

test('a busy Host defers the release to the next idle moment', async (t) => {
  const { root, store } = await storeFixture(t, 'yuantu-reclaim-busy-', '.yuantu/sessions.sqlite');
  git(root, ['init', '-q']);
  await writeFile(path.join(root, 'a.txt'), 'a\n');
  git(root, ['add', 'a.txt']);
  git(root, ['commit', '-q', '-m', 'base']);
  const manager = new WorkspaceManager({ store });
  const session = store.create(root);
  const snapshot = await manager.freeze({
    parentSessionId: session.id,
    sourceBinding: manager.resolve(session.id),
    signal: new AbortController().signal,
  });
  const ctx = {
    workspace: root,
    store,
    active: new Map([['running', {}]]),
    manualOperations: new Set(),
  } as unknown as HostContext;
  assert.equal(await releaseSnapshotsIfIdle(ctx), 0);
  assert.ok(store.workspaceSnapshot(snapshot.id));
});
