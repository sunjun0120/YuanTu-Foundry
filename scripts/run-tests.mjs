import { spawn } from 'node:child_process';
import { mkdir, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const options = [];
const files = [];
let concurrency = 1;
for (const arg of args) {
  if (arg.startsWith('--concurrency=')) {
    concurrency = Number(arg.slice('--concurrency='.length));
    if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
      throw new Error('--concurrency must be a positive integer');
    }
  } else if (/^--test-(?:name-pattern|skip-pattern|timeout)=/.test(arg)) {
    options.push(arg);
  } else if (arg.startsWith('-')) {
    throw new Error(`Unsupported test option: ${arg}`);
  } else {
    files.push(arg);
  }
}
if (!files.length) {
  files.push(
    ...(await readdir(path.join(root, 'tests')))
      .filter((name) => name.endsWith('.test.ts'))
      .sort()
      .map((name) => `tests/${name}`),
  );
}
const directory = path.join(root, '.scratch/test-logs');
await mkdir(directory, { recursive: true });
const log = path.join(directory, `${Date.now()}-${process.pid}-${randomUUID()}.log`);
console.log(`Running ${files.length} test file(s), concurrency=${concurrency}`);
console.log(`Log: ${log}`);
// A runner invoked by a regression test must start a fresh test harness.
const env = { ...process.env };
delete env.NODE_TEST_CONTEXT;
const child = spawn(
  process.execPath,
  [
    '--test',
    `--test-concurrency=${concurrency}`,
    `--test-reporter=${pathToFileURL(path.join(root, 'scripts/test-summary.mjs')).href}`,
    '--test-reporter-destination=stdout',
    '--test-reporter=spec',
    `--test-reporter-destination=${log}`,
    ...options,
    ...files,
  ],
  { cwd: root, stdio: 'inherit', windowsHide: true, env },
);
child.on('error', (error) => {
  console.error(error);
  process.exitCode = 1;
});
child.on('exit', (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
});
