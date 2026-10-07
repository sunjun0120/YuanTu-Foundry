import test from 'node:test';
import assert from 'node:assert/strict';
import { access, chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Approval, ToolContext } from '../packages/protocol/index.ts';
import { gitCommandLine } from '../packages/tools/git.ts';
import { createTools } from '../packages/tools/index.ts';

const execFileAsync = promisify(execFile);
const call = (name: string, args: Record<string, unknown>) => ({
  id: 'call-1',
  name,
  arguments: args,
});
const ctx = (): ToolContext => ({
  signal: new AbortController().signal,
  approve: async () => true,
});
function observing(allow: boolean): {
  context: ToolContext;
  kinds: string[];
  descriptions: string[];
} {
  const kinds: string[] = [];
  const descriptions: string[] = [];
  return {
    kinds,
    descriptions,
    context: {
      signal: new AbortController().signal,
      approve: async (approval: Approval) => {
        kinds.push(approval.kind);
        descriptions.push(approval.description);
        return allow;
      },
    },
  };
}

async function repository(t: test.TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-gitwrite-'));
  const tools = createTools(root);
  t.after(async () => {
    await tools.close();
    await rm(root, { recursive: true, force: true });
  });
  await execFileAsync('git', ['init'], { cwd: root });
  await execFileAsync('git', ['config', 'user.name', 'Agent Test'], { cwd: root });
  await execFileAsync('git', ['config', 'user.email', 'agent@example.invalid'], { cwd: root });
  return { root, tools };
}

test('git command line pins the safe directory and disables external diff helpers', () => {
  const command = gitCommandLine('C:\\work\\repo');
  assert.ok(
    command.includes('safe.directory=C:/work/repo'),
    'a Windows path must reach Git with forward slashes so it cannot read them as escapes',
  );
  assert.ok(command.includes('diff.external='));
  assert.ok(command.includes('core.fsmonitor=false'));
  assert.ok(command.includes('--no-pager'));
});

test('git_log reports an unborn branch instead of failing', async (t) => {
  const { tools } = await repository(t);
  const log = await tools.execute(call('git_log', {}), ctx());
  assert.equal(log.isError, false, log.content);
  assert.equal(log.content, 'No commits');
});

test('git_stage and git_commit create a real commit that git_log then reports', async (t) => {
  const { root, tools } = await repository(t);
  await writeFile(path.join(root, 'a.txt'), 'hello\n');
  await writeFile(path.join(root, 'b.txt'), 'world\n');

  const stage = await tools.execute(call('git_stage', { paths: ['a.txt', 'b.txt'] }), ctx());
  assert.equal(stage.isError, false, stage.content);
  assert.match(stage.content, /a\.txt/);
  assert.match(stage.content, /Staged now \(2\)/);

  const commit = await tools.execute(
    call('git_commit', { message: 'feat: add a and b\n\nBody text.' }),
    ctx(),
  );
  assert.equal(commit.isError, false, commit.content);
  assert.match(commit.content, /HEAD is now [0-9a-f]{7,}/);

  const log = await tools.execute(call('git_log', { count: 5 }), ctx());
  assert.equal(log.isError, false, log.content);
  assert.match(log.content, /feat: add a and b/);

  const verbose = await tools.execute(call('git_log', { verbose: true }), ctx());
  assert.match(verbose.content, /Body text\./);

  const status = await tools.execute(call('git_status', {}), ctx());
  assert.ok(!status.content.includes('a.txt'), status.content);
});

test('git_log filters by repository-relative paths', async (t) => {
  const { root, tools } = await repository(t);
  await writeFile(path.join(root, 'one.txt'), '1\n');
  await tools.execute(call('git_stage', { paths: ['one.txt'] }), ctx());
  await tools.execute(call('git_commit', { message: 'first' }), ctx());
  await writeFile(path.join(root, 'two.txt'), '2\n');
  await tools.execute(call('git_stage', { paths: ['two.txt'] }), ctx());
  await tools.execute(call('git_commit', { message: 'second' }), ctx());

  const scoped = await tools.execute(call('git_log', { paths: ['one.txt'] }), ctx());
  assert.match(scoped.content, /first/);
  assert.ok(!scoped.content.includes('second'), scoped.content);
});

