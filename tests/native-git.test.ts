import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fixture } from './native-git-fixture.ts';

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
