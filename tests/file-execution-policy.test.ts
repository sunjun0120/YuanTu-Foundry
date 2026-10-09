import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileTools } from '../packages/tools/files.ts';
import { ToolRegistry } from '../packages/tools/registry.ts';
import { executionPolicy } from '../packages/tools/execution-policy.ts';

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-file-policy-'));
  const tools = new ToolRegistry();
  for (const tool of fileTools(root)) tools.register(tool);
  t.after(async () => {
    await tools.close();
    assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir()));
    assert.ok(path.basename(root).startsWith('yuantu-file-policy-'));
    await rm(root, { recursive: true, force: true });
  });
  return { root, tools };
}

test('explicit read-only file policy prevents a real file write before approval in every backend', async (t) => {
  const { root, tools } = await fixture(t);
  let approvals = 0;
  for (const mode of ['host', 'windows', 'docker', 'sbx'] as const) {
    const file = `${mode}.txt`;
    const result = await tools.execute(
      { id: mode, name: 'write_file', arguments: { path: file, content: 'fixture' } },
      {
        signal: new AbortController().signal,
        executionPolicy: executionPolicy(mode, { files: 'read-only' }),
        approve: async () => {
          approvals++;
          return true;
        },
      },
    );
    assert.equal(result.isError, true);
    assert.match(result.content, /read.only/i);
    await assert.rejects(readFile(path.join(root, file)), { code: 'ENOENT' });
  }
  assert.equal(approvals, 0);
});

test('container command restrictions leave approved workspace file edits available and denied edits have no effect', async (t) => {
  const { root, tools } = await fixture(t);
  let approvals = 0;
  for (const mode of ['docker', 'sbx'] as const) {
    for (const allowed of [false, true]) {
      const file = `${mode}-${allowed}.txt`;
      const result = await tools.execute(
        { id: file, name: 'write_file', arguments: { path: file, content: 'fixture' } },
        {
          signal: new AbortController().signal,
          executionPolicy: executionPolicy(mode),
          approve: async () => {
            approvals++;
            return allowed;
          },
        },
      );
      assert.equal(result.isError, !allowed, result.content);
      if (allowed) assert.equal(await readFile(path.join(root, file), 'utf8'), 'fixture');
      else await assert.rejects(readFile(path.join(root, file)), { code: 'ENOENT' });
    }
  }
  assert.equal(approvals, 4);
});
