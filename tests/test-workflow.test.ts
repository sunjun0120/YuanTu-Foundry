import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { projectRoot } from './process-fixture.ts';

const execAsync = promisify(execFile);
const exec = (command: string, args: string[], options: { cwd: string; windowsHide: boolean }) =>
  execAsync(command, args, {
    ...options,
    // Synthetic runner fixtures share no real machine resource with other files.
    env: { ...process.env, FOUNDRY_TEST_MACHINE_LOCK_ROOT: path.join(tmpdir(), 'workflow-locks') },
  });

async function tree(
  t: { after: (fn: () => Promise<void>) => void },
  files: Record<string, string>,
) {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-test-workflow-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [file, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), content);
  }
  return root;
}

// Exercise the real entry point in an isolated repository so policy failures and stage transitions
// can be tested without replacing the shared checkout's policy or running its entire suite.
async function runnerTree(t: test.TestContext, files: Record<string, string>) {
  const root = await tree(t, files);
  await mkdir(path.join(root, 'scripts'), { recursive: true });
  for (const name of [
    'run-tests.mjs',
    'test-summary.mjs',
    'test-reporter.mjs',
    'test-timings.mjs',
    'test-execution-policy.ts',
    'windows-sandbox-suites.mjs',
    'test-resource-policy.ts',
    'test-resource-lease.mjs',
    'test-scheduler.mjs',
    'test-report-merge.mjs',
    'test-source-fingerprint.mjs',
    'test-duration-history.ts',
  ])
    await copyFile(path.join(projectRoot, 'scripts', name), path.join(root, 'scripts', name));
  await cp(
    path.join(projectRoot, 'scripts/test-isolation'),
    path.join(root, 'scripts/test-isolation'),
    { recursive: true },
  );
  const policy = path.join(root, 'scripts/test-resource-policy.ts');
  await writeFile(
    policy,
    (await readFile(policy, 'utf8')).replace(
      "from 'typescript'",
      'from ' +
        JSON.stringify(
          pathToFileURL(path.join(projectRoot, 'node_modules/typescript/lib/typescript.js')).href,
        ),
    ),
  );
  return root;
}

const readRecords = async (file: string) =>
  (await readFile(file, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));

test(
  'IPC cancellation lets the controller settle workers and release its resource lease',
  { timeout: 20000 },
  async (t) => {
    const root = await runnerTree(t, {
      'tests/wait.test.ts':
        "// @test-serial machine-lease: Local fixture exercises cancellation cleanup\nimport test from 'node:test';test('wait',()=>new Promise(()=>{}));setInterval(()=>{},1000);",
    });
    const locks = path.join(root, 'locks');
    const child = spawn(process.execPath, ['scripts/run-tests.mjs'], {
      cwd: root,
      env: { ...process.env, FOUNDRY_TEST_MACHINE_LOCK_ROOT: locks },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    let stdout = '',
      stderr = '',
      requested = false;
    const closed = new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    t.after(async () => {
      if (child.connected) child.send({ type: 'foundry-test-abort-v1' }, () => {});
      await closed;
    });
    assert.ok(child.stderr && child.stdout);
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (!requested && stdout.includes('Log: ')) {
        requested = true;
        child.send({ type: 'foundry-test-abort-v1' });
      }
    });
    assert.equal(await closed, 1, stderr);
    assert.equal(requested, true, stdout);
    await assert.rejects(readFile(path.join(locks, 'machine-lease.lock')), { code: 'ENOENT' });
  },
);

test('legacy parallel policy is ignored and invalid resource declarations fail every schedule', async (t) => {
  const root = await runnerTree(t, {
    'tests/pass.test.ts': "import test from 'node:test';test('passing fixture',()=>{});",
    'test-parallel-safe.json': '{invalid',
  });
  const result = await run(process.execPath, ['scripts/run-tests.mjs'], {
    cwd: root,
    windowsHide: true,
  });
  assert.equal(result.code, undefined, result.stderr);
  for (const schedule of ['serial', 'partitioned']) {
    await writeFile(
      path.join(root, 'tests/pass.test.ts'),
      '// @test-serial invalid: invalid resource\nexport {};',
    );
    const refusal = await run(
      process.execPath,
      ['scripts/run-tests.mjs', '--schedule=' + schedule, '--plan'],
      { cwd: root, windowsHide: true },
    );
    assert.equal(refusal.code, 1);
    assert.match(refusal.stderr, /Invalid test resource/);
  }
});

