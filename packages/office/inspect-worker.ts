import { parentPort, workerData } from 'node:worker_threads';
import { inspectOffice } from './inspect.ts';

/** One inspection per worker: the runner starts it with the file and ends it when the answer is back. */
const { file, format } = workerData as {
  file: string;
  format: Parameters<typeof inspectOffice>[1];
};
inspectOffice(file, format).then(
  (content) => parentPort?.postMessage({ ok: true, content }),
  (error: unknown) =>
    parentPort?.postMessage({
      ok: false,
      error: error instanceof Error ? error.message : 'Office inspection failed',
    }),
);
