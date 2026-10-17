import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { acquireResourceLease } from '../scripts/test-resource-lease.mjs';
import { readFileReport } from '../scripts/test-report-merge.mjs';
import { sourceFingerprint } from '../scripts/test-source-fingerprint.mjs';
import { projectRoot } from './process-fixture.ts';
import {
  orderTestsByDuration,
  readTestDurations,
  writeTestDurations,
} from '../scripts/test-duration-history.ts';

async function directory(t: test.TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-scheduler-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('source fingerprints include build locks, root packaging and CI configuration but exclude generated assets', async (t) => {
  const root = await directory(t);
  for (const file of [
    'build/windows-runtime.lock.json',
    'electron-builder.config.cjs',
    'electron-builder.protected.config.cjs',
    '.github/workflows/ci.yml',
  ]) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), 'before');
    const before = await sourceFingerprint(root);
    await writeFile(path.join(root, file), 'after');
    assert.notEqual((await sourceFingerprint(root)).digest, before.digest, file);
  }
  const before = await sourceFingerprint(root);
  await mkdir(path.join(root, 'build/search-assets'), { recursive: true });
  await writeFile(path.join(root, 'build/search-assets/rg.exe'), 'generated');
  assert.equal((await sourceFingerprint(root)).digest, before.digest);
});

test('duration scheduling starts unknown and slow files early without changing the file set', () => {
  const files = ['fast', 'new', 'slow', 'medium'];
  assert.deepEqual(orderTestsByDuration(files, { fast: 10, slow: 100, medium: 50 }), [
    'new',
    'slow',
    'medium',
    'fast',
  ]);
  assert.deepEqual(files, ['fast', 'new', 'slow', 'medium']);
  assert.deepEqual(orderTestsByDuration(files, {}), ['fast', 'medium', 'new', 'slow']);
});

test('duration history tolerates cold starts and rejects foreign environments and invalid costs', async (t) => {
  const root = await directory(t),
    file = path.join(root, 'cache', 'durations.json');
  assert.deepEqual(await readTestDurations(file), {});
  await writeTestDurations(file, { slow: 100, fast: 10 });
  assert.deepEqual(await readTestDurations(file), { slow: 100, fast: 10 });
  const original = JSON.parse(await readFile(file, 'utf8'));
  for (const field of ['nodeMajor', 'platform', 'arch', 'schemaVersion']) {
    await writeFile(file, JSON.stringify({ ...original, [field]: 'foreign' }));
    assert.deepEqual(await readTestDurations(file), {});
  }
  await writeFile(
    file,
    JSON.stringify({
      ...original,
      files: { good: 1, negative: -1, zero: 0, text: '2', null: null },
    }),
  );
  assert.deepEqual(await readTestDurations(file), { good: 1 });
});

test('reports reject missing terminal markers, truncated JSON and foreign file summaries', async (t) => {
  const root = await directory(t),
    file = path.join(root, 'one.test.ts'),
    target = path.join(root, 'report.ndjson');
  const summary = { kind: 'file-summary', file, counts: { tests: 0 } };
  const run = { kind: 'run-summary', counts: { tests: 0 } };
  const terminal = { kind: 'phase-summary' };
  for (const entries of [
    [summary, run],
    [summary, terminal],
    [{ ...summary, file: path.join(root, 'other.ts') }, run, terminal],
    [summary, run, terminal, { kind: 'case' }],
  ]) {
    await writeFile(target, entries.map((item) => JSON.stringify(item) + '\n').join(''));
    assert.ok((await readFileReport(target, file, root)).problem);
  }
  await writeFile(target, JSON.stringify(summary) + '\n{truncated');
  assert.ok((await readFileReport(target, file, root)).problem);
  await writeFile(
    target,
    [summary, run, terminal].map((item) => JSON.stringify(item) + '\n').join(''),
  );
  const result = await readFileReport(target, file, root);
  assert.equal(result.problem, undefined);
  assert.equal(result.zeroTestFiles, 1, 'a genuinely filtered empty file is legal');
});

test('machine resource lease excludes another process and an aborted waiter does not remove the owner', async (t) => {
  const root = await directory(t);
  const release = await acquireResourceLease(root, ['machine-lease']);
  const original = await readFile(path.join(root, 'machine-resources.lock'), 'utf8');
  const module = pathToFileURL(path.join(projectRoot, 'scripts/test-resource-lease.mjs')).href;
  const source = `import{acquireResourceLease}from ${JSON.stringify(module)};try{await acquireResourceLease(${JSON.stringify(root)},['machine-lease'],{timeoutMs:150});process.exitCode=2}catch(e){console.log(e.message)}`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk;
  });
  child.stderr.on('data', (chunk) => {
    output += chunk;
  });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  assert.equal(code, 0, output);
  assert.match(output, /Timed out waiting/);
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(acquireResourceLease(root, ['machine-lease'], { signal: abort.signal }));
  assert.equal(await readFile(path.join(root, 'machine-resources.lock'), 'utf8'), original);
  release();
  const next = await acquireResourceLease(root, ['machine-lease']);
  next();
});

test('unknown machine resource ownership is refused without deleting the lock', async (t) => {
  const root = await directory(t),
    file = path.join(root, 'machine-resources.lock');
  await writeFile(file, 'not a lease');
  await assert.rejects(acquireResourceLease(root, ['machine-lease']), /unknown ownership/);
  assert.equal(await readFile(file, 'utf8'), 'not a lease');
});

test('a caught isolation violation still fails the real runner in serial and parallel modes', async (t) => {
  const root = await directory(t),
    file = path.join(root, 'violation.test.mjs');
  await writeFile(
    file,
    "import test from 'node:test';test('caught violation',()=>{try{process.chdir(process.env.TMP)}catch{}});",
  );
  for (const schedule of ['serial', 'partitioned']) {
    const child = spawn(
      process.execPath,
      [path.join(projectRoot, 'scripts/run-tests.mjs'), '--schedule=' + schedule, file],
      { cwd: projectRoot, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk) => {
      output += chunk;
    });
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    assert.equal(code, 1, output);
    assert.match(output, /Isolation violations/);
  }
});