test('the runner retains spec and timing evidence without multiplying event-stream listeners', async (t) => {
  const root = await runnerTree(t, {
    'tests/pass.test.ts': "import test from 'node:test'; test('reporter fixture', () => {});",
  });
  const logs: string[] = [];
  for (const timed of [false, true]) {
    const result = await run(
      process.execPath,
      ['scripts/run-tests.mjs', ...(timed ? ['--timings=timings.ndjson'] : [])],
      { cwd: root, windowsHide: true },
    );
    assert.equal(result.code, undefined, result.stderr);
    assert.match(result.stdout, /Tests: 1 pass=1 fail=0/);
    assert.doesNotMatch(result.stderr, /MaxListenersExceededWarning/);
    logs.push(...[...result.stdout.matchAll(/^Log: (.+)$/gm)].map((match) => match[1]!.trim()));
  }
  for (const log of logs) assert.match(await readFile(log, 'utf8'), /reporter fixture/);
  assert.ok(
    (await readRecords(path.join(root, 'timings.ndjson'))).some(
      (record) => record.kind === 'phase-summary',
    ),
  );
});

test('a spec log that cannot be opened fails promptly instead of waiting forever for drain', async (t) => {
  const root = await runnerTree(t, {});
  const moduleURL = pathToFileURL(path.join(root, 'scripts/test-reporter.mjs'));
  moduleURL.searchParams.set('log', root); // A directory cannot be opened as the spec log file.
  const { default: reporter } = await import(moduleURL.href);
  async function* events() {
    await new Promise((resolve) => setTimeout(resolve, 100));
    yield { type: 'test:pass', data: { name: 'delayed', nesting: 0, details: { duration_ms: 1 } } };
  }
  let timer;
  const outcome = await Promise.race([
    reporter(events())
      .next()
      .then(
        () => ({ error: null }),
        (error: NodeJS.ErrnoException) => ({ error }),
      ),
    new Promise<{ error: null }>((resolve) => {
      timer = setTimeout(() => resolve({ error: null }), 1000);
    }),
  ]);
  clearTimeout(timer);
  assert.ok(outcome.error, 'the failed spec stream never rejected');
  assert.match(outcome.error.code ?? '', /EISDIR|EPERM|EACCES/);
});

test('explicit files default to parallel without selecting unrelated files', async (t) => {
  const content = "import test from 'node:test';test('fixture',()=>{});";
  const root = await runnerTree(t, { 'tests/a.test.ts': content, 'tests/b.test.ts': content });
  for (const file of ['tests/a.test.ts', path.join(root, 'tests/a.test.ts')]) {
    const { stdout } = await exec(process.execPath, ['scripts/run-tests.mjs', '--plan', file], {
      cwd: root,
      windowsHide: true,
    });
    assert.match(stdout, /^parallel\s+tests\/a\.test\.ts/m);
    assert.match(stdout, /parallel=1 serial=0 total=1/);
    assert.doesNotMatch(stdout, /tests\/b\.test\.ts/);
  }
});

test('continue-on-failure reports every file while preserving a failed exit status', async (t) => {
  const root = await runnerTree(t, {
    'tests/a.test.ts':
      "import test from 'node:test';test('fails',()=>{throw Error('expected failure')});",
    'tests/b.test.ts': "import test from 'node:test';test('still runs',()=>{});",
    'tests/c.test.ts':
      "// @test-serial machine-lease: local continuation fixture\nimport test from 'node:test';test('serial still runs',()=>{});",
  });
  const result = await run(
    process.execPath,
    [
      'scripts/run-tests.mjs',
      '--concurrency=1',
      '--continue-on-failure',
      '--timings=timings.ndjson',
    ],
    { cwd: root, windowsHide: true },
  );
  assert.equal(result.code, 1, result.stdout + result.stderr);
  const metadata = JSON.parse(await readFile(path.join(root, 'timings.ndjson.meta.json'), 'utf8'));
  assert.equal(metadata.complete, true);
  assert.equal(metadata.passed, false);
  assert.deepEqual(
    metadata.files.map((file: { file: string }) => file.file),
    ['tests/a.test.ts', 'tests/b.test.ts', 'tests/c.test.ts'],
  );
});

