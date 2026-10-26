import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { PassThrough } from 'node:stream';
import path from 'node:path';
import {
  accountCommand,
  capabilityFor,
  configureAccountBackend,
  ensureReadRefresh,
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
import { ToolRegistry } from '../packages/tools/registry.ts';
import { withSandboxPreparation, type SandboxPlan } from '../packages/tools/sandbox-provider.ts';
import { tempRoot } from './temp-fixture.ts';
import { windowsShell, windowsShellArgs } from '../packages/tools/windows-shell.ts';

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

test('read refresh retries failures and does not reuse a completed refresh', async (t) => {
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
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[0]![0], 'read-refresh');
  assert.equal(calls[0]![1], '--env');
  // A new PATH names other toolchains: that is a different question and is asked again.
  await ensureReadRefresh({ ...env, PATH: 'C:\\two' });
  assert.equal(calls.length, 4);
  // The request file carries only the values discovery reads, and is gone afterwards.
  const file = calls[0]![2]!;
  assert.ok(file.startsWith(path.join(state, 'requests')));
  await assert.rejects(stat(file), { code: 'ENOENT' });
  // Maintenance leaves the next command free to refresh as well.
  await refreshAccountBackend();
  await ensureReadRefresh(env);
  assert.equal(calls.filter((args) => args[0] === 'read-refresh').length, 5);
});

test('returning from environment B to A refreshes the automatic read roots again', async (t) => {
  const state = await tempRoot(t, 'yuantu-account-refresh-switch-');
  const environments: string[] = [];
  configureAccountBackend({
    helper: 'C:\\fake\\yuantu-sandbox.exe',
    state,
    run: async (_helper, args) => {
      assert.equal(args[0], 'read-refresh');
      const request = JSON.parse(await readFile(args[2]!, 'utf8'));
      environments.push(request.env.PATH);
      return JSON.stringify({ version: 1, roots: [request.env.PATH], skipped: [] });
    },
  });
  await ensureReadRefresh({ PATH: 'C:\\one' });
  await ensureReadRefresh({ PATH: 'C:\\two' });
  await ensureReadRefresh({ PATH: 'C:\\one' });
  assert.deepEqual(environments, ['C:\\one', 'C:\\two', 'C:\\one']);
});

test('concurrent identical environments share only the refresh that is still running', async (t) => {
  const state = await tempRoot(t, 'yuantu-account-refresh-concurrent-');
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  t.after(() => release());
  let calls = 0;
  configureAccountBackend({
    helper: 'C:\\fake\\yuantu-sandbox.exe',
    state,
    run: async (_helper, args) => {
      assert.equal(args[0], 'read-refresh');
      calls++;
      markStarted();
      await waiting;
      return '{"version":1,"roots":[],"skipped":[]}';
    },
  });
  const env = { PATH: 'C:\\one' };
  const pending = Promise.all([ensureReadRefresh(env), ensureReadRefresh({ ...env })]);
  await started;
  assert.equal(calls, 1);
  release();
  await pending;
  assert.equal(calls, 1);
  await ensureReadRefresh(env);
  assert.equal(calls, 2, 'a later command must not reuse the completed refresh');
});

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

