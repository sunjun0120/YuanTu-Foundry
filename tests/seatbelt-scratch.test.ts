import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { SeatbeltScratchRegistry } from '../packages/tools/seatbelt-scratch.ts';

test('unused owned scratch can be removed without trusting mutable plan paths', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yuantu-seatbelt-owner-'));
  const foreign = await mkdtemp(path.join(os.tmpdir(), 'yuantu-seatbelt-foreign-'));
  t.after(() =>
    Promise.all([directory, foreign].map((p) => rm(p, { recursive: true, force: true }))),
  );
  const registry = new SeatbeltScratchRegistry();
  const plan = { cleanupPath: directory };
  registry.register(plan, directory);
  plan.cleanupPath = foreign;
  await registry.cleanup(plan);
  await registry.cleanup(plan);
  await assert.rejects(stat(directory), { code: 'ENOENT' });
  assert.ok((await stat(foreign)).isDirectory());
});

test('executed Seatbelt scratch survives normal cleanup until a real descendant reaper exists', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yuantu-seatbelt-retained-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const registry = new SeatbeltScratchRegistry();
  const plan = {};
  registry.register(plan, directory);
  registry.started(plan);
  await writeFile(path.join(directory, 'guest-data'), 'still owned by the sandbox');
  await registry.cleanup(plan);
  await registry.cleanup(plan);
  assert.equal(
    await readFile(path.join(directory, 'guest-data'), 'utf8'),
    'still owned by the sandbox',
  );
});

test('forged or copied plan cannot start or clean another original plan', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yuantu-seatbelt-forged-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const registry = new SeatbeltScratchRegistry();
  const plan = { cleanupPath: directory };
  registry.register(plan, directory);
  const copy = { ...plan };
  registry.started(copy);
  await registry.cleanup(copy);
  assert.ok((await stat(directory)).isDirectory());
  await registry.cleanup(plan);
  await assert.rejects(stat(directory), { code: 'ENOENT' });
});

test('a plan cannot start while its unused scratch is being released', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yuantu-seatbelt-release-race-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const registry = new SeatbeltScratchRegistry();
  const plan = {};
  registry.register(plan, directory);
  const cleanup = registry.cleanup(plan);
  assert.throws(() => registry.started(plan), /being released/);
  await cleanup;
  assert.throws(() => registry.started(plan), /already released/);
});

test(
  'macOS kernel acceptance rejects other operating systems rather than passing skipped probes',
  { skip: process.platform === 'darwin' && 'asserts the non-macOS failure path' },
  () => {
    const result = spawnSync(process.execPath, ['scripts/check-macos-sandbox.mjs'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: { ...process.env, NODE_TEST_CONTEXT: undefined },
    });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /requires a real macOS host/);
    assert.doesNotMatch(result.stdout, /Running .* test file/);
  },
);
