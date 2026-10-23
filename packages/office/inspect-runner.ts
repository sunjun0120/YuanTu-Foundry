import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import type { OfficeFormat } from './automation.ts';
import { workerExecArgv } from '../tools/environment.ts';

export { MAX_OFFICE_BYTES } from './inspect.ts';

/**
 * The wall clock and heap one inspection may use.
 *
 * A 20 MB package that inflates to the 48 MB the inspect path admits takes SheetJS a few seconds and a few hundred
 * megabytes at worst; these are walls for a parser that has gone wrong on a hostile file, not budgets for real
 * work, so they are generous. Past either, the worker is stopped and the call fails — the Host is not involved.
 */
export const INSPECT_TIMEOUT_MS = 30_000;
const INSPECT_HEAP_MB = 512;

/**
 * Where the worker entry is, for each way this module runs.
 *
 * Bundled into the Host (`scripts/build-host-bundle.mjs`), `import.meta.url` is the bundle in `dist/packages/tools/`,
 * and the build writes the worker beside it as its own bundle. Unbundled, the worker is this module's sibling —
 * `.ts` from source, `.js` from the tsc output.
 */
function workerEntry(): URL {
  const bundled = new URL('./office-inspect-worker.js', import.meta.url);
  if (existsSync(fileURLToPath(bundled))) return bundled;
  return new URL(
    import.meta.url.endsWith('.ts') ? './inspect-worker.ts' : './inspect-worker.js',
    import.meta.url,
  );
}

/**
 * Inspect an Office file in a worker thread.
 *
 * `office_inspect` needs no approval and reads whatever the workspace holds, so a hostile document reaches mammoth
 * or SheetJS as easily as a model can name it. Parsed on the Host's event loop, one such file stalled every
 * session's streaming and approvals, or took the process down with it; in a worker it is bounded in time and heap,
 * cancelled with the call, and a crash is this call's failure.
 */
export function inspectInWorker(
  file: string,
  format: OfficeFormat,
  signal: AbortSignal,
  options: { timeoutMs?: number } = {},
): Promise<string> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerEntry(), {
      execArgv: workerExecArgv(),
      workerData: { file, format },
      resourceLimits: { maxOldGenerationSizeMb: INSPECT_HEAP_MB },
    });
    let settled = false;
    const finish = (error: unknown, content?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      void worker.terminate();
      if (error) reject(error);
      else resolve(content!);
    };
    const abort = () => finish(signal.reason ?? new Error('Office inspection cancelled'));
    const timer = setTimeout(
      () => finish(new Error('Office inspection timed out')),
      options.timeoutMs ?? INSPECT_TIMEOUT_MS,
    );
    signal.addEventListener('abort', abort, { once: true });
    worker.once('message', (reply: { ok: boolean; content?: string; error?: string }) =>
      reply.ok
        ? finish(undefined, reply.content ?? '')
        : finish(new Error(reply.error ?? 'Office inspection failed')),
    );
    worker.once('error', (error) =>
      finish(
        (error as NodeJS.ErrnoException).code === 'ERR_WORKER_OUT_OF_MEMORY'
          ? new Error('Office inspection ran out of memory')
          : error,
      ),
    );
    worker.once('exit', (code) => {
      if (!settled) finish(new Error(`Office inspection worker exited with code ${code}`));
    });
  });
}
