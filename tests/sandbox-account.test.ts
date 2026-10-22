import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  accountCommand,
  capabilityFor,
  configureAccountBackend,
  parseAccountStatus,
  refreshAccountReadiness,
  windowsAccountSandboxProvider,
  type HelperRunner,
} from '../packages/tools/sandbox-account.ts';
import {
  brokerPipe,
  parseBrokerAnnouncement,
  stopBrokers,
  type BrokerLauncher,
} from '../packages/tools/sandbox-account-broker.ts';
import { nativeSandboxBackend, setWindowsAccountReady } from '../packages/tools/sandbox-mode.ts';
import { executionPolicy } from '../packages/tools/execution-policy.ts';
import { tempRoot } from './temp-fixture.ts';

const windowsOnly = process.platform !== 'win32' && 'the account backend only runs on Windows';
const PIPE = '\\\\.\\pipe\\yuantu-sbx-broker-' + '0123456789abcdef0123456789abcdef';

function status(ready: boolean, problems: string[] = ready ? [] : ['accounts-missing']) {
  return JSON.stringify({
    version: 1,
    ready,
    problems,
    details: [],
    accounts: [
      { account: 'offline', sid: ready ? 'S-1-5-21-1-2-3-1003' : null },
      { account: 'online', sid: ready ? 'S-1-5-21-1-2-3-1004' : null },
    ],
    group: ready ? 'S-1-5-21-1-2-3-1005' : null,
  });
}

