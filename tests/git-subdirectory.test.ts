import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { workspaceInsideOuterRepository } from '../packages/tools/git.ts';

test('git tools are withheld only from a workspace nested inside an outer repository', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-git-subdir-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = path.join(root, 'repo');
  const nested = path.join(repository, 'projects', 'shop');
  const plain = path.join(root, 'plain');
  await mkdir(path.join(repository, '.git'), { recursive: true });
  await mkdir(nested, { recursive: true });
  await mkdir(plain, { recursive: true });
  // A subdirectory of a repository: every Git tool would refuse it, so none is offered.
  assert.equal(workspaceInsideOuterRepository(nested), true);
  // The repository root itself keeps its tools.
  assert.equal(workspaceInsideOuterRepository(repository), false);
  // A managed worktree has a `.git` file at its root rather than a directory, and keeps its tools too.
  const worktree = path.join(repository, 'worktree');
  await mkdir(worktree);
  await writeFile(path.join(worktree, '.git'), 'gitdir: ../.git/worktrees/w\n');
  assert.equal(workspaceInsideOuterRepository(worktree), false);
  // Outside any repository the tools stay: they say "not a repository", and `git init` can make one.
  if (!workspaceInsideOuterRepository(root))
    assert.equal(workspaceInsideOuterRepository(plain), false);
});
