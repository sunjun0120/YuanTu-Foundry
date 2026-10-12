import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BackgroundCommands } from '../packages/tools/background.ts';
import { executionPolicy } from '../packages/tools/execution-policy.ts';
import {
  registerSandboxProvider,
  sandboxProvider,
  type SandboxPlan,
} from '../packages/tools/sandbox.ts';

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
