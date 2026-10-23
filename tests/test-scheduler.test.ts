import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { acquireResourceLease } from '../scripts/test-resource-lease.mjs';
import { readFileReport } from '../scripts/test-report-merge.mjs';
import { lastReportedCase } from '../scripts/test-scheduler.mjs';
import { sourceFingerprint } from '../scripts/test-source-fingerprint.mjs';
import { projectRoot } from './process-fixture.ts';
import {
  orderTestsByDuration,
  readTestDurations,
  writeTestDurations,
} from '../scripts/test-duration-history.ts';
import { tempRoot } from './temp-fixture.ts';

async function directory(t: test.TestContext) {
  const root = await tempRoot(t, 'yuantu-scheduler-');
  return root;
}

test('source fingerprints include build locks, root packaging and CI configuration but exclude generated assets', async (t) => {
  const root = await directory(t);
  for (const file of [
    'build/windows-runtime.lock.json',
    'electron-builder.config.cjs',
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

test('watchdog diagnostics preserve the case reported before termination even when its name is a file path', async (t) => {
  const root = await directory(t),
    file = path.join(root, '真实🙂 case.test.ts'),
    timings = path.join(root, 'report.ndjson');
  const reported = { kind: 'case', file, name: file, status: 'passed', durationMs: 5 };
  const snapshot = JSON.stringify(reported) + '\n';
  // Ending a worker can append a synthetic file failure after the watchdog has fired.
  await writeFile(
    timings,
    snapshot + JSON.stringify({ ...reported, status: 'failed', durationMs: 1500 }) + '\n',
  );
  assert.deepEqual(await lastReportedCase(timings, Buffer.byteLength(snapshot)), reported);
  assert.equal(await lastReportedCase(timings, 0), undefined);
  assert.equal(await lastReportedCase(path.join(root, 'not-created.ndjson'), 0), undefined);
  const unfinished = '{"kind":"case","name":"未完成🙂';
  await writeFile(timings, snapshot + unfinished + '"}\n');
  assert.deepEqual(
    await lastReportedCase(timings, Buffer.byteLength(snapshot + unfinished) - 1),
    reported,
  );
});

test('machine resource lease excludes another process and an aborted waiter does not remove the owner', async (t) => {
  const root = await directory(t);
  const release = await acquireResourceLease(root, ['machine-lease']);
  const original = await readFile(path.join(root, 'machine-lease.lock'), 'utf8');
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
  assert.equal(await readFile(path.join(root, 'machine-lease.lock'), 'utf8'), original);
  release();
  const next = await acquireResourceLease(root, ['machine-lease']);
  next();
});

test('different machine resources are leased independently; a shared one still excludes', async (t) => {
  const root = await directory(t);
  const desktop = await acquireResourceLease(root, ['desktop-ui']);
  // Another resource is not held up by the desktop window.
  const sandbox = await acquireResourceLease(root, ['windows-sandbox'], { timeoutMs: 150 });
  // A set that overlaps a held resource waits for it, and gives back what it already took when it times out.
  await assert.rejects(
    acquireResourceLease(root, ['real-pty', 'desktop-ui'], { timeoutMs: 150 }),
    /Timed out waiting for machine resource lease: .*desktop-ui\.lock/,
  );
  await assert.rejects(readFile(path.join(root, 'real-pty.lock')), { code: 'ENOENT' });
  desktop();
  sandbox();
  const both = await acquireResourceLease(root, ['windows-sandbox', 'desktop-ui', 'desktop-ui']);
  for (const resource of ['desktop-ui', 'windows-sandbox'])
    assert.equal(
      JSON.parse(await readFile(path.join(root, `${resource}.lock`), 'utf8')).resource,
      resource,
    );
  both();
  for (const resource of ['desktop-ui', 'windows-sandbox'])
    await assert.rejects(readFile(path.join(root, `${resource}.lock`)), { code: 'ENOENT' });
});

test('unknown machine resource ownership is refused without deleting the lock', async (t) => {
  const root = await directory(t),
    file = path.join(root, 'machine-lease.lock');
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

test('a file that never settles is ended by the watchdog and reported as a failure', async (t) => {
  const root = await directory(t),
    file = path.join(root, 'hang.test.mjs');
  await writeFile(
    file,
    [
      "import test from 'node:test';",
      "test('a passing case', () => {});",
      // A real interval keeps the loop alive, so this is a hang rather than a Node process that simply runs dry.
      "test('a case that never settles', () => new Promise(() => setInterval(() => {}, 1000)));",
      '',
    ].join('\n'),
  );
  const child = spawn(process.execPath, [path.join(projectRoot, 'scripts/run-tests.mjs'), file], {
    cwd: projectRoot,
    env: { ...process.env, FOUNDRY_TEST_FILE_TIMEOUT_MS: '1500' },
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
  // The watchdog's own failure must not turn this test into the same kind of hang it exists to prevent.
  const guard = setTimeout(() => child.kill('SIGKILL'), 60_000);
  t.after(() => clearTimeout(guard));
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  clearTimeout(guard);
  assert.equal(code, 1, output);
  assert.match(output, /Test file timed out after \d+s: .*hang\.test\.mjs/);
  // The bound names the work that was running, which is what makes a hang actionable without a re-run.
  assert.match(output, /last reported case "a passing case"/);
});
