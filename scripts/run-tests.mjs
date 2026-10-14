/**
 * The entry point the suite is run through.
 *
 * Two invariants shape everything here. First, the default is unchanged: every discovered
 * `tests/*.test.ts` file, one harness, concurrency 1, the same quiet summary and the same spec log,
 * and the child's exit status is the runner's exit status. Second, a phase boundary may never hide
 * a failure: the phases do not overlap, a failure in the first one stops the second from starting,
 * and a missing or truncated report is a failed run rather than a successful one with less output.
 *
 * Use `node scripts/run-tests.mjs [--concurrency=N] [--test-name-pattern=...] [files...]` exactly
 * as before. The additions are `--timings=<path>`, `--schedule=partitioned`,
 * `--parallel-concurrency=N` and `--plan`; see scripts/test-execution-policy.ts for the schedule.
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { discoverTests, loadPolicy, partitionTests } from './test-execution-policy.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const startedAt = new Date().toISOString();
const wallStart = performance.now();
const args = process.argv.slice(2);
const options = [];
const files = [];
let concurrency = 1;
let schedule = 'serial';
let parallelConcurrency = 2;
let plan = false;
let timings;

for (const arg of args) {
  if (arg.startsWith('--concurrency=')) {
    concurrency = Number(arg.slice('--concurrency='.length));
    if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
      throw new Error('--concurrency must be a positive integer');
    }
  } else if (arg === '--schedule=serial' || arg === '--schedule=partitioned') {
    schedule = arg.slice('--schedule='.length);
  } else if (arg.startsWith('--schedule=')) {
    throw new Error(`Unsupported schedule: ${arg.slice('--schedule='.length)}`);
  } else if (arg.startsWith('--parallel-concurrency=')) {
    parallelConcurrency = Number(arg.slice('--parallel-concurrency='.length));
    if (!Number.isSafeInteger(parallelConcurrency) || parallelConcurrency < 1) {
      throw new Error('--parallel-concurrency must be a positive integer');
    }
  } else if (arg.startsWith('--timings=')) {
    timings = arg.slice('--timings='.length);
    if (!timings.trim()) throw new Error('--timings requires a path');
  } else if (arg === '--plan') {
    plan = true;
  } else if (/^--test-(?:name-pattern|skip-pattern|timeout)=/.test(arg)) {
    options.push(arg);
  } else if (arg.startsWith('-')) {
    throw new Error(`Unsupported test option: ${arg}`);
  } else {
    files.push(arg);
  }
}

// `--plan` prints the discovered set and the schedule for it. It must not create a log directory or
// start a harness, so that a preview can never be mistaken for a run.
if (plan && schedule !== 'partitioned')
  throw new Error('--plan is only meaningful with --schedule=partitioned');
if (schedule === 'partitioned' && args.some((arg) => arg.startsWith('--concurrency=')))
  throw new Error(
    '--concurrency applies to the serial phases; use --parallel-concurrency with --schedule=partitioned',
  );

const explicit = files.length > 0;
const discovered = explicit
  ? files.map((file) => {
      const relative = path.relative(root, path.resolve(root, file));
      return relative !== '..' &&
        !relative.startsWith(`..${path.sep}`) &&
        !path.isAbsolute(relative)
        ? relative.replaceAll('\\', '/')
        : file;
    })
  : await discoverTests(root);
// A preview of an explicit file list is a preview of that list, not of the whole suite.
// The serial baseline must remain usable even if an experimental policy is invalid or stale.
const partition =
  schedule === 'partitioned'
    ? await partitionTests(discovered, {
        root,
        policy: await loadPolicy(root, discovered, { tolerateUnknown: explicit }),
        strictFiles: !explicit,
      })
    : { parallel: [], serial: discovered, reasons: {} };
const filtered = options.some((option) => /^--test-(?:name|skip)-pattern=/.test(option));

if (plan) {
  console.log(`Discovered ${discovered.length} test file(s)`);
  for (const file of partition.parallel)
    console.log(`parallel  ${file}  (${partition.reasons[file]})`);
  for (const file of partition.serial)
    console.log(`serial    ${file}  (${partition.reasons[file]})`);
  console.log(
    `Plan: parallel=${partition.parallel.length} serial=${partition.serial.length} total=${discovered.length} parallel-concurrency=${parallelConcurrency}`,
  );
  process.exit(0);
}

const directory = path.join(root, '.scratch/test-logs');
await mkdir(directory, { recursive: true });
const runId = `${Date.now()}-${process.pid}-${randomUUID()}`;
const logPath = (phase) => path.join(directory, `${runId}-${phase}.log`);
const preparationWallMs = Number((performance.now() - wallStart).toFixed(1));

if (schedule === 'serial') {
  console.log(`Running ${discovered.length} test file(s), concurrency=${concurrency}`);
  const result = await runPhase({
    phase: 'serial',
    files: discovered,
    // `--concurrency` is the harness's file width and keeps its original meaning for every serial
    // invocation, including the default full run (whose default is 1).
    concurrency,
    log: logPath('serial'),
    // A report is always produced, because it is how the phase proves it ran and how the totals are
    // obtained. It is only *merged to the caller's path* when --timings asked for one.
    timings: path.join(directory, `${runId}-serial-timings.ndjson`),
  });
  const verified = await verifyPhases([result]);
  await mergeTimings(
    verified,
    timings,
    { serial: result.wallMs },
    Number((performance.now() - wallStart).toFixed(1)),
  );
  printTotals([result], verified.totals);
  if (verified.problem) console.error(verified.problem);
  process.exitCode = result.exitCode || (verified.problem ? 1 : 0);
} else {
  console.log(
    `Running ${discovered.length} test file(s) in two phases, parallel-concurrency=${parallelConcurrency}`,
  );
  console.log(`Run id: ${runId}`);
  const results = [];
  const phases = [
    { phase: 'parallel', files: partition.parallel, concurrency: parallelConcurrency },
    { phase: 'serial', files: partition.serial, concurrency: 1 },
  ];
  for (const spec of phases) {
    // An empty phase is not started at all: an empty harness writes a report that says nothing and
    // costs a process.
    if (!spec.files.length) continue;
    const result = await runPhase({
      ...spec,
      log: logPath(spec.phase),
      timings: path.join(directory, `${runId}-${spec.phase}-timings.ndjson`),
    });
    results.push({ ...spec, ...result });
    if (result.exitCode !== 0) {
      console.error(`Phase ${spec.phase} failed with exit code ${result.exitCode}; stopping.`);
      break;
    }
  }
  const phaseWall = Object.fromEntries(results.map((r) => [r.phase, r.wallMs]));
  const verified = await verifyPhases(results);
  await mergeTimings(
    verified,
    timings,
    phaseWall,
    Number((performance.now() - wallStart).toFixed(1)),
  );
  printTotals(results, verified.totals);
  if (verified.problem) console.error(verified.problem);
  const failed = results.some((r) => r.exitCode !== 0);
  process.exitCode = failed ? 1 : verified.problem ? 1 : 0;
}

/** Run one harness over one phase and wait for its log and report to be complete. */
async function runPhase({ phase, files, concurrency, log, timings: timingsPath }) {
  // A runner invoked by a regression test must start a fresh test harness. Nothing about *this*
  // runner's own bookkeeping is added to it: the tests under measurement start the Host, the CLI and
  // the sandbox as children that inherit the environment, and the Host refuses settings it does not
  // know — its environment check would reject the run before those children ever started. The
  // reporter's configuration therefore travels in its module URL, which reaches nothing else.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  if (timingsPath) await rm(timingsPath, { force: true });
  const reporter = pathToFileURL(path.join(root, 'scripts/test-reporter.mjs'));
  reporter.searchParams.set('log', log);
  reporter.searchParams.set('phase', phase);
  if (timingsPath) reporter.searchParams.set('timings', timingsPath);
  const reporters = [`--test-reporter=${reporter.href}`, '--test-reporter-destination=stdout'];
  console.log(`Phase ${phase}: ${files.length} file(s), concurrency=${concurrency}`);
  console.log(`Log: ${log}`);
  const start = performance.now();
  const code = await new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ['--test', `--test-concurrency=${concurrency}`, ...reporters, ...options, ...files],
      { cwd: root, stdio: 'inherit', windowsHide: true, env },
    );
    child.on('error', (error) => {
      console.error(error);
      resolve(1);
    });
    child.on('exit', (exitCode, signal) => resolve(exitCode ?? (signal ? 1 : 0)));
  });
  return {
    phase,
    exitCode: code,
    wallMs: Number((performance.now() - start).toFixed(1)),
    log,
    timingsPath,
  };
}

