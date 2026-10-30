import test from 'node:test';
import assert from 'node:assert/strict';
import {
  access,
  chmod,
  copyFile,
  mkdir,
  readFile,
  rename,
  symlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { fixture } from './native-git-fixture.ts';
import { git } from './git-fixture.ts';
import { executionPolicy } from '../packages/sandbox/execution-policy.ts';
import { registerSandboxProvider, sandboxProvider } from '../packages/sandbox/sandbox.ts';
import { nativeGitExecutable } from '../packages/tools/git-native-write.ts';

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

test('native Git stages and commits through approval without changing its execution policy', async (t) => {
  const { root, tools, policy } = await fixture(t);
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
  assert.equal(stage.isError, false, stage.content);
  assert.equal(git(root, ['show', ':tracked.txt']), 'after');
  const commit = await tools.execute(
    { id: 'commit', name: 'git_commit', arguments: { message: 'native write' } },
    context,
  );
  assert.equal(commit.isError, false, commit.content);
  assert.equal(git(root, ['show', 'HEAD:tracked.txt']), 'after');
  assert.equal(approvals, 2);
  assert.equal(context.executionPolicy.mode, 'windows-account');
});

test('native Git denial and read-only policy leave the index and HEAD unchanged', async (t) => {
  const { root, tools, policy } = await fixture(t);
  const index = await readFile(path.join(root, '.git/index'));
  const head = git(root, ['rev-parse', 'HEAD']);
  for (const context of [
    { signal: new AbortController().signal, executionPolicy: policy, approve: async () => false },
    {
      signal: new AbortController().signal,
      executionPolicy: executionPolicy('windows-account', { files: 'read-only' }),
      approve: async () => true,
    },
  ]) {
    const result = await tools.execute(
      { id: 'denied', name: 'git_stage', arguments: { paths: ['tracked.txt'] } },
      context,
    );
    assert.equal(result.isError, true, result.content);
    assert.deepEqual(await readFile(path.join(root, '.git/index')), index);
    assert.equal(git(root, ['rev-parse', 'HEAD']), head);
  }
});

test('native Git unstage restores the index without changing the working file', async (t) => {
  const { root, tools, policy } = await fixture(t);
  git(root, ['add', 'tracked.txt']);
  const result = await tools.execute(
    { id: 'unstage', name: 'git_stage', arguments: { paths: ['tracked.txt'], unstage: true } },
    { signal: new AbortController().signal, executionPolicy: policy, approve: async () => true },
  );
  assert.equal(result.isError, false, result.content);
  assert.equal(git(root, ['show', ':tracked.txt']), 'before');
  assert.equal(await readFile(path.join(root, 'tracked.txt'), 'utf8'), 'after\n');
});

test('native Git refuses a commit when the same staged file changes during approval', async (t) => {
  const { root, tools, policy } = await fixture(t);
  git(root, ['add', 'tracked.txt']);
  const head = git(root, ['rev-parse', 'HEAD']);
  const result = await tools.execute(
    { id: 'commit-race', name: 'git_commit', arguments: { message: 'approved content only' } },
    {
      signal: new AbortController().signal,
      executionPolicy: policy,
      approve: async () => {
        await writeFile(path.join(root, 'tracked.txt'), 'not approved\n');
        git(root, ['add', 'tracked.txt']);
        return true;
      },
    },
  );
  assert.equal(result.isError, true, result.content);
  assert.match(result.content, /changed.*approval|approval.*changed/i);
  assert.equal(git(root, ['rev-parse', 'HEAD']), head);
});

test('native Git never executes repository commit hooks', async (t) => {
  const { root, tools, policy } = await fixture(t);
  git(root, ['add', 'tracked.txt']);
  const marker = path.join(root, 'hook-ran');
  const hook = path.join(root, '.git/hooks/pre-commit');
  await writeFile(hook, '#!/bin/sh\necho unsafe > hook-ran\nexit 1\n');
  await chmod(hook, 0o755);
  const result = await tools.execute(
    { id: 'safe-commit', name: 'git_commit', arguments: { message: 'without hooks' } },
    {
      signal: new AbortController().signal,
      executionPolicy: policy,
      approve: async (approval) => {
        assert.match(approval.description, /hooks.*disabled/i);
        assert.doesNotMatch(approval.description, /Runs sandboxed:/i);
        return true;
      },
    },
  );
  assert.equal(result.isError, false, result.content);
  await assert.rejects(access(marker));
});

test('native Git refuses filtered files without running a clean filter or changing the index', async (t) => {
  const { root, tools, policy } = await fixture(t);
  await writeFile(path.join(root, '.gitattributes'), 'tracked.txt filter=unsafe\n');
  git(root, ['config', 'filter.unsafe.clean', 'echo unsafe > filter-ran']);
  const index = await readFile(path.join(root, '.git/index'));
  const result = await tools.execute(
    { id: 'filter', name: 'git_stage', arguments: { paths: ['.'] } },
    { signal: new AbortController().signal, executionPolicy: policy, approve: async () => true },
  );
  assert.equal(result.isError, true, result.content);
  assert.match(result.content, /filter/i);
  assert.deepEqual(await readFile(path.join(root, '.git/index')), index);
  await assert.rejects(access(path.join(root, 'filter-ran')));
});

test('native Git creates an approved worktree without changing a dirty primary worktree', async (t) => {
  const { root, tools, policy } = await fixture(t);
  const result = await tools.execute(
    {
      id: 'worktree',
      name: 'git_worktree_create',
      arguments: { name: 'native-child', branch: 'feature/native-child' },
    },
    { signal: new AbortController().signal, executionPolicy: policy, approve: async () => true },
  );
  assert.equal(result.isError, false, result.content);
  assert.equal(
    await readFile(path.join(root, '.yuantu/worktrees/native-child/tracked.txt'), 'utf8'),
    'before\n',
  );
  assert.equal(await readFile(path.join(root, 'tracked.txt'), 'utf8'), 'after\n');
});

test('native Git rejects linked metadata before modifying another directory', async (t) => {
  const { root, tools, policy } = await fixture(t);
  const outside = path.join(root, 'outside');
  await mkdir(outside);
  const link = path.join(root, '.git/refs/linked');
  try {
    await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? ''))
      return t.skip('links unavailable');
    throw error;
  }
  const result = await tools.execute(
    { id: 'link', name: 'git_stage', arguments: { paths: ['tracked.txt'] } },
    { signal: new AbortController().signal, executionPolicy: policy, approve: async () => true },
  );
  assert.equal(result.isError, true, result.content);
  assert.match(result.content, /metadata.*link|link.*metadata/i);
});

