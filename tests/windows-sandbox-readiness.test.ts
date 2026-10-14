import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

async function script(name: string) {
  const url = new URL(`../scripts/${name}`, import.meta.url);
  assert.ok(existsSync(url), `Required Windows acceptance module is missing: ${name}`);
  return import(url.href);
}

const runtime = { platform: 'win32', arch: 'x64', nodeVersion: '24.19.0', uv: '1.52.1' };

test('Windows packaging validates runtime identity without a future libuv version gate', async () => {
  const { assertWindowsRuntime } = await script('windows-runtime.mjs');
  assert.doesNotThrow(() => assertWindowsRuntime({ ...runtime, uv: '1.52.1' }));
  assert.doesNotThrow(() => assertWindowsRuntime(runtime, { enhanced: true }));
  for (const uv of [undefined, 'unknown', '1.52'])
    assert.throws(() => assertWindowsRuntime({ ...runtime, uv }, { enhanced: true }), /identity/i);
  for (const changed of [
    { platform: 'linux' },
    { arch: 'arm64' },
    { nodeVersion: '23.0.0' },
    { electron: '42.0.0' },
  ])
    assert.throws(() => assertWindowsRuntime({ ...runtime, ...changed }), /Windows x64.*Node/);
});

test('Windows runtime inspection uses the selected executable and excludes Node injection flags', async () => {
  const { inspectWindowsRuntime } = await script('windows-runtime.mjs');
  const inspected = await inspectWindowsRuntime(process.execPath, {
    ...process.env,
    NODE_OPTIONS: '--require=THIS_MUST_NOT_EXECUTE',
  });
  assert.equal(inspected.nodeVersion, process.versions.node);
  assert.equal(inspected.uv, process.versions.uv);
  assert.equal(inspected.platform, process.platform);
});

test('Windows runtime preparation records inspected runtime identity and protects old files on rejection', async (t) => {
  assert.match(
    await readFile(new URL('../scripts/prepare-windows-package.mjs', import.meta.url), 'utf8'),
    /export async function prepareWindowsRuntime/,
    'Packaging must expose a side-effect-free import before it can be tested',
  );
  const { prepareWindowsRuntime } = await script('prepare-windows-package.mjs');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yuantu-windows-runtime-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const output = path.join(directory, 'runtime');
  await mkdir(output);
  const sentinel = path.join(output, 'node.exe');
  await writeFile(sentinel, 'previous runtime');
  const license = 'Node.js is licensed for use as follows:\nfixture license\n';
  await writeFile(path.join(output, 'LICENSE.node'), license);
  await writeFile(
    path.join(output, 'runtime.json'),
    JSON.stringify({
      nodeVersion: process.versions.node,
      licenseUrl: `https://raw.githubusercontent.com/nodejs/node/v${process.versions.node}/LICENSE`,
      licenseSha256: createHash('sha256').update(license).digest('hex'),
    }),
  );
  if (process.platform !== 'win32' || process.arch !== 'x64') {
    await assert.rejects(prepareWindowsRuntime({ directory: output }), /Windows x64/);
  } else {
    await assert.rejects(
      prepareWindowsRuntime({ directory: output, executable: path.join(directory, 'missing.exe') }),
    );
    assert.equal(await readFile(sentinel, 'utf8'), 'previous runtime');
    const result = await prepareWindowsRuntime({ directory: output, executable: process.execPath });
    assert.equal(result.nodeVersion, process.versions.node);
    assert.equal(result.uvVersion, process.versions.uv);
    const manifest = JSON.parse(await readFile(path.join(output, 'runtime.json'), 'utf8'));
    assert.equal(
      manifest.sha256,
      createHash('sha256')
        .update(await readFile(sentinel))
        .digest('hex'),
    );
    assert.equal(manifest.uvVersion, process.versions.uv);
    assert.equal(manifest.enhancedCompatible, null);
    assert.equal(manifest.enhancedCompatibilityChecked, false);
  }
});

test('real Windows acceptance rejects skipped, empty, cancelled, todo and incomplete runs', async () => {
  const { assertAcceptanceOutput } = await script('check-windows-sandbox.mjs');
  const summary = (extra = '') =>
    `Tests: 5 pass=5 fail=0 skip=0 cancelled=0 todo=0 duration=1.00s${extra}`;
  assert.equal(assertAcceptanceOutput(summary(), 0).tests, 5);
  for (const invalid of [
    '',
    summary().replace('skip=0', 'skip=1'),
    summary().replace('cancelled=0', 'cancelled=1'),
    summary().replace('todo=0', 'todo=1'),
    summary().replace('fail=0', 'fail=1'),
    summary().replace('Tests: 5 pass=5', 'Tests: 0 pass=0'),
  ])
    assert.throws(() => assertAcceptanceOutput(invalid, 0), /acceptance/i);
  assert.throws(() => assertAcceptanceOutput(summary(), 1), /acceptance/i);
});

