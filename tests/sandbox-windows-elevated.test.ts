import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { windowsSandboxProvider } from '../packages/tools/sandbox-windows.ts';

test('a serialized or forged Windows plan cannot delete an arbitrary cleanup directory', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yuantu-forged-cleanup-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await windowsSandboxProvider.cleanup({
    executable: '',
    args: [],
    cwd: directory,
    env: {},
    windowsVerbatimArguments: false,
    backend: 'windows',
    cleanupPath: directory,
  });
  assert.equal((await stat(directory)).isDirectory(), true);
});

test('basic Windows refuses a requested strict read-only policy before availability or ACL mutation', async () => {
  await assert.rejects(
    windowsSandboxProvider.prepare({
      root: process.cwd(),
      cwd: process.cwd(),
      command: 'echo forbidden',
      config: { mode: 'windows', image: '', files: 'read-only' },
    }),
    /cannot enforce strict process read-only/i,
  );
});

test('basic Windows refuses denied network rather than silently starting with network access', async () => {
  await assert.rejects(
    windowsSandboxProvider.prepare({
      root: process.cwd(),
      cwd: process.cwd(),
      command: 'echo forbidden',
      config: { mode: 'windows', image: '', network: 'denied' },
    }),
    /cannot deny network/i,
  );
});
