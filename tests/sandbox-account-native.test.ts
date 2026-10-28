// @test-serial windows-sandbox: Creates and removes the machine's sandbox accounts, group and WFP filters.
// @test-serial real-pty: Opens a terminal on the account runner through node-pty.
/**
 * The sandbox account backend through the TypeScript provider, on a real machine: initialization, workspace
 * grants, the broker, and the runner, as a Host would drive them.
 *
 * It changes machine state (local accounts, logon rights, firewall filters), so it runs only where that is the
 * point — a disposable elevated GitHub Actions machine that sets FOUNDRY_TEST_WINDOWS_ACCOUNT_ACCEPTANCE=1.
 * The test harness deliberately strips YUANTU_* settings; the helper is invoked through the same `account-setup`
 * / `account-uninstall` entries the desktop uses, and everything is removed afterwards.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { userInfo } from 'node:os';
import { promisify } from 'node:util';
import {
  configureAccountBackend,
  refreshAccountReadiness,
  windowsAccountSandboxProvider,
} from '../packages/sandbox/sandbox-account.ts';
import { stopBrokers } from '../packages/sandbox/sandbox-account-broker.ts';
import { nativeSandboxBackend } from '../packages/sandbox/sandbox-mode.ts';
import type { SandboxConfig, SandboxPlan } from '../packages/sandbox/sandbox-provider.ts';
import { projectRoot } from './process-fixture.ts';
import { tempRoot } from './temp-fixture.ts';

const helper = path.join(
  projectRoot,
  'packages/sandbox/windows-sandbox/native/target/debug/yuantu-sandbox.exe',
);
const skip =
  process.platform !== 'win32'
    ? 'needs Windows'
    : process.env.GITHUB_ACTIONS !== 'true'
      ? 'real account provisioning is verified only on disposable GitHub Actions runners'
      : process.env.FOUNDRY_TEST_WINDOWS_ACCOUNT_ACCEPTANCE !== '1'
        ? 'changes machine accounts; enable FOUNDRY_TEST_WINDOWS_ACCOUNT_ACCEPTANCE only on a disposable Actions runner'
        : false;

const exec = promisify(execFile);

/** Failure details as a run annotation: the job log needs authentication, annotations do not. */
function annotate(title: string, message: string): void {
  if (process.env.GITHUB_ACTIONS !== 'true') return;
  const text = message
    .slice(0, 3500)
    .replaceAll('%', '%25')
    .replaceAll('\r', '%0D')
    .replaceAll('\n', '%0A');
  console.log(`::error title=${title.replaceAll(':', '%3A').replaceAll(',', '%2C')}::${text}`);
}

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
    const env = { ...process.env };
    t.after(async () => {
      await stopBrokers();
      try {
        await exec(helper, ['account-uninstall'], { env });
      } catch (error) {
        const failure = error as { stdout?: string; stderr?: string; message: string };
        annotate(
          'account-uninstall',
          `${failure.message}\n${failure.stdout ?? ''}\n${failure.stderr ?? ''}`,
        );
        throw error;
      }
    });
    try {
      const setup = await exec(helper, ['account-setup'], { env });
      console.log(`account-setup: ${setup.stdout}`);
    } catch (error) {
      const failure = error as { stdout?: string; stderr?: string; message: string };
      annotate(
        'account-setup',
        `${failure.message}\n${failure.stdout ?? ''}\n${failure.stderr ?? ''}`,
      );
      throw error;
    }
    // The accounts must be able to run the helper and node (outside any workspace grant on a CI machine).
    for (const directory of [path.dirname(helper), path.dirname(process.execPath)])
      await exec('icacls', [directory, '/grant', 'YuanTuSandboxUsers:(OI)(CI)RX']);

    const ready = await refreshAccountReadiness();
    if (!ready?.ready) {
      const verify = await exec(helper, ['account-status', '--verify'], { env }).catch(
        (error: unknown) => error as { stdout?: string; stderr?: string; message: string },
      );
      const verifyText = 'message' in verify ? verify.message : verify.stdout;
      annotate(
        'account-status after setup',
        `${JSON.stringify(ready)}\n${verifyText}\n${verify.stderr ?? ''}`,
      );
    }
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
    // Concurrent helper processes must retain both recovery records, not overwrite one another.
    const grants = JSON.parse(
      await readFile(
        path.join(userInfo().homedir, '.yuantu', 'sandbox-state', 'windows-account', 'grants.json'),
        'utf8',
      ),
    );
    for (const root of [a, b])
      assert.ok(
        grants.grants.some(
          (entry: { root: string }) => entry.root.toLowerCase() === root.toLowerCase(),
        ),
        `missing recovery record for ${root}`,
      );
    // Protected metadata and read-only policy.
    await command(a, 'echo x> .git\\config');
    assert.equal(await exists(path.join(a, '.git', 'config')), false);
    await command(a, 'echo x> readonly.txt', { files: 'read-only' });
    assert.equal(await exists(path.join(a, 'readonly.txt')), false);
    // A forking test runner, through the shell like an acceptance check.
    const forks = path.join(
      projectRoot,
      'packages/sandbox/windows-sandbox/native/tests/fixtures/forks',
    );
    for (const name of ['a.test.cjs', 'b.test.cjs'])
      await import('node:fs/promises').then((fs) =>
        fs.copyFile(path.join(forks, name), path.join(a, name)),
      );
    const tests = await command(a, `"${process.execPath}" --test`);
    assert.equal(tests.code, 0, tests.output);
    assert.match(tests.output, /pass 2/);
    // Scratch is the account's own, not the desktop user's TEMP.
    // Windows may expose TEMP with an 8.3 account-directory alias (YUANTU~1).
    // Resolve it while the command's scratch still exists, and verify the actual token identity too.
    const temp = await command(
      a,
      `"${process.execPath}" -e "const fs=require('fs');fs.writeFileSync(require('path').join(process.env.TEMP,'probe.txt'),'ok');console.log(JSON.stringify({temp:fs.realpathSync.native(process.env.TEMP),profile:fs.realpathSync.native(process.env.USERPROFILE),user:require('os').userInfo().username}))" > temp.json`,
    );
    assert.equal(temp.code, 0, temp.output);
    const scratch = JSON.parse(await readFile(path.join(a, 'temp.json'), 'utf8'));
    assert.match(scratch.user, /^YuanTuSandbox(Online|Offline)$/i);
    assert.notEqual(scratch.profile.toLowerCase(), userInfo().homedir.toLowerCase());
    assert.ok(
      scratch.temp.toLowerCase().startsWith(`${scratch.profile.toLowerCase()}\\`),
      JSON.stringify(scratch),
    );
    assert.match(path.basename(scratch.temp), /^yuantu-sbx-/);
    // A terminal, as terminal_open runs it: the plan inside a pseudo terminal. The command runs on the runner's own
    // console and its output is relayed; handing exec's console handles over instead lost all of it.
    const { spawn: spawnPty } = await import('@lydell/node-pty');
    const terminalPlan = await windowsAccountSandboxProvider.prepare({
      root: a,
      cwd: a,
      command: 'echo terminal-visible',
      config: { mode: 'windows-account', image: '', network: 'denied' },
      terminal: { columns: 100, rows: 30 },
    });
    try {
      const screen = await new Promise<string>((resolve) => {
        const terminal = spawnPty(terminalPlan.executable, terminalPlan.args, {
          cwd: terminalPlan.cwd,
          env: terminalPlan.env as Record<string, string>,
          cols: 100,
          rows: 30,
        });
        let text = '';
        terminal.onData((chunk) => (text += chunk));
        terminal.onExit(() => resolve(text));
      });
      if (!screen.includes('terminal-visible')) annotate('terminal output', JSON.stringify(screen));
      assert.match(screen, /terminal-visible/);
    } finally {
      await windowsAccountSandboxProvider.cleanup(terminalPlan);
    }
    // Offline: no connection; online: connects.
    const connect = (host: string) =>
      `"${process.execPath}" -e "const s=require('net').connect(443,'${host}');s.setTimeout(4000);s.on('connect',()=>{console.log('CONNECTED');s.destroy()});s.on('timeout',()=>{console.log('BLOCKED');s.destroy()});s.on('error',e=>console.log('BLOCKED '+e.code))"`;
    const offline = await command(a, connect('1.1.1.1'), { network: 'denied' });
    assert.doesNotMatch(offline.output, /CONNECTED/);
    const online = await command(a, connect('1.1.1.1'));
    assert.match(online.output, /CONNECTED/);
  },
);
