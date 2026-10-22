import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
test('native helper staging refuses an output outside project scratch before building', async () => {
  await assert.rejects(
    promisify(execFile)(
      process.execPath,
      [
        path.resolve('scripts/build-windows-sandbox.mjs'),
        `--output-directory=${path.parse(process.cwd()).root}`,
      ],
      { windowsHide: true },
    ),
    /staged helper output.*scratch/i,
  );
});
async function moduleScript(name: string) {
  const url = new URL(`../scripts/${name}`, import.meta.url);
  assert.ok(existsSync(url), `Required product runtime module missing: ${name}`);
  return import(url.href);
}

test('candidate validation rejects changed binary, license and non-official runtimes', async (t) => {
  const { validateRuntimeCandidate } = await moduleScript('windows-runtime-product.mjs');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yuantu-candidate-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const binary = 'test binary';
  const license = 'Node.js is licensed for use as follows:\ncomplete fixture\n';
  const provenance = {
    profile: 'official',
    source: { signedChecksumsVerified: true },
    binary: { sha256: digest(binary), licenseSHA256: digest(license) },
  };
  const write = (value: object) =>
    writeFile(path.join(directory, 'provenance.json'), JSON.stringify(value));
  await writeFile(path.join(directory, 'node.exe'), binary);
  await writeFile(path.join(directory, 'LICENSE'), license);
  await write(provenance);
  assert.equal((await validateRuntimeCandidate(directory)).sha256, digest(binary));
  for (const changed of [
    { ...provenance, profile: 'diagnostic' },
    { ...provenance, source: { signedChecksumsVerified: false } },
  ]) {
    await write(changed);
    await assert.rejects(validateRuntimeCandidate(directory), /official/i);
  }
  await write(provenance);
  await writeFile(path.join(directory, 'node.exe'), 'tampered');
  await assert.rejects(validateRuntimeCandidate(directory), /binary.*hash/i);
  await writeFile(path.join(directory, 'node.exe'), binary);
  await writeFile(path.join(directory, 'LICENSE'), license + 'tampered');
  await assert.rejects(validateRuntimeCandidate(directory), /license.*hash/i);
});

test('only the locked official release bytes are an official candidate', async () => {
  const { assertOfficialCandidate, lock } = await moduleScript('fetch-windows-runtime.mjs');
  const provenance = {
    source: {
      version: lock.nodeVersion,
      sha256: lock.archive.sha256,
      releaseSigner: lock.releaseSigner,
    },
    binary: { sha256: lock.executableSha256, licenseSHA256: lock.licenseSha256 },
  };
  assert.doesNotThrow(() => assertOfficialCandidate({ provenance }));
  const rebuilt = {
    ...provenance,
    binary: { ...provenance.binary, sha256: 'c'.repeat(64), upstreamSha256: lock.executableSha256 },
  };
  assert.throws(() => assertOfficialCandidate({ provenance: rebuilt }), /locked official/i);
  for (const changed of [
    { ...provenance, source: { ...provenance.source, version: '24.0.0' } },
    { ...provenance, source: { ...provenance.source, sha256: 'd'.repeat(64) } },
    { ...provenance, source: { ...provenance.source, releaseSigner: 'E'.repeat(40) } },
    { ...provenance, binary: { ...provenance.binary, sha256: 'e'.repeat(64) } },
    { ...provenance, binary: { ...provenance.binary, licenseSHA256: 'f'.repeat(64) } },
  ])
    assert.throws(() => assertOfficialCandidate({ provenance: changed }), /locked official/i);
});
test('packaged runtime validation checks bytes and provenance, not only version strings', async (t) => {
  const { validatePackagedWindowsRuntime } = await moduleScript('windows-runtime-product.mjs');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yuantu-package-runtime-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const binary = 'binary',
    license = 'license',
    provenance = '{"profile":"official"}';
  await mkdir(path.join(directory, 'runtime'));
  const runtime = path.join(directory, 'runtime');
  for (const [name, contents] of Object.entries({
    'node.exe': binary,
    'LICENSE.node': license,
    'provenance.json': provenance,
    'runtime.json': JSON.stringify({
      sha256: digest(binary),
      licenseSha256: digest(license),
      provenanceSha256: digest(provenance),
      selection: 'candidate',
      profile: 'official',
    }),
  }))
    await writeFile(path.join(runtime, name), contents);
  assert.equal((await validatePackagedWindowsRuntime(runtime)).selection, 'candidate');
  await writeFile(path.join(runtime, 'node.exe'), 'wrong binary with same version');
  await assert.rejects(validatePackagedWindowsRuntime(runtime), /node.exe.*hash/i);
  await writeFile(path.join(runtime, 'node.exe'), binary);
  await writeFile(path.join(runtime, 'provenance.json'), '{}');
  await assert.rejects(validatePackagedWindowsRuntime(runtime), /provenance.*hash/i);
});

