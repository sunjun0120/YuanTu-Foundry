/**
 * The runtime's `.yuantu` directory is invisible to the user's `git status`, except the files people write.
 *
 * The session database, the search index and whole workspace snapshots live under `<workspace>/.yuantu`, and Git
 * used to list every one of them as untracked — one `git add -A` away from committing a snapshot of the tree.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { excludeRuntimeState } from '../packages/workspaces/runtime-exclude.ts';
import { tempRoot } from './temp-fixture.ts';
import { git } from './git-fixture.ts';

/** The test runner switches the exclusion off for every Host and CLI it starts; these cases switch it back on. */
const ENABLED = { env: { ...process.env, YUANTU_GIT_EXCLUDE: '1' } };

test('YUANTU_GIT_EXCLUDE=0 leaves the repository untouched', async (t) => {
  const root = await tempRoot(t, 'yuantu-runtime-exclude-');
  git(root, ['init', '-q']);
  await runtimeState(root);
  assert.equal(await excludeRuntimeState(root, { env: { YUANTU_GIT_EXCLUDE: '0' } }), false);
  assert.ok(untracked(root).includes('.yuantu/sessions.sqlite'));
});

/** What `git status` reports as untracked, one path per entry. */
function untracked(cwd: string): string[] {
  return git(cwd, ['status', '--porcelain', '--untracked-files=all'])
    .split('\n')
    .filter(Boolean)
    .map((line) => line.slice(3))
    .sort();
}

async function runtimeState(workspace: string): Promise<void> {
  await mkdir(path.join(workspace, '.yuantu', 'search'), { recursive: true });
  await writeFile(path.join(workspace, '.yuantu', 'sessions.sqlite'), 'db');
  await writeFile(path.join(workspace, '.yuantu', 'search', 'index.bin'), 'index');
  await writeFile(path.join(workspace, '.yuantu', 'lsp.json'), '{}');
  await writeFile(path.join(workspace, '.yuantu', 'memory.md'), '- note\n');
  await writeFile(path.join(workspace, 'source.ts'), 'export {};\n');
}

test('runtime state is excluded, the files people write stay visible, and the block is written once', async (t) => {
  const root = await tempRoot(t, 'yuantu-runtime-exclude-');
  git(root, ['init', '-q']);
  await runtimeState(root);
  assert.equal(await excludeRuntimeState(root, ENABLED), true);
  assert.deepEqual(untracked(root), ['.yuantu/lsp.json', '.yuantu/memory.md', 'source.ts']);
  assert.equal(
    await excludeRuntimeState(root, ENABLED),
    false,
    'a second open wrote the block again',
  );
  const exclude = await readFile(path.join(root, '.git', 'info', 'exclude'), 'utf8');
  assert.equal(exclude.split('\n').filter((line) => line === '/.yuantu/*').length, 1);
});

test('a workspace inside a larger repository excludes only its own runtime directory', async (t) => {
  const root = await tempRoot(t, 'yuantu-runtime-exclude-');
  git(root, ['init', '-q']);
  const workspace = path.join(root, 'packages', 'app');
  await mkdir(workspace, { recursive: true });
  await runtimeState(workspace);
  // Somebody else's `.yuantu` elsewhere in the repository is not this workspace's to hide.
  await mkdir(path.join(root, 'other', '.yuantu'), { recursive: true });
  await writeFile(path.join(root, 'other', '.yuantu', 'kept.txt'), 'kept');
  assert.equal(await excludeRuntimeState(workspace, ENABLED), true);
  assert.deepEqual(untracked(root), [
    'other/.yuantu/kept.txt',
    'packages/app/.yuantu/lsp.json',
    'packages/app/.yuantu/memory.md',
    'packages/app/source.ts',
  ]);
});

test('a workspace that is not a Git working tree is left alone', async (t) => {
  const root = await tempRoot(t, 'yuantu-runtime-exclude-');
  await runtimeState(root);
  assert.equal(await excludeRuntimeState(root, ENABLED), false);
});
