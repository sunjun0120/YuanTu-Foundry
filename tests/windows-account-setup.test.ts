import test from 'node:test';
import assert from 'node:assert/strict';
import * as setupModule from '../apps/desktop/sandbox-setup.ts';
import { systemHandlers } from '../apps/agent-host/handlers/system.ts';
import { configureAccountBackend } from '../packages/tools/sandbox-account.ts';
import { nativeSandboxBackend, setWindowsAccountReady } from '../packages/tools/sandbox-mode.ts';
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
  assert.deepEqual(
    setupModule.parseSandboxSetupCommand({
      type: 'read-add',
      path: 'D:\\Tools',
      acknowledge: true,
    }),
    { type: 'read-add', path: 'D:\\Tools', acknowledge: true },
  );
  for (const input of [
    { type: 'read-add', path: 'D:\\Tools' },
    { type: 'read-add', path: 'D:\\Tools', acknowledge: true, command: 'cmd.exe' },
    { type: 'read-remove', path: '', acknowledge: true },
  ])
    assert.throws(() => setupModule.parseSandboxSetupCommand(input));
});

test('a damaged read allowlist can still be revoked through the settings service', async () => {
  const calls: string[][] = [];
  const setup = new setupModule.WindowsAccountSandboxSetup({
    platform: 'win32',
    helperPath: 'fixed',
    execute: async (_file, args) => {
      calls.push(args);
      return { stdout: report(false, ['read-allowlist-invalid']) };
    },
  });
  await setup.allowRead('D:\\Tools', true);
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
  'the live Host refresh refuses active work and updates native selection without changing session policies',
  { skip: process.platform !== 'win32' && 'Windows account readiness requires Windows' },
  async () => {
    const handler = systemHandlers['sandbox.refresh'];
    assert.equal(typeof handler, 'function');
    const ctx = { active: new Map() } as HostContext;
    configureAccountBackend({ run: async () => report(true) });
    try {
      await handler!(ctx, {});
      assert.equal(nativeSandboxBackend('win32'), 'windows-account');
      ctx.active.set('busy', {} as never);
      await assert.rejects(handler!(ctx, {}), /active/);
      ctx.active.clear();
      configureAccountBackend({ run: async () => report() });
      await handler!(ctx, {});
      assert.equal(nativeSandboxBackend('win32'), 'windows');
      await assert.rejects(handler!(ctx, { path: 'x' }), /parameters/);
    } finally {
      setWindowsAccountReady(false);
    }
  },
);
