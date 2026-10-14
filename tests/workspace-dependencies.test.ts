import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { nodeDependencyWarning } from '../packages/workspaces/dependencies.ts';

async function project(t: test.TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-dependencies-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('a copied Node project reports missing local dependencies without borrowing the parent install', async (t) => {
  const root = await project(t);
  await mkdir(path.join(root, 'node_modules'));
  const child = path.join(root, 'isolated');
  await mkdir(child);
  await writeFile(
    path.join(child, 'package.json'),
    JSON.stringify({ devDependencies: { typescript: '5.9.3' } }),
  );
  const warning = await nodeDependencyWarning(child, new AbortController().signal);
  assert.equal(warning?.code, 'WORKSPACE_DEPENDENCIES_MISSING');
  assert.deepEqual(warning?.paths, ['node_modules']);
  assert.match(warning?.message ?? '', /approval/i);
  await mkdir(path.join(child, 'node_modules'));
  assert.equal(await nodeDependencyWarning(child, new AbortController().signal), null);
});

test('source-only and dependency-free projects do not report missing packages', async (t) => {
  const root = await project(t);
  const signal = new AbortController().signal;
  assert.equal(await nodeDependencyWarning(root, signal), null);
  await writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'plain', dependencies: {} }),
  );
  assert.equal(await nodeDependencyWarning(root, signal), null);
});

test('dependency inspection honours cancellation', async (t) => {
  const root = await project(t);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(nodeDependencyWarning(root, controller.signal), { name: 'AbortError' });
});
