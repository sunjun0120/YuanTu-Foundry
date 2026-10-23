import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { manageWindowsAccounts } from './windows-account-ci.mjs';
import { assertAcceptanceOutput } from './check-windows-legacy-sandbox.mjs';
import { WINDOWS_ACCOUNT_JOURNEY_FILES } from './windows-sandbox-suites.mjs';

export { assertAcceptanceOutput };
export const WINDOWS_ACCEPTANCE_FILES = WINDOWS_ACCOUNT_JOURNEY_FILES;
export const WINDOWS_DESKTOP_ACCEPTANCE_FILES = ['tests/windows-sandbox-desktop.smoke.mjs'];

/** Accounts are initialized and removed by explicit workflow steps, even if this acceptance fails. */
export async function runWindowsAcceptance({ desktop = false } = {}) {
  await manageWindowsAccounts('check');
  const root = fileURLToPath(new URL('..', import.meta.url));
  const files = desktop ? WINDOWS_DESKTOP_ACCEPTANCE_FILES : WINDOWS_ACCEPTANCE_FILES;
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const directory = path.join(root, '.scratch/windows-account-acceptance');
  await mkdir(directory, { recursive: true });
  const id = `${desktop ? 'desktop-' : ''}${Date.now()}-${process.pid}`;
  let output = '';
  const startedAt = new Date().toISOString();
  const child = spawn(
    process.execPath,
    ['scripts/run-tests.mjs', '--continue-on-failure', '--test-timeout=180000', ...files],
    {
      cwd: root,
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  for (const [stream, target] of [
    [child.stdout, process.stdout],
    [child.stderr, process.stderr],
  ])
    stream.on('data', (chunk) => {
      output += chunk;
      target.write(chunk);
    });
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  await writeFile(path.join(directory, `${id}.log`), output);
  const report = {
    backend: 'windows-account',
    suite: desktop ? 'desktop' : 'backend',
    files,
    startedAt,
    finishedAt: new Date().toISOString(),
    code,
    status: 'failed',
  };
  let failure;
  try {
    report.summary = assertAcceptanceOutput(output, code);
    // A missing file summary cannot be excused by another file's successful summary.
    if ((output.match(/^Tests: /gm) ?? []).length !== files.length)
      throw new Error('Account acceptance requires a completed summary for every requested file');
    await manageWindowsAccounts('check');
    report.status = 'passed';
  } catch (error) {
    failure = error;
    report.error = error.message;
  }
  const result = path.join(directory, `${id}.json`);
  await writeFile(result, JSON.stringify(report, null, 2));
  console.log(`Windows account acceptance report: ${result}`);
  if (failure) throw failure;
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length > 1 || args.some((arg) => arg !== '--desktop'))
    throw new Error('Use --desktop or no arguments');
  await runWindowsAcceptance({ desktop: args.includes('--desktop') });
}
