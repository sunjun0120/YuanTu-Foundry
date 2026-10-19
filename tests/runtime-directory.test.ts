/**
 * Runtime state never follows a pre-existing `.yuantu` link out of the workspace.
 *
 * A cloned repository can carry `.yuantu` as a symbolic link (or, on Windows, a junction someone created). Opening a
 * session store, spilling a tool's output or building the search index used to `mkdir -p` straight through it and
 * write session content into whatever directory it pointed at.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import { ensureRuntimeDirectory } from '../packages/platform/runtime-directory.ts';
import { SessionStore } from '../packages/storage/sqlite.ts';
import { tempRoot } from './temp-fixture.ts';

async function linkedWorkspace(t: test.TestContext) {
  const base = await tempRoot(t, 'yuantu-runtime-directory-');
  const workspace = path.join(base, 'workspace');
  const outside = path.join(base, 'outside');
  mkdirSync(workspace);
  mkdirSync(outside);
  symlinkSync(
    outside,
    path.join(workspace, '.yuantu'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  return { workspace, outside };
}

test('a session store refuses a .yuantu link and writes nothing outside the workspace', async (t) => {
  const { workspace, outside } = await linkedWorkspace(t);
  assert.throws(
    () => new SessionStore(path.join(workspace, '.yuantu', 'sessions.sqlite')),
    /symbolic link or junction/,
  );
  assert.deepEqual(readdirSync(outside), []);
});

test('a nested runtime directory refuses a link at any level below .yuantu', async (t) => {
  const base = await tempRoot(t, 'yuantu-runtime-directory-');
  const workspace = path.join(base, 'workspace');
  const outside = path.join(base, 'outside');
  mkdirSync(path.join(workspace, '.yuantu'), { recursive: true });
  mkdirSync(outside);
  symlinkSync(
    outside,
    path.join(workspace, '.yuantu', 'spill'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  assert.throws(
    () => ensureRuntimeDirectory(path.join(workspace, '.yuantu', 'spill', 'session-1')),
    /symbolic link or junction/,
  );
  assert.deepEqual(readdirSync(outside), []);
});

test('an ordinary runtime directory is created level by level', async (t) => {
  const workspace = await tempRoot(t, 'yuantu-runtime-directory-');
  const target = path.join(workspace, '.yuantu', 'workspace-snapshots', 'snap-1');
  assert.equal(ensureRuntimeDirectory(target), path.resolve(target));
  assert.ok(existsSync(target));
  // Idempotent: a second call over the directories it made is not an error.
  ensureRuntimeDirectory(target);
});