test('skip-pattern exclusion is marked as filtered in measurement metadata', async (t) => {
  const root = await runnerTree(t, {
    'tests/pass.test.ts':
      "import test from 'node:test'; test('included', () => {}); test('excluded', () => { throw Error('must not run'); });",
  });
  const { stdout } = await exec(
    process.execPath,
    ['scripts/run-tests.mjs', '--test-skip-pattern=excluded', '--timings=timings.ndjson'],
    { cwd: root, windowsHide: true },
  );
  assert.match(stdout, /Tests: 1 pass=1 fail=0/);
  assert.equal(
    JSON.parse(await readFile(path.join(root, 'timings.ndjson.meta.json'), 'utf8')).filtered,
    true,
  );
});

test('default scheduling overlaps private files and finishes them before machine resources', async (t) => {
  const content =
    "import test from 'node:test';import{writeFile}from'node:fs/promises';import{tmpdir}from'node:os';import path from'node:path';test('private file',async()=>{await writeFile(path.join(tmpdir(),'same.txt'),'owned');await new Promise(r=>setTimeout(r,500));});";
  const root = await runnerTree(t, {
    'tests/a.test.ts': content,
    'tests/b.test.ts': content,
    'tests/c.test.ts': '// @test-serial machine-lease: exercise resource phase\n' + content,
  });
  const { stdout } = await exec(
    process.execPath,
    ['scripts/run-tests.mjs', '--concurrency=2', '--timings=timings.ndjson'],
    { cwd: root, windowsHide: true },
  );
  assert.match(stdout, /Phase parallel: 2 file\(s\), concurrency=2/);
  assert.match(stdout, /Phase serial: 1 file\(s\), concurrency=1/);
  const meta = JSON.parse(await readFile(path.join(root, 'timings.ndjson.meta.json'), 'utf8'));
  const parallel = meta.files.filter((f: { phase: string }) => f.phase === 'parallel');
  const serial = meta.files.find((f: { phase: string }) => f.phase === 'serial');
  assert.ok(
    Math.max(...parallel.map((f: { startedAt: number }) => f.startedAt)) <
      Math.min(...parallel.map((f: { finishedAt: number }) => f.finishedAt)),
  );
  assert.ok(
    serial.startedAt >= Math.max(...parallel.map((f: { finishedAt: number }) => f.finishedAt)),
  );
  assert.equal(new Set(meta.files.map((f: { isolationRoot: string }) => f.isolationRoot)).size, 3);
  assert.equal(
    (await readRecords(path.join(root, 'timings.ndjson'))).filter((r) => r.kind === 'run-summary')
      .length,
    1,
  );
});

test('timings retain ordinary nested tests and their skip reasons', async (t) => {
  const root = await runnerTree(t, {
    'tests/nested.test.ts':
      "import test from 'node:test'; test('parent', async t => { await t.test('child pass', () => {}); await t.test('child skip', {skip:'nested skip reason'}, () => {}); });",
  });
  await exec(process.execPath, ['scripts/run-tests.mjs', '--timings=timings.ndjson'], {
    cwd: root,
    windowsHide: true,
  });
  const records = await readRecords(path.join(root, 'timings.ndjson'));
  const cases = records.filter((record) => record.kind === 'case');
  assert.deepEqual(cases.map((record) => record.name).sort(), [
    'child pass',
    'child skip',
    'parent',
  ]);
  assert.equal(
    cases.find((record) => record.name === 'child skip').skipReason,
    'nested skip reason',
  );
  assert.equal(records.find((record) => record.kind === 'run-summary').counts.tests, 3);
});

test('timings distinguish cancelled tests and failed TODO cases from ordinary failures', async (t) => {
  const root = await runnerTree(t, {
    'tests/status.test.ts':
      "import test from 'node:test'; test('todo failure', {todo:'pending fix'}, () => { throw Error('pending'); }); test('cancelled case', {timeout:20}, async () => { await new Promise(resolve => setTimeout(resolve,60)); });",
  });
  const failure = await run(
    process.execPath,
    ['scripts/run-tests.mjs', '--timings=timings.ndjson'],
    {
      cwd: root,
      windowsHide: true,
    },
  );
  assert.equal(failure.code, 1);
  const records = await readRecords(path.join(root, 'timings.ndjson'));
  const cases = records.filter((record) => record.kind === 'case');
  assert.equal(cases.find((record) => record.name === 'todo failure').status, 'todo');
  assert.equal(cases.find((record) => record.name === 'cancelled case').status, 'cancelled');
  assert.equal(records.find((record) => record.kind === 'run-summary').counts.failed, 0);
});

