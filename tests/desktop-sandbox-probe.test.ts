import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SandboxEnvironment } from '../apps/desktop/sandbox-environment.ts';

test('desktop probes use its standalone Node with a sanitized environment', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-desktop-probe-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workerPath = path.join(root, 'probe.mjs');
  await writeFile(
    workerPath,
    `process.stdout.write(JSON.stringify({ availability: process.argv[2] === 'seatbelt' && !process.versions.electron && !process.env.YUANTU_API_KEY ? null : 'wrong probe runtime or environment' }));`,
  );
  const environment = new SandboxEnvironment(
    { YUANTU_API_KEY: 'fixture-only' },
    { nodePath: process.execPath, workerPath },
  );
  assert.equal(await environment.probe('seatbelt'), null);
  assert.equal(environment.known('seatbelt'), true);
  assert.equal(environment.defaultMode, 'native');
});

test('desktop probes report malformed worker output and never change the selected mode', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-desktop-probe-bad-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workerPath = path.join(root, 'probe.mjs');
  await writeFile(workerPath, `process.stdout.write('not a protocol reply');`);
  const environment = new SandboxEnvironment({}, { nodePath: process.execPath, workerPath });
  assert.match((await environment.probe('host')) ?? '', /probe failed/i);
  assert.equal(environment.defaultMode, 'native');
});
