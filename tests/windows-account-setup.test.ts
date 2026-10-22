import test from 'node:test';
import assert from 'node:assert/strict';
import * as setupModule from '../apps/desktop/sandbox-setup.ts';
import { systemHandlers } from '../apps/agent-host/handlers/system.ts';
import { configureAccountBackend } from '../packages/tools/sandbox-account.ts';
import { nativeSandboxBackend } from '../packages/tools/sandbox-mode.ts';
import type { HostContext } from '../apps/agent-host/state.ts';

const report = (ready = false, problems = ready ? [] : ['accounts-missing']) =>
  JSON.stringify({
    version: 1,
    ready,
    problems,
    details: [],
    accounts: [
      { account: 'offline', sid: ready ? 'S-1-5-21-1-2-3-1001' : null },
      { account: 'online', sid: ready ? 'S-1-5-21-1-2-3-1002' : null },
    ],
    group: ready ? 'S-1-5-21-1-2-3-1003' : null,
    readRoots: ready
      ? [
          { path: 'C:\\Users\\Alice\\.cargo\\bin', source: 'auto' },
          { path: 'D:\\Tools', source: 'user' },
        ]
      : [],
  });

test('account setup distinguishes missing, damaged and ready without elevation', async () => {
  assert.equal(typeof setupModule.WindowsAccountSandboxSetup, 'function');
  for (const [stdout, state] of [
    [report(), 'uninitialized'],
    [report(false, ['setup-marker-missing', 'credentials-missing']), 'uninitialized'],
    [report(false, ['setup-marker-version']), 'damaged'],
    [report(false, ['logon-failed']), 'damaged'],
    [report(true), 'ready'],
  ] as const) {
    const calls: string[][] = [];
    const setup = new setupModule.WindowsAccountSandboxSetup({
      platform: 'win32',
      helperPath: 'C:\\protected\\yuantu-sandbox.exe',
      execute: async (_file, args) => {
        calls.push(args);
        return { stdout };
      },
    });
    assert.equal((await setup.status()).state, state);
    assert.deepEqual(calls, [['account-status']]);
  }
});

test('the settings diagnostic uses account-status --verify', async () => {
  const calls: string[][] = [];
  const setup = new setupModule.WindowsAccountSandboxSetup({
    platform: 'win32',
    helperPath: 'C:\\protected\\yuantu-sandbox.exe',
    execute: async (_file, args) => {
      calls.push(args);
      return { stdout: report(false, ['accounts-missing']) };
    },
  });
  const view = await setup.verify();
  assert.deepEqual(calls, [['account-status', '--verify']]);
  assert.equal(view.state, 'uninitialized');
});

test('read allowlist IPC requires explicit acknowledgement and never forwards a renderer command', () => {
  assert.deepEqual(setupModule.parseSandboxSetupCommand({ type: 'read-add', acknowledge: true }), {
    type: 'read-add',
    acknowledge: true,
  });
  assert.deepEqual(
    setupModule.parseSandboxSetupCommand({
      type: 'read-remove',
      path: 'D:\\Tools',
      acknowledge: true,
    }),
    { type: 'read-remove', path: 'D:\\Tools', acknowledge: true },
  );
  for (const input of [
    // The path of an added root comes from the native picker, not from the page.
    { type: 'read-add', path: 'D:\\Tools', acknowledge: true },
    { type: 'read-add' },
    { type: 'read-add', acknowledge: true, command: 'cmd.exe' },
    { type: 'read-remove', path: 'D:\\Tools' },
    { type: 'read-remove', path: '', acknowledge: true },
    { type: 'read-remove', acknowledge: true },
    { type: 'read-remove', path: 'D:\\Tools', acknowledge: true, command: 'cmd.exe' },
  ])
    assert.throws(() => setupModule.parseSandboxSetupCommand(input));
});

test('an added read root comes from the picker, and a cancelled picker calls nothing', async () => {
  const calls: string[][] = [];
  const roots: { path: string; source: 'auto' | 'user' }[] = [];
  const setup = new setupModule.WindowsAccountSandboxSetup({
    platform: 'win32',
    helperPath: 'fixed',
    chooseDirectory: async () => 'D:\\Tools',
    execute: async (_file, args) => {
      calls.push(args);
      if (args[0] === 'read-grant') roots.push({ path: args[2]!, source: 'user' });
      if (args[0] === 'read-ungrant') roots.splice(0, roots.length);
      return { stdout: report(true) };
    },
  });
  await setup.addRead();
  assert.deepEqual(calls, [
    ['account-status'],
    ['read-grant', '--root', 'D:\\Tools'],
    ['account-status'],
  ]);
  const cancelled = new setupModule.WindowsAccountSandboxSetup({
    platform: 'win32',
    helperPath: 'fixed',
    chooseDirectory: async () => undefined,
    execute: async (_file, args) => {
      calls.push(args);
      return { stdout: report(true) };
    },
  });
  calls.length = 0;
  const view = await cancelled.addRead();
  assert.equal(view.state, 'ready');
  assert.deepEqual(calls, [['account-status']]);
});