/**
 * Read every phase report and require each one to be complete. A phase that produced no report is a
 * phase that cannot be shown to have run, which is a failed run rather than a successful one with
 * less output.
 */
async function verifyPhases(results) {
  const records = [];
  const totals = [];
  let problem = null;
  for (const result of results) {
    const report = await readReport(result.timingsPath);
    if (!report) {
      problem = `Phase ${result.phase} wrote no complete timings report at ${result.timingsPath}`;
      break;
    }
    records.push(...report.records);
    totals.push(report.summary);
  }
  return { problem, records, totals };
}

/**
 * Merge the verified per-phase reports into the path the caller asked for, together with the run
 * metadata. Nothing is written when no `--timings` path was given: a run that did not ask for a
 * report does not leave one behind.
 */
async function mergeTimings(verified, target, phaseWall, wallMs) {
  if (verified.problem || !target) return;
  const targetPath = path.resolve(target);
  await mkdir(path.dirname(targetPath), { recursive: true });
  await writeFile(
    targetPath,
    verified.records.map((record) => `${JSON.stringify(record)}\n`).join(''),
  );
  await writeRunMetadata(targetPath, { phaseWall, totals: verified.totals, wallMs });
}

/** Read one NDJSON report, requiring the terminal record that says the writer finished. */
async function readReport(file) {
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    return null;
  }
  const records = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      return null;
    }
  }
  if (!records.some((record) => record.kind === 'phase-summary')) return null;
  if (!records.some((record) => record.kind === 'run-summary')) return null;
  return {
    records,
    summary: records.find((record) => record.kind === 'run-summary'),
  };
}

