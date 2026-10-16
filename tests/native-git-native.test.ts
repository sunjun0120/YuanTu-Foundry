// @test-serial windows-sandbox: Runs Git in the actual Windows token and ACL sandbox.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { executionPolicy } from '../packages/tools/execution-policy.ts';
import { sandboxProvider, registerSandboxProvider } from '../packages/tools/sandbox.ts';
import { fixture } from './native-git-fixture.ts';

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
