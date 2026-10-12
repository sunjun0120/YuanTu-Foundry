import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createTools } from '../packages/tools/index.ts';
import { executionPolicy } from '../packages/tools/execution-policy.ts';
import {
  sandboxProvider,
  registerSandboxProvider,
  type SandboxPlan,
} from '../packages/tools/sandbox.ts';

async function fixture(t: test.TestContext) {
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

test('native Git reads use the owned execution environment and preserve repository metadata', async (t) => {
  const { root, tools, policy, counts } = await fixture(t);
  const index = await readFile(path.join(root, '.git/index'));
  const context = {
    signal: new AbortController().signal,
    approve: async () => true,
    executionPolicy: policy,
  };
  const status = await tools.execute({ id: 'status', name: 'git_status', arguments: {} }, context);
  assert.equal(status.isError, false, status.content);
  assert.match(status.content, /tracked\.txt/);
  const diff = await tools.execute(
    { id: 'diff', name: 'git_diff', arguments: { paths: ['tracked.txt'] } },
    context,
  );
  assert.equal(diff.isError, false, diff.content);
  assert.match(diff.content, /\+after/);
  assert.deepEqual(await readFile(path.join(root, '.git/index')), index);
  assert.deepEqual(counts(), { prepared: 6, started: 6, cleaned: 6 });
});

test('native Git log does not report an empty history after owner cleanup fails', async (t) => {
  const { tools, policy, failCleanup } = await fixture(t);
  // Discovery uses two commands; the third verifies HEAD inside git_log.
  failCleanup(3);
  await assert.rejects(
    tools.execute(
      { id: 'log', name: 'git_log', arguments: {} },
      {
        signal: new AbortController().signal,
        approve: async () => true,
        executionPolicy: policy,
      },
    ),
    { name: 'ToolCleanupError', message: /fixture Git native cleanup failed/ },
  );
});

test('native Git metadata mutations fail before approval or process launch', async (t) => {
  const { tools, policy, counts } = await fixture(t);
  let approvals = 0;
  const context = {
    signal: new AbortController().signal,
    approve: async () => {
      approvals++;
      return true;
    },
    executionPolicy: policy,
  };
  const stage = await tools.execute(
    { id: 'stage', name: 'git_stage', arguments: { paths: ['tracked.txt'] } },
    context,
  );
  assert.equal(stage.isError, true);
  assert.match(stage.content, /protected.*metadata/i);
  assert.equal(approvals, 0);
  assert.deepEqual(counts(), { prepared: 0, started: 0, cleaned: 0 });
});

test(
  'real platform sandbox Git status preserves the repository index',
  { skip: process.platform !== 'win32' && process.platform !== 'darwin', timeout: 120000 },
  async (t) => {
    const mode = process.platform === 'win32' ? 'windows' : 'seatbelt';
    const provider = sandboxProvider(mode);
    const { root, tools } = await fixture(t);
    registerSandboxProvider(provider);
    const index = await readFile(path.join(root, '.git/index'));
    const policy = executionPolicy(mode, {
      files: process.platform === 'darwin' ? 'read-only' : 'workspace-write',
      network: process.platform === 'darwin' ? 'denied' : 'unrestricted',
    });
    const result = await tools.execute(
      { id: 'native-status', name: 'git_status', arguments: {} },
      {
        signal: new AbortController().signal,
        approve: async () => true,
        executionPolicy: policy,
      },
    );
    assert.equal(result.isError, false, result.content);
    assert.match(result.content, /tracked\.txt/);
    assert.deepEqual(await readFile(path.join(root, '.git/index')), index);
  },
);