test('native Git resolves the desktop user global author identity', async (t) => {
  const { root, tools, policy } = await fixture(t);
  git(root, ['config', '--unset', 'user.name']);
  git(root, ['config', '--unset', 'user.email']);
  git(root, ['add', 'tracked.txt']);
  const config = path.join(root, 'global-identity');
  await writeFile(config, '[user]\nname = Global Native\nemail = global@example.invalid\n');
  const previous = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = config;
  t.after(() => {
    if (previous === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = previous;
  });
  const result = await tools.execute(
    { id: 'global', name: 'git_commit', arguments: { message: 'global identity' } },
    { signal: new AbortController().signal, executionPolicy: policy, approve: async () => true },
  );
  assert.equal(result.isError, false, result.content);
  assert.equal(
    git(root, ['log', '-1', '--format=%an <%ae>']),
    'Global Native <global@example.invalid>',
  );
});

test('native Git refuses a commit if HEAD switches branches during approval', async (t) => {
  const { root, tools, policy } = await fixture(t);
  git(root, ['add', 'tracked.txt']);
  const head = git(root, ['rev-parse', 'HEAD']);
  const result = await tools.execute(
    { id: 'head-race', name: 'git_commit', arguments: { message: 'old branch only' } },
    {
      signal: new AbortController().signal,
      executionPolicy: policy,
      approve: async () => {
        git(root, ['checkout', '-b', 'other']);
        return true;
      },
    },
  );
  assert.equal(result.isError, true, result.content);
  assert.match(result.content, /changed.*approval|approval.*changed/i);
  assert.equal(git(root, ['rev-parse', 'HEAD']), head);
});

test('native Git rejects configured filters even when mutable attributes currently do not match', async (t) => {
  const { root, tools, policy } = await fixture(t);
  await writeFile(path.join(root, '.gitattributes'), '*.large filter=unsafe\n');
  git(root, ['config', 'filter.unsafe.clean', 'echo unsafe > filter-ran']);
  const result = await tools.execute(
    { id: 'unfiltered', name: 'git_stage', arguments: { paths: ['tracked.txt'] } },
    { signal: new AbortController().signal, executionPolicy: policy, approve: async () => true },
  );
  assert.equal(result.isError, true, result.content);
  assert.match(result.content, /filter/i);
  assert.equal(git(root, ['show', ':tracked.txt']), 'before');
  await assert.rejects(access(path.join(root, 'filter-ran')));
});

test('native Git refuses mutable included config before a Host metadata write', async (t) => {
  const { root, tools, policy } = await fixture(t);
  const included = path.join(root, 'agent-config');
  await writeFile(included, '');
  git(root, ['config', 'include.path', '../agent-config']);
  const index = await readFile(path.join(root, '.git/index'));
  const result = await tools.execute(
    { id: 'include', name: 'git_stage', arguments: { paths: ['tracked.txt'] } },
    { signal: new AbortController().signal, executionPolicy: policy, approve: async () => true },
  );
  assert.equal(result.isError, true, result.content);
  assert.match(result.content, /include/i);
  assert.deepEqual(await readFile(path.join(root, '.git/index')), index);
});

test('native Git refuses a core.worktree redirect to a different nested repository', async (t) => {
  const { root, tools, policy } = await fixture(t);
  const child = path.join(root, 'nested');
  await mkdir(child);
  git(child, ['init']);
  await writeFile(path.join(child, 'tracked.txt'), 'child\n');
  git(root, ['config', 'core.worktree', child]);
  const result = await tools.execute(
    { id: 'redirect', name: 'git_stage', arguments: { paths: ['tracked.txt'] } },
    { signal: new AbortController().signal, executionPolicy: policy, approve: async () => true },
  );
  assert.equal(result.isError, true, result.content);
  assert.match(result.content, /selected.*root|root.*workspace/i);
  await assert.rejects(access(path.join(child, '.git/index')));
});

test('native Git refuses a worktree whose committed attributes require a checkout filter', async (t) => {
  const { root, tools, policy } = await fixture(t);
  await writeFile(path.join(root, '.gitattributes'), 'tracked.txt filter=unsafe\n');
  git(root, ['add', '.gitattributes']);
  git(root, ['commit', '-m', 'attributes']);
  git(root, ['config', 'filter.unsafe.smudge', 'echo unsafe > filter-ran']);
  const result = await tools.execute(
    {
      id: 'filtered-worktree',
      name: 'git_worktree_create',
      arguments: { name: 'filtered', branch: 'feature/filtered' },
    },
    { signal: new AbortController().signal, executionPolicy: policy, approve: async () => true },
  );
  assert.equal(result.isError, true, result.content);
  assert.match(result.content, /filter/i);
  await assert.rejects(access(path.join(root, '.yuantu/worktrees/filtered')));
  await assert.rejects(access(path.join(root, 'filter-ran')));
});

test('native Git selects a sandbox-compatible executable outside the workspace', async (t) => {
  const { root, tools, policy } = await fixture(t);
  // A PATH-selected Homebrew Git loads dylibs outside Seatbelt's platform read grants.
  // The system launcher and its developer tools are already covered by that policy.
  if (process.platform === 'darwin') assert.equal(await nativeGitExecutable(root), '/usr/bin/git');
  const bin = path.join(root, 'bin');
  await mkdir(bin);
  if (process.platform === 'win32') await copyFile(process.execPath, path.join(bin, 'git.exe'));
  else {
    await writeFile(path.join(bin, 'git'), '#!/bin/sh\nexit 87\n');
    await chmod(path.join(bin, 'git'), 0o755);
  }
  const previousPath = process.env.PATH;
  process.env.PATH = bin + path.delimiter + previousPath;
  t.after(() => {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  });
  const result = await tools.execute(
    { id: 'trusted-program', name: 'git_stage', arguments: { paths: ['tracked.txt'] } },
    { signal: new AbortController().signal, executionPolicy: policy, approve: async () => true },
  );
  assert.equal(result.isError, false, result.content);
});

test('native Git commits an approved split index without reading a mutable private index', async (t) => {
  const { root, tools, policy } = await fixture(t);
  git(root, ['add', 'tracked.txt']);
  git(root, ['update-index', '--split-index']);
  const result = await tools.execute(
    { id: 'split-index', name: 'git_commit', arguments: { message: 'split index' } },
    { signal: new AbortController().signal, executionPolicy: policy, approve: async () => true },
  );
  assert.equal(result.isError, false, result.content);
  assert.equal(git(root, ['show', 'HEAD:tracked.txt']), 'after');
});

test('native worktree creation rechecks its parent after the last sandbox preparation', async (t) => {
  const { root, tools, policy } = await fixture(t);
  const outside = path.join(root, 'outside-target');
  await mkdir(outside);
  const provider = sandboxProvider('windows-account');
  let approved = false;
  let swapped = false;
  registerSandboxProvider({
    ...provider,
    async prepare(request) {
      const plan = await provider.prepare(request);
      if (
        approved &&
        !swapped &&
        request.argv?.includes('config') &&
        request.argv.includes('--list')
      ) {
        const parent = path.join(root, '.yuantu/worktrees');
        await rename(parent, path.join(root, 'saved-parent'));
        await symlink(outside, parent, process.platform === 'win32' ? 'junction' : 'dir');
        swapped = true;
      }
      return plan;
    },
  });
  try {
    const result = await tools.execute(
      {
        id: 'parent-race',
        name: 'git_worktree_create',
        arguments: { name: 'escape', branch: 'feature/escape' },
      },
      {
        signal: new AbortController().signal,
        executionPolicy: policy,
        approve: async () => {
          approved = true;
          return true;
        },
      },
    );
    assert.equal(swapped, true);
    assert.equal(result.isError, true, result.content);
    await assert.rejects(access(path.join(outside, 'escape')));
  } finally {
    registerSandboxProvider(provider);
  }
});
