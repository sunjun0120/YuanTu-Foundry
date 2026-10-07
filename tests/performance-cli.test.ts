import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { projectRoot } from './process-fixture.ts';

test('batch CLI refuses an existing evidence file without overwriting or appending', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-perf-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const evidence = path.join(root, 'measurements.jsonl');
  await writeFile(evidence, 'KEEP_THIS_EVIDENCE\n');
  const child = spawnSync(
    process.execPath,
    ['benchmarks/performance.mjs', '--pairs=1', `--out=${root}`],
    { cwd: projectRoot, encoding: 'utf8', windowsHide: true, timeout: 30000 },
  );
  assert.notEqual(child.status, 0);
  assert.equal(await readFile(evidence, 'utf8'), 'KEEP_THIS_EVIDENCE\n');
});
