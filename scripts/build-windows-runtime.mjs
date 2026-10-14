import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdir, copyFile, mkdtemp, rm } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256, validateRuntimeCandidate } from './windows-runtime-product.mjs';
import { inspectWindowsRuntime, assertWindowsRuntime } from './windows-runtime.mjs';
import { toolEnvironment } from '../packages/tools/environment.ts';

const execute = promisify(execFile);
const project = fileURLToPath(new URL('..', import.meta.url));
export const lock = JSON.parse(
  await readFile(new URL('../build/windows-runtime.lock.json', import.meta.url), 'utf8'),
);
export const defaultCache = path.join(
  project,
  '.scratch/windows-appcontainer-runtime/node-v24.19.0-libuv-2cadaa4',
);

export function runtimeBuildArguments(profile) {
  if (!['diagnostic', 'production'].includes(profile))
    throw new Error('Unknown runtime build profile');
  return [
    'release',
    'x64',
    'vs2022',
    'clang-cl',
    ...(profile === 'diagnostic' ? ['openssl-no-asm'] : []),
  ];
}

export async function verifyLockedFile(file, expected) {
  if (sha256(await readFile(file)) !== expected)
    throw new Error(`Source hash mismatch: ${path.basename(file)}`);
}

function localSourcePath(value) {
  const resolved = path.resolve(value);
  if (!resolved.startsWith(path.join(project, '.scratch') + path.sep) || resolved.length > 70)
    throw new Error(
      'Source directory must be a short path (<=70 characters) inside project .scratch',
    );
  return resolved;
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

export async function verifyRuntimeSources({ cache = defaultCache, gpg } = {}) {
  gpg ??= await locateGpg();
  await mkdir(cache, { recursive: true });
  const archive = path.join(cache, lock.archive.name),
    patch = path.join(cache, lock.patch.name);
  const key = path.join(cache, `${lock.releaseSigner}.asc`),
    checksums = path.join(cache, 'SHASUMS256.txt.asc');
  for (const [file, url] of [
    [archive, lock.archive.url],
    [patch, lock.patch.url],
    [key, lock.releaseKeyUrl],
    [checksums, lock.checksumsUrl],
  ])
    await obtain(file, url);
  await verifyLockedFile(archive, lock.archive.sha256);
  await verifyLockedFile(patch, lock.patch.sha256);
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
      throw new Error('Release public key fingerprint differs from source lock');
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
      throw new Error('Node source checksum signature is not valid for the pinned release key');
    if (!stdout.split(/\r?\n/).includes(`${lock.archive.sha256}  ${lock.archive.name}`))
      throw new Error('Signed checksums do not identify the locked source archive');
    await writeFile(path.join(cache, 'product-gpg-verification.log'), stderr);
    await writeFile(path.join(cache, 'product-verified-SHASUMS256.txt'), stdout);
    return {
      archive,
      patch,
      releaseSigner: lock.releaseSigner,
      sourceSha256: lock.archive.sha256,
      patchSha256: lock.patch.sha256,
    };
  } finally {
    await rm(keyring, { recursive: true, force: true });
  }
}

async function toolchainIdentity(profile) {
  const vswhere = path.join(
    process.env['ProgramFiles(x86)'] || 'C:/Program Files (x86)',
    'Microsoft Visual Studio/Installer/vswhere.exe',
  );
  const { stdout } = await execute(
    vswhere,
    [
      '-version',
      '[17.0,18.0)',
      '-latest',
      '-requires',
      'Microsoft.VisualStudio.Component.VC.Llvm.Clang',
      'Microsoft.VisualStudio.Component.VC.Llvm.ClangToolset',
      '-format',
      'json',
    ],
    { windowsHide: true },
  );
  const installation = JSON.parse(stdout)[0];
  if (!installation) throw new Error('Node build requires VS2022 Clang Compiler and ClangToolset');
  const compiler = path.join(installation.installationPath, 'VC/Tools/Llvm/x64/bin/clang-cl.exe');
  const clang = await execute(compiler, ['--version'], { windowsHide: true });
  const python = await execute('python', ['--version'], { windowsHide: true });
  const nasm =
    profile === 'production' ? await execute('nasm', ['-v'], { windowsHide: true }) : null;
  return {
    visualStudio: installation.installationVersion,
    installationPath: installation.installationPath,
    compiler,
    compilerVersion: clang.stdout.trim(),
    compilerSha256: sha256(await readFile(compiler)),
    python: (python.stdout || python.stderr).trim(),
    nasm: nasm?.stdout.trim() ?? null,
  };
}

