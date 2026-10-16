import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  discoverTests,
  normalizeRepoPath,
  partitionTests,
} from '../scripts/test-execution-policy.ts';
test('discovery and default parallel partition retain resource metadata', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-policy-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'tests/nested'), { recursive: true });
  for (const file of ['b.test.ts', 'a.test.ts', 'helper.ts', 'nested/c.test.ts'])
    await writeFile(path.join(root, 'tests', file), 'export {};');
  assert.deepEqual(await discoverTests(root), ['tests/a.test.ts', 'tests/b.test.ts']);
  await writeFile(path.join(root, 'tests/b.test.ts'), '// @test-serial real-pty: actual terminal');
  const result = await partitionTests(['./tests/a.test.ts', 'tests/b.test.ts'], { root });
  assert.deepEqual(result.parallel, ['tests/a.test.ts']);
  assert.deepEqual(result.serial, ['tests/b.test.ts']);
  assert.deepEqual(result.resources['tests/b.test.ts'], ['real-pty']);
  assert.match(result.reasons['tests/b.test.ts']!, /actual terminal/);
});
test('Windows and relative paths normalize consistently', () => {
  assert.equal(normalizeRepoPath('.\\tests\\a.test.ts'), 'tests/a.test.ts');
  assert.equal(normalizeRepoPath('./tests/a.test.ts'), 'tests/a.test.ts');
});
