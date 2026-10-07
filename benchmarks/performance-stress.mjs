import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { runStressCase } from './performance-stress.ts';

const args = process.argv.slice(2);
if (args.some((arg) => !/^--(?:duration-ms=\d+|concurrency=\d+|interval-ms=\d+|out=.+)$/.test(arg)))
  throw new Error('Unsupported stress option');
const value = (name, fallback) =>
  Number(args.find((arg) => arg.startsWith(`--${name}=`))?.split('=')[1] ?? fallback);
const directory = path.resolve(
  args.find((arg) => arg.startsWith('--out='))?.slice(6) ?? `.scratch/stress-${Date.now()}`,
);
await mkdir(directory, { recursive: true });
await writeFile(
  path.join(directory, 'run.json'),
  JSON.stringify({
    durationMs: value('duration-ms', 60000),
    concurrency: value('concurrency', 4),
    at: new Date().toISOString(),
  }) + '\n',
  { flag: 'wx' },
);
let lastProgress = -60000;
const result = await runStressCase({
  durationMs: value('duration-ms', 60000),
  concurrency: value('concurrency', 4),
  intervalMs: value('interval-ms', 5000),
  onProgress(row) {
    if (row.elapsedMs - lastProgress < 60000) return;
    lastProgress = row.elapsedMs;
    console.log(JSON.stringify(row));
  },
});
await writeFile(path.join(directory, 'analysis.json'), JSON.stringify(result, null, 2) + '\n');
console.log(
  JSON.stringify({
    checksPassed: result.checksPassed,
    actualDurationMs: result.actualDurationMs,
    hourVerified: result.hourVerified,
    runs: result.samples.length,
    p50: result.p50,
    p95: result.p95,
    databaseBytes: result.databaseBytes,
    sessionsReleased: result.sessionsReleased,
  }),
);
if (!result.checksPassed) process.exitCode = 1;
