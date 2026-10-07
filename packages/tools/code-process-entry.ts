/** Ordinary Node broker; guest code never runs in the Agent Host process. */
import { Worker } from 'node:worker_threads';
import { guestResourceLimits } from './environment.ts';
import type { CodeWorkerData } from './code-worker.ts';
let worker: Worker | undefined;
let buffer = '';
const send = (value: unknown) => {
  const frame = JSON.stringify(value) + '\n';
  if (Buffer.byteLength(frame) > 1048576) process.exit(70);
  process.stdout.write(frame);
};
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => {
  buffer += chunk;
  if (Buffer.byteLength(buffer) > 1048576) process.exit(70);
  for (;;) {
    const end = buffer.indexOf('\n');
    if (end < 0) break;
    const frame = buffer.slice(0, end);
    buffer = buffer.slice(end + 1);
    try {
      const message = JSON.parse(frame);
      if (message.type === 'start' && !worker) {
        worker = new Worker(
          new URL(
            import.meta.url.endsWith('.ts') ? './code-worker.ts' : './code-worker.js',
            import.meta.url,
          ),
          {
            workerData: message.data as CodeWorkerData,
            // Permissions are explicitly passed: Node 24 workers do not inherit the permission policy.
            execArgv: process.execArgv,
            resourceLimits: guestResourceLimits(),
          },
        );
        worker.on('message', send);
        worker.on('error', (error) => {
          process.stderr.write(error.message);
          process.exitCode = 1;
          process.stdin.destroy();
        });
        worker.on('exit', (code) => {
          if (code) {
            process.exitCode = code;
            process.stdin.destroy();
          }
        });
      } else if (message.type === 'call-result' && worker) worker.postMessage(message);
      else process.exit(70);
    } catch {
      process.exit(70);
    }
  }
});
process.stdin.on('end', () => {
  void worker?.terminate();
});