test('only a directory the settings page added can be removed', async () => {
  const calls: string[][] = [];
  const execute = async (_file: string, args: string[]) => {
    calls.push(args);
    return { stdout: report(true) };
  };
  const setup = new setupModule.WindowsAccountSandboxSetup({
    platform: 'win32',
    helperPath: 'fixed',
    execute,
  });
  await setup.removeRead('D:\\Tools');
  assert.deepEqual(calls, [
    ['account-status'],
    ['read-ungrant', '--root', 'D:\\Tools'],
    ['account-status'],
  ]);
  calls.length = 0;
  // An automatic root and a path the journal never listed are both refused before the helper is asked.
  for (const path of ['C:\\Users\\Alice\\.cargo\\bin', 'C:\\Windows'])
    await assert.rejects(setup.removeRead(path), /added in these settings/);
  assert.deepEqual(calls, [['account-status'], ['account-status']]);
});

test('a damaged read allowlist can still be revoked through the settings service', async () => {
  const calls: string[][] = [];
  const setup = new setupModule.WindowsAccountSandboxSetup({
    platform: 'win32',
    helperPath: 'fixed',
    execute: async (_file, args) => {
      calls.push(args);
      return {
        stdout: JSON.stringify({
          version: 1,
          ready: false,
          problems: ['read-allowlist-invalid'],
          details: [],
          accounts: [
            { account: 'offline', sid: 'S-1-5-21-1-2-3-1001' },
            { account: 'online', sid: 'S-1-5-21-1-2-3-1002' },
          ],
          group: 'S-1-5-21-1-2-3-1003',
          readRoots: [{ path: 'D:\\Tools', source: 'user' }],
        }),
      };
    },
  });
  await setup.removeRead('D:\\Tools');
  assert.ok(calls.some((args) => args[0] === 'read-ungrant'));
});

test('account setup verifies mutations, refreshes even on UAC failure and has no UAC timeout', async () => {
  assert.equal(typeof setupModule.WindowsAccountSandboxSetup, 'function');
  let installed = false;
  let refreshes = 0;
  const mutations: [string, string[], number][] = [];
  const setup = new setupModule.WindowsAccountSandboxSetup({
    platform: 'win32',
    helperPath: 'C:\\protected\\yuantu-sandbox.exe',
    changed: async () => {
      refreshes++;
    },
    execute: async (file, args, timeout) => {
      if (args[0] === 'account-status') return { stdout: report(installed) };
      mutations.push([file, args, timeout]);
      installed = args[0] === 'account-setup';
      return { stdout: '' };
    },
  });
  assert.equal((await setup.initialize()).state, 'ready');
  assert.equal((await setup.uninstall()).state, 'uninitialized');
  assert.equal(refreshes, 2);
  assert.deepEqual(mutations, [
    ['C:\\protected\\yuantu-sandbox.exe', ['account-setup'], 0],
    ['C:\\protected\\yuantu-sandbox.exe', ['account-uninstall'], 0],
  ]);
  const cancelled = new setupModule.WindowsAccountSandboxSetup({
    platform: 'win32',
    helperPath: 'fixed',
    changed: async () => {
      refreshes++;
    },
    execute: async (_file, args) => {
      if (args[0] === 'account-status') return { stdout: report() };
      throw new Error('UAC cancelled');
    },
  });
  await assert.rejects(cancelled.initialize(), /cancelled/);
  assert.equal(refreshes, 3);
});

test('account maintenance fails closed when the platform or helper is unavailable', async () => {
  assert.equal(typeof setupModule.WindowsAccountSandboxSetup, 'function');
  const platform = new setupModule.WindowsAccountSandboxSetup({
    platform: 'darwin',
    helperPath: 'fixed',
    execute: async () => {
      throw new Error('must not execute');
    },
  });
  await assert.rejects(platform.initialize(), /unavailable/);
  await assert.rejects(platform.uninstall(), /unavailable/);
  const missing = new setupModule.WindowsAccountSandboxSetup({
    platform: 'win32',
    helperPath: 'fixed',
    execute: async () => {
      throw new Error('helper missing');
    },
  });
  await assert.rejects(missing.initialize(), /unavailable/);
  await assert.rejects(missing.uninstall(), /unavailable/);
});

test('account maintenance serializes concurrent operations', async () => {
  let complete!: () => void;
  const pending = new Promise<void>((resolve) => {
    complete = resolve;
  });
  const setup = new setupModule.WindowsAccountSandboxSetup({
    platform: 'win32',
    helperPath: 'fixed',
    execute: async (_file, args) => {
      if (args[0] !== 'account-status') await pending;
      return { stdout: report() };
    },
  });
  const first = setup.initialize();
  await assert.rejects(setup.uninstall(), /progress/);
  complete();
  await assert.rejects(first, /verified/);
});

test(
  'the live Host refresh refuses active work and keeps native on the account backend',
  { skip: process.platform !== 'win32' && 'Windows account readiness requires Windows' },
  async () => {
    const handler = systemHandlers['sandbox.refresh'];
    assert.equal(typeof handler, 'function');
    const ctx = { active: new Map() } as HostContext;
    configureAccountBackend({ run: async () => report(true) });
    await handler!(ctx, {});
    assert.equal(nativeSandboxBackend('win32'), 'windows-account');
    ctx.active.set('busy', {} as never);
    await assert.rejects(handler!(ctx, {}), /active/);
    ctx.active.clear();
    configureAccountBackend({ run: async () => report() });
    await handler!(ctx, {});
    assert.equal(nativeSandboxBackend('win32'), 'windows-account');
    await assert.rejects(handler!(ctx, { path: 'x' }), /parameters/);
  },
);