test('Windows acceptance refuses leftover leases and newly retained or changed ACL journals', async () => {
  const { assertStateRestored } = await script('check-windows-sandbox.mjs');
  const before = { locks: [], journals: { 'existing.json': 'original' } };
  assert.doesNotThrow(() => assertStateRestored(before, before));
  assert.throws(
    () => assertStateRestored(before, { ...before, locks: ['workspace-owner.lock'] }),
    /state/i,
  );
  assert.throws(
    () =>
      assertStateRestored(before, {
        locks: [],
        journals: { ...before.journals, 'new.json': 'retained' },
      }),
    /state/i,
  );
  assert.throws(
    () => assertStateRestored(before, { locks: [], journals: { 'existing.json': 'changed' } }),
    /state/i,
  );
});

test('AppContainer pipe diagnostics require observed child exit and actual channel contents', async () => {
  const { assessPipeScenario } = await script('check-windows-appcontainer-pipes.mjs');
  const result = {
    exitCode: 0,
    cancelled: false,
    stages: [{ stage: 'returned', status: 0, stdout: 'pipe-output' }],
  };
  assert.equal(assessPipeScenario('pipe-sync-output', result), true);
  for (const invalid of [
    { ...result, cancelled: true },
    { ...result, exitCode: 1 },
    { ...result, stages: [{ stage: 'before-spawn' }] },
    { ...result, stages: [{ stage: 'returned', status: 1, stdout: 'pipe-output' }] },
    { ...result, stages: [{ stage: 'returned', status: 0, stdout: '' }] },
  ])
    assert.equal(assessPipeScenario('pipe-sync-output', invalid), false);
  assert.equal(assessPipeScenario('unknown', result), false);
});

test('AppContainer readiness separates initialization prerequisites from actual enforcement acceptance', async () => {
  const { evaluateReadiness } = await script('check-windows-appcontainer.mjs');
  const prerequisites = {
    platform: 'win32',
    runtime: { validated: true, compatible: null, uv: '1.52.1' },
    signature: { valid: true, timestamped: true },
    signedAssets: { validated: true },
    preflight: { passed: true },
    policy: { installed: true },
    publicMode: false,
    functionalAcceptance: false,
  };
  const report = evaluateReadiness(prerequisites);
  assert.equal(report.canInitialize, true);
  assert.equal(report.readyForAcceptance, true);
  assert.equal(report.canEnable, false);
  assert.deepEqual(report.blockers, ['runtime-capability', 'public-mode', 'functional-acceptance']);
  const accepted = { ...prerequisites, publicMode: true, functionalAcceptance: true };
  assert.equal(evaluateReadiness(accepted).canEnable, false);
  assert.equal(
    evaluateReadiness({ ...accepted, runtime: { ...accepted.runtime, compatible: true } })
      .canEnable,
    true,
  );
  const unavailable = evaluateReadiness({
    ...prerequisites,
    runtime: { validated: false, compatible: null },
    signature: { valid: false },
  });
  assert.equal(unavailable.canInitialize, false);
  assert.ok(unavailable.blockers.includes('runtime'));
  assert.ok(unavailable.blockers.includes('helper-signature'));
  for (const missing of [
    { ...prerequisites, signature: { valid: true, timestamped: false } },
    { ...prerequisites, signedAssets: { validated: false } },
  ]) {
    assert.equal(evaluateReadiness(missing).canInitialize, false);
  }
});

test('enhanced packaging rejects unsigned, mismatched, overwritten and untimestamped helper assets', async () => {
  const { assertPinnedHelperManifest } = await script('check-windows-appcontainer.mjs');
  const digest = 'a'.repeat(64);
  const signer = 'b'.repeat(64);
  const manifest = { version: 1, helperSha256: digest, signerSha256: signer, timestamped: true };
  const signature = { valid: true, signerSha256: signer, timestamped: true };
  assert.doesNotThrow(() => assertPinnedHelperManifest(manifest, signature, digest));
  for (const [record, signed, hash] of [
    [manifest, { ...signature, valid: false }, digest],
    [manifest, { ...signature, signerSha256: 'c'.repeat(64) }, digest],
    [manifest, signature, 'd'.repeat(64)],
    [{ ...manifest, timestamped: false }, signature, digest],
    [manifest, { ...signature, timestamped: false }, digest],
  ])
    assert.throws(() => assertPinnedHelperManifest(record, signed, hash), /signed helper/i);
});

test('helper signing without an explicit certificate refuses before building or modifying assets', async () => {
  const helper = new URL('../scripts/sign-windows-sandbox.ps1', import.meta.url);
  assert.ok(existsSync(helper), 'Explicit-certificate signing workflow is missing');
  if (process.platform !== 'win32') return;
  const binary = new URL(
    '../packages/tools/windows-sandbox/yuantu-appcontainer.exe',
    import.meta.url,
  );
  const before = existsSync(binary) ? await readFile(binary) : undefined;
  await assert.rejects(
    promisify(execFile)('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      fileURLToPath(helper),
      '-Check',
    ]),
    (error: unknown) => {
      const result = error as { stderr: string; code: number };
      assert.equal(result.code, 2);
      assert.match(result.stderr, /certificate/i);
      return true;
    },
  );
  if (before) assert.deepEqual(await readFile(binary), before);
});
