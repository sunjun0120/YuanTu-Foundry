import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createTools } from '../packages/catalog/index.ts';
import { executionPolicy } from '../packages/tools/execution-policy.ts';
import {
  sandboxProvider,
  registerSandboxProvider,
  type SandboxPlan,
} from '../packages/tools/sandbox.ts';

export async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-native-git-'));
  const git = (args: string[]) =>
    promisify(execFile)('git', args, {
      cwd: root,
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
      },
    });
  await git(['init']);
  await writeFile(path.join(root, 'tracked.txt'), 'before\n');
  await git(['add', 'tracked.txt']);
  await git([
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '--no-verify',
    '-m',
    'fixture',
  ]);
  await writeFile(path.join(root, 'tracked.txt'), 'after\n');
  const original = sandboxProvider('windows');
  const host = sandboxProvider('host');
  const plans = new Set<SandboxPlan>();
  let prepared = 0,
    cleaned = 0,
    started = 0;
  let failCleanupAt = 0;
  registerSandboxProvider({
    ...host,
    mode: 'windows',
    async prepare(request) {
      prepared++;
      const plan = { ...(await host.prepare(request)), backend: 'windows' as const };
      plans.add(plan);
      return plan;
    },
    started(plan) {
      assert.equal(plans.has(plan), true);
      started++;
    },
    async cleanup(plan) {
      assert.equal(plans.has(plan), true);
      plans.delete(plan);
      cleaned++;
      if (cleaned === failCleanupAt) throw new Error('fixture Git native cleanup failed');
    },
  });
  const tools = createTools(root);
  t.after(async () => {
    await tools.close();
    registerSandboxProvider(original);
    await rm(root, { recursive: true, force: true });
  });
  return {
    root,
    tools,
    policy: executionPolicy('windows'),
    counts: () => ({ prepared, started, cleaned }),
    failCleanup(at: number) {
      failCleanupAt = at;
    },
  };
}
