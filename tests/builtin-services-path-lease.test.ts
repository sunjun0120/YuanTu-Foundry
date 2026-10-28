import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rename, symlink } from 'node:fs/promises';
import path from 'node:path';
import { PathLease } from '../packages/builtin-services/path-lease.ts';
import { tempRoot } from './temp-fixture.ts';

test(
  'a held parent cannot be replaced and junctions are rejected',
  { skip: process.platform !== 'win32' ? 'Windows path leases' : false },
  async (t) => {
    const root = await tempRoot(t);
    const outside = await tempRoot(t);
    const directory = path.join(root, 'folder');
    await mkdir(directory);
    const lease = await PathLease.open();
    try {
      await lease.lockDirectory(root);
      await lease.lockDirectory(directory);
      await assert.rejects(rename(directory, path.join(root, 'moved')));
      const link = path.join(root, 'linked');
      await symlink(outside, link, 'junction');
      await assert.rejects(lease.lockDirectory(link), /link|reparse/i);
    } finally {
      await lease.close();
    }
  },
);

test(
  'unsupported platforms reject secure filesystem access',
  { skip: process.platform === 'win32' ? 'Windows implements secure path leases' : false },
  async () => {
    await assert.rejects(PathLease.open(), /unavailable/);
  },
);

test(
  'read and create operations fail if the lease helper exits',
  { skip: process.platform !== 'win32' ? 'Windows path leases' : false },
  async (t) => {
    const root = await tempRoot(t);
    const { writeFile, stat } = await import('node:fs/promises');
    const file = path.join(root, 'source.txt');
    await writeFile(file, 'safe');
    const lease = await PathLease.open();
    try {
      await lease.lockDirectory(root);
      await lease.lockFile(file);
      const child = (lease as unknown as { child: import('node:child_process').ChildProcess })
        .child;
      const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
      child.kill();
      await exited;
      await assert.rejects(lease.readFile(file));
      await assert.rejects(lease.createFile(path.join(root, 'created'), Buffer.from('x')));
      await assert.rejects(stat(path.join(root, 'created')), { code: 'ENOENT' });
    } finally {
      await lease.close();
    }
  },
);

test(
  'an aborted lease cannot issue filesystem operations',
  { skip: process.platform !== 'win32' ? 'Windows path leases' : false },
  async (t) => {
    const root = await tempRoot(t);
    const controller = new AbortController();
    const lease = await PathLease.open(controller.signal);
    try {
      await lease.lockDirectory(root);
      controller.abort();
      await assert.rejects(lease.mkdir(path.join(root, 'not-created')));
    } finally {
      await lease.close();
    }
  },
);

test(
  'protected file operations preserve binary payloads',
  { skip: process.platform !== 'win32' ? 'Windows path leases' : false },
  async (t) => {
    const root = await tempRoot(t);
    const lease = await PathLease.open();
    try {
      await lease.lockDirectory(root);
      const expected = Buffer.alloc(1024 * 1024, 0xab);
      const target = path.join(root, 'payload.bin');
      await lease.createFile(target, expected);
      await lease.lockFile(target);
      assert.deepEqual(await lease.readFile(target), expected);
    } finally {
      await lease.close();
    }
  },
);

test(
  'a read is refused when the file at the path is not the one the lease holds',
  { skip: process.platform !== 'win32' ? 'Windows path leases' : false },
  async (t) => {
    const root = await tempRoot(t);
    const { writeFile } = await import('node:fs/promises');
    const file = path.join(root, 'source.txt');
    await writeFile(file, 'safe');
    const lease = await PathLease.open();
    try {
      await lease.lockFile(file);
      assert.equal((await lease.readFile(file)).toString(), 'safe');
      // The lease keeps the path from being swapped, so a swap is simulated by making the held identity disagree.
      const held = (lease as unknown as { files: Map<string, { volume: bigint; index: bigint }> })
        .files;
      for (const identity of held.values()) identity.index += 1n;
      await assert.rejects(lease.readFile(file), /changed/);
    } finally {
      await lease.close();
    }
  },
);

test(
  'missing helper fails promptly',
  { skip: process.platform !== 'win32' ? 'Windows path leases' : false },
  async (t) => {
    const root = await tempRoot(t);
    const lease = await PathLease.open(undefined, path.join(root, 'missing-helper.exe'));
    try {
      await assert.rejects(lease.lockDirectory(root));
    } finally {
      await lease.close();
    }
  },
);
