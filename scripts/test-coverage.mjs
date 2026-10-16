/**
 * Keep the coverage floor suite-wide while every test runs through the isolation scheduler.
 * Raw V8 ranges are retained by the controller, then merged with this Node runtime's own
 * implementation: reporter line-only branch summaries cannot identify overlapping ranges.
 * The internal dependency is deliberate, version-checked, and fails closed if Node changes it.
 */
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const thresholds = { line: 90, branch: 75, function: 85 };

if (args[0] === '--aggregate') {
  if (!process.execArgv.includes('--expose-internals'))
    throw Error('Coverage aggregation requires --expose-internals');
  if (Number(process.versions.node.split('.')[0]) !== 24)
    throw Error(
      'Coverage aggregation currently requires Node 24; verify native coverage API before updating',
    );
  const directory = path.resolve(args[1]);
  if (!(await readdir(directory)).some((name) => /^coverage-.*\.json$/.test(name)))
    throw Error('No raw V8 coverage reports were retained');
  const require = createRequire(import.meta.url);
  const { TestCoverage } = require('internal/test_runner/coverage');
  if (typeof TestCoverage !== 'function') throw Error('Native coverage merger unavailable');
  const coverage = new TestCoverage(directory, undefined, {
    cwd: root,
    lineCoverage: thresholds.line,
    branchCoverage: thresholds.branch,
    functionCoverage: thresholds.function,
    sourceMaps: process.execArgv.includes('--enable-source-maps'),
  });
  const summary = coverage.summary();
  if (!summary.files.length) throw Error('Aggregate coverage contains no source files');
  await writeFile(
    path.join(directory, '..', 'coverage-summary.json'),
    JSON.stringify(summary, null, 2) + '\n',
  );
  for (const [kind, property] of [
    ['line', 'coveredLinePercent'],
    ['branch', 'coveredBranchPercent'],
    ['function', 'coveredFunctionPercent'],
  ]) {
    const actual = summary.totals[property];
    if (!Number.isFinite(actual)) throw Error(`Missing aggregate ${kind} coverage`);
    console.log(`Coverage ${kind}: ${actual.toFixed(2)}% (minimum ${thresholds[kind]}%)`);
    if (actual < thresholds[kind]) process.exitCode = 1;
  }
} else {
  if (
    args.some((arg) => arg.startsWith('--test-coverage-') || arg === '--experimental-test-coverage')
  )
    throw Error('The coverage entrypoint owns coverage options and aggregate thresholds');
  const parent = process.env.FOUNDRY_TEST_ARTIFACTS ?? path.join(root, '.scratch', 'coverage');
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(path.join(parent, 'run-'));
  const raw = path.join(directory, 'raw');
  await mkdir(raw);
  console.log(`Aggregate coverage evidence: ${directory}`);
  let cancelled = false;
  const run = (argv, env = process.env, cooperative = false) =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, argv, {
        cwd: root,
        env,
        windowsHide: true,
        stdio: cooperative ? ['inherit', 'inherit', 'inherit', 'ipc'] : 'inherit',
      });
      child.once('error', reject);
      child.once('close', (code) => resolve(code ?? 1));
      const cancel = () => {
        if (cancelled) return;
        cancelled = true;
        process.exitCode = 1;
        if (cooperative) {
          // Wait for scheduler settlement and lease release, including on Windows.
          if (child.connected) child.send({ type: 'foundry-test-abort-v1' }, () => {});
        } else {
          // The aggregation-only child owns no test workers or machine leases.
          child.kill();
        }
      };
      process.on('SIGINT', cancel);
      process.on('SIGTERM', cancel);
      child.once('close', () => {
        process.removeListener('SIGINT', cancel);
        process.removeListener('SIGTERM', cancel);
      });
    });
  const code = await run(
    ['scripts/run-tests.mjs', '--experimental-test-coverage', ...args],
    {
      ...process.env,
      FOUNDRY_TEST_COVERAGE_DIR: raw,
    },
    true,
  );
  if (code || cancelled) process.exitCode = code || 1;
  else
    process.exitCode = await run([
      '--expose-internals',
      ...process.execArgv.filter((arg) => arg === '--enable-source-maps'),
      'scripts/test-coverage.mjs',
      '--aggregate',
      raw,
    ]);
}
