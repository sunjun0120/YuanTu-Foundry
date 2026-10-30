import { appendFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

/**
 * Per-step timing of one Host's way down, for a test run that has to see where a slow shutdown spends its time.
 *
 * Off unless `FOUNDRY_TEST_SHUTDOWN_TRACE` names a file. Each step is appended as its own NDJSON line the moment it
 * finishes, rather than once at the end, because the shutdown being investigated is the one the client gives up on
 * and kills: the last line a killed Host left is the step before the one it was stuck in. The variable is a test
 * harness name (`FOUNDRY_TEST_*`), not a product setting, so test isolation passes it through to every worker.
 */
function shutdownTrace(): (step: string, detail?: Record<string, unknown>) => void {
  const file = process.env.FOUNDRY_TEST_SHUTDOWN_TRACE;
  if (!file) return () => {};
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