/** Exercises the real provider/registry wait without provisioning accounts or launching a command. */
async function authorizationBudgetFixture(
  t: TestContext,
  after?: (signal: AbortSignal) => Promise<void>,
) {
  const root = await realpath(await tempRoot(t, 'yuantu-grant-budget-'));
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started!: () => void;
  const active = new Promise<void>((resolve) => {
    started = resolve;
  });
  let helperSignal: AbortSignal | undefined;
  configureAccountBackend({
    state: root,
    launch: announcing,
    run: async (_helper, args, options) => {
      if (args[0] === 'account-status') return status(true);
      if (args[0] === 'grant') {
        helperSignal = options?.signal;
        await new Promise<void>((resolve, reject) => {
          const abort = () => reject(helperSignal!.reason);
          helperSignal?.addEventListener('abort', abort, { once: true });
          void waiting
            .then(resolve)
            .finally(() => helperSignal?.removeEventListener('abort', abort));
          if (helperSignal?.aborted) abort();
        });
      }
      return '{}';
    },
  });
  const registry = new ToolRegistry();
  registry.deadlines = { defaultMs: 100 };
  registry.register({
    name: 'authorize',
    description: 'Prepare a command through the Windows account provider',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async execute(_args, ctx) {
      const plan = await windowsAccountSandboxProvider.prepare({
        root,
        cwd: root,
        command: 'echo ok',
        config: { mode: 'windows-account', image: '' },
      });
      await windowsAccountSandboxProvider.cleanup(plan);
      ctx.signal.throwIfAborted();
      await after?.(ctx.signal);
      return { isError: false, content: 'authorized' };
    },
  });
  const controller = new AbortController();
  const progress: boolean[] = [];
  const result = registry.execute(
    { id: 'authorize-1', name: 'authorize', arguments: {} },
    {
      signal: controller.signal,
      approve: async () => true,
      executionPolicy: executionPolicy('windows-account'),
      onPreparation: (event) => {
        progress.push(event.active);
        if (event.active) started();
      },
    },
  );
  // Attach immediately so a regression timing out before the test releases authorization is observed.
  void result.catch(() => {});
  t.after(async () => {
    controller.abort();
    release();
    await result.catch(() => {});
    await stopBrokers();
    await registry.close();
  });
  return { result, active, release, controller, progress, helperSignal: () => helperSignal };
}

test(
  'workspace authorization can outlast the tool budget without ending the call or its progress',
  { skip: windowsOnly },
  async (t) => {
    const fixture = await authorizationBudgetFixture(t);
    await fixture.active;
    let settled = false;
    void fixture.result
      .finally(() => {
        settled = true;
      })
      .catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 180));
    assert.equal(settled, false, 'authorization must be excluded from the tool execution budget');
    assert.deepEqual(fixture.progress, [true]);
    assert.equal(fixture.helperSignal()?.aborted, false);
    fixture.release();
    assert.equal((await fixture.result).isError, false);
    assert.deepEqual(fixture.progress, [true, false]);
  },
);

