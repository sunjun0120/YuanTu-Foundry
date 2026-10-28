import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { BackgroundCommands } from '../packages/tools/background.ts';
import { executionPolicy } from '../packages/sandbox/execution-policy.ts';
import {
  registerSandboxProvider,
  sandboxProvider,
  type SandboxPlan,
} from '../packages/sandbox/sandbox.ts';

test('a failed force-stop still records cleanup uncertainty as a ToolCleanupError', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yuantu-background-stop-error-'));
  const manager = new BackgroundCommands(root);
  const worker = Object.assign(new EventEmitter(), {
    pid: 2147483646,
    connected: true,
    send(message: { type: string }, callback: () => void) {
      if (message.type === 'start')
        queueMicrotask(() => worker.emit('message', { type: 'ready', pid: worker.pid }));
      callback?.();
    },
  });
  const originalSpawn = childProcess.spawn;
  t.mock.method(childProcess, 'spawn', (file: string, args: string[], options: object) => {
    if (args?.[0]?.includes('background-worker.')) return worker;
    if (file === 'taskkill.exe') {
      const killer = Object.assign(new EventEmitter(), { kill: () => true });
      queueMicrotask(() => killer.emit('close', 1));
      return killer;
    }
    return originalSpawn(file, args, options);
  });
  const kill = process.kill;
  t.mock.method(process, 'kill', (pid: number, signal: NodeJS.Signals | number = 'SIGTERM') => {
    if (pid === -worker.pid)
      throw Object.assign(new Error('fixture termination refused'), { code: 'EPERM' });
    return kill(pid, signal);
  });
  const timeout = setTimeout;
  t.mock.method(
    globalThis,
    'setTimeout',
    (callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) =>
      timeout(callback, ms === 8000 ? 1 : ms, ...args),
  );
  syncBuiltinESMExports();
  t.after(async () => {
    worker.emit('close');
    await manager.close().catch(() => {});
    t.mock.restoreAll();
    syncBuiltinESMExports();
    await rm(root, { recursive: true, force: true });
  });
  const settlements: boolean[] = [];
  const started = await manager.tools('s')[0]!.execute(
    { command: 'fixture command' },
    {
      signal: new AbortController().signal,
      executionPolicy: executionPolicy('host'),
      approve: async () => true,
      commandJournal: {
        started() {},
        read() {},
        record: () => undefined,
        records: () => [],
        settled: (record) => {
          settlements.push(record.cleanupConfirmed === true);
        },
      },
    },
  );
  await assert.rejects(
    manager.stopById(JSON.parse(started.content).id, 's'),
    (error: unknown) => error instanceof Error && error.name === 'ToolCleanupError',
  );
  assert.deepEqual(settlements, [false]);
});

test('background input refuses a changed file or network policy', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yuantu-background-policy-'));
  await writeFile(
    path.join(root, 'input.cjs'),
    "process.stdin.on('data',()=>{});setInterval(()=>{},1000)",
  );
  const manager = new BackgroundCommands(root);
  t.after(async () => {
    await manager.close();
    await rm(root, { recursive: true, force: true });
  });
  const context = (mode: 'host' | 'seatbelt') => ({
    signal: new AbortController().signal,
    approve: async () => true,
    executionPolicy: executionPolicy(mode),
  });
  const tools = manager.tools('s');
  const started = await tools[0]!.execute({ command: 'node input.cjs' }, context('host'));
  const { id } = JSON.parse(started.content);
  const input = tools.find((tool) => tool.name === 'write_command')!;
  await assert.rejects(
    input.execute({ id, input: 'forbidden' }, context('seatbelt')),
    /creation policy/,
  );
});

for (const scenario of ['success', 'failure', 'process-group'] as const)
  test(`background owner releases its original plan before settlement (${scenario})`, async (t) => {
    const failCleanup = scenario === 'failure';
    const root = await mkdtemp(path.join(os.tmpdir(), 'yuantu-background-owner-'));
    const original = sandboxProvider('host');
    const manager = new BackgroundCommands(root);
    const plans = new Set<SandboxPlan>();
    let cleaned = false;
    const settled: boolean[] = [];
    registerSandboxProvider({
      ...original,
      prepare: async (request) => {
        const plan = await original.prepare(request);
        plan.backend = 'host';
        if (scenario === 'process-group') plan.processTree = 'process-group';
        plans.add(plan);
        return plan;
      },
      cleanup: async (plan) => {
        assert.ok(plans.has(plan), 'cleanup must receive the owner object');
        cleaned = true;
        if (failCleanup) throw new Error('fixture restoration failed');
      },
    });
    t.after(async () => {
      await manager.close().catch(() => {});
      registerSandboxProvider(original);
      await rm(root, { recursive: true, force: true });
    });
    const started = await manager.tools('s')[0]!.execute(
      { command: 'echo owner-cleanup' },
      {
        signal: new AbortController().signal,
        approve: async () => true,
        executionPolicy: executionPolicy('host'),
        commandJournal: {
          started: () => {},
          read: () => {},
          record: () => undefined,
          records: () => [],
          settled: (record) => {
            assert.equal(cleaned, true, 'settlement cannot precede owner cleanup');
            settled.push(record.cleanupConfirmed === true);
          },
        },
      },
    );
    const { id } = JSON.parse(started.content);
    await manager.poll(id, 's', 0, 10000);
    assert.equal(cleaned, true);
    assert.deepEqual(settled, [!failCleanup && scenario !== 'process-group']);
  });
