import test from 'node:test';
import assert from 'node:assert/strict';
import { manageWindowsAccounts, accountAcceptanceSkip } from '../scripts/windows-account-ci.mjs';

const env = {
  GITHUB_ACTIONS: 'true',
  RUNNER_ENVIRONMENT: 'github-hosted',
  FOUNDRY_TEST_WINDOWS_ACCOUNT_JOURNEYS: '1',
};

test('account maintenance refuses local and self-hosted machines before invoking a helper', async () => {
  let calls = 0;
  const run = async () => {
    calls++;
    return { stdout: '{}' };
  };
  for (const changed of [
    { GITHUB_ACTIONS: '' },
    { RUNNER_ENVIRONMENT: 'self-hosted' },
    { FOUNDRY_TEST_WINDOWS_ACCOUNT_JOURNEYS: '' },
  ])
    await assert.rejects(
      manageWindowsAccounts('setup', { platform: 'win32', env: { ...env, ...changed }, run }),
      /disposable GitHub Actions/i,
    );
  assert.equal(calls, 0);
  assert.notEqual(accountAcceptanceSkip('win32', {}), false);
  assert.equal(accountAcceptanceSkip('win32', env), false);
  assert.notEqual(accountAcceptanceSkip('linux', env), false);
});

test('account CI setup verifies readiness and cleanup uses the uninstall entry', async () => {
  const commands: string[][] = [];
  const run = async (_file: string, args: string[]) => {
    commands.push(args);
    return { stdout: JSON.stringify({ ready: true, problems: [] }) };
  };
  await manageWindowsAccounts('setup', { platform: 'win32', env, run });
  assert.deepEqual(commands[0], ['account-setup']);
  assert.ok(commands.some((args) => args.join(' ') === 'account-status --verify'));
  assert.ok(
    !commands.some((args) => args[0] === 'read-grant' && /packages[\\/]tools$/.test(args.at(-1)!)),
  );
  assert.deepEqual(
    commands
      .filter((args) => args.includes('YuanTuSandboxUsers:RX'))
      .map((args) => args[0]!.split(/[\\/]/).at(-1))
      .sort(),
    ['code-process-entry.ts', 'code-worker.ts', 'program-runtime.ts', 'yuantu-sandbox.exe'],
  );
  commands.length = 0;
  await manageWindowsAccounts('cleanup', { platform: 'win32', env, run });
  assert.deepEqual(commands.at(-1), ['account-uninstall']);
  assert.ok(commands.slice(0, -1).every((args) => args.includes('/remove:g')));
  await assert.rejects(
    manageWindowsAccounts('setup', {
      platform: 'win32',
      env,
      run: async () => ({ stdout: '{"ready":false,"problems":["missing"]}' }),
    }),
    /missing/,
  );
});

test('account uninstall still runs if withdrawing a source asset grant fails', async () => {
  let uninstalled = false;
  await assert.rejects(
    manageWindowsAccounts('cleanup', {
      platform: 'win32',
      env,
      run: async (_file: string, args: string[]) => {
        if (args.includes('/remove:g')) throw new Error('asset revoke failed');
        if (args[0] === 'account-uninstall') uninstalled = true;
        return { stdout: '' };
      },
    }),
    /asset revoke failed/,
  );
  assert.equal(uninstalled, true);
});
