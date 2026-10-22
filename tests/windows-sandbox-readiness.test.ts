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
  assert.doesNotThrow(() => assertWindowsRuntime({ ...runtime, uv: '2.0.0' }));
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
  // A later passing file does not excuse an earlier failing one: the acceptance run prints one summary per
  // file, so the last line is not the only evidence about the run.
  assert.throws(
    () =>
      assertAcceptanceOutput(
        `${summary().replace('pass=5', 'pass=4').replace('fail=0', 'fail=1')}\n${summary()}`,
        0,
      ),
    /acceptance/i,
  );
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

test('protected packaging rejects unsigned, mismatched, overwritten and untimestamped helper assets', async () => {
  const { assertPinnedHelperManifest } = await script('windows-helper-signature.mjs');
  const digest = 'a'.repeat(64);
  const signer = 'b'.repeat(64);
  const manifest = {
    version: 1,
    accountHelperSha256: digest,
    signerSha256: signer,
    timestamped: true,
  };
  const signature = { valid: true, signerSha256: signer, timestamped: true };
  assert.doesNotThrow(() => assertPinnedHelperManifest(manifest, signature, digest));
  for (const [record, signed, hash] of [
    [manifest, { ...signature, valid: false }, digest],
    [manifest, { ...signature, signerSha256: 'c'.repeat(64) }, digest],
    [manifest, signature, 'd'.repeat(64)],
    [{ ...manifest, timestamped: false }, signature, digest],
    [manifest, { ...signature, timestamped: false }, digest],
    [{ ...manifest, accountHelperSha256: undefined }, signature, digest],
    // A manifest from before the account executor pinned only the retired AppContainer helper.
    [
      { version: 1, helperSha256: digest, signerSha256: signer, timestamped: true },
      signature,
      digest,
    ],
  ])
    assert.throws(() => assertPinnedHelperManifest(record, signed, hash), /signed helper/i);
});
test('helper signing without an explicit certificate refuses before building or modifying assets', async () => {
  const helper = new URL('../scripts/sign-windows-sandbox.ps1', import.meta.url);
  assert.ok(existsSync(helper), 'Explicit-certificate signing workflow is missing');
  if (process.platform !== 'win32') return;
  const binary = new URL('../packages/tools/windows-sandbox/yuantu-sandbox.exe', import.meta.url);
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