test('whole-run wall time includes preparation before either schedule starts its harness', async (t) => {
  const root = await runnerTree(t, {
    'tests/pass.test.ts': "import test from 'node:test'; test('passing fixture', () => {});",
  });
  // A controlled slow dependency exposes whether the runner starts its clock only after discovery.
  // The actual discovery/classification implementation still runs after the delay.
  await copyFile(
    path.join(root, 'scripts/test-execution-policy.ts'),
    path.join(root, 'scripts/real-policy.ts'),
  );
  await writeFile(
    path.join(root, 'scripts/test-execution-policy.ts'),
    `
import { discoverTests as discover, partitionTests } from './real-policy.ts';
export { partitionTests };
export async function discoverTests(root) {
  await new Promise(resolve => setTimeout(resolve, 300));
  return discover(root);
}`,
  );
  for (const schedule of ['serial', 'partitioned']) {
    await exec(
      process.execPath,
      ['scripts/run-tests.mjs', `--schedule=${schedule}`, `--timings=${schedule}.ndjson`],
      {
        cwd: root,
        windowsHide: true,
      },
    );
    const metadata = JSON.parse(
      await readFile(path.join(root, `${schedule}.ndjson.meta.json`), 'utf8'),
    );
    const phaseMs = Object.values(metadata.phaseWall).reduce(
      (sum: number, value) => sum + Number(value),
      0,
    );
    assert.ok(
      metadata.wallMs - phaseMs >= 250,
      `whole run omitted preparation: ${JSON.stringify(metadata)}`,
    );
  }
});

/**
 * Run a command and describe how it ended, whether it succeeded or failed.
 *
 * `execFile` rejects on a non-zero exit code, so a test that cares about the code has to catch; this
 * keeps that shape in one place instead of a cast at every call site.
 */
async function run(
  command: string,
  args: string[],
  options: { cwd: string; windowsHide: boolean },
): Promise<{ code: number | undefined; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await exec(command, args, options);
    return { code: undefined, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return {
      code: typeof failure.code === 'number' ? failure.code : 1,
      stdout: failure.stdout ?? '',
      stderr: failure.stderr ?? '',
    };
  }
}

test('quiet runner retains successful output in a log without printing each passing test', async (t) => {
  const root = await tree(t, {
    'pass.test.mjs':
      "import test from 'node:test'; test('passing case', () => console.log('fixture output'));",
  });
  const { stdout } = await exec(
    process.execPath,
    ['scripts/run-tests.mjs', path.join(root, 'pass.test.mjs')],
    { cwd: projectRoot, windowsHide: true },
  );
  assert.match(stdout, /pass=1 fail=0/);
  assert.doesNotMatch(stdout, /passing case|fixture output/);
  const log = /Log: (.+)/.exec(stdout)?.[1]?.trim();
  assert.ok(log);
  t.after(() => rm(log, { force: true }));
  assert.match(await readFile(log, 'utf8'), /fixture output/);
});

test('quiet runner reports the failing assertion and preserves a nonzero exit code', async (t) => {
  const root = await tree(t, {
    'fail.test.mjs':
      "import test from 'node:test'; import assert from 'node:assert/strict'; test('broken fixture', () => assert.equal(1, 2));",
  });
  await assert.rejects(
    exec(process.execPath, ['scripts/run-tests.mjs', path.join(root, 'fail.test.mjs')], {
      cwd: projectRoot,
      windowsHide: true,
    }),
    (error: unknown) => {
      const result = error as { code: number; stdout: string };
      assert.equal(result.code, 1);
      assert.match(result.stdout, /broken fixture/);
      assert.match(result.stdout, /1 !== 2/);
      assert.match(result.stdout, /fail=1/);
      const log = /Log: (.+)/.exec(result.stdout)?.[1]?.trim();
      assert.ok(log);
      t.after(() => rm(log, { force: true }));
      return true;
    },
  );
});

/**
 * The timing reporter is an extra observer, so it may not change what the run does: the same cases
 * pass, fail and skip, the quiet output stays quiet, and the exit code still reports a failure. Each
 * of these asserts a property of the run rather than of the file's shape, because a reporter that
 * silently swallowed an event would still produce a plausible-looking file.
 */