async function compile(source, args, log) {
  const output = createWriteStream(log);
  const child = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/c', 'vcbuild.bat', ...args], {
    cwd: source,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, msbuild_args: '/m:1 /p:MultiProcMaxCount=2 /p:CL_MPCount=2' },
  });
  child.stdout.pipe(output, { end: false });
  child.stderr.pipe(output, { end: false });
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  await new Promise((resolve, reject) => {
    output.on('error', reject);
    output.end(resolve);
  });
  if (code !== 0) throw new Error(`Node build failed (${code}); inspect ${log}`);
}

export async function buildWindowsRuntime({
  profile = 'diagnostic',
  source,
  cache = defaultCache,
  verifyOnly = false,
  prepareOnly = false,
  adoptExisting = false,
  gpg,
} = {}) {
  if (process.platform !== 'win32') throw new Error('Runtime build requires Windows');
  const args = runtimeBuildArguments(profile);
  const verified = await verifyRuntimeSources({ cache, gpg });
  const candidateDirectory =
    verifyOnly && profile === 'production' && process.env.WINDOWS_SANDBOX_NODE_CANDIDATE
      ? path.resolve(process.env.WINDOWS_SANDBOX_NODE_CANDIDATE)
      : path.join(cache, `candidate-${profile}`);
  if (adoptExisting) {
    if (profile !== 'diagnostic')
      throw new Error('Only the accepted legacy diagnostic candidate can be adopted');
    const legacy = path.join(cache, 'candidate');
    const accepted = await validateRuntimeCandidate(legacy);
    if (
      accepted.provenance.pipesAcceptance?.compatible !== true ||
      accepted.provenance.desktopBasicAcceptance?.status !== 'passed'
    )
      throw new Error('Legacy adoption requires actual pipes and desktop acceptance records');
    await mkdir(candidateDirectory, { recursive: true });
    for (const name of ['node.exe', 'LICENSE', 'provenance.json'])
      await copyFile(path.join(legacy, name), path.join(candidateDirectory, name));
  }
  if (verifyOnly || adoptExisting) {
    const candidate = await validateRuntimeCandidate(candidateDirectory, {
      production: profile === 'production',
    });
    if (
      candidate.provenance.source?.sha256 !== lock.archive.sha256 ||
      candidate.provenance.patch?.sha256 !== lock.patch.sha256 ||
      candidate.provenance.source?.releaseSigner !== lock.releaseSigner ||
      candidate.provenance.binary?.licenseSHA256 !== lock.licenseSha256 ||
      candidate.provenance.patch?.patchedPipeSHA256 !== lock.patch.patchedSha256
    )
      throw new Error('Existing candidate provenance differs from locked sources');
    const identity = await inspectWindowsRuntime(path.join(candidateDirectory, 'node.exe'));
    assertWindowsRuntime(identity);
    if (identity.nodeVersion !== lock.nodeVersion)
      throw new Error('Candidate Node version differs from locked sources');
    return {
      status: 'existing_candidate_reverified',
      ...verified,
      candidate: candidateDirectory,
      binarySha256: candidate.sha256,
      profile: candidate.profile,
    };
  }
  source = localSourcePath(
    source ?? path.join(project, `.scratch/n24-${profile === 'diagnostic' ? 'diag' : 'prod'}`),
  );
  const toolchain = await toolchainIdentity(profile);
  await execute(
    'python',
    [
      path.join(project, 'scripts/extract-windows-runtime.py'),
      verified.archive,
      source,
      `node-v${lock.nodeVersion}`,
    ],
    { windowsHide: true, timeout: 180000 },
  );
  await verifyLockedFile(path.join(source, lock.patch.file), lock.patch.originalSha256);
  await verifyLockedFile(path.join(source, 'LICENSE'), lock.licenseSha256);
  const upstream = await readFile(verified.patch, 'utf8');
  const segment = upstream.match(
    /diff --git a\/src\/win\/pipe\.c b\/src\/win\/pipe\.c\r?\n[\s\S]*?(?=diff --git |$)/,
  )?.[0];
  if (!segment) throw new Error('Locked patch lacks the pipe.c backport');
  const backport = path.join(cache, 'pipe-only.patch');
  await writeFile(backport, segment);
  // The extracted tree is inside an ignored parent checkout. Give git apply its
  // own repository root so it cannot silently skip every hunk due to that prefix.
  await execute('git', ['init', '--quiet'], { cwd: source, windowsHide: true });
  for (const operation of ['--check', null])
    await execute(
      'git',
      ['apply', '--no-index', '--directory=deps/uv', ...(operation ? [operation] : []), backport],
      { cwd: source, windowsHide: true },
    );
  await verifyLockedFile(path.join(source, lock.patch.file), lock.patch.patchedSha256);
  if (prepareOnly) return { status: 'verified_sources_prepared', source, profile, ...verified };
  const log = path.join(cache, `build-${profile}-${Date.now()}.log`);
  console.log(`Building ${profile} runtime at ${source}; full log: ${log}`);
  const startedAt = new Date().toISOString();
  await compile(source, args, log);
  const binaryPath = path.join(source, 'Release/node.exe');
  const info = await inspectWindowsRuntime(binaryPath);
  assertWindowsRuntime(info);
  if (info.nodeVersion !== lock.nodeVersion)
    throw new Error('Built Node version differs from lock');
  await execute(
    binaryPath,
    [
      '-e',
      "const assert=require('node:assert/strict');assert.equal(require('node:crypto').createHash('sha256').update('abc').digest('hex'),'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(':memory:');assert.equal(db.prepare('SELECT 42 AS answer').get().answer,42);db.close();",
    ],
    { windowsHide: true, timeout: 10000, env: toolEnvironment() },
  );
  const candidate = path.join(cache, `candidate-${profile}`);
  await mkdir(candidate, { recursive: true });
  await copyFile(binaryPath, path.join(candidate, 'node.exe'));
  await copyFile(path.join(source, 'LICENSE'), path.join(candidate, 'LICENSE'));
  const provenance = {
    version: 1,
    source: {
      version: lock.nodeVersion,
      url: lock.archive.url,
      sha256: lock.archive.sha256,
      releaseSigner: lock.releaseSigner,
      signedChecksumsVerified: true,
    },
    patch: {
      upstreamCommit: lock.patch.commit,
      sha256: lock.patch.sha256,
      appliedFiles: [lock.patch.file],
      patchedPipeSHA256: lock.patch.patchedSha256,
    },
    build: {
      profile,
      exitCode: 0,
      opensslAssembly: profile === 'production',
      command: ['vcbuild.bat', ...args].join(' '),
      msbuildArgs: '/m:1 /p:MultiProcMaxCount=2 /p:CL_MPCount=2',
      startedAt,
      finishedAt: new Date().toISOString(),
      log,
      toolchain,
    },
    binary: {
      sha256: sha256(await readFile(path.join(candidate, 'node.exe'))),
      licenseSHA256: lock.licenseSha256,
      identity: info,
      cryptoSqliteStartupPassed: true,
    },
    productionEnhancedAcceptance: null,
  };
  await writeFile(path.join(candidate, 'provenance.json'), JSON.stringify(provenance, null, 2));
  await validateRuntimeCandidate(candidate, { production: profile === 'production' });
  return {
    status: 'built_not_accepted',
    candidate,
    profile,
    binarySha256: provenance.binary.sha256,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = {};
  for (const arg of process.argv.slice(2)) {
    if (arg === '--verify-only') options.verifyOnly = true;
    else if (arg === '--adopt-existing') options.adoptExisting = true;
    else if (arg === '--prepare-only') options.prepareOnly = true;
    else if (arg.startsWith('--profile=')) options.profile = arg.slice(10);
    else if (arg.startsWith('--source=')) options.source = arg.slice(9);
    else if (arg.startsWith('--cache=')) options.cache = path.resolve(arg.slice(8));
    else throw new Error(`Unknown runtime build argument: ${arg}`);
  }
  console.log(JSON.stringify(await buildWindowsRuntime(options), null, 2));
}
