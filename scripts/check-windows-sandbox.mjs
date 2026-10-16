import { spawn } from 'node:child_process';
import { mkdir, writeFile, readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

export const WINDOWS_ACCEPTANCE_FILES = [
  'tests/sandbox-windows.test.ts',
  'tests/sandbox-windows-assets.test.ts',
  'tests/sandbox-windows-recovery.test.ts',
  'tests/restricted-consumers.test.ts',
  'tests/restricted-consumers-native.test.ts',
  'tests/native-sandbox-lifecycle.test.ts',
  'tests/native-background-cleanup.test.ts',
  'tests/windows-sandbox-host.test.ts',
];
export const WINDOWS_DESKTOP_ACCEPTANCE_FILES = ['tests/windows-sandbox-desktop.smoke.mjs'];

export function assertAcceptanceOutput(output, code) {
  const matches = [
    ...output.matchAll(
      /^Tests: (\d+) pass=(\d+) fail=(\d+) skip=(\d+) cancelled=(\d+) todo=(\d+) duration=([\d.]+)s\s*$/gm,
    ),
  ];
  const last = matches.at(-1);
  if (!last) throw new Error('Windows acceptance has no completed test summary');
  const [tests, passed, failed, skipped, cancelled, todo, seconds] = last.slice(1).map(Number);
  if (code !== 0 || tests < 1 || passed !== tests || failed || skipped || cancelled || todo)
    throw new Error(
      'Windows acceptance requires a nonempty passing run with no skips, cancellations or todo',
    );
  return { tests, passed, failed, skipped, cancelled, todo, seconds };
}

async function stateSnapshot(state) {
  const entries = await readdir(state).catch((error) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const journals = {};
  for (const name of entries.filter((name) => name.endsWith('.json')).sort())
    journals[name] = createHash('sha256')
      .update(await readFile(path.join(state, name)))
      .digest('hex');
  return { locks: entries.filter((name) => name.endsWith('.lock')).sort(), journals };
}

export function assertStateRestored(before, after) {
  if (after.locks.length || !isDeepStrictEqual(before.journals, after.journals))
    throw new Error(
      'Windows acceptance left changed sandbox state, leases or ACL journals; inspect without deleting other owners',
    );
}

export async function runWindowsAcceptance({ desktop = false } = {}) {
  if (process.platform !== 'win32')
    throw new Error('Windows acceptance requires a real Windows host');
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const state = path.join(os.userInfo().homedir, '.yuantu', 'sandbox-state', 'windows');
  const before = await stateSnapshot(state);
  if (before.locks.length)
    throw new Error(
      `Windows sandbox state has active or unreconciled locks: ${before.locks.join(', ')}`,
    );
  const directory = path.join(root, '.scratch/windows-sandbox-acceptance');
  await mkdir(directory, { recursive: true });
  const id = `${desktop ? 'desktop-' : ''}${Date.now()}-${process.pid}`;
  const files = desktop ? WINDOWS_DESKTOP_ACCEPTANCE_FILES : WINDOWS_ACCEPTANCE_FILES;
  let output = '';
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const startedAt = new Date().toISOString();
  const child = spawn(
    process.execPath,
    ['scripts/run-tests.mjs', '--test-timeout=180000', ...files],
    { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  child.stdout.on('data', (chunk) => {
    output += chunk;
    process.stdout.write(chunk);
  });
  child.stderr.on('data', (chunk) => {
    output += chunk;
    process.stderr.write(chunk);
  });
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (value) => resolve(value));
  });
  await writeFile(path.join(directory, `${id}.log`), output);
  const after = await stateSnapshot(state);
  const report = {
    startedAt,
    finishedAt: new Date().toISOString(),
    os: os.release(),
    node: process.versions.node,
    uv: process.versions.uv,
    platform: process.platform,
    suite: desktop ? 'desktop' : 'backend',
    executable: process.execPath,
    executableSha256: createHash('sha256')
      .update(await readFile(process.execPath))
      .digest('hex'),
    packagedApp: process.env.WINDOWS_SANDBOX_PACKAGED_APP ?? null,
    files,
    stateBefore: before,
    stateAfter: after,
    code,
    status: 'failed',
    limits: 'Windows basic backend: partial write boundary; reads and network unrestricted',
  };
  let failure;
  try {
    report.summary = assertAcceptanceOutput(output, code);
    assertStateRestored(before, after);
    report.status = 'passed';
  } catch (error) {
    failure = error;
    report.error = error.message;
  }
  const result = path.join(directory, `${id}.json`);
  await writeFile(result, JSON.stringify(report, null, 2));
  console.log(`Windows acceptance report: ${result}`);
  if (failure) throw failure;
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length > 1 || args.some((arg) => arg !== '--desktop'))
    throw Error('Use --desktop or no arguments');
  await runWindowsAcceptance({ desktop: args.includes('--desktop') });
}