test('timings are opt-in, and the run is otherwise identical without them', async (t) => {
  const root = await tree(t, {
    'pass.test.mjs': "import test from 'node:test'; test('passing case', () => {});",
  });
  const file = path.join(root, 'pass.test.mjs');
  const { stdout } = await exec(process.execPath, ['scripts/run-tests.mjs', file], {
    cwd: projectRoot,
    windowsHide: true,
  });
  assert.match(stdout, /pass=1 fail=0/);
  // One total line per phase is new; it is the phase's own summary, not a second copy of the run.
  assert.match(stdout, /^Total: parallel tests=1 pass=1 fail=0/m);
  const log = /Log: (.+)/.exec(stdout)?.[1]?.trim();
  assert.ok(log);
  t.after(() => rm(log, { force: true }));
  // No --timings path was given, so nothing is written where a caller would look for one; the
  // phase's internal report lives beside the log, not in the caller's tree.
  assert.deepEqual(
    (await readdir(root)).filter((name) => name.includes('timings') || name.includes('meta')),
    [],
  );
});

test('timings record every case outcome, create their directory, and report a failure', async (t) => {
  const root = await tree(t, {
    'mixed.test.mjs': `import test from 'node:test';
import assert from 'node:assert/strict';
test('passing case', () => {});
test('failing case', () => assert.equal(1, 2));
test('skipped case', { skip: 'fixture skip reason' }, () => {});
test('todo case', { todo: 'fixture todo' }, () => {});`,
  });
  const file = path.join(root, 'mixed.test.mjs');
  // A directory that does not exist yet: the reporter creates it instead of failing the run.
  const timings = path.join(root, 'nested', 'deeper', 'timings.ndjson');
  const failure = await run(
    process.execPath,
    ['scripts/run-tests.mjs', `--timings=${timings}`, file],
    { cwd: projectRoot, windowsHide: true },
  );
  assert.equal(failure.code, 1, 'a failing case still fails the run');
  assert.match(failure.stdout, /fail=1/);
  const log = /Log: (.+)/.exec(failure.stdout)?.[1]?.trim();
  assert.ok(log);
  t.after(() => rm(log, { force: true }));

  const records = (await readFile(timings, 'utf8'))
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
  const cases = records.filter((record) => record.kind === 'case');
  assert.deepEqual(cases.map((record) => record.status).sort(), [
    'failed',
    'passed',
    'skipped',
    'todo',
  ]);
  for (const record of cases) {
    assert.equal(record.schemaVersion, 1);
    assert.equal(record.phase, 'parallel');
    assert.ok(Number.isFinite(record.durationMs), `${record.name} has no duration`);
    assert.ok(path.isAbsolute(record.file), `${record.name} carries no absolute file`);
  }
  const skipped = cases.find((record) => record.status === 'skipped');
  assert.equal(skipped.skipReason, 'fixture skip reason');
  for (const record of cases.filter((item) => item.status !== 'skipped'))
    assert.equal(record.skipReason, null);
  // A complete report is one the writer closed: the terminal record is what tells a truncated file
  // from a finished one, and the runner refuses the former.
  assert.equal(records.at(-1).kind, 'phase-summary');
  const summary = records.find((record) => record.kind === 'run-summary');
  assert.equal(summary.file, null);
  assert.deepEqual(summary.counts, {
    tests: 4,
    passed: 1,
    failed: 1,
    skipped: 1,
    cancelled: 0,
    todo: 1,
  });
  // The per-file summary is Node's own duration for that file, not a sum over the cases.
  const perFile = records.find((record) => record.kind === 'file-summary');
  assert.equal(perFile.file, file);
  assert.ok(Number.isFinite(perFile.durationMs));
});

test('a timings report on an unwritable path fails the run rather than passing quietly', async (t) => {
  const root = await tree(t, {
    'pass.test.mjs': "import test from 'node:test'; test('passing case', () => {});",
  });
  // A path whose parent is an existing *file* cannot be created, whatever the platform's error code.
  const blocked = path.join(root, 'not-a-directory', 'timings.ndjson');
  await writeFile(path.join(root, 'not-a-directory'), 'a file, not a directory');
  const failure = await run(
    process.execPath,
    ['scripts/run-tests.mjs', `--timings=${blocked}`, path.join(root, 'pass.test.mjs')],
    { cwd: projectRoot, windowsHide: true },
  );
  assert.equal(failure.code, 1, 'an unwritable report is a failed run');
  const log = /Log: (.+)/.exec(failure.stdout)?.[1]?.trim();
  assert.ok(log);
  t.after(() => rm(log, { force: true }));
});