test(
  'the tool budget resumes after a long workspace authorization',
  { skip: windowsOnly },
  async (t) => {
    let afterStarted = false;
    const fixture = await authorizationBudgetFixture(t, (signal) => {
      afterStarted = true;
      return new Promise<void>((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
      );
    });
    await fixture.active;
    await new Promise((resolve) => setTimeout(resolve, 180));
    fixture.release();
    const result = await fixture.result;
    assert.equal(afterStarted, true, 'the tool must reach its post-authorization work');
    assert.equal(result.isError, true);
    assert.match(result.content, /^TOOL_TIMEOUT:/);
    assert.deepEqual(fixture.progress, [true, false]);
  },
);

test(
  'Stop still cancels authorization while its tool budget is suspended',
  { skip: windowsOnly },
  async (t) => {
    const fixture = await authorizationBudgetFixture(t);
    await fixture.active;
    const rejected = assert.rejects(fixture.result, /stopped during authorization/);
    fixture.controller.abort(new Error('stopped during authorization'));
    await rejected;
    assert.equal(fixture.helperSignal()?.aborted, true);
    assert.deepEqual(fixture.progress, [true, false]);
  },
);

test(
  'workspace authorization has its own deadline and reports the failed stage before retry',
  { skip: windowsOnly },
  async (t) => {
    const root = await realpath(await tempRoot(t, 'yuantu-grant-policy-'));
    let attempts = 0;
    const progress: unknown[] = [];
    configureAccountBackend({
      state: root,
      launch: announcing,
      run: async (_helper, args, options) => {
        if (args[0] === 'account-status') return status(true);
        if (args[0] === 'grant') {
          assert.equal(
            options?.timeout,
            0,
            'workspace propagation must not use the 60-second helper deadline',
          );
          if (++attempts === 1)
            throw Object.assign(new Error('Command failed'), {
              stderr: JSON.stringify({
                version: 1,
                stage: 'protect-reserved',
                path: root + '/.git',
                message: 'Windows error 5',
              }),
              code: 1,
            });
        }
        return '{}';
      },
    });
    t.after(stopBrokers);
    const request = {
      root,
      cwd: root,
      command: 'echo ok',
      config: { mode: 'windows-account' as const, image: '' },
    };
    // The observer arrives through the ambient context, which is what a run's tool execution provides.
    const prepare = () =>
      withSandboxPreparation({ onPreparation: (event) => progress.push(event) }, () =>
        windowsAccountSandboxProvider.prepare(request),
      );
    await assert.rejects(prepare(), (error: Error) => {
      assert.match(error.message, /workspace authorization.*incomplete/i);
      assert.match(error.message, /protect-reserved/);
      assert.match(error.message, /Windows error 5/);
      assert.ok(error.message.includes(root));
      return true;
    });
    const plan = await prepare();
    await windowsAccountSandboxProvider.cleanup(plan);
    assert.equal(attempts, 2);
    assert.deepEqual(
      progress,
      [true, false, true, false].map((active) => ({
        stage: 'workspace-authorization',
        root,
        active,
      })),
    );
  },
);

test(
  'cancelling one authorization waiter keeps the other, cancelling all stops the helper',
  { skip: windowsOnly },
  async (t) => {
    const root = await realpath(await tempRoot(t, 'yuantu-grant-cancel-'));
    let starts = 0;
    let helperSignal: AbortSignal | undefined;
    let release!: () => void;
    configureAccountBackend({
      state: root,
      launch: announcing,
      run: async (_helper, args, options) => {
        if (args[0] === 'account-status') return status(true);
        if (args[0] === 'grant') {
          starts++;
          helperSignal = options?.signal;
          await new Promise<void>((resolve, reject) => {
            release = resolve;
            helperSignal?.addEventListener('abort', () => reject(helperSignal!.reason), {
              once: true,
            });
          });
        }
        return '{}';
      },
    });
    t.after(stopBrokers);
    const first = new AbortController(),
      second = new AbortController();
    let seen = 0;
    let bothStarted!: () => void;
    const ready = new Promise<void>((resolve) => {
      bothStarted = resolve;
    });
    const request = {
      root,
      cwd: root,
      command: 'echo ok',
      config: { mode: 'windows-account' as const, image: '' },
    };
    const prepare = (signal: AbortSignal) =>
      withSandboxPreparation(
        {
          signal,
          onPreparation: (event) => {
            if (event.active && ++seen === 2) bothStarted();
          },
        },
        () => windowsAccountSandboxProvider.prepare(request),
      );
    const a = prepare(first.signal);
    const b = prepare(second.signal);
    const rejectedA = assert.rejects(a, /first stopped/);
    const rejectedB = assert.rejects(b, /second stopped/);
    // This deadline is only a guard for a regression that never reports preparation.
    await Promise.race([
      ready,
      new Promise((_, reject) => {
        const timer = setTimeout(() => {
          release?.();
          reject(new Error('authorization progress missing'));
        }, 1000);
        timer.unref();
      }),
    ]);
    assert.equal(starts, 1);
    first.abort(new Error('first stopped'));
    await rejectedA;
    assert.equal(helperSignal?.aborted, false);
    second.abort(new Error('second stopped'));
    await rejectedB;
    assert.equal(helperSignal?.aborted, true);
  },
);

/** Prepares one command with `refresh` answering the helper's `read-refresh`; returns the requests it was sent. */
async function prepareWithRefresh(
  t: TestContext,
  refresh: () => string,
): Promise<{ prepared: Promise<SandboxPlan>; requests: { root?: string }[]; root: string }> {
  const state = await tempRoot(t, 'yuantu-account-refresh-fail-');
  const requests: { root?: string }[] = [];
  configureAccountBackend({
    helper: 'C:\\fake\\yuantu-sandbox.exe',
    state,
    run: async (_helper, args) => {
      if (args[0] === 'account-status') return status(true);
      if (args[0] === 'read-refresh') {
        requests.push(JSON.parse(await readFile(args[2]!, 'utf8')));
        return refresh();
      }
      if (args[0] === 'grant') return '{}';
      throw new Error(`unexpected helper call ${args.join(' ')}`);
    },
    launch: announcing,
  });
  t.after(stopBrokers);
  const root = await realpath(await tempRoot(t, 'yuantu-account-ws-'));
  const prepared = windowsAccountSandboxProvider.prepare({
    root,
    cwd: root,
    command: 'echo hi',
    config: { mode: 'windows-account', image: '' },
  });
  return { prepared, requests, root };
}

test('a failed read-root refresh never stops a command', { skip: windowsOnly }, async (t) => {
  const { prepared, requests, root } = await prepareWithRefresh(t, () =>
    JSON.stringify({ version: 1, roots: [], skipped: [], protected: [], error: 'refresh refused' }),
  );
  assert.equal((await prepared).args[0], 'exec');
  // The request names the command's workspace, so its reserved names are protected first.
  assert.equal(requests[0]?.root, root);
});

test(
  'a workspace whose reserved names cannot be protected runs no command',
  { skip: windowsOnly },
  async (t) => {
    const { prepared } = await prepareWithRefresh(t, () => {
      throw new Error('.git cannot be protected');
    });
    await assert.rejects(
      prepared,
      /protected directories could not be secured.*\.git cannot be protected/,
    );
  },
);

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

test('commands keep the host shape: shell text through PowerShell, absolute images directly', () => {
  const shell = accountCommand({ command: 'npm test' });
  const expected = windowsShell();
  assert.equal(shell.argv[0], expected.path);
  assert.equal(shell.verbatim, expected.kind === 'cmd');
  if (expected.kind !== 'cmd')
    assert.deepEqual(shell.argv.slice(1), windowsShellArgs(expected, 'npm test'));
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
  const b = await capabilityFor('C:\\work\\b');
  assert.notEqual(b, a);
  // A fresh process reads the same SID back.
  configureAccountBackend({ state });
  assert.equal(await capabilityFor('C:\\work\\a'), a);
  assert.equal(await capabilityFor('C:\\work\\b'), b);
});

test('independent Hosts agree on a capability and retain every workspace mapping', async (t) => {
  const state = await tempRoot(t, 'yuantu-account-multiprocess-');
  const moduleUrl = new URL('../packages/tools/sandbox-account.ts', import.meta.url).href;
  const workers = Array.from({ length: 4 }, (_, index) => {
    const uniqueRoot = path.join(state, `workspace-${index}`);
    const child = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
      import { capabilityFor, configureAccountBackend } from ${JSON.stringify(moduleUrl)};
      configureAccountBackend({ state: process.argv[1] });
      const unique = await capabilityFor(process.argv[2]);
      process.send({ ready: true });
      process.once('message', async () => {
        const shared = await capabilityFor(process.argv[3]);
        process.send({ unique, shared });
        process.disconnect();
      });
    `,
        state,
        uniqueRoot,
        path.join(state, 'shared'),
      ],
      {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      },
    );
    let stderr = '';
    child.stderr!.on('data', (chunk) => (stderr += chunk));
    const result = new Promise<{ unique: string; shared: string }>((resolve, reject) => {
      child.on('message', (message) => {
        if ('shared' in (message as object)) resolve(message as { unique: string; shared: string });
      });
      child.once('error', reject);
      child.once('exit', (code) => {
        if (code) reject(new Error(stderr));
      });
    });
    const ready = new Promise<void>((resolve, reject) => {
      child.once('message', () => resolve());
      child.once('error', reject);
      child.once('exit', () => reject(new Error(stderr || 'worker exited before ready')));
    });
    t.after(() => {
      if (child.exitCode === null) child.kill();
    });
    return { child, uniqueRoot, ready, result };
  });
  await Promise.all(workers.map((worker) => worker.ready));
  const results = await Promise.all(
    workers.map((worker) => {
      worker.child.send('go');
      return worker.result;
    }),
  );
  assert.equal(
    new Set(results.map((result) => result.shared)).size,
    1,
    'one workspace must have one SID across Hosts',
  );
  for (const [index, worker] of workers.entries()) {
    configureAccountBackend({ state });
    assert.equal(await capabilityFor(worker.uniqueRoot), results[index]!.unique);
  }
  configureAccountBackend({ state });
  assert.equal(await capabilityFor(path.join(state, 'shared')), results[0]!.shared);
});

test('a capability assigned by an earlier version survives migration', async (t) => {
  const { state } = await backend(t);
  const root = path.resolve('legacy-workspace');
  const sid = 'S-1-5-21-11-22-33-44';
  await writeFile(
    path.join(state, 'cap-sids.json'),
    JSON.stringify({
      version: 1,
      workspaces: { [root.toLowerCase()]: sid },
    }),
  );
  assert.equal(await capabilityFor(root), sid);
  configureAccountBackend({ state });
  assert.equal(await capabilityFor(root), sid);
});

test('an unreadable legacy capability registry cannot silently replace an existing identity', async (t) => {
  const { state } = await backend(t);
  const root = path.join(state, 'legacy-workspace');
  const legacy = path.join(state, 'cap-sids.json');
  await writeFile(legacy, '{broken');
  await assert.rejects(capabilityFor(root), /capability state could not be accessed/);
  const sid = 'S-1-5-21-11-22-33-44';
  await writeFile(
    legacy,
    JSON.stringify({ version: 1, workspaces: { [root.toLowerCase()]: sid } }),
  );
  assert.equal(await capabilityFor(root), sid);
});

test('a failed capability publication cannot return an unpersisted SID on retry', async (t) => {
  const { state } = await backend(t);
  const directory = path.join(state, 'capabilities');
  await writeFile(directory, 'not a directory');
  const root = path.join(state, 'workspace');
  for (let attempt = 0; attempt < 2; attempt++)
    await assert.rejects(capabilityFor(root), /capability state could not be accessed/);
  await rm(directory);
  const sid = await capabilityFor(root);
  configureAccountBackend({ state });
  assert.equal(await capabilityFor(root), sid);
});

test(
  'native always selects the account backend and refuses until it is ready',
  { skip: windowsOnly },
  async (t) => {
    await backend(t, false);
    await refreshAccountReadiness();
    assert.equal(nativeSandboxBackend('win32'), 'windows-account');
    const unavailable = (await windowsAccountSandboxProvider.available()) ?? '';
    assert.match(unavailable, /accounts-missing/);
    assert.doesNotMatch(unavailable, /select the weaker|mode manually/);
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

test(
  'account initialization names its stage, its helper and the failure underneath',
  { skip: windowsOnly },
  async (t) => {
    const state = await tempRoot(t, 'yuantu-account-init-');
    // The helper path exists, so the refusal is "did not answer" rather than "missing"; the runner's own text is
    // the only record of why, and a message that dropped it would be the vague "sandbox unavailable" again.
    configureAccountBackend({
      helper: process.execPath,
      state,
      run: async () => {
        throw Object.assign(new Error('Command failed: yuantu-sandbox.exe account-status'), {
          stderr: 'resource directory is incomplete: yuantu-sandbox.manifest',
          code: 1,
        });
      },
    });
    const root = await tempRoot(t, 'yuantu-account-init-ws-');
    await assert.rejects(
      windowsAccountSandboxProvider.prepare({
        root,
        cwd: root,
        command: 'echo x',
        config: { mode: 'windows-account', image: '' },
      }),
      (error: Error) => {
        assert.match(error.message, /blocked at Windows sandbox account initialization/i);
        assert.ok(
          error.message.includes(process.execPath),
          'the helper path is part of the report',
        );
        assert.match(error.message, /resource directory is incomplete/);
        assert.doesNotMatch(error.message, /workspace authorization/i);
        return true;
      },
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
    assert.equal(request.verbatim, windowsShell().kind === 'cmd');
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
