import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ToolRegistry } from '../packages/tools/registry.ts';
import { PermissionPolicy } from '../packages/core/permissions.ts';
import { resolveSandboxConfig, setSandboxMode } from '../packages/tools/sandbox.ts';
import {
  executionPolicy,
  withExecutionPolicy,
  requireExecutionCapabilities,
  localExecutionEnvironment,
} from '../packages/tools/execution-environment.ts';

const context = () => ({ signal: new AbortController().signal, approve: async () => true });

test('timed out policy re-preparation cannot start a body or journal a new effect', async () => {
  const registry = new ToolRegistry();
  registry.deadlines = { defaultMs: 20 };
  let selected = executionPolicy('sbx');
  let prepared = 0,
    executed = 0,
    journaled = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fallback = setTimeout(release, 200);
  registry.register({
    name: 'slow_reprepare',
    description: 'fixture',
    permission: 'command',
    inputSchema: { type: 'object' },
    async prepare() {
      if (++prepared === 2) await gate;
      return {
        execute: async () => {
          executed++;
          return { isError: false, content: 'executed' };
        },
      };
    },
    execute: async () => ({ isError: false, content: 'unused' }),
  });
  try {
    const result = await registry.execute(
      { id: 'slow', name: 'slow_reprepare', arguments: {} },
      {
        ...context(),
        executionPolicy: selected,
        executionPolicyForCall: () => selected,
        approve: async () => {
          selected = executionPolicy('host');
          return true;
        },
        effectJournal: {
          begin() {
            journaled++;
          },
        },
      },
    );
    assert.match(result.content, /TOOL_TIMEOUT/);
    release();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(executed, 0);
    assert.equal(journaled, 0);
  } finally {
    clearTimeout(fallback);
    release();
    await registry.close();
  }
});

for (const timing of ['approval resolution', 'wrapper next']) {
  test(`permission revocation at ${timing} cannot start a pending body`, async () => {
    const registry = new ToolRegistry();
    const deny = new PermissionPolicy({ version: 1, rules: [{ kind: 'command', effect: 'deny' }] });
    let policy = new PermissionPolicy({
      version: 1,
      rules: [{ kind: 'command', effect: 'allow' }],
    });
    let executed = false;
    registry.register({
      name: 'revoked_command',
      description: 'fixture',
      permission: 'command',
      inputSchema: { type: 'object' },
      execute: async () => {
        executed = true;
        return { isError: false, content: 'executed' };
      },
    });
    if (timing === 'wrapper next')
      registry.registerHooks({
        aroundTool: async (_dispatch, next) => {
          const pending = next();
          policy = deny;
          return pending;
        },
      });
    try {
      const result = await registry.execute(
        { id: 'revoked', name: 'revoked_command', arguments: {} },
        {
          ...context(),
          permissionPolicyForCall: () => policy,
          approve: async (approval) => {
            const allowed = policy.decide(approval) === 'allow';
            if (timing === 'approval resolution') policy = deny;
            return allowed;
          },
        },
      );
      assert.equal(result.isError, true);
      assert.equal(executed, false);
    } finally {
      await registry.close();
    }
  });
}

test('live selection changes while a wrapper waits are applied before the tool body', async () => {
  const registry = new ToolRegistry();
  let selected = executionPolicy('host');
  let policy = new PermissionPolicy({ version: 1, rules: [] });
  let policyReads = 0;
  registry.register({
    name: 'waiting_policy',
    description: 'inspect policy',
    inputSchema: { type: 'object' },
    execute: async (_args, ctx) => ({
      isError: false,
      content: `${ctx.executionPolicy?.mode}/${resolveSandboxConfig().mode}`,
    }),
  });
  registry.registerHooks({
    aroundTool: async (_dispatch, next) => {
      selected = executionPolicy('sbx');
      policy = new PermissionPolicy({ version: 1, rules: [{ kind: 'command', effect: 'deny' }] });
      await Promise.resolve();
      return next();
    },
  });
  try {
    const result = await registry.execute(
      { id: 'waiting', name: 'waiting_policy', arguments: {} },
      {
        ...context(),
        executionPolicy: selected,
        executionPolicyForCall: () => selected,
        permissionPolicyForCall: () => {
          assert.ok(
            ++policyReads < 20,
            'a permissionless tool must not loop waiting for an obsolete approval policy',
          );
          return policy;
        },
      },
    );
    assert.equal(result.content, 'sbx/sbx');
  } finally {
    await registry.close();
  }
});

test('permission tightening while a wrapper waits prevents an already approved body from starting', async () => {
  const registry = new ToolRegistry();
  let policy = new PermissionPolicy({ version: 1, rules: [{ kind: 'command', effect: 'allow' }] });
  let executed = false;
  registry.register({
    name: 'waiting_command',
    description: 'fixture command',
    permission: 'command',
    inputSchema: { type: 'object' },
    execute: async () => {
      executed = true;
      return { isError: false, content: 'executed' };
    },
  });
  registry.registerHooks({
    aroundTool: async (_dispatch, next) => {
      policy = new PermissionPolicy({ version: 1, rules: [{ kind: 'command', effect: 'deny' }] });
      return next();
    },
  });
  try {
    const result = await registry.execute(
      { id: 'tightened', name: 'waiting_command', arguments: {} },
      {
        ...context(),
        permissionPolicyForCall: () => policy,
        approve: async (approval) => policy.decide(approval) === 'allow',
      },
    );
    assert.equal(result.isError, true);
    assert.equal(executed, false);
  } finally {
    await registry.close();
  }
});

test('a trusted live policy refreshes after approval and stays fixed once the tool body starts', async () => {
  const registry = new ToolRegistry();
  let selected = executionPolicy('sbx');
  registry.register({
    name: 'live_policy',
    description: 'inspect live policy',
    permission: 'command',
    inputSchema: { type: 'object' },
    async execute(_args, ctx) {
      const before = `${ctx.executionPolicy?.mode}/${resolveSandboxConfig().mode}`;
      selected = executionPolicy('docker');
      await Promise.resolve();
      return {
        isError: false,
        content: `${before}/${ctx.executionPolicy?.mode}/${resolveSandboxConfig().mode}`,
      };
    },
  });
  try {
    const result = await registry.execute(
      { id: 'live', name: 'live_policy', arguments: {} },
      {
        ...context(),
        executionPolicy: selected,
        executionPolicyForCall: () => selected,
        approve: async () => {
          selected = executionPolicy('host');
          return true;
        },
      },
    );
    assert.equal(result.content, 'host/host/host/host');
  } finally {
    await registry.close();
  }
});

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
