import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tempRoot } from './temp-fixture.ts';

const exec = promisify(execFile);
const harness = new URL('../benchmarks/swe-bench/', import.meta.url);
async function moduleFor(name: string): Promise<any> {
  return import(new URL(name, harness).href).catch(() => ({}));
}
const fakeRecords = () =>
  Array.from({ length: 30 }, (_, i) => ({
    instance_id: `owner__repo${i % 3}-${i}`,
    repo: `owner/repo${i % 3}`,
    difficulty: i % 2 ? '<15 min fix' : '15 min - 1 hour',
    base_commit: 'a'.repeat(40),
    problem_statement: `Fix issue ${i}`,
  }));

test('SWE subset is byte deterministic, stratified and binds complete records', async () => {
  const { selectSubset, serializeSubset, recordHash } = await moduleFor('select-subset.mjs');
  assert.equal(typeof selectSubset, 'function', 'deterministic selector is required');
  const options = { revision: 'a'.repeat(40), seed: 20261023, size: 12, smokeSize: 5 };
  const records = fakeRecords();
  const subset = selectSubset(records, options);
  assert.equal(
    serializeSubset(subset),
    serializeSubset(selectSubset([...records].reverse(), options)),
  );
  assert.equal(subset.instances.length, 12);
  assert.equal(new Set(subset.instances.map((r: any) => r.repo)).size, 3);
  const smoke = subset.instances.filter((r: any) => subset.smoke.includes(r.instance_id));
  assert.equal(smoke.length, 5);
  assert.equal(new Set(smoke.map((r: any) => r.repo)).size, 3);
  assert.ok(smoke.every((r: any) => ['<15 min fix', '15 min - 1 hour'].includes(r.difficulty)));
  for (const item of subset.instances) {
    const record = records.find((r) => r.instance_id === item.instance_id);
    assert.equal(item.sha256, recordHash(record));
    assert.notEqual(item.sha256, recordHash({ ...record, problem_statement: 'changed' }));
  }
  assert.throws(() => selectSubset([...records, records[0]], options), /duplicate/i);
  assert.throws(() => selectSubset(records, { ...options, size: 2 }), /size/i);
});

test('SWE materialization pins base commit and confines git configuration to the cache', async (t) => {
  const { materializeRepo } = await moduleFor('repos.mjs');
  assert.equal(typeof materializeRepo, 'function', 'repository materialization is required');
  const root = await tempRoot(t, 'yuantu-swe-repo-');
  const source = path.join(root, 'source');
  await mkdir(source);
  const git = (args: string[]) => exec('git', args, { cwd: source, windowsHide: true });
  await git(['init']);
  await git(['config', 'user.name', 'Fixture']);
  await git(['config', 'user.email', 'fixture@example.invalid']);
  await writeFile(path.join(source, 'module.py'), 'value = 1\n');
  await git(['add', '.']);
  await git(['-c', 'core.autocrlf=false', 'commit', '-m', 'first']);
  const base = (await git(['rev-parse', 'HEAD'])).stdout.trim();
  await writeFile(path.join(source, 'module.py'), 'value = 2\n');
  await git(['commit', '-am', 'second']);
  const directory = path.join(root, 'work');
  const record = { repo: 'fixture/source', base_commit: base, instance_id: 'fixture__source-1' };
  const cache = path.join(root, 'repos');
  await materializeRepo({ record, cacheDirectory: cache, directory, source });
  assert.equal((await exec('git', ['rev-parse', 'HEAD'], { cwd: directory })).stdout.trim(), base);
  assert.equal((await exec('git', ['status', '--porcelain'], { cwd: directory })).stdout, '');
  assert.equal(await readFile(path.join(directory, 'module.py'), 'utf8'), 'value = 1\n');
  assert.match(await readFile(path.join(directory, '.git'), 'utf8'), /^gitdir: /);
  for (const [key, value] of [
    ['core.autocrlf', 'false'],
    ['core.longpaths', 'true'],
  ]) {
    assert.equal(
      (
        await exec('git', [
          '--git-dir',
          path.join(cache, 'fixture__source.git'),
          'config',
          '--local',
          key!,
        ])
      ).stdout.trim(),
      value,
    );
  }
  await assert.rejects(materializeRepo({ record, cacheDirectory: cache, directory, source }));
  await assert.rejects(
    materializeRepo({
      record: { ...record, repo: '../escape' },
      cacheDirectory: cache,
      directory: path.join(root, 'other'),
      source,
    }),
  );
});