test('a new branch gets an isolated contained worktree without switching a dirty workspace', async (t) => {
  const { root, tools } = await repository(t);
  await writeFile(path.join(root, 'tracked.txt'), 'base\n');
  await tools.execute(call('git_stage', { paths: ['tracked.txt'] }), ctx());
  await tools.execute(call('git_commit', { message: 'base' }), ctx());
  const originalBranch = (
    await execFileAsync('git', ['branch', '--show-current'], { cwd: root })
  ).stdout.trim();
  await writeFile(path.join(root, 'tracked.txt'), 'dirty\n');

  const denied = observing(false);
  const deniedResult = await tools.execute(
    call('git_worktree_create', { branch: 'feature/delivery', name: 'delivery' }),
    denied.context,
  );
  assert.equal(deniedResult.isError, true);
  assert.deepEqual(denied.kinds, ['command']);
  assert.match(denied.descriptions[0]!, /feature\/delivery/);
  await assert.rejects(access(path.join(root, '.yuantu', 'worktrees', 'delivery')));

  const created = await tools.execute(
    call('git_worktree_create', { branch: 'feature/delivery', name: 'delivery' }),
    ctx(),
  );
  assert.equal(created.isError, false, created.content);
  const childRoot = path.join(root, '.yuantu', 'worktrees', 'delivery');
  assert.equal(await readFile(path.join(childRoot, 'tracked.txt'), 'utf8'), 'base\n');
  assert.equal(await readFile(path.join(root, 'tracked.txt'), 'utf8'), 'dirty\n');
  assert.equal(
    (await execFileAsync('git', ['branch', '--show-current'], { cwd: root })).stdout.trim(),
    originalBranch,
  );
  assert.match(
    (await tools.execute(call('git_worktrees', {}), ctx())).content,
    /feature\/delivery/,
  );
  assert.match((await tools.execute(call('git_branches', {}), ctx())).content, /feature\/delivery/);

  const childTools = createTools(childRoot);
  t.after(() => childTools.close());
  const childStatus = await childTools.execute(call('git_status', {}), ctx());
  assert.equal(childStatus.isError, false, childStatus.content);
  assert.match(childStatus.content, /feature\/delivery/);
});

test('worktree creation rejects invalid names and an occupied target before approval', async (t) => {
  const { root, tools } = await repository(t);
  await writeFile(path.join(root, 'tracked.txt'), 'base\n');
  await tools.execute(call('git_stage', { paths: ['tracked.txt'] }), ctx());
  await tools.execute(call('git_commit', { message: 'base' }), ctx());
  let approvals = 0;
  const context = {
    ...ctx(),
    approve: async () => {
      approvals++;
      return true;
    },
  };
  for (const args of [
    { branch: 'feature/escape', name: '../escape' },
    { branch: '-bad', name: 'bad' },
    { branch: 'feature/nested', name: 'bad/nested' },
  ]) {
    const result = await tools.execute(call('git_worktree_create', args), context);
    assert.equal(result.isError, true, result.content);
  }
  assert.equal(approvals, 0);
  await assert.rejects(access(path.join(root, '.yuantu', 'worktrees', 'bad')));
});

test('git_commit refuses when nothing is staged', async (t) => {
  const { tools } = await repository(t);
  const commit = await tools.execute(call('git_commit', { message: 'nothing' }), ctx());
  assert.equal(commit.isError, true);
  assert.match(commit.content, /Nothing is staged/);
});

test('git_commit requires command approval and denial commits nothing', async (t) => {
  const { root, tools } = await repository(t);
  await writeFile(path.join(root, 'c.txt'), 'c\n');
  await tools.execute(call('git_stage', { paths: ['c.txt'] }), ctx());

  const denied = observing(false);
  const result = await tools.execute(
    call('git_commit', { message: 'should not happen' }),
    denied.context,
  );
  assert.equal(result.isError, true);
  assert.deepEqual(denied.kinds, ['command']);
  assert.match(denied.descriptions[0]!, /should not happen/);
  assert.match(denied.descriptions[0]!, /c\.txt/);
  assert.match(denied.descriptions[0]!, /Agent Test <agent@example\.invalid>/);

  assert.equal((await tools.execute(call('git_log', {}), ctx())).content, 'No commits');
  const status = await tools.execute(call('git_status', {}), ctx());
  assert.match(status.content, /c\.txt/);
});

