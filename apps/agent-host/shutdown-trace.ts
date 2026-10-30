import { appendFileSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

/**
 * Per-step timing of one Host's way down, for a test run that has to see where a slow shutdown spends its time.
 *
 * Off unless `FOUNDRY_TEST_SHUTDOWN_TRACE=1` and the Host runs under a test worker. Each step is appended as its
 * own NDJSON line the moment it finishes, rather than once at the end, because the shutdown being investigated is
 * the one the client gives up on and kills: the last line a killed Host left is the step before the one it was
 * stuck in. The file goes into the worker's own artifact directory, the one place test isolation lets it write;
 * the runner copies that directory into `.scratch/test-logs` when the worker ends.
 */
function shutdownTrace(): (step: string, detail?: Record<string, unknown>) => void {
  const artifacts = process.env.FOUNDRY_TEST_ARTIFACTS;
  if (process.env.FOUNDRY_TEST_SHUTDOWN_TRACE !== '1' || !artifacts) return () => {};
  const file = path.join(artifacts, 'host-shutdown.ndjson');
  let started: number | undefined;
  let last = 0;
  return (step, detail) => {
    const now = performance.now();
    started ??= now;
    const line = {
      pid: process.pid,
      time: new Date().toISOString(),
      step,
      atMs: Math.round(now - started),
      stepMs: Math.round(now - (last || now)),
      ...detail,
    };
    last = now;
    try {
      appendFileSync(file, JSON.stringify(line) + '\n');
    } catch {
      // A diagnostic must never be the reason a shutdown fails.
    }
  };
}

/** One trace per process: the read loop, the release steps and the process exit all mark the same timeline. */
export const markShutdown = shutdownTrace();