test('source lock verification rejects modified cached archives before extraction', async (t) => {
  const { verifyLockedFile } = await moduleScript('fetch-windows-runtime.mjs');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yuantu-source-lock-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'archive');
  await writeFile(file, 'modified archive');
  await assert.rejects(verifyLockedFile(file, digest('original archive')), /hash/i);
  assert.equal(await readFile(file, 'utf8'), 'modified archive');
});

test(
  'candidate packaging consumes local provenance and license and rejects tampering before publishing',
  { skip: process.platform !== 'win32' && 'needs Windows' },
  async (t) => {
    const { prepareWindowsRuntime } = await moduleScript('prepare-windows-package.mjs');
    const root = await mkdtemp(path.join(os.tmpdir(), 'yuantu-local-candidate-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const candidate = path.join(root, 'candidate'),
      output = path.join(root, 'runtime');
    await mkdir(candidate);
    const binary = await readFile(process.execPath);
    const license = 'Node.js is licensed for use as follows:\nlocal fixture license\n';
    const provenance = JSON.stringify({
      profile: 'official',
      source: { signedChecksumsVerified: true },
      binary: { sha256: digest(binary), licenseSHA256: digest(license) },
    });
    for (const [name, contents] of Object.entries({
      'node.exe': binary,
      LICENSE: license,
      'provenance.json': provenance,
    }))
      await writeFile(path.join(candidate, name), contents);
    // Seed the old cache to make a missing candidate path fail without network access.
    await mkdir(output);
    await writeFile(path.join(output, 'LICENSE.node'), license);
    await writeFile(
      path.join(output, 'runtime.json'),
      JSON.stringify({
        nodeVersion: process.versions.node,
        licenseUrl: `https://raw.githubusercontent.com/nodejs/node/v${process.versions.node}/LICENSE`,
        licenseSha256: digest(license),
      }),
    );
    const manifest = await prepareWindowsRuntime({
      candidateDirectory: candidate,
      directory: output,
    });
    assert.equal(manifest.selection, 'candidate');
    assert.equal(manifest.profile, 'official');
    assert.equal(await readFile(path.join(output, 'provenance.json'), 'utf8'), provenance);
    assert.equal(await readFile(path.join(output, 'LICENSE.node'), 'utf8'), license);
    await writeFile(path.join(candidate, 'node.exe'), 'tampered');
    await assert.rejects(
      prepareWindowsRuntime({ candidateDirectory: candidate, directory: output }),
      /binary.*hash/i,
    );
    assert.equal(digest(await readFile(path.join(output, 'node.exe'))), digest(binary));
  },
);

test(
  'returning to an upstream runtime removes obsolete candidate provenance',
  { skip: process.platform !== 'win32' && 'needs Windows' },
  async (t) => {
    const { prepareWindowsRuntime } = await moduleScript('prepare-windows-package.mjs');
    const root = await mkdtemp(path.join(os.tmpdir(), 'yuantu-upstream-runtime-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const license = 'Node.js is licensed for use as follows:\nfixture\n';
    await writeFile(path.join(root, 'LICENSE.node'), license);
    await writeFile(path.join(root, 'provenance.json'), '{"candidate":"obsolete"}');
    await writeFile(
      path.join(root, 'runtime.json'),
      JSON.stringify({
        nodeVersion: process.versions.node,
        licenseUrl: `https://raw.githubusercontent.com/nodejs/node/v${process.versions.node}/LICENSE`,
        licenseSha256: digest(license),
      }),
    );
    const result = await prepareWindowsRuntime({ directory: root, executable: process.execPath });
    assert.equal(result.selection, 'explicit-or-host');
    await assert.rejects(readFile(path.join(root, 'provenance.json')), { code: 'ENOENT' });
  },
);
