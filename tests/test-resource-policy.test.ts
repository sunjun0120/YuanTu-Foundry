import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { partitionIsolatedTests, testResources } from '../scripts/test-resource-policy.ts';

test('resource declarations are explicit, validated, and only accepted in the file header', () => {
  assert.deepEqual(
    testResources('// @test-serial windows-sandbox: changes actual ACLs\nexport {};', 'one.ts'),
    ['windows-sandbox'],
  );
  assert.deepEqual(testResources('const text = "// @test-serial real-pty: fake";', 'one.ts'), []);
  for (const source of [
    '// @test-serial typo: explanation',
    '// @test-serial real-pty:',
    '// @test-serial real-pty: first\n// @test-serial real-pty: duplicate',
    'export {};\n// @test-serial real-pty: too late',
  ])
    assert.throws(
      () => testResources(source, 'one.ts'),
      /Invalid test resource declaration.*one.ts/,
    );
});

test('new files default to parallel and only actual resource declarations make them serial', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-resource-policy-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'tests'));
  await writeFile(path.join(root, 'tests', 'plain.test.ts'), 'export {};');
  await writeFile(
    path.join(root, 'tests', 'native.test.ts'),
    '// @test-serial windows-sandbox: actual token changes\nexport {};',
  );
  const result = await partitionIsolatedTests(['tests/plain.test.ts', 'tests/native.test.ts'], {
    root,
  });
  assert.deepEqual(result.parallel, ['tests/plain.test.ts']);
  assert.deepEqual(result.serial, ['tests/native.test.ts']);
  assert.deepEqual(result.resources['tests/native.test.ts'], ['windows-sandbox']);
  assert.match(result.reasons['tests/plain.test.ts']!, /isolated/);
});

test('a missing requested file fails instead of becoming an implicit serial exception', async () => {
  await assert.rejects(
    () => partitionIsolatedTests(['tests/not-present.test.ts'], { root: tmpdir() }),
    /ENOENT/,
  );
});
