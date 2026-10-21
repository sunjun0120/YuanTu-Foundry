// @test-serial windows-sandbox: Creates and removes the machine's sandbox accounts, group and WFP filters.
/**
 * The sandbox account backend through the TypeScript provider, on a real machine: initialization, workspace
 * grants, the broker, and the runner, as a Host would drive them.
 *
 * It changes machine state (local accounts, logon rights, firewall filters), so it runs only where that is the
 * point — a disposable elevated CI machine that sets YUANTU_SANDBOX_ACCOUNT_ACCEPTANCE=1 and
 * YUANTU_SANDBOX_DEV_PROVISION=1 — with the debug build of the helper, and it removes everything afterwards.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  configureAccountBackend,
  refreshAccountReadiness,
  windowsAccountSandboxProvider,
} from '../packages/tools/sandbox-account.ts';
import { stopBrokers } from '../packages/tools/sandbox-account-broker.ts';
import { nativeSandboxBackend, setWindowsAccountReady } from '../packages/tools/sandbox-mode.ts';
import type { SandboxConfig, SandboxPlan } from '../packages/tools/sandbox-provider.ts';
import { projectRoot } from './process-fixture.ts';
import { tempRoot } from './temp-fixture.ts';

const helper = path.join(
  projectRoot,
  'packages/tools/windows-sandbox/appcontainer/target/debug/yuantu-sandbox.exe',
);
const skip =
  process.platform !== 'win32'
    ? 'needs Windows'
    : process.env.GITHUB_ACTIONS !== 'true'
      ? 'real account provisioning is verified only on disposable GitHub Actions runners'
      : process.env.YUANTU_SANDBOX_ACCOUNT_ACCEPTANCE !== '1'
        ? 'changes machine accounts; set YUANTU_SANDBOX_ACCOUNT_ACCEPTANCE=1 on a disposable machine'
        : false;

const exec = promisify(execFile);

async function run(plan: SandboxPlan): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(plan.executable, plan.args, {
      cwd: plan.cwd,
      env: plan.env,
      windowsVerbatimArguments: plan.windowsVerbatimArguments,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, output }));
  });
}

async function command(
  root: string,
  text: string,
  config: Partial<SandboxConfig> = {},
): Promise<{ code: number | null; output: string }> {
  const plan = await windowsAccountSandboxProvider.prepare({
    root,
    cwd: root,
    command: text,
    config: { mode: 'windows-account', image: '', ...config },
  });
  try {
    return await run(plan);
  } finally {
    await windowsAccountSandboxProvider.cleanup(plan);
  }
}

const exists = (file: string) =>
  stat(file).then(
    () => true,
    () => false,
  );

test(
  'the provider confines writes per workspace, forks, and denies the offline network',
  { skip, timeout: 240_000 },
  async (t) => {
    const state = await tempRoot(t, 'yuantu-account-native-');
    configureAccountBackend({ helper, state });
    const env = { ...process.env, YUANTU_SANDBOX_DEV_PROVISION: '1' };
    await exec(helper, ['account-initialize', '--dev-direct'], { env });
    t.after(async () => {
      await stopBrokers();
      setWindowsAccountReady(false);
      await exec(helper, ['account-remove', '--dev-direct'], { env });
    });
    // The accounts must be able to run the helper and node (outside any workspace grant on a CI machine).
    for (const directory of [path.dirname(helper), path.dirname(process.execPath)])
      await exec('icacls', [directory, '/grant', 'YuanTuSandboxUsers:(OI)(CI)RX']);

    const ready = await refreshAccountReadiness();
    assert.equal(ready?.ready, true, JSON.stringify(ready));
    assert.equal(nativeSandboxBackend('win32'), 'windows-account');

    const a = await tempRoot(t, 'yuantu-account-a-');
    const b = await tempRoot(t, 'yuantu-account-b-');
    await mkdir(path.join(a, '.git'));
    // Concurrent commands in two workspaces, each confined to its own.
    const [first, second] = await Promise.all([
      command(a, `echo a> own.txt & echo a> "${path.join(b, 'from-a.txt')}"`),
      command(b, `echo b> own.txt & echo b> "${path.join(a, 'from-b.txt')}"`),
    ]);
    assert.ok(await exists(path.join(a, 'own.txt')), first.output);
    assert.ok(await exists(path.join(b, 'own.txt')), second.output);
    assert.equal(await exists(path.join(b, 'from-a.txt')), false);
    assert.equal(await exists(path.join(a, 'from-b.txt')), false);
    // Protected metadata and read-only policy.
    await command(a, 'echo x> .git\\config');
    assert.equal(await exists(path.join(a, '.git', 'config')), false);
    await command(a, 'echo x> readonly.txt', { files: 'read-only' });
    assert.equal(await exists(path.join(a, 'readonly.txt')), false);
    // A forking test runner, through the shell like an acceptance check.
    const forks = path.join(
      projectRoot,
      'packages/tools/windows-sandbox/appcontainer/tests/fixtures/forks',
    );
    for (const name of ['a.test.cjs', 'b.test.cjs'])
      await import('node:fs/promises').then((fs) =>
        fs.copyFile(path.join(forks, name), path.join(a, name)),
      );
    const tests = await command(a, `"${process.execPath}" --test`);
    assert.equal(tests.code, 0, tests.output);
    assert.match(tests.output, /pass 2/);
    // Scratch is the account's own, not the desktop user's TEMP.
    const temp = await command(a, 'echo %TEMP%> temp.txt');
    assert.equal(temp.code, 0, temp.output);
    assert.match(
      await readFile(path.join(a, 'temp.txt'), 'utf8'),
      /YuanTuSandbox(Online|Offline)/i,
    );
    // Offline: no connection; online: connects.
    const connect = (host: string) =>
      `"${process.execPath}" -e "const s=require('net').connect(443,'${host}');s.setTimeout(4000);s.on('connect',()=>{console.log('CONNECTED');s.destroy()});s.on('timeout',()=>{console.log('BLOCKED');s.destroy()});s.on('error',e=>console.log('BLOCKED '+e.code))"`;
    const offline = await command(a, connect('1.1.1.1'), { network: 'denied' });
    assert.doesNotMatch(offline.output, /CONNECTED/);
    const online = await command(a, connect('1.1.1.1'));
    assert.match(online.output, /CONNECTED/);
  },
);
