import { spawn } from 'node:child_process';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { finished } from 'node:stream/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { selectTests, getChangedFiles, requiresDesktop } from './select-tests.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
let base = 'HEAD';
let preview = false;
let explicit;
for (let index = 0; index < args.length; index++) {
  const arg = args[index];
  if (arg === '--plan') preview = true;
  else if (arg === '--base' && args[index + 1]) base = args[++index];
  else if (arg === '--files') {
    explicit = args.slice(index + 1);
    break;
  } else throw new Error(`Unsupported option: ${arg}`);
}
if (explicit && !preview)
  throw new Error('--files is only allowed with --plan; real checks include every Git change');

const changed = explicit ?? (await getChangedFiles(root, base));
const selection = await selectTests(root, changed);
console.log(
  `Changed files: ${changed.length}; selected tests: ${selection.tests.length}; full=${selection.full}`,
);
console.log(`Reason: ${selection.reason}`);
if (preview) {
  console.log(JSON.stringify({ changed, ...selection }, null, 2));
} else if (!changed.length) {
  console.log(
    'No checks needed for an unchanged working tree. Use check:full for milestone validation.',
  );
} else {
  const directory = path.join(root, '.scratch/check-logs', `${Date.now()}-${process.pid}`);
  await mkdir(directory, { recursive: true });
  const npm =
    process.env.npm_execpath ??
    path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
  let step = 0;
  async function run(name, argv) {
    const log = path.join(directory, `${++step}-${name}.log`);
    const output = createWriteStream(log);
    const started = performance.now();
    console.log(`RUN ${name} Log: ${log}`);
    const child = spawn(process.execPath, argv, {
      cwd: root,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.pipe(output, { end: false });
    child.stderr.pipe(output, { end: false });
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (exitCode) => resolve(exitCode ?? 1));
    }).finally(() => output.end());
    await finished(output);
    console.log(
      `${code === 0 ? 'PASS' : 'FAIL'} ${name} (${((performance.now() - started) / 1000).toFixed(2)}s) Log: ${log}`,
    );
    if (code === 0) {
      const result = await readFile(log, 'utf8');
      console.log(
        result
          .split('\n')
          .filter((line) => /^(Tests:|SKIP |Log:)/.test(line))
          .join('\n'),
      );
    }
    if (code !== 0) {
      console.error((await readFile(log, 'utf8')).slice(-8000));
      throw new Error(`${name} failed (exit ${code}); see ${log}`);
    }
  }
  try {
    if (selection.full) {
      await run('check-full', [npm, 'run', 'check']);
      // The standard CI aggregate excludes Electron; desktop edits also need its real UI gate.
      if (requiresDesktop(changed)) {
        await run('smoke-desktop', [npm, 'run', 'smoke:desktop']);
      }
    } else {
      const existing = [];
      for (const file of changed)
        if ((await stat(path.join(root, file)).catch(() => undefined))?.isFile())
          existing.push(file);
      if (existing.length)
        await run('format', [
          'node_modules/prettier/bin/prettier.cjs',
          '--check',
          '--log-level',
          'warn',
          '--',
          ...existing,
        ]);
      for (const name of ['docs:check', 'references:check', 'i18n:check'])
        await run(name.replace(':', '-'), [npm, 'run', name]);
      if (selection.tests.length) {
        await run('typecheck', [npm, 'run', 'typecheck']);
        await run('test', ['scripts/run-tests.mjs', ...selection.tests]);
      }
    }
    console.log('Development checks passed. Full CI/release validation remains a separate gate.');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
