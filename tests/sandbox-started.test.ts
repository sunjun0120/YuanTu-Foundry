import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  sandboxProvider,
  registerSandboxProvider,
  prepareSandbox,
  markSandboxStarted,
  cleanupSandbox,
  type SandboxPlan,
} from '../packages/tools/sandbox.ts';
import { commandTool } from '../packages/tools/command.ts';
import {
  localExecutionEnvironment,
  executionPolicy,
} from '../packages/tools/execution-environment.ts';
import { BackgroundCommands } from '../packages/tools/background.ts';

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-started-'));
  const original = sandboxProvider('windows');
  const host = sandboxProvider('host');
  const started = new Set<SandboxPlan>();
  const cleaned = new Set<SandboxPlan>();
  const provider = {
    ...host,
    mode: 'windows' as const,
    async prepare(request: Parameters<typeof host.prepare>[0]) {
      return { ...(await host.prepare(request)), backend: 'windows' as const };
    },
    started(plan: SandboxPlan) {
      started.add(plan);
    },
    async cleanup(plan: SandboxPlan) {
      cleaned.add(plan);
    },
  };
  registerSandboxProvider(provider);
  t.after(async () => {
    registerSandboxProvider(original);
    await rm(root, { recursive: true, force: true });
  });
  return { root, started, cleaned, policy: executionPolicy('windows') };
}

test('foreground commands register their original plan before owner cleanup', async (t) => {
  const { root, policy, started, cleaned } = await fixture(t);
  const result = await commandTool(root).execute(
    { command: `"${process.execPath}" -e "console.log('started')"` },
    { signal: new AbortController().signal, approve: async () => true, executionPolicy: policy },
  );
  assert.equal(result.isError, false, result.content);
  assert.equal(started.size, 1);
  assert.equal(cleaned.size, started.size);
  assert.equal(
    [...cleaned].every((plan) => started.has(plan)),
    true,
  );
});

test('managed subprocesses register the original provider plan', async (t) => {
  const { root, policy, started, cleaned } = await fixture(t);
  const environment = await localExecutionEnvironment(root, policy);
  const running = await environment.processes.start(process.execPath, ['-e', 'process.exit(0)']);
  await running.closed;
  assert.equal(started.size, 1);
  assert.equal(started.has(running.plan), true);
  assert.equal(cleaned.size, started.size);
  assert.equal(
    [...cleaned].every((plan) => started.has(plan)),
    true,
  );
});

test('background launch registers the owner plan before serializing it to a worker', async (t) => {
  const { root, policy, started, cleaned } = await fixture(t);
  const manager = new BackgroundCommands(root);
  t.after(() => manager.close());
  const tool = manager.tools('fixture').find((item) => item.name === 'start_command');
  assert.ok(tool);
  const result = await tool.execute(
    { command: `"${process.execPath}" -e "console.log('background')"` },
    { signal: new AbortController().signal, approve: async () => true, executionPolicy: policy },
  );
  assert.equal(result.isError, false, result.content);
  await manager.close();
  assert.equal(started.size, 1);
  assert.equal(cleaned.size, started.size);
  assert.equal(
    [...cleaned].every((plan) => started.has(plan)),
    true,
  );
});

test('original owner receives lifecycle calls after backend mutation and provider replacement', async (t) => {
  const { root, started, cleaned } = await fixture(t);
  const plan = await prepareSandbox(root, root, process.execPath, ['-e', ''], {
    mode: 'windows',
    image: 'native',
  });
  let replacementCalls = 0;
  const host = sandboxProvider('host');
  registerSandboxProvider({
    ...host,
    mode: 'windows',
    started() {
      replacementCalls++;
    },
    async cleanup() {
      replacementCalls++;
    },
  });
  plan.backend = 'host';
  markSandboxStarted(plan);
  await cleanupSandbox(plan);
  assert.equal(started.has(plan), true);
  assert.equal(cleaned.has(plan), true);
  assert.equal(replacementCalls, 0);
});

test(
  'native alias binds the actual platform provider before it is replaced',
  { skip: process.platform !== 'win32' && process.platform !== 'darwin' },
  async (t) => {
    const { root } = await fixture(t);
    const mode = process.platform === 'win32' ? 'windows' : 'seatbelt';
    const original = sandboxProvider(mode);
    const host = sandboxProvider('host');
    let started = 0,
      cleaned = 0;
    registerSandboxProvider({
      ...host,
      mode,
      async prepare(request) {
        return { ...(await host.prepare(request)), backend: mode };
      },
      started() {
        started++;
      },
      async cleanup() {
        cleaned++;
      },
    });
    t.after(() => registerSandboxProvider(original));
    const plan = await prepareSandbox(root, root, process.execPath, ['-e', ''], {
      mode: 'native',
      image: 'native',
    });
    registerSandboxProvider({ ...host, mode });
    markSandboxStarted(plan);
    await cleanupSandbox(plan);
    assert.equal(started, 1);
    assert.equal(cleaned, 1);
  },
);