/** A broker that announces a pipe and lives until its stdin closes, like the real one. */
const fakeBroker =
  (starts: string[]): BrokerLauncher =>
  (_helper, account) => {
    starts.push(account);
    return spawn(
      process.execPath,
      [
        '-e',
        `process.stdout.write(JSON.stringify({version:1,pipe:${JSON.stringify(PIPE)}})+'\\n');` +
          "process.stdin.on('end',()=>process.exit(0));process.stdin.resume();",
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
  };

async function backend(t: test.TestContext, ready = true) {
  const state = await tempRoot(t, 'yuantu-account-state-');
  const calls: string[][] = [];
  const starts: string[] = [];
  const run: HelperRunner = async (_helper, args) => {
    calls.push(args);
    if (args[0] === 'account-status') return status(ready);
    if (args[0] === 'grant') return '{}';
    throw new Error(`unexpected helper call ${args.join(' ')}`);
  };
  configureAccountBackend({
    helper: 'C:\\fake\\yuantu-sandbox.exe',
    run,
    state,
    launch: fakeBroker(starts),
  });
  t.after(async () => {
    await stopBrokers();
    setWindowsAccountReady(false);
  });
  return { state, calls, starts };
}

test('the helper status is accepted only in exactly its own shape', () => {
  assert.equal(parseAccountStatus(status(true)).ready, true);
  assert.deepEqual(parseAccountStatus(status(false)).problems, ['accounts-missing']);
  const base = JSON.parse(status(true));
  for (const broken of [
    'not json',
    JSON.stringify({ ...base, version: 2 }),
    JSON.stringify({ ...base, extra: true }),
    JSON.stringify({ ...base, problems: ['firewall-missing'] }),
    JSON.stringify({ ...base, group: 'S-1-1-0' }),
    JSON.stringify({ ...base, accounts: [base.accounts[0]] }),
    JSON.stringify({ ...base, accounts: [{ account: 'root', sid: null }, base.accounts[1]] }),
  ])
    assert.throws(() => parseAccountStatus(broken), broken);
});

test('a broker announcement must name one of its own pipes', () => {
  assert.equal(parseBrokerAnnouncement(JSON.stringify({ version: 1, pipe: PIPE })), PIPE);
  for (const broken of [
    '',
    JSON.stringify({ version: 1, pipe: '\\\\.\\pipe\\other' }),
    JSON.stringify({ version: 1, pipe: PIPE + 'x' }),
    JSON.stringify({ version: 1, pipe: PIPE, extra: 1 }),
  ])
    assert.throws(() => parseBrokerAnnouncement(broken));
});

test('commands keep the host shape: shell text through cmd, absolute images directly', () => {
  const shell = accountCommand({ command: 'npm test' });
  assert.equal(shell.verbatim, true);
  assert.match(shell.argv[0]!, /cmd\.exe$/i);
  assert.equal(shell.argv[1], '/d /s /c "npm test"');
  const direct = accountCommand(
    { command: 'C:\\Program Files\\nodejs\\node.exe', argv: ['-e', 'x'] },
    { PATH: '' },
  );
  assert.deepEqual(direct, {
    argv: ['C:\\Program Files\\nodejs\\node.exe', '-e', 'x'],
    verbatim: false,
  });
  const shim = accountCommand({ command: 'npm', argv: ['run', 'a b'] }, { PATH: '' });
  assert.equal(shim.verbatim, true);
  assert.equal(shim.argv[1], '/d /s /c "npm run "a b""');
});

test('a workspace keeps one capability SID, distinct from every other workspace', async (t) => {
  const { state } = await backend(t);
  const a = await capabilityFor('C:\\work\\a');
  assert.match(a, /^S-1-5-21(-\d{1,10}){4}$/);
  assert.equal(await capabilityFor('c:\\WORK\\A'), a);
  assert.notEqual(await capabilityFor('C:\\work\\b'), a);
  // A fresh process reads the same SID back.
  configureAccountBackend({ state });
  assert.equal(await capabilityFor('C:\\work\\a'), a);
  const file = JSON.parse(await readFile(path.join(state, 'cap-sids.json'), 'utf8'));
  assert.equal(Object.keys(file.workspaces).length, 2);
});

test(
  'native picks the account backend only while it is ready',
  { skip: windowsOnly },
  async (t) => {
    await backend(t, false);
    await refreshAccountReadiness();
    assert.equal(nativeSandboxBackend('win32'), 'windows');
    assert.match((await windowsAccountSandboxProvider.available()) ?? '', /accounts-missing/);
    await backend(t, true);
    await refreshAccountReadiness();
    assert.equal(nativeSandboxBackend('win32'), 'windows-account');
    assert.equal(await windowsAccountSandboxProvider.available(), null);
  },
);

test(
  'an explicit account selection refuses to run before initialization',
  { skip: windowsOnly },
  async (t) => {
    await backend(t, false);
    const root = await tempRoot(t, 'yuantu-account-ws-');
    await assert.rejects(
      windowsAccountSandboxProvider.prepare({
        root,
        cwd: root,
        command: 'echo x',
        config: { mode: 'windows-account', image: '' },
      }),
      /not ready/,
    );
  },
);

test('concurrent commands share one broker per account and a dead broker is replaced', async (t) => {
  const starts: string[] = [];
  const launcher = fakeBroker(starts);
  t.after(stopBrokers);
  const pipes = await Promise.all([
    brokerPipe('x', 'offline', launcher),
    brokerPipe('x', 'offline', launcher),
    brokerPipe('x', 'online', launcher),
  ]);
  assert.deepEqual(pipes, [PIPE, PIPE, PIPE]);
  assert.deepEqual(starts.sort(), ['offline', 'online']);
  await stopBrokers();
  await brokerPipe('x', 'offline', launcher);
  assert.equal(starts.filter((a) => a === 'offline').length, 2);
});

test(
  'prepare grants the workspace, picks the account and writes a private request',
  { skip: windowsOnly },
  async (t) => {
    const { state, calls, starts } = await backend(t, true);
    const root = await tempRoot(t, 'yuantu-account-ws-');
    await mkdir(path.join(root, 'src'));
    const write = await windowsAccountSandboxProvider.prepare({
      root,
      cwd: path.join(root, 'src'),
      command: 'echo hi',
      config: { mode: 'windows-account', image: '', network: 'denied' },
    });
    assert.equal(write.backend, 'windows-account');
    assert.equal(write.args[0], 'exec');
    assert.equal(write.args[2], PIPE);
    const file = write.args[4]!;
    assert.ok(file.startsWith(path.join(state, 'requests')));
    const request = JSON.parse(await readFile(file, 'utf8'));
    const capability = await capabilityFor(root);
    assert.deepEqual(request.capabilities, [capability]);
    assert.equal(request.verbatim, true);
    assert.equal(request.cwd.toLowerCase(), path.join(root, 'src').toLowerCase());
    assert.deepEqual(starts, ['offline']);
    assert.ok(calls.some((args) => args[0] === 'grant' && args.includes(capability)));

    const read = await windowsAccountSandboxProvider.prepare({
      root,
      cwd: root,
      command: 'type x',
      config: { mode: 'windows-account', image: '', files: 'read-only' },
    });
    assert.deepEqual(JSON.parse(await readFile(read.args[4]!, 'utf8')).capabilities, []);
    assert.deepEqual(starts.sort(), ['offline', 'online']);
    // One grant per workspace per process.
    assert.equal(calls.filter((args) => args[0] === 'grant').length, 1);

    await windowsAccountSandboxProvider.cleanup(write);
    await windowsAccountSandboxProvider.cleanup(write);
    await assert.rejects(stat(file), { code: 'ENOENT' });
  },
);

test('the account backend declares both file and both network policies', () => {
  const denied = executionPolicy('windows-account', { files: 'read-only', network: 'denied' });
  assert.equal(denied.processFiles, 'read-only');
  assert.equal(denied.network, 'denied');
  assert.equal(executionPolicy('windows-account').network, 'unrestricted');
});
