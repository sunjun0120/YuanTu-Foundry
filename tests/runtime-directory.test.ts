/**
 * Runtime state never follows a pre-existing `.yuantu` link out of the workspace.
 *
 * A cloned repository can carry `.yuantu` as a symbolic link (or, on Windows, a junction someone created). Opening a
 * session store, spilling a tool's output or building the search index used to `mkdir -p` straight through it and
 * write session content into whatever directory it pointed at.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
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

test('a session store refuses a database file or sidecar that is a link', async (t) => {
  const base = await tempRoot(t, 'yuantu-runtime-file-link-');
  const workspace = path.join(base, 'workspace');
  const outside = path.join(base, 'outside.sqlite');
  mkdirSync(path.join(workspace, '.yuantu'), { recursive: true });
  writeFileSync(outside, '');
  for (const name of ['sessions.sqlite', 'sessions.sqlite-wal']) {
    const link = path.join(workspace, '.yuantu', name);
    try {
      symlinkSync(outside, link, 'file');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') return t.skip('no symlink privilege');
      throw error;
    }
    assert.throws(
      () => new SessionStore(path.join(workspace, '.yuantu', 'sessions.sqlite')),
      /Runtime file cannot be a symbolic link/,
    );
    rmSync(link);
  }
  assert.equal(readFileSync(outside, 'utf8'), '');
});

test(
  'the session database and its runtime directory are private to the user',
  { skip: process.platform === 'win32' && 'Windows has no mode bits; the workspace ACL applies' },
  async (t) => {
    const workspace = await tempRoot(t, 'yuantu-runtime-private-');
    const runtime = path.join(workspace, '.yuantu');
    const file = path.join(runtime, 'sessions.sqlite');
    const mode = (target: string) => statSync(target).mode & 0o777;

    const store = new SessionStore(file);
    store.create(workspace);
    assert.equal(mode(runtime), 0o700);
    assert.equal(mode(file), 0o600);
    if (existsSync(`${file}-wal`)) assert.equal(mode(`${file}-wal`), 0o600);
    store.close();

    // State from an older build, created with the umask's defaults, is narrowed when it is opened again.
    chmodSync(runtime, 0o755);
    chmodSync(file, 0o644);
    new SessionStore(file).close();
    assert.equal(mode(runtime), 0o700);
    assert.equal(mode(file), 0o600);
  },
);
