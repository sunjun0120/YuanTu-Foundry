import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdir, copyFile, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256, validateRuntimeCandidate } from './windows-runtime-product.mjs';
import { inspectWindowsRuntime, assertWindowsRuntime } from './windows-runtime.mjs';
import { toolEnvironment } from '../packages/platform/child-environment.ts';

const execute = promisify(execFile);
const project = fileURLToPath(new URL('..', import.meta.url));
export const lock = JSON.parse(
  await readFile(new URL('../build/windows-runtime.lock.json', import.meta.url), 'utf8'),
);
export const defaultCandidate = path.join(project, '.scratch/windows-runtime', lock.archive.root);
export const defaultCache = path.join(project, '.scratch/windows-runtime/downloads');

export async function verifyLockedFile(file, expected) {
  if (sha256(await readFile(file)) !== expected)
    throw new Error(`Locked hash mismatch: ${path.basename(file)}`);
}

async function obtain(file, url) {
  try {
    await readFile(file);
    return;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw new Error(`Download failed: ${url}: ${response.status}`);
  // Publish only a completed download. Hash and signature checks follow before extraction.
  await writeFile(file, Buffer.from(await response.arrayBuffer()));
}

async function locateGpg() {
  if (process.env.WINDOWS_RUNTIME_GPG) return process.env.WINDOWS_RUNTIME_GPG;
  try {
    await execute('gpg', ['--version'], { windowsHide: true });
    return 'gpg';
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const { stdout } = await execute('where.exe', ['git.exe'], { windowsHide: true });
  const git = stdout.trim().split(/\r?\n/)[0];
  const bundled = path.resolve(path.dirname(git), '../usr/bin/gpg.exe');
  await readFile(bundled);
  return bundled;
}

/** Downloads the locked official archive and proves it against the release key's signed checksums. */
export async function verifyRuntimeArchive({ cache = defaultCache, gpg } = {}) {
  gpg ??= await locateGpg();
  await mkdir(cache, { recursive: true });
  const archive = path.join(cache, lock.archive.name);
  const key = path.join(cache, `${lock.releaseSigner}.asc`),
    checksums = path.join(cache, 'SHASUMS256.txt.asc');
  for (const [file, url] of [
    [archive, lock.archive.url],
    [key, lock.releaseKeyUrl],
    [checksums, lock.checksumsUrl],
  ])
    await obtain(file, url);
  await verifyLockedFile(archive, lock.archive.sha256);
  const keyring = await mkdtemp(path.join(cache, 'verification-'));
  try {
    // Relative paths work for native and MSYS GPG without drive-letter translation.
    const gpgOptions = { cwd: cache, windowsHide: true, maxBuffer: 1024 * 1024 };
    const gpgArgs = ['--homedir', './' + path.basename(keyring), '--batch', '--no-autostart'];
    // Dearmor the public key rather than importing it: verification needs no agent,
    // private key store, or long MSYS socket path.
    const publicRing = './' + path.basename(keyring) + '/release-public.gpg';
    await execute(
      gpg,
      [...gpgArgs, '--output', publicRing, '--dearmor', path.basename(key)],
      gpgOptions,
    );
    const { stdout: keys } = await execute(
      gpg,
      [...gpgArgs, '--with-colons', '--show-keys', path.basename(key)],
      gpgOptions,
    );
    if (
      !keys
        .split(/\r?\n/)
        .some((line) => line.startsWith('fpr:') && line.split(':')[9] === lock.releaseSigner)
    )
      throw new Error('Release public key fingerprint differs from runtime lock');
    const { stdout, stderr } = await execute(
      gpg,
      [
        ...gpgArgs,
        '--no-default-keyring',
        '--keyring',
        publicRing,
        '--status-fd',
        '2',
        '--decrypt',
        path.basename(checksums),
      ],
      gpgOptions,
    );
    if (
      !stderr.includes(`[GNUPG:] VALIDSIG ${lock.releaseSigner} `) ||
      /\[GNUPG:\] (?:BADSIG|ERRSIG|REVKEYSIG|EXPKEYSIG|EXPSIG) /.test(stderr)
    )
      throw new Error('Node checksum signature is not valid for the pinned release key');
    const lines = stdout.split(/\r?\n/);
    if (
      !lines.includes(`${lock.archive.sha256}  ${lock.archive.name}`) ||
      !lines.includes(`${lock.executableSha256}  win-x64/node.exe`)
    )
      throw new Error('Signed checksums do not identify the locked archive and executable');
    return { archive, releaseSigner: lock.releaseSigner, archiveSha256: lock.archive.sha256 };
  } finally {
    await rm(keyring, { recursive: true, force: true });
  }
}

/** The candidate is the locked official release, byte for byte. */
export function assertOfficialCandidate(candidate) {
  const { provenance } = candidate;
  if (
    provenance.source?.version !== lock.nodeVersion ||
    provenance.source?.sha256 !== lock.archive.sha256 ||
    provenance.source?.releaseSigner !== lock.releaseSigner ||
    provenance.binary?.licenseSHA256 !== lock.licenseSha256 ||
    provenance.binary?.sha256 !== lock.executableSha256
  )
    throw new Error('Runtime candidate differs from the locked official Node release');
}

export async function fetchWindowsRuntime({
  candidate = defaultCandidate,
  cache = defaultCache,
  verifyOnly = false,
  gpg,
} = {}) {
  if (process.platform !== 'win32') throw new Error('Windows runtime preparation requires Windows');
  if (verifyOnly) {
    const existing = await validateRuntimeCandidate(candidate);
    assertOfficialCandidate(existing);
    const identity = await inspectWindowsRuntime(path.join(candidate, 'node.exe'));
    assertWindowsRuntime(identity);
    if (identity.nodeVersion !== lock.nodeVersion)
      throw new Error('Candidate Node version differs from runtime lock');
    return { status: 'existing_candidate_reverified', candidate, binarySha256: existing.sha256 };
  }
  const verified = await verifyRuntimeArchive({ cache, gpg });
  const stage = await mkdtemp(path.join(cache, 'extract-'));
  try {
    // Windows' bsdtar reads zip archives; Git's GNU tar on PATH does not.
    await execute(
      path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/tar.exe'),
      [
        '-xf',
        verified.archive,
        '-C',
        stage,
        `${lock.archive.root}/node.exe`,
        `${lock.archive.root}/LICENSE`,
      ],
      { windowsHide: true, timeout: 180000 },
    );
    const extracted = path.join(stage, lock.archive.root);
    await verifyLockedFile(path.join(extracted, 'node.exe'), lock.executableSha256);
    await verifyLockedFile(path.join(extracted, 'LICENSE'), lock.licenseSha256);
    const binaryPath = path.join(extracted, 'node.exe');
    const info = await inspectWindowsRuntime(binaryPath);
    assertWindowsRuntime(info);
    if (info.nodeVersion !== lock.nodeVersion)
      throw new Error('Official Node version differs from runtime lock');
    await execute(
      binaryPath,
      [
        '-e',
        "const assert=require('node:assert/strict');assert.equal(require('node:crypto').createHash('sha256').update('abc').digest('hex'),'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(':memory:');assert.equal(db.prepare('SELECT 42 AS answer').get().answer,42);db.close();",
      ],
      { windowsHide: true, timeout: 10000, env: toolEnvironment() },
    );
    await rm(candidate, { recursive: true, force: true });
    await mkdir(candidate, { recursive: true });
    await copyFile(binaryPath, path.join(candidate, 'node.exe'));
    await copyFile(path.join(extracted, 'LICENSE'), path.join(candidate, 'LICENSE'));
    const provenance = {
      version: 2,
      profile: 'official',
      source: {
        version: lock.nodeVersion,
        url: lock.archive.url,
        sha256: lock.archive.sha256,
        releaseSigner: lock.releaseSigner,
        signedChecksumsVerified: true,
      },
      binary: {
        sha256: lock.executableSha256,
        licenseSHA256: lock.licenseSha256,
        identity: info,
        cryptoSqliteStartupPassed: true,
      },
    };
    await writeFile(path.join(candidate, 'provenance.json'), JSON.stringify(provenance, null, 2));
    assertOfficialCandidate(await validateRuntimeCandidate(candidate));
    return {
      status: 'official_candidate_prepared',
      candidate,
      binarySha256: lock.executableSha256,
    };
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = {};
  if (process.env.WINDOWS_SANDBOX_NODE_CANDIDATE)
    options.candidate = path.resolve(process.env.WINDOWS_SANDBOX_NODE_CANDIDATE);
  for (const arg of process.argv.slice(2)) {
    if (arg === '--verify-only') options.verifyOnly = true;
    else if (arg.startsWith('--candidate=')) options.candidate = path.resolve(arg.slice(12));
    else if (arg.startsWith('--cache=')) options.cache = path.resolve(arg.slice(8));
    else throw new Error(`Unknown runtime argument: ${arg}`);
  }
  console.log(JSON.stringify(await fetchWindowsRuntime(options), null, 2));
}
