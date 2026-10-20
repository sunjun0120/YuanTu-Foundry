/**
 * The shell's path gate: a deliverable or Markdown path only becomes a shell target when it is a real file inside
 * the workspace's real path and outside the runtime directory.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { workspaceFilePath } from '../apps/desktop/workspace-file-path.ts';

async function fixture(t: test.TestContext) {
  const outside = await mkdtemp(path.join(tmpdir(), 'yuantu-file-path-outside-'));
  const workspace = path.join(outside, 'workspace');
  await mkdir(path.join(workspace, 'sub'), { recursive: true });
  await writeFile(path.join(workspace, 'sub', 'report.md'), '# report\n');
  await writeFile(path.join(outside, 'secret.txt'), 'secret');
  await mkdir(path.join(workspace, '.yuantu'), { recursive: true });
  await writeFile(path.join(workspace, '.yuantu', 'sessions.sqlite'), 'state');
  t.after(() => rm(outside, { recursive: true, force: true }));
  return { workspace, outside };
}

test('a file inside the workspace resolves to its real path', async (t) => {
  const { workspace } = await fixture(t);
  assert.equal(
    workspaceFilePath(workspace, 'sub/report.md'),
    path.join(workspace, 'sub', 'report.md'),
  );
  assert.equal(
    workspaceFilePath(workspace, './sub/report.md'),
    path.join(workspace, 'sub', 'report.md'),
  );
});

test('parent traversal, absolute paths and the runtime directory are refused', async (t) => {
  const { workspace, outside } = await fixture(t);
  assert.throws(() => workspaceFilePath(workspace, '../secret.txt'), /escapes the workspace/);
  assert.throws(() => workspaceFilePath(workspace, path.join(outside, 'secret.txt')), /escapes/);
  assert.throws(() => workspaceFilePath(workspace, '.yuantu/sessions.sqlite'), /Runtime state/);
  assert.throws(() => workspaceFilePath(workspace, 'missing.txt'), /ENOENT/);
  assert.throws(() => workspaceFilePath(workspace, ''), /Invalid workspace path/);
});
