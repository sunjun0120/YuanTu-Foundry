/** Ordinary Node broker; guest code never runs in the Agent Host process. */
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { guestResourceLimits, PROGRAM_PROTOCOL } from '../platform/child-environment.ts';
import type { CodeWorkerData } from './code-worker.ts';
/**
 * Leave the workspace before any worker exists.
 *
 * Under `--permission`, Node grants every Environment implicit read access to its entrypoint (`argv[1]`). A worker
 * has no entrypoint argument, so that grant is an empty path, which resolves to the process's working directory —
 * recursively. The host starts this runner *in the workspace*, so a guest worker could read every workspace file,
 * `.env` included, past the file tools' credential exclusions. Moving to the runner's own directory (the one
 * directory the host grants for reading) turns that implicit grant into one the runner already has.
 */
// Where the host launched this runner — the workspace identity it chose — kept as evidence after the move below.
process.env.YUANTU_PROGRAM_LAUNCH_DIR = process.cwd();
process.chdir(fileURLToPath(new URL('.', import.meta.url)));
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
// Host must validate this before sending any guest source or tool data.
send({
  type: 'ready',
  protocol: PROGRAM_PROTOCOL,
  nodeMajor: Number(process.versions.node.split('.')[0]),
});