test('git_stage rejects paths that leave the repository', async (t) => {
  const { tools } = await repository(t);
  for (const paths of [['../outside'], ['a/../../b'], ['/etc/passwd'], [':(glob)*']]) {
    const result = await tools.execute(call('git_stage', { paths }), ctx());
    assert.equal(result.isError, true, `expected rejection for ${paths.join()}`);
  }
  const empty = await tools.execute(call('git_stage', { paths: [] }), ctx());
  assert.equal(empty.isError, true);
});

test('git_stage unstage clears the index entry', async (t) => {
  const { root, tools } = await repository(t);
  await writeFile(path.join(root, 'u.txt'), 'u\n');
  await tools.execute(call('git_stage', { paths: ['u.txt'] }), ctx());
  const unstage = await tools.execute(
    call('git_stage', { paths: ['u.txt'], unstage: true }),
    ctx(),
  );
  assert.equal(unstage.isError, false, unstage.content);
  assert.match(unstage.content, /Nothing is staged/);
});

test('git_commit runs repository hooks by default and no_verify skips them', async (t) => {
  const { root, tools } = await repository(t);
  await writeFile(path.join(root, 'h.txt'), 'h\n');
  await tools.execute(call('git_stage', { paths: ['h.txt'] }), ctx());

  const hook = path.join(root, '.git', 'hooks', 'pre-commit');
  await writeFile(hook, '#!/bin/sh\necho blocked-by-hook >&2\nexit 1\n');
  await chmod(hook, 0o755);

  const blocked = await tools.execute(call('git_commit', { message: 'blocked' }), ctx());
  if (!blocked.isError) return t.skip('this Git installation does not execute repository hooks');
  assert.match(blocked.content, /blocked-by-hook/);

  const forced = await tools.execute(
    call('git_commit', { message: 'forced', no_verify: true }),
    ctx(),
  );
  assert.equal(forced.isError, false, forced.content);
  assert.match((await tools.execute(call('git_log', {}), ctx())).content, /forced/);
});

test('git_commit refuses repositories that require GPG signing', async (t) => {
  const { root, tools } = await repository(t);
  await execFileAsync('git', ['config', 'commit.gpgsign', 'true'], { cwd: root });
  await writeFile(path.join(root, 'g.txt'), 'g\n');
  await tools.execute(call('git_stage', { paths: ['g.txt'] }), ctx());
  const commit = await tools.execute(call('git_commit', { message: 'signed' }), ctx());
  assert.equal(commit.isError, true);
  assert.match(commit.content, /gpgsign/);
});

test('git_commit refuses when no author identity resolves', async (t) => {
  const { root, tools } = await repository(t);
  await execFileAsync('git', ['config', 'user.name', ''], { cwd: root });
  await execFileAsync('git', ['config', 'user.email', ''], { cwd: root });
  await writeFile(path.join(root, 'n.txt'), 'n\n');
  await tools.execute(call('git_stage', { paths: ['n.txt'] }), ctx());
  const commit = await tools.execute(call('git_commit', { message: 'no identity' }), ctx());
  assert.equal(commit.isError, true);
  assert.match(commit.content, /identity is not configured/);
});

test('git_commit rejects an empty or oversized message', async (t) => {
  const { root, tools } = await repository(t);
  await writeFile(path.join(root, 'm.txt'), 'm\n');
  await tools.execute(call('git_stage', { paths: ['m.txt'] }), ctx());
  for (const message of ['', '   ', 'x'.repeat(8_001)]) {
    const commit = await tools.execute(call('git_commit', { message }), ctx());
    assert.equal(commit.isError, true, `expected rejection for ${message.length} chars`);
  }
});