test('a filtered run is marked as filtered in the timings metadata', async (t) => {
  const root = await tree(t, {
    'skip.test.mjs': `import test from 'node:test';
test('chosen case', () => {});
test('excluded case', () => { throw new Error('must be filtered'); });`,
  });
  const timings = path.join(root, 'timings.ndjson');
  const { stdout } = await exec(
    process.execPath,
    [
      'scripts/run-tests.mjs',
      '--test-name-pattern=chosen',
      `--timings=${timings}`,
      path.join(root, 'skip.test.mjs'),
    ],
    { cwd: projectRoot, windowsHide: true },
  );
  assert.match(stdout, /pass=1 fail=0/);
  const log = /Log: (.+)/.exec(stdout)?.[1]?.trim();
  assert.ok(log);
  t.after(() => rm(log, { force: true }));
  const metadata = JSON.parse(await readFile(`${timings}.meta.json`, 'utf8'));
  assert.equal(metadata.filtered, true);
  assert.equal(metadata.schedule, 'partitioned');
  assert.ok(metadata.parallelConcurrency >= 1);
  assert.equal(metadata.discovered, 1);
  assert.equal(metadata.explicit, true);
  assert.ok(metadata.head, 'the run records the revision it measured');
  assert.ok(Number.isFinite(metadata.wallMs), 'the run records a monotonic wall clock');
});

