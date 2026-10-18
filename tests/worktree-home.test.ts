/**
 * Where delegated children's worktrees live.
 *
 * The location is the fix for write-capable children under a native sandbox: inside the repository, under
 * `.yuantu/worktrees/`, a child's whole tree sat beneath a protected path component and could not be written, and
 * it sat inside the delegator's root. These tests pin the properties that make the new location work — outside the
 * repository, free of protected components, one stable directory per repository — and that the legacy layout is
 * still recognised so bindings recorded before the move can be maintained.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  managedWorktreeHome,
  repositoryWorktreeKey,
  repositoryWorktreeParent,
} from '../packages/platform/worktree-home.ts';
import {
  isManagedWorktreePath,
  managedWorktreeParents,
  managedWorktreeRoot,
} from '../packages/workspaces/git.ts';
import { isWithin } from '../packages/platform/workspace-paths.ts';

const PROTECTED = ['.git', '.yuantu', '.agents', '.codex', '.aws', '.ssh', '.gnupg'];

test('the configured home is used as given, and must be absolute', async (t) => {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), 'yuantu-wt-home-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const configured = path.join(base, 'not-yet', 'created');
  assert.equal(managedWorktreeHome({ YUANTU_WORKTREE_DIR: configured }), configured);
  assert.throws(() => managedWorktreeHome({ YUANTU_WORKTREE_DIR: 'relative/dir' }), /absolute/);
});

test('the default home is outside the user state directory and has no protected component', () => {
  const home = managedWorktreeHome({});
  const segments = home.split(/[\\/]+/).map((segment) => segment.toLowerCase());
  for (const name of PROTECTED) assert.ok(!segments.includes(name), `${home} contains ${name}`);
});

test('a repository gets one stable directory, distinct from any other repository', () => {
  const env = { YUANTU_WORKTREE_DIR: path.join(tmpdir(), 'yuantu-wt-keys') };
  const a = path.join(tmpdir(), 'repo-a');
  const b = path.join(tmpdir(), 'repo-b');
  assert.equal(repositoryWorktreeKey(a), repositoryWorktreeKey(a));
  assert.notEqual(repositoryWorktreeKey(a), repositoryWorktreeKey(b));
  assert.match(repositoryWorktreeKey(a), /^[0-9a-f]{16}$/);
  assert.equal(
    path.dirname(repositoryWorktreeParent(a, env)),
    managedWorktreeHome(env),
    'the per-repository directory sits directly under the home',
  );
});

test('a managed worktree is allocated outside the repository', async (t) => {
  const repository = await realpath(await mkdtemp(path.join(tmpdir(), 'yuantu-wt-repo-')));
  t.after(() => rm(repository, { recursive: true, force: true }));
  const target = managedWorktreeRoot(repository, 'binding-1');
  assert.ok(!isWithin(repository, target), `${target} must not be inside ${repository}`);
  assert.ok(isManagedWorktreePath(repository, target));
  assert.equal(managedWorktreeParents(repository)[0], path.dirname(target));
  // Only a direct child is managed: the parent itself, a grandchild and another repository's directory are not.
  assert.ok(!isManagedWorktreePath(repository, path.dirname(target)));
  assert.ok(!isManagedWorktreePath(repository, path.join(target, 'nested')));
  assert.ok(!isManagedWorktreePath(path.join(repository, 'other'), target));
  assert.throws(() => managedWorktreeRoot(repository, '../escape'), /Invalid workspace identifier/);
});

test('the legacy in-repository layout is still recognised for maintenance', async (t) => {
  const repository = await realpath(await mkdtemp(path.join(tmpdir(), 'yuantu-wt-legacy-')));
  t.after(() => rm(repository, { recursive: true, force: true }));
  const legacy = path.join(repository, '.yuantu', 'worktrees', 'old-binding');
  assert.ok(isManagedWorktreePath(repository, legacy));
  assert.ok(!isManagedWorktreePath(repository, path.join(repository, '.yuantu', 'other', 'x')));
});
