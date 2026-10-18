import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, copyFile, cp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { createIsolation } from './test-isolation/environment.mjs';
import { readIsolationViolations, settleProcesses } from './test-isolation/processes.mjs';
import { readFileReport } from './test-report-merge.mjs';
import { acquireResourceLease } from './test-resource-lease.mjs';

/** Only call for a live retained ChildProcess or a PID whose creation identity was verified. */
async function terminateOwned(pid, child) {
  if (child && (child.exitCode !== null || child.signalCode !== null)) return;
  if (process.platform === 'win32') {
    await new Promise((resolve, reject) => {
      const killer = spawn('taskkill.exe', ['/pid', String(pid), '/t', '/f'], {
        windowsHide: true,
        stdio: 'ignore',
      });
      killer.once('error', reject);
      killer.once('close', () => resolve());
    });
  } else {
    // Harnesses have private process groups; a verified orphan only owns its own PID.
    try {
      process.kill(child ? -pid : pid, 'SIGKILL');
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  }
}

/**
 * How long a single test file may run before its process tree is ended.
 *
 * Without this, one test that never settles hangs the whole run: the worker keeps its stdio open forever, the
 * scheduler waits on `close`, and neither CI nor a developer ever gets a failing exit code — only a run that
 * never finishes. The bound is per file, not per case, because the hang observed in practice was after the last
 * case had been reported (a leaked handle or a teardown waiting on a child that will not exit), which no
 * `--test-timeout` reaches.
 */
export const DEFAULT_FILE_TIMEOUT_MS = 15 * 60 * 1000;

/** The watchdog's own grace period between ending the tree and giving up on its `close` event. */
const WATCHDOG_CLOSE_GRACE_MS = 15_000;

/** The last case the reporter wrote for a file, or undefined when it wrote none. */
async function lastReportedCase(timings) {
  try {
    const lines = (await readFile(timings, 'utf8')).trimEnd().split('\n');
    for (let index = lines.length - 1; index >= 0; index--) {
      const row = JSON.parse(lines[index]);
      if (row.kind === 'case' && typeof row.name === 'string') return row;
      if (row.kind === 'file-summary') return undefined;
    }
  } catch {
    /* No report yet: the file timed out before it settled anything. */
  }
  return undefined;
}

export async function runSchedule({
  root,
  directory,
  runId,
  phases,
  resources,
  options,
  signal,
  verbose = false,
  continueOnFailure = false,
  /** A number, or a function of the file, saying how long that file may run (see `DEFAULT_FILE_TIMEOUT_MS`). */
  fileTimeout = DEFAULT_FILE_TIMEOUT_MS,
}) {
  const parent = await mkdtemp(path.join(tmpdir(), 'yuantu-test-run-'));
  const results = [],
    phaseWall = {},
    processes = new Set(),
    cancellations = new Set();
  let failed = false,
    unsafe = false;
  const cancel = () => {
    failed = true;
    for (const child of processes) {
      const action = terminateOwned(child.pid, child).catch((error) =>
        console.error(`Cancellation cleanup failed: ${error.message}`),
      );
      cancellations.add(action);
    }
  };
  signal.addEventListener('abort', cancel);
  async function runFile(file, phase) {
    let isolation;
    const start = performance.now();
    const result = {
      file,
      phase,
      resources: resources[file],
      startedAt: Date.now(),
      isolationVersion: 1,
      report: { records: [] },
      violations: [],
      cleanup: { clean: false },
    };
    try {
      isolation = await createIsolation(parent, file, resources[file]);
      result.isolationRoot = isolation.root;
      if (process.env.FOUNDRY_TEST_COVERAGE_DIR) {
        isolation.env.NODE_V8_COVERAGE = path.join(isolation.root, 'coverage');
        await mkdir(isolation.env.NODE_V8_COVERAGE, { recursive: true });
      }
      const stem = `${runId}-${phase}-${path.basename(isolation.root)}`;
      result.log = path.join(directory, `${stem}.log`);
      const timings = path.join(directory, `${stem}.ndjson`);
      const reporter = pathToFileURL(path.join(root, 'scripts/test-reporter.mjs'));
      reporter.searchParams.set('log', result.log);
      reporter.searchParams.set('phase', phase);
      reporter.searchParams.set('timings', timings);
      console.log(`Log: ${result.log}`);
      const requested = typeof fileTimeout === 'function' ? fileTimeout(file) : fileTimeout;
      result.timeoutMs =
        Number.isFinite(requested) && requested > 0
          ? Math.round(requested)
          : DEFAULT_FILE_TIMEOUT_MS;
      result.exitCode = await new Promise((resolve) => {
        const child = spawn(
          process.execPath,
          [
            '--test',
            '--test-concurrency=1',
            /**
             * A file whose last case has reported still holds the process open when a test leaves a handle behind —
             * a Host whose teardown never ran because an earlier `t.after` hook threw, for instance. The isolation
             * probe already treats a surviving process as a failure, so exiting once the runner is done turns a
             * permanent hang into that recorded failure. Coverage collection keeps the normal exit: V8 writes its
             * profile from the exit path this skips.
             */
            ...(isolation.env.NODE_V8_COVERAGE ? [] : ['--test-force-exit']),
            `--test-reporter=${reporter.href}`,
            '--test-reporter-destination=stdout',
            ...options,
            path.resolve(root, file),
          ],
          {
            cwd: root,
            env: isolation.env,
            windowsHide: true,
            detached: process.platform !== 'win32',
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        );
        processes.add(child);
        child.stdout.on('data', (chunk) => process.stdout.write(chunk));
        child.stderr.on('data', (chunk) => process.stderr.write(chunk));
        child.once('error', (error) => {
          result.spawnError = error.message;
          console.error(error);
        });
        let settled = false,
          grace;
        const finish = (code) => {
          if (settled) return;
          settled = true;
          clearTimeout(watchdog);
          clearTimeout(grace);
          processes.delete(child);
          resolve(code ?? 1);
        };
        const watchdog = setTimeout(() => {
          result.timedOut = true;
          console.error(
            `Test file timed out after ${Math.round(result.timeoutMs / 1000)}s: ${file} — ending its process tree`,
          );
          void terminateOwned(child.pid, child).catch((error) =>
            console.error(`Watchdog termination failed for ${file}: ${error.message}`),
          );
          // The tree is being ended, so `close` should follow. An unkillable process must not re-create the hang
          // this watchdog exists to end.
          grace = setTimeout(() => {
            console.error(`Test file did not close after termination: ${file}`);
            finish(1);
          }, WATCHDOG_CLOSE_GRACE_MS);
        }, result.timeoutMs);
        // 'close' follows 'error' and waits for stdio; never delete its roots while still alive.
        child.once('close', (code) => finish(code));
        if (signal.aborted) cancel();
      });
      result.report = await readFileReport(timings, file, root);
      if (result.timedOut) {
        const last = await lastReportedCase(timings);
        const where = last
          ? `last reported case "${last.name}" (${Math.round(Number(last.durationMs) || 0)} ms)`
          : 'no case had reported a result';
        const message = `Test file timed out after ${Math.round(result.timeoutMs / 1000)}s: ${file} — ${where}; its process tree was ended`;
        console.error(message);
        result.report.problem = result.report.problem
          ? `${message} (${result.report.problem})`
          : message;
        result.exitCode = 1;
      }
      result.violations = readIsolationViolations(isolation);
      if (result.violations.length) {
        const evidence = result.violations.map((value) => JSON.stringify(value) + '\n').join('');
        await writeFile(path.join(directory, `${stem}-violations.ndjson`), evidence);
        console.error(`Isolation violations in ${file}:\n${evidence}`);
        result.exitCode = 1;
      }
      if (result.report.problem) {
        console.error(result.report.problem);
        result.exitCode = 1;
      }
      if (verbose) process.stdout.write(await readFile(result.log, 'utf8'));
    } catch (error) {
      console.error(`${file}: ${error.stack}`);
      result.exitCode = 1;
      result.report.problem = error.message;
    } finally {
      if (isolation) {
        try {
          const settled = await settleProcesses(isolation, {
            terminate: (pid) => terminateOwned(pid),
          });
          result.cleanup = {
            clean: settled.clean,
            remaining: settled.remaining,
            terminated: settled.terminated,
          };
          // Even a successfully cleaned leak fails; cleanup must never conceal a broken test.
          if (!settled.clean) {
            await writeFile(
              path.join(directory, `${runId}-${path.basename(isolation.root)}-processes.json`),
              JSON.stringify(settled, null, 2) + '\n',
            );
            console.error(`Process cleanup failed for ${file}: ${JSON.stringify(result.cleanup)}`);
            result.exitCode = 1;
          }
          if (settled.remaining.length) {
            // Preserve an unsafe-to-delete active process directory as diagnostic evidence.
            result.cleanup.directoryRetained = isolation.root;
          } else {
            const artifacts = isolation.env.FOUNDRY_TEST_ARTIFACTS;
            if ((await readdir(artifacts)).length) {
              result.artifacts = path.join(
                directory,
                `${runId}-${path.basename(isolation.root)}-artifacts`,
              );
              await cp(artifacts, result.artifacts, { recursive: true });
            }
            if (process.env.FOUNDRY_TEST_COVERAGE_DIR) {
              await mkdir(process.env.FOUNDRY_TEST_COVERAGE_DIR, { recursive: true });
              for (const name of await readdir(isolation.env.NODE_V8_COVERAGE)) {
                if (/^coverage-.*\.json$/.test(name))
                  await copyFile(
                    path.join(isolation.env.NODE_V8_COVERAGE, name),
                    path.join(process.env.FOUNDRY_TEST_COVERAGE_DIR, name),
                    constants.COPYFILE_EXCL,
                  );
              }
            }
            await rm(isolation.root, {
              recursive: true,
              force: true,
              maxRetries: 10,
              retryDelay: 100,
            });
          }
        } catch (error) {
          console.error(`Private resource cleanup failed for ${file}: ${error.message}`);
          result.cleanup = {
            clean: false,
            directoryRetained: isolation.root,
            error: error.message,
          };
          result.exitCode = 1;
        }
      }
      result.wallMs = Number((performance.now() - start).toFixed(1));
      result.finishedAt = Date.now();
      results.push(result);
      if (result.exitCode) failed = true;
      if (!result.cleanup.clean) unsafe = true;
    }
  }
  try {
    for (const spec of phases) {
      if (!spec.files.length || unsafe || (failed && !continueOnFailure) || signal.aborted)
        continue;
      const started = performance.now();
      console.log(
        `Phase ${spec.phase}: ${spec.files.length} file(s), concurrency=${spec.concurrency}`,
      );
      const declarations = [...new Set(spec.files.flatMap((file) => resources[file]))];
      const release = await acquireResourceLease(
        process.env.FOUNDRY_TEST_MACHINE_LOCK_ROOT ??
          path.join(tmpdir(), 'yuantu-test-resource-locks'),
        declarations,
        { signal },
      );
      let next = 0;
      try {
        await Promise.all(
          Array.from({ length: Math.min(spec.concurrency, spec.files.length) }, async () => {
            while (
              next < spec.files.length &&
              !unsafe &&
              (!failed || continueOnFailure) &&
              !signal.aborted
            )
              await runFile(spec.files[next++], spec.phase);
          }),
        );
      } finally {
        release();
      }
      phaseWall[spec.phase] = Number((performance.now() - started).toFixed(1));
    }
  } finally {
    signal.removeEventListener('abort', cancel);
    await Promise.allSettled([...cancellations]);
    if (!results.some((result) => result.cleanup.directoryRetained))
      await rm(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
  return { results, phaseWall, failed: failed || signal.aborted };
}