test('--plan previews the partition without starting a harness or writing a log', async () => {
  const { discoverTests } = await import('../scripts/test-execution-policy.ts');
  const discovered = await discoverTests(projectRoot);
  const { stdout } = await exec(
    process.execPath,
    ['scripts/run-tests.mjs', '--schedule=partitioned', '--parallel-concurrency=2', '--plan'],
    { cwd: projectRoot, windowsHide: true },
  );
  // The preview covers the discovered suite exactly once and names every file's phase.
  assert.match(stdout, /^Discovered \d+ test file\(s\)$/m);
  const phase = [...stdout.matchAll(/^(parallel|serial)\s+(tests\/\S+\.test\.ts)\s+\(/gm)];
  assert.equal(phase.length, discovered.length);
  assert.deepEqual(phase.map((match) => match[2]).sort(), [...discovered].sort());
  assert.match(stdout, /^Plan: parallel=\d+ serial=\d+ total=\d+ parallel-concurrency=2$/m);
  assert.doesNotMatch(stdout, /^Log: /m, 'a preview writes no log');
  assert.doesNotMatch(stdout, /^Tests: /m, 'a preview runs no harness');
});

test('--plan and the partitioned schedule refuse a schedule they cannot honour', async () => {
  const bad = async (args: string[]) => {
    const failure = await run(process.execPath, ['scripts/run-tests.mjs', ...args], {
      cwd: projectRoot,
      windowsHide: true,
    });
    assert.notEqual(failure.code, undefined, `expected a refusal for ${args.join(' ')}, not a run`);
    assert.notEqual(failure.code, 0, `expected a refusal for ${args.join(' ')}`);
    return failure.stderr;
  };
  // `--plan` on the serial schedule would print a plan for a run that does not use one.
  assert.match(await bad(['--schedule=serial', '--concurrency=2']), /requires concurrency=1/);
  // Two different widths for the same idea: the phase width and the harness width.
  assert.match(
    await bad(['--parallel-concurrency=2', '--concurrency=4']),
    /Conflicting concurrency options/,
  );
  assert.match(await bad(['--schedule=unknown']), /Unsupported schedule/);
  assert.match(
    await bad(['--schedule=partitioned', '--parallel-concurrency=0']),
    /--parallel-concurrency must be a positive integer/,
  );
  assert.match(await bad(['--timings=']), /--timings requires a path/);
});

test('a new file runs in the default parallel phase', async (t) => {
  const root = await tree(t, {
    'pass.test.mjs': "import test from 'node:test'; test('passing case', () => {});",
  });
  const file = path.join(root, 'pass.test.mjs');
  const timings = path.join(root, 'partitioned.ndjson');
  const { stdout } = await exec(
    process.execPath,
    [
      'scripts/run-tests.mjs',
      '--schedule=partitioned',
      '--parallel-concurrency=2',
      `--timings=${timings}`,
      file,
    ],
    { cwd: projectRoot, windowsHide: true },
  );
  // New files are parallel by default. Only the nonempty parallel phase should run.
  assert.doesNotMatch(stdout, /^Phase serial:/m, 'an empty phase is not started');
  assert.match(stdout, /^Phase parallel: 1 file\(s\), concurrency=2$/m);
  assert.match(stdout, /^Total: parallel tests=1 pass=1 fail=0/m);
  const log = /Log: (.+)/.exec(stdout)?.[1]?.trim();
  assert.ok(log);
  t.after(() => rm(log, { force: true }));
  const records = (await readFile(timings, 'utf8'))
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
  assert.equal(records.filter((record) => record.phase === 'serial').length, 0);
  assert.ok(records.some((record) => record.phase === 'parallel' && record.kind === 'case'));
  const metadata = JSON.parse(await readFile(`${timings}.meta.json`, 'utf8'));
  assert.equal(metadata.schedule, 'partitioned');
  assert.equal(metadata.parallelConcurrency, 2);
  assert.equal(metadata.parallel, 1);
  assert.equal(metadata.serial, 0);
});

test('--concurrency controls the isolated worker pool', async (t) => {
  const root = await tree(t, {
    'pass.test.mjs': "import test from 'node:test'; test('passing case', () => {});",
  });
  const { stdout } = await exec(
    process.execPath,
    ['scripts/run-tests.mjs', '--concurrency=4', path.join(root, 'pass.test.mjs')],
    { cwd: projectRoot, windowsHide: true },
  );
  // The runner's own line and the harness phase line must agree, and both must say 4: a width that
  // is silently dropped would make every concurrency experiment measure nothing.
  assert.match(stdout, /^Running 1 test file\(s\), concurrency=4$/m);
  assert.match(stdout, /^Phase parallel: 1 file\(s\), concurrency=4$/m);
  assert.match(stdout, /pass=1 fail=0/);
  const log = /Log: (.+)/.exec(stdout)?.[1]?.trim();
  assert.ok(log);
  t.after(() => rm(log, { force: true }));
});

test('changed selection follows transitive imports and literal worker paths', async (t) => {
  const root = await tree(t, {
    'packages/example/leaf.ts': 'export const value = 1;',
    'packages/example/index.ts': "export { value } from './leaf.ts';",
    'packages/example/worker.ts': 'console.log(1);',
    'tests/consumer.test.ts': "import { value } from '../packages/example/index.ts';",
    'tests/worker.test.ts':
      "const worker = new URL('../packages/example/worker.ts', import.meta.url);",
    'tests/unrelated.test.ts': 'export {};',
  });
  const { selectTests } = await import('../scripts/select-tests.ts');
  assert.deepEqual((await selectTests(root, ['packages/example/leaf.ts'])).tests, [
    'tests/consumer.test.ts',
  ]);
  assert.deepEqual((await selectTests(root, ['packages/example/worker.ts'])).tests, [
    'tests/worker.test.ts',
  ]);
});

test('unmapped files, deleted source and shared contracts fall back to all tests', async (t) => {
  const root = await tree(t, {
    'tests/a.test.ts': 'export {};',
    'tests/b.test.ts': 'export {};',
    'packages/example/new.ts': 'export {};',
    'packages/protocol/rpc.ts': 'export {};',
  });
  const { selectTests } = await import('../scripts/select-tests.ts');
  for (const changed of [
    'package-lock.json',
    'packages/example/deleted.ts',
    'packages/example/new.ts',
    'packages/protocol/rpc.ts',
  ]) {
    const selection = await selectTests(root, [changed]);
    assert.deepEqual(selection.tests, ['tests/a.test.ts', 'tests/b.test.ts']);
    assert.equal(selection.full, true);
  }
});

test('documentation changes select no behavior tests and changed tests select themselves', async (t) => {
  const root = await tree(t, { 'tests/a.test.ts': 'export {};', 'docs/guide.md': 'Guide' });
  const { selectTests } = await import('../scripts/select-tests.ts');
  assert.deepEqual((await selectTests(root, ['docs/guide.md'])).tests, []);
  assert.deepEqual((await selectTests(root, ['tests/a.test.ts'])).tests, ['tests/a.test.ts']);
});

test('shared smoke helpers select full verification including the desktop gate', async (t) => {
  const root = await tree(t, {
    'tests/a.test.ts': "import './page-wait.mjs';",
    'tests/b.test.ts': 'export {};',
    'tests/page-wait.mjs': 'export {};',
  });
  const { selectTests, requiresDesktop } = await import('../scripts/select-tests.ts');
  const selection = await selectTests(root, ['tests/page-wait.mjs']);
  assert.equal(selection.full, true);
  assert.deepEqual(selection.tests, ['tests/a.test.ts', 'tests/b.test.ts']);
  assert.equal(requiresDesktop(['tests/page-wait.mjs']), true);
  assert.equal(requiresDesktop(['tests/a.test.ts']), false);
});

test('quiet runner keeps skip reasons and test-name filtering visible', async (t) => {
  const root = await tree(t, {
    'skip.test.mjs':
      "import test from 'node:test'; test('optional case', { skip: 'fixture dependency absent' }, () => {}); test('chosen case', () => {}); test('excluded case', () => { throw new Error('must be filtered'); });",
  });
  const { stdout } = await exec(
    process.execPath,
    [
      'scripts/run-tests.mjs',
      '--test-name-pattern=optional|chosen',
      path.join(root, 'skip.test.mjs'),
    ],
    { cwd: projectRoot, windowsHide: true },
  );
  assert.match(stdout, /pass=1 fail=0 skip=1/);
  assert.match(stdout, /fixture dependency absent/);
  const log = /Log: (.+)/.exec(stdout)?.[1]?.trim();
  assert.ok(log);
  t.after(() => rm(log, { force: true }));
});

test('changed discovery includes staged, unstaged, deleted and untracked files but excludes ignored files', async (t) => {
  const root = await tree(t, {
    '.gitignore': 'ignored.txt\n',
    'staged.txt': 'before',
    'unstaged.txt': 'before',
    'deleted.txt': 'before',
  });
  const git = (args: string[]) => exec('git', args, { cwd: root, windowsHide: true });
  await git(['init', '--template=']);
  await git(['add', '.']);
  await git([
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.invalid',
    'commit',
    '--no-verify',
    '-m',
    'baseline',
  ]);
  await writeFile(path.join(root, 'staged.txt'), 'after');
  await git(['add', 'staged.txt']);
  await writeFile(path.join(root, 'unstaged.txt'), 'after');
  await rm(path.join(root, 'deleted.txt'));
  await writeFile(path.join(root, 'new.txt'), 'new');
  await writeFile(path.join(root, 'ignored.txt'), 'ignored');
  const { getChangedFiles } = await import('../scripts/select-tests.ts');
  assert.deepEqual(await getChangedFiles(root), [
    'deleted.txt',
    'new.txt',
    'staged.txt',
    'unstaged.txt',
  ]);
  await assert.rejects(getChangedFiles(root, 'nonexistent-baseline'));
});

test('a documentation-only change selects nothing instead of the whole suite', async (t) => {
  const root = await tree(t, {
    'tests/a.test.ts': 'export {};',
    'packages/example/new.ts': 'export {};',
    'README.md': '# readme',
    LICENSE: 'licence',
    'docs/notes.md': 'notes',
  });
  const { selectTests } = await import('../scripts/select-tests.ts');
  // Editing prose is the one change that provably cannot affect a test, and running 2000 cases for it is what
  // makes a developer stop using the selector at all. None of these three may fall through to the fallbacks
  // below, which would turn a README edit into a full run.
  for (const changed of ['README.md', 'LICENSE', 'docs/notes.md']) {
    const selection = await selectTests(root, [changed]);
    assert.deepEqual(selection.tests, [], changed);
    assert.equal(selection.full, false, changed);
  }
  assert.equal((await selectTests(root, ['README.md'])).reason, 'Documentation only');
});

test('a shared critical module outside the ones already exercised still falls back to all tests', async (t) => {
  const root = await tree(t, {
    'tests/a.test.ts': 'export {};',
    'tests/carrier-consumer.test.ts': "import '../packages/carrier/service.ts';",
    'packages/carrier/service.ts': 'export {};',
  });
  const { selectTests } = await import('../scripts/select-tests.ts');
  // `carrier` has implicit consumers: a test imports its service, so without the critical-module rule the
  // selector would answer "just that one test" for a change to a module whose real reach is the whole runtime.
  const selection = await selectTests(root, ['packages/carrier/service.ts']);
  assert.equal(selection.full, true, selection.reason);
  assert.deepEqual(selection.tests, ['tests/a.test.ts', 'tests/carrier-consumer.test.ts']);
});
