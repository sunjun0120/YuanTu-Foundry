import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ToolRegistry } from '../packages/tools/registry.ts';
import { resolveSandboxConfig, setSandboxMode } from '../packages/tools/sandbox.ts';
import {
  executionPolicy,
  withExecutionPolicy,
  requireExecutionCapabilities,
  localExecutionEnvironment,
} from '../packages/tools/execution-environment.ts';

const context = () => ({ signal: new AbortController().signal, approve: async () => true });

test('mutating the caller policy while approval waits cannot change the dispatched policy', async () => {
  const registry = new ToolRegistry();
  const selected = { ...executionPolicy('windows') };
  registry.register({
    name: 'policy',
    description: 'inspect policy after approval',
    permission: 'command',
    inputSchema: { type: 'object' },
    async execute(_args, ctx) {
      return {
        isError: false,
        content: `${ctx.executionPolicy?.mode}/${resolveSandboxConfig().mode}`,
      };
    },
  });
  const result = await registry.execute(
    { id: 'a', name: 'policy', arguments: {} },
    {
      ...context(),
      executionPolicy: selected,
      approve: async () => {
        selected.mode = 'host';
        selected.processFiles = 'unrestricted';
        return true;
      },
    },
  );
  assert.equal(result.content, 'windows/windows');
  await registry.close();
});

test('concurrent tool calls pin separate backend policies across awaits and global switches', async () => {
  const registry = new ToolRegistry();
  registry.register({
    name: 'mode',
    description: 'report pinned backend',
    inputSchema: { type: 'object' },
    async execute() {
      const before = resolveSandboxConfig().mode;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { isError: false, content: `${before}/${resolveSandboxConfig().mode}` };
    },
  });
  try {
    const host = registry.execute(
      { id: 'a', name: 'mode', arguments: {} },
      { ...context(), executionPolicy: executionPolicy('host') },
    );
    const windows = registry.execute(
      { id: 'b', name: 'mode', arguments: {} },
      { ...context(), executionPolicy: executionPolicy('windows') },
    );
    setSandboxMode('docker');
    assert.deepEqual(
      (await Promise.all([host, windows])).map((r) => r.content),
      ['host/host', 'windows/windows'],
    );
  } finally {
    setSandboxMode(undefined);
    await registry.close();
  }
});

test('readonly file policy refuses mutation before preparation, approval or effect journaling', async () => {
  const registry = new ToolRegistry();
  const effects: string[] = [];
  registry.register({
    name: 'write',
    description: 'write fixture',
    permission: 'write',
    inputSchema: { type: 'object' },
    async prepare() {
      effects.push('prepare');
      return { execute: async () => ({ isError: false, content: 'written' }) };
    },
    async execute() {
      effects.push('execute');
      return { isError: false, content: 'written' };
    },
  });
  const result = await registry.execute(
    { id: 'a', name: 'write', arguments: {} },
    {
      ...context(),
      executionPolicy: executionPolicy('host', { files: 'read-only' }),
      approve: async () => {
        effects.push('approve');
        return true;
      },
      effectJournal: {
        begin() {
          effects.push('journal');
        },
      },
    },
  );
  assert.equal(result.isError, true);
  assert.match(result.content, /read.only/);
  assert.deepEqual(effects, []);
  await registry.close();
});

test('capability checks separate process filesystem confinement from network and never weaken requirements', () => {
  assert.throws(
    () =>
      requireExecutionCapabilities(executionPolicy('host'), { processFiles: 'workspace-write' }),
    /filesystem/,
  );
  assert.throws(
    () => requireExecutionCapabilities(executionPolicy('windows'), { network: 'denied' }),
    /network/,
  );
  assert.throws(
    () =>
      requireExecutionCapabilities(executionPolicy('windows'), { processFiles: 'workspace-write' }),
    /filesystem/,
  );
  assert.throws(
    () =>
      requireExecutionCapabilities(executionPolicy('docker'), { processFiles: 'workspace-write' }),
    /filesystem/,
  );
  requireExecutionCapabilities(executionPolicy('docker'), {
    processFiles: 'read-only',
    network: 'denied',
  });
  assert.ok(Object.isFrozen(executionPolicy('windows')));
});

test('local file and process contracts resolve one workspace identity and reject foreign paths and links', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-environment-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'nested'));
  await writeFile(path.join(root, 'nested', 'file.txt'), 'shared');
  const environment = await localExecutionEnvironment(root, executionPolicy('host'));
  assert.equal(environment.identity.kind, 'local');
  assert.equal(await environment.files.read('nested/file.txt'), 'shared');
  assert.equal(
    (await environment.processes.prepare('echo shared', 'nested')).cwd,
    await environment.files.resolve('nested'),
  );
  for (const foreign of ['../outside', 'ssh://host/workspace', 'file:///tmp/example'])
    await assert.rejects(() => environment.files.resolve(foreign));
  await symlink(
    path.join(root, 'nested'),
    path.join(root, 'link'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  await assert.rejects(() => environment.processes.prepare('echo shared', 'link'), /links/);
});

test('nested async scopes restore the parent policy and preserve explicit hook selection', async () => {
  await withExecutionPolicy(executionPolicy('docker'), async () => {
    assert.equal(resolveSandboxConfig().mode, 'docker');
    await withExecutionPolicy(executionPolicy('host'), async () =>
      assert.equal(resolveSandboxConfig().mode, 'host'),
    );
    assert.equal(resolveSandboxConfig().mode, 'docker');
    assert.equal(resolveSandboxConfig({ YUANTU_SANDBOX_HOOK: 'host' }, 'hook').mode, 'host');
  });
});

test('paired file writes retain approval and effect records; refusal leaves bytes absent', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-environment-write-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const environment = await localExecutionEnvironment(root, executionPolicy('host'));
  const records: string[] = [];
  const denied = await environment.files.write('denied.txt', 'no', {
    ...context(),
    approve: async () => false,
  });
  assert.equal(denied.isError, true);
  await assert.rejects(() => environment.files.read('denied.txt'));
  const result = await environment.files.write('accepted.txt', 'yes', {
    ...context(),
    approve: async () => {
      records.push('approve');
      return true;
    },
    effectJournal: {
      begin() {
        records.push('effect');
      },
    },
  });
  assert.equal(result.isError, false, result.content);
  assert.equal(await environment.files.read('accepted.txt'), 'yes');
  assert.deepEqual(records, ['approve', 'effect']);
});

test(
  'paired process cancellation waits for tree cleanup before closing',
  { timeout: 10000 },
  async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), 'yuantu-environment-process-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const environment = await localExecutionEnvironment(root, executionPolicy('host'));
    const controller = new AbortController();
    const running = await environment.processes.start(
      process.execPath,
      ['-e', 'console.log("ready");setInterval(()=>{},1000)'],
      '.',
      controller.signal,
    );
    await new Promise<void>((resolve) => running.child.stdout!.once('data', () => resolve()));
    controller.abort();
    await running.closed;
    assert.notEqual(running.child.exitCode === null && running.child.signalCode === null, true);
  },
);
