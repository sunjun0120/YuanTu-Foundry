import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
export const accountHelper = path.join(root, 'packages/sandbox/windows-sandbox/yuantu-sandbox.exe');
// Source-mode PTC reads these modules; the helper is copied out of Cargo's hard-linked target tree.
const sourceAssets = [
  accountHelper,
  path.join(root, 'packages/tools/code-process-entry.ts'),
  path.join(root, 'packages/tools/code-worker.ts'),
  path.join(root, 'packages/platform/child-environment.ts'),
];

export function accountAcceptanceSkip(platform = process.platform, env = process.env) {
  if (platform !== 'win32') return 'needs Windows sandbox accounts';
  if (
    env.GITHUB_ACTIONS !== 'true' ||
    env.RUNNER_ENVIRONMENT !== 'github-hosted' ||
    env.FOUNDRY_TEST_WINDOWS_ACCOUNT_JOURNEYS !== '1'
  )
    return 'real account journeys require an explicitly enabled disposable GitHub Actions runner';
  return false;
}

/** Only the workflow owns account maintenance; tests consume an already initialized backend. */
export async function manageWindowsAccounts(
  action,
  { platform = process.platform, env = process.env, run = promisify(execFile) } = {},
) {
  const reason = accountAcceptanceSkip(platform, env);
  if (reason) throw new Error(reason);
  const options = { env, windowsHide: true, timeout: 120_000, maxBuffer: 1 << 20 };
  if (action === 'cleanup') {
    try {
      for (const file of sourceAssets)
        await run('icacls.exe', [file, '/remove:g', 'YuanTuSandboxUsers'], options);
    } finally {
      await run(accountHelper, ['account-uninstall'], options);
    }
    return;
  }
  if (action !== 'setup' && action !== 'check') throw new Error('Use setup, check or cleanup');
  if (action === 'setup') {
    await run(accountHelper, ['account-setup'], options);
    // Runtime assets are outside each disposable test workspace. Grant only the required read/execute roots.
    for (const directory of [path.dirname(process.execPath), path.join(root, 'dist')])
      await run(accountHelper, ['read-grant', '--root', directory], options);
    // Per-file RX has no inherited grant. Never walk packages/tools: native/target contains hard links.
    for (const file of sourceAssets)
      await run('icacls.exe', [file, '/grant', 'YuanTuSandboxUsers:RX'], options);
  }
  const { stdout } = await run(accountHelper, ['account-status', '--verify'], options);
  const status = JSON.parse(stdout);
  if (status.ready !== true || !Array.isArray(status.problems) || status.problems.length)
    throw new Error(`Sandbox accounts are not ready: ${stdout}`);
  console.log('Windows sandbox account backend verified ready');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) throw new Error('Use setup, check or cleanup');
  await manageWindowsAccounts(process.argv[2]);
}
