import { spawn } from 'node:child_process';
import { access, writeFile } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

export function riskWorker(
  kind: string,
  file: string,
  root: string,
  document: string,
  barrier: string,
) {
  const child = spawn(
    process.execPath,
    [
      fileURLToPath(new URL('./risk-concurrency-worker.ts', import.meta.url)),
      kind,
      file,
      root,
      document,
      barrier,
    ],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let output = '';
  let errors = '';
  child.stdout.on('data', (chunk) => {
    output += chunk;
  });
  child.stderr.on('data', (chunk) => {
    errors += chunk;
  });
  const result = new Promise<{ ok: boolean; error?: string }>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', () => {
      try {
        resolve(JSON.parse(output.trim()) as { ok: boolean; error?: string });
      } catch {
        reject(new Error(`Worker returned no result: ${errors}`));
      }
    });
  });
  // Observe failures while the parent is waiting for the synchronous constructor barrier.
  void result.catch(() => {});
  const waitForMarker = async (suffix: string) => {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      try {
        await access(barrier + suffix);
        return;
      } catch {
        /* not at the barrier yet */
      }
      if (child.exitCode !== null)
        throw new Error(`Worker exited before barrier: ${output} ${errors}`);
      await setTimeout(10);
    }
    throw new Error('Worker did not reach concurrency barrier');
  };
  return {
    result,
    ready: () => waitForMarker('.ready'),
    migrating: () => waitForMarker('.migrating'),
    commit: () => writeFile(barrier + '.commit', 'commit'),
    release: () => writeFile(barrier + '.release', 'release'),
    stop: async () => {
      if (child.exitCode === null) child.kill();
      await Promise.allSettled([result]);
    },
  };
}
