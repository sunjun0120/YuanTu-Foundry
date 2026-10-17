import { spawnSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { availableParallelism, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverTests, partitionTests } from './test-execution-policy.ts';
import { runSchedule } from './test-scheduler.mjs';
import { mergeReports, sumCounts, writeMergedReport } from './test-report-merge.mjs';
import { sourceFingerprint } from './test-source-fingerprint.mjs';
import {
  orderTestsByDuration,
  readTestDurations,
  writeTestDurations,
} from './test-duration-history.ts';

const controller = new AbortController();
const cancel = () => controller.abort();
// An IPC parent asks for cleanup; it never has to terminate this lease-owning controller.
const ipcChild = typeof process.send === 'function';
const abortMessage = (message) => {
  if (message?.type === 'foundry-test-abort-v1') cancel();
};
if (ipcChild) {
  process.on('message', abortMessage);
  process.on('disconnect', cancel);
  process.channel?.unref();
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const startedAt = new Date().toISOString(),
  wallStart = performance.now();
const args = process.argv.slice(2),
  options = [],
  files = [];
/**
 * How many test files run at once.
 *
 * Eight rather than four because the parallel phase is dominated by files that spend their time waiting on
 * spawned Host processes and file I/O, not on the CPU: on a 16-core machine the same 249 files took 477 s at four
 * and 348 s at eight, with the same 2563 cases and no failures in either run. The cap still follows
 * `availableParallelism`, so a smaller machine keeps a smaller default, and `--concurrency=N` remains the way to
 * pin it. Only the parallel phase is affected: the native sandbox files are serial by construction.
 */
let concurrency = Math.min(8, availableParallelism()),
  schedule = 'partitioned',
  order = 'duration',
  durationHistory;
let plan = false,
  /**
   * Whether a failing file stops the dispatch of the rest.
   *
   * Locally "stop at the first failure" is the fast loop a developer wants. A gate wants the opposite: one run has
   * to list every failure, and an unrelated hanging cleanup must not hide the other 140 files. The default stays
   * fail-fast so `npm test` behaves the way it always has; `FOUNDRY_TEST_CONTINUE_ON_FAILURE=1` (what CI sets)
   * keeps dispatching while still exiting non-zero.
   */
  continueOnFailure = process.env.FOUNDRY_TEST_CONTINUE_ON_FAILURE === '1',
  timings,
  verbose = false,
  width;
for (const arg of args) {
  const match = /^--(parallel-concurrency|concurrency)=(.*)$/.exec(arg);
  if (match) {
    const value = Number(match[2]);
    if (!Number.isSafeInteger(value) || value < 1)
      throw Error(`--${match[1]} must be a positive integer`);
    if (width !== undefined && width !== value) throw Error('Conflicting concurrency options');
    width = concurrency = value;
  } else if (arg.startsWith('--schedule=')) {
    schedule = arg.slice('--schedule='.length);
    if (!['serial', 'partitioned'].includes(schedule))
      throw Error(`Unsupported schedule: ${schedule}`);
  } else if (arg.startsWith('--order=')) {
    order = arg.slice('--order='.length);
    if (!['duration', 'name'].includes(order)) throw Error(`Unsupported test order: ${order}`);
  } else if (arg.startsWith('--duration-history=')) {
    durationHistory = arg.slice('--duration-history='.length);
    if (!durationHistory.trim()) throw Error('--duration-history requires a path');
  } else if (arg === '--plan') plan = true;
  else if (arg === '--verbose') verbose = true;
  else if (arg === '--continue-on-failure') continueOnFailure = true;
  else if (arg.startsWith('--timings=')) {
    timings = arg.slice('--timings='.length);
    if (!timings.trim()) throw Error('--timings requires a path');
  } else if (/^--test-(?:name-pattern|skip-pattern|timeout)=/.test(arg)) options.push(arg);
  else if (
    arg === '--experimental-test-coverage' ||
    /^--test-coverage-(?:lines|branches|functions)=/.test(arg)
  )
    options.push(arg);
  else if (arg.startsWith('-')) throw Error(`Unsupported test option: ${arg}`);
  else files.push(arg);
}
if (schedule === 'serial') {
  if (width !== undefined && width !== 1) throw Error('--schedule=serial requires concurrency=1');
  concurrency = 1;
}
const explicit = files.length > 0;
const discovered = [
  ...new Set(
    explicit
      ? files.map((file) => {
          const absolute = path.resolve(root, file),
            relative = path.relative(root, absolute);
          return !relative.startsWith('..') && !path.isAbsolute(relative)
            ? relative.replaceAll('\\', '/')
            : absolute.replaceAll('\\', '/');
        })
      : await discoverTests(root),
  ),
];
const partition = await partitionTests(discovered, { root });
const filtered = options.some((option) => /^--test-(?:name|skip)-pattern=/.test(option));
// Nested controllers write hints inside their outer owner's artifacts. Coverage has a separate cost profile.
const historyFile = path.resolve(
  root,
  durationHistory ??
    path.join(
      process.env.FOUNDRY_TEST_ARTIFACTS ?? path.join(root, '.scratch/cache'),
      `test-durations-${process.platform}-${process.arch}-node${process.versions.node.split('.')[0]}${process.env.FOUNDRY_TEST_COVERAGE_DIR ? '-coverage' : ''}.json`,
    ),
);
const durations =
  order === 'duration' && schedule !== 'serial' && !explicit && !filtered
    ? await readTestDurations(historyFile)
    : {};
const parallelFiles =
  order === 'duration' && !explicit && !filtered
    ? orderTestsByDuration(partition.parallel, durations)
    : partition.parallel;
const phases =
  schedule === 'serial'
    ? [{ phase: 'serial', files: discovered, concurrency: 1 }]
    : [
        { phase: 'parallel', files: parallelFiles, concurrency },
        { phase: 'serial', files: partition.serial, concurrency: 1 },
      ];
if (plan) {
  console.log(`Discovered ${discovered.length} test file(s)`);
  for (const phase of phases)
    for (const file of phase.files)
      console.log(`${phase.phase.padEnd(8)}  ${file}  (${partition.reasons[file]})`);
  console.log(
    `Plan: parallel=${schedule === 'serial' ? 0 : partition.parallel.length} serial=${schedule === 'serial' ? discovered.length : partition.serial.length} total=${discovered.length} parallel-concurrency=${concurrency}`,
  );
} else {
  // Nested runners keep controller evidence inside their outer owner's artifact directory.
  const directory = process.env.FOUNDRY_TEST_ARTIFACTS
    ? path.join(process.env.FOUNDRY_TEST_ARTIFACTS, 'test-logs')
    : path.join(root, '.scratch/test-logs');
  await mkdir(directory, { recursive: true });
  const runId = `${Date.now()}-${process.pid}-${randomUUID()}`;
  process.env.FOUNDRY_TEST_MACHINE_LOCK_ROOT ??= path.join(tmpdir(), 'yuantu-test-resource-locks');
  const preparationWallMs = Number((performance.now() - wallStart).toFixed(1));
  process.on('SIGINT', cancel);
  process.on('SIGTERM', cancel);
  console.log(`Running ${discovered.length} test file(s), concurrency=${concurrency}`);
  console.log(`Run id: ${runId}`);
  try {
    const source = timings ? await sourceFingerprint(root) : undefined;
    const { results, phaseWall, failed } = await runSchedule({
      root,
      directory,
      runId,
      phases,
      resources: partition.resources,
      options,
      signal: controller.signal,
      verbose,
      continueOnFailure,
    });
    const sourceAfter = timings ? await sourceFingerprint(root) : undefined;
    const sourceChanged = source?.digest !== sourceAfter?.digest;
    if (sourceChanged)
      console.error('Source inputs changed during this run; equivalence evidence is invalid.');
    const merged = mergeReports(results, phaseWall);
    const incomplete =
      results.length !== discovered.length || results.some((result) => result.report.problem);
    for (const [phase, wallMs] of Object.entries(phaseWall)) {
      const counts = sumCounts(
        results.filter((result) => result.phase === phase).map((result) => result.report.summary),
      );
      console.log(
        `Total: ${phase} tests=${counts.tests} pass=${counts.passed} fail=${counts.failed} skip=${counts.skipped} cancelled=${counts.cancelled} todo=${counts.todo} wall=${(wallMs / 1000).toFixed(2)}s`,
      );
    }
    const zeros = results.reduce((count, result) => count + (result.report.zeroTestFiles ?? 0), 0);
    if (zeros)
      console.log(
        `${zeros} file(s) reported no test cases; a name/skip filter was ${filtered ? '' : 'not '}in effect.`,
      );
    if (incomplete)
      console.error(
        `Incomplete run: ${results.length}/${discovered.length} files settled; every requested file must have a complete summary.`,
      );
    const metadata = {
      schemaVersion: 1,
      command: process.argv.slice(1),
      node: process.version,
      head: git(['rev-parse', 'HEAD']),
      dirtyFiles: git(['status', '--porcelain=v1'])?.split('\n').filter(Boolean).length ?? null,
      schedule,
      continueOnFailure,
      order: schedule === 'serial' ? 'input' : explicit || filtered ? 'name' : order,
      durationHistory: historyFile,
      measuredFiles: discovered.filter((file) => Object.hasOwn(durations, file)).length,
      parallelConcurrency: concurrency,
      filtered,
      explicit,
      discovered: discovered.length,
      parallel: partition.parallel.length,
      serial: partition.serial.length,
      startedAt,
      preparationWallMs,
      phaseWall,
      wallMs: Number((performance.now() - wallStart).toFixed(1)),
      isolationVersion: 1,
      complete: !incomplete,
      passed: !failed && !incomplete && !sourceChanged && !controller.signal.aborted,
      resources: partition.resources,
      source,
      sourceAfter,
      files: results.map(({ report, ...result }) => ({
        ...result,
        counts: report.summary?.counts,
      })),
      coverage:
        'Node filesystem/network/SQLite probes; registered subprocess lifecycle; filtered guests and native commands retain their actual environment contracts and rely on fixture path ownership.',
    };
    await writeMergedReport(timings, merged, metadata);
    // Never let a partial, filtered or failed execution teach the next full run artificially short costs.
    if (metadata.passed && !explicit && !filtered) {
      try {
        await writeTestDurations(
          historyFile,
          Object.fromEntries(results.map((result) => [result.file, result.wallMs])),
        );
      } catch (error) {
        console.warn(`Could not save test duration history: ${error.message}`);
      }
    }
    process.exitCode = failed || incomplete || sourceChanged || controller.signal.aborted ? 1 : 0;
  } finally {
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
    if (ipcChild) {
      process.removeListener('message', abortMessage);
      process.removeListener('disconnect', cancel);
      if (process.connected) process.disconnect();
    }
  }
}
if (ipcChild && plan) {
  process.removeListener('message', abortMessage);
  process.removeListener('disconnect', cancel);
  if (process.connected) process.disconnect();
}
function git(args) {
  const result = spawnSync('git', args, { cwd: root, windowsHide: true, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : null;
}
