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

/**
 * The last line: the JavaScript `exit` event, and what Node still has to tear down after it.
 *
 * On Windows CI a Host has been seen to reach this event and then stay alive for more than ten seconds with no
 * child and no crash reporter, so the time goes into the native teardown that follows: closing every libuv
 * handle (unreferenced ones included, which `getActiveResourcesInfo` does not list), joining worker threads and
 * unloading native addons. The diagnostic report names all three; only its compact summary is kept.
 */
export function markExit(code: number): void {
  if (process.env.FOUNDRY_TEST_SHUTDOWN_TRACE !== '1' || !process.env.FOUNDRY_TEST_ARTIFACTS)
    return;
  let teardown: Record<string, unknown> = {};
  try {
    const report = process.report.getReport() as unknown as {
      libuv?: {
        type: string;
        is_active?: boolean;
        is_referenced?: boolean;
        [key: string]: unknown;
      }[];
      sharedObjects?: string[];
      workers?: unknown[];
    };
    teardown = {
      handles: (report.libuv ?? [])
        .filter((handle) => handle.type !== 'loop')
        .map(({ type, is_active, is_referenced, ...rest }) => ({
          type,
          active: is_active,
          referenced: is_referenced,
          ...rest,
        })),
      addons: (report.sharedObjects ?? []).filter((file) => file.endsWith('.node')),
      workers: report.workers?.length ?? 0,
    };
  } catch (error) {
    teardown = { reportError: String(error) };
  }
  markShutdown('exit', { code, ...teardown });
}
