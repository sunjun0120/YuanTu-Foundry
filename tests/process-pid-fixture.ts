import { readFile } from 'node:fs/promises';
import path from 'node:path';

/** The foreground run must remain alive until its own PID marker is observed. */
export async function commandPid(
  file: string,
  what: string,
  options: {
    finished?: Promise<{ status: string; error?: string }>;
    signal?: AbortSignal;
  } = {},
): Promise<number> {
  let terminal: Error | undefined;
  // Observe rejection immediately. A refused command cannot produce a PID later, and hiding its
  // failure behind a polling timeout makes both diagnosis and failed full checks unnecessarily slow.
  void options.finished?.then(
    (result) => {
      terminal = new Error(
        `${what} ended before readiness (${result.status}): ${result.error ?? 'no process readiness marker'}`,
      );
    },
    (error) => {
      terminal = error instanceof Error ? error : new Error(String(error));
    },
  );
  for (let attempt = 0; attempt < 150; attempt++) {
    options.signal?.throwIfAborted();
    if (terminal) throw terminal;
    try {
      const pid = Number(await readFile(file, 'utf8'));
      if (pid > 0) return pid;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${what} did not write ${path.basename(file)} within 15s`);
}
