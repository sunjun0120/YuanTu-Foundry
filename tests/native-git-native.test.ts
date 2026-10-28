// @test-serial windows-sandbox: Runs Git under the Windows sandbox account.
import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { executionPolicy } from '../packages/tools/execution-policy.ts';
import { sandboxProvider, registerSandboxProvider } from '../packages/tools/sandbox.ts';
import { fixture } from './native-git-fixture.ts';
import { useAccountTests, nativeAccountTests } from './windows-account-fixture.ts';
import { localExecutionEnvironment } from '../packages/tools/execution-environment.ts';

useAccountTests();

test(
  'real platform sandbox Git status preserves the repository index',
  nativeAccountTests,
  async (t) => {
    const mode = process.platform === 'win32' ? 'windows-account' : 'seatbelt';
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

test(
  'real platform sandbox Git writes preserve ordinary-command metadata denial',
  nativeAccountTests,
  async (t) => {
    const mode = process.platform === 'win32' ? 'windows-account' : 'seatbelt';
    const provider = sandboxProvider(mode);
    const { root, tools } = await fixture(t);
    registerSandboxProvider(provider);
    const policy = executionPolicy(mode, { files: 'workspace-write', network: 'denied' });
    const context = {
      signal: new AbortController().signal,
      approve: async () => true,
      executionPolicy: policy,
    };
    for (const call of [
      { id: 'stage', name: 'git_stage', arguments: { paths: ['tracked.txt'] } },
      { id: 'unstage', name: 'git_stage', arguments: { paths: ['tracked.txt'], unstage: true } },
      { id: 'stage-again', name: 'git_stage', arguments: { paths: ['tracked.txt'] } },
      { id: 'commit', name: 'git_commit', arguments: { message: 'native platform commit' } },
      {
        id: 'worktree',
        name: 'git_worktree_create',
        arguments: { name: 'native', branch: 'feature/native' },
      },
    ]) {
      const result = await tools.execute(call, context);
      assert.equal(result.isError, false, result.content);
    }
    assert.equal(
      await readFile(path.join(root, '.yuantu/worktrees/native/tracked.txt'), 'utf8'),
      'after\n',
    );
    const environment = await localExecutionEnvironment(root, policy);
    const managed = await environment.processes.start(
      'node',
      ['-e', "require('node:fs').writeFileSync('.git/unapproved', 'escape')"],
      '.',
      context.signal,
    );
    managed.child.stdout?.resume();
    managed.child.stderr?.resume();
    assert.notEqual((await managed.closed).code, 0);
    await assert.rejects(access(path.join(root, '.git/unapproved')));
  },
);