/**
 * The run's own account of itself: the command, the runtime, the revision, the schedule actually
 * used, and the phase/whole-run wall clock. Wall clock is read from a monotonic clock, because the
 * sum of case durations is not the time the run took.
 */
async function writeRunMetadata(targetPath, extra) {
  const metadata = {
    schemaVersion: 1,
    command: process.argv.slice(1),
    node: process.version,
    head: git(['rev-parse', 'HEAD']),
    dirtyFiles: git(['status', '--porcelain=v1'])?.split('\n').filter(Boolean).length ?? null,
    schedule,
    parallelConcurrency: schedule === 'partitioned' ? parallelConcurrency : null,
    filtered,
    explicit,
    discovered: discovered.length,
    parallel: partition.parallel.length,
    serial: partition.serial.length,
    startedAt,
    preparationWallMs,
    ...extra,
  };
  await writeFile(`${targetPath}.meta.json`, `${JSON.stringify(metadata, null, 2)}\n`);
}

function git(gitArgs) {
  const result = spawnSync('git', gitArgs, { cwd: root, windowsHide: true, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : null;
}

function printTotals(results, summaries) {
  for (const result of results) {
    const summary = summaries.find((total) => total?.phase === result.phase);
    const counts = summary?.counts ?? {};
    console.log(
      `Total: ${result.phase} tests=${counts.tests ?? '?'} pass=${counts.passed ?? '?'} fail=${
        counts.failed ?? '?'
      } skip=${counts.skipped ?? '?'} cancelled=${counts.cancelled ?? '?'} todo=${
        counts.todo ?? '?'
      } duration=${((summary?.durationMs ?? 0) / 1000).toFixed(2)}s wall=${(
        result.wallMs / 1000
      ).toFixed(2)}s`,
    );
  }
}
