import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { PassThrough } from 'node:stream';
import path from 'node:path';
import {
  accountCommand,
  capabilityFor,
  configureAccountBackend,
  ensureReadRefresh,
  READ_REFRESH_TTL_MS,
  parseAccountStatus,
  refreshAccountBackend,
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
import { nativeSandboxBackend } from '../packages/tools/sandbox-mode.ts';
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
    readRoots: [],
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
    if (args[0] === 'read-refresh') return '{"version":1,"roots":[],"skipped":[]}';
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
  });
  return { state, calls, starts };
}

test('the helper status is accepted only in exactly its own shape', () => {
  assert.equal(parseAccountStatus(status(true)).ready, true);
  assert.deepEqual(parseAccountStatus(status(false)).problems, ['accounts-missing']);
  const withRoots = JSON.parse(status(true));
  withRoots.readRoots = [
    { path: 'C:\\Users\\Alice\\.cargo\\bin', source: 'auto' },
    { path: 'D:\\Tools', source: 'user' },
  ];
  assert.deepEqual(parseAccountStatus(JSON.stringify(withRoots)).readRoots, withRoots.readRoots);
  const base = JSON.parse(status(true));
  for (const broken of [
    'not json',
    JSON.stringify({ ...base, version: 2 }),
    JSON.stringify({ ...base, extra: true }),
    JSON.stringify({ ...base, problems: ['firewall-missing'] }),
    JSON.stringify({ ...base, group: 'S-1-1-0' }),
    JSON.stringify({ ...base, accounts: [base.accounts[0]] }),
    JSON.stringify({ ...base, accounts: [{ account: 'root', sid: null }, base.accounts[1]] }),
    // The read roots are part of the shape: a status without them is from another build.
    JSON.stringify({ ...base, readRoots: undefined }),
    JSON.stringify({ ...base, readRoots: [{ path: 'D:\\Tools', source: 'other' }] }),
    JSON.stringify({ ...base, readRoots: [{ path: '', source: 'user' }] }),
    JSON.stringify({ ...base, readRoots: [{ path: 'D:\\Tools', source: 'user', mode: 'x' }] }),
  ])
    assert.throws(() => parseAccountStatus(broken), broken);
});

test('the automatic read roots are refreshed once per environment and retried after a failure', async (t) => {
  const state = await tempRoot(t, 'yuantu-account-refresh-');
  const calls: string[][] = [];
  let failures = 1;
  configureAccountBackend({
    helper: 'C:\\fake\\yuantu-sandbox.exe',
    state,
    run: async (_helper, args) => {
      calls.push(args);
      if (args[0] === 'read-refresh' && failures-- > 0) throw new Error('refresh refused');
      return '{}';
    },
  });
  const env = { PATH: 'C:\\one', CARGO_HOME: 'C:\\cargo' };
  // The first attempt fails and is forgotten, so the next command asks again.
  await assert.rejects(ensureReadRefresh(env), /refresh refused/);
  await ensureReadRefresh(env);
  await ensureReadRefresh({ ...env });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0]![0], 'read-refresh');
  assert.equal(calls[0]![1], '--env');
  // A new PATH names other toolchains: that is a different question and is asked again.
  await ensureReadRefresh({ ...env, PATH: 'C:\\two' });
  assert.equal(calls.length, 3);
  // The request file carries only the values discovery reads, and is gone afterwards.
  const file = calls[0]![2]!;
  assert.ok(file.startsWith(path.join(state, 'requests')));
  await assert.rejects(stat(file), { code: 'ENOENT' });
  // Maintenance forgets the cache: the next command refreshes again.
  await refreshAccountBackend();
  await ensureReadRefresh(env);
  assert.equal(calls.filter((args) => args[0] === 'read-refresh').length, 4);
});

test('a read refresh expires, so a credential file created later is denied without a Host restart', async (t) => {
  const state = await tempRoot(t, 'yuantu-account-refresh-ttl-');
  const calls: string[][] = [];
  let clock = 1_000_000;
  t.after(() => configureAccountBackend({ now: Date.now }));
  configureAccountBackend({
    helper: 'C:\\fake\\yuantu-sandbox.exe',
    state,
    now: () => clock,
    run: async (_helper, args) => {
      calls.push(args);
      return '{}';
    },
  });
  const env = { PATH: 'C:\\one' };
  await ensureReadRefresh(env);
  clock += READ_REFRESH_TTL_MS - 1;
  await ensureReadRefresh(env);
  assert.equal(calls.length, 1, 'an unexpired refresh answers for the same environment');
  clock += 1;
  await ensureReadRefresh(env);
  assert.equal(calls.length, 2, 'an expired refresh asks the helper again');
});

test('a failed refresh never stops a command', { skip: windowsOnly }, async (t) => {
  const state = await tempRoot(t, 'yuantu-account-refresh-fail-');
  // A broker announcement without a child process: the point here is the refresh, and a confined CI runner may
  // refuse to spawn one at all.
  const announcing: BrokerLauncher = () => {
    const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
    const [stdin, stdout, stderr] = [new PassThrough(), new PassThrough(), new PassThrough()];
    Object.assign(child, {
      stdin,
      stdout,
      stderr,
      unref: () => {},
      kill: () => true,
    });
    setImmediate(() => stdout.write(`${JSON.stringify({ version: 1, pipe: PIPE })}\n`));
    return child as unknown as ChildProcess;
  };
  configureAccountBackend({
    helper: 'C:\\fake\\yuantu-sandbox.exe',
    state,
    run: async (_helper, args) => {
      if (args[0] === 'account-status') return status(true);
      if (args[0] === 'read-refresh') throw new Error('refresh refused');
      if (args[0] === 'grant') return '{}';
      throw new Error(`unexpected helper call ${args.join(' ')}`);
    },
    launch: announcing,
  });
  t.after(stopBrokers);
  const root = await tempRoot(t, 'yuantu-account-ws-');
  const plan = await windowsAccountSandboxProvider.prepare({
    root,
    cwd: root,
    command: 'echo hi',
    config: { mode: 'windows-account', image: '' },
  });
  assert.equal(plan.args[0], 'exec');
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
  'native always selects the account backend and refuses until it is ready',
  { skip: windowsOnly },
  async (t) => {
    await backend(t, false);
    await refreshAccountReadiness();
    assert.equal(nativeSandboxBackend('win32'), 'windows-account');
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
    // An ordinary command runs on the host's pipes: no terminal is requested.
    assert.equal('tty' in request, false);
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

    // A terminal asks the runner for a console of its size.
    const terminal = await windowsAccountSandboxProvider.prepare({
      root,
      cwd: root,
      command: 'cmd.exe',
      argv: [],
      config: { mode: 'windows-account', image: '', network: 'denied' },
      terminal: { columns: 120, rows: 40 },
    });
    assert.deepEqual(JSON.parse(await readFile(terminal.args[4]!, 'utf8')).tty, {
      columns: 120,
      rows: 40,
    });
    await windowsAccountSandboxProvider.cleanup(terminal);
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
