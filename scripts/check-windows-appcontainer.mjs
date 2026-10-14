import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectWindowsRuntime, assertWindowsRuntime } from './windows-runtime.mjs';
import { toolEnvironment } from '../packages/tools/environment.ts';
import { SANDBOX_MODES } from '../packages/tools/sandbox-mode.ts';

export function evaluateReadiness(facts) {
  const blockers = [];
  if (facts.platform !== 'win32') blockers.push('platform');
  if (!facts.runtime?.validated) blockers.push('runtime');
  if (!facts.signature?.valid || !facts.signature?.timestamped) blockers.push('helper-signature');
  if (!facts.signedAssets?.validated) blockers.push('signed-assets');
  if (!facts.preflight?.passed) blockers.push('release-preflight');
  const canInitialize = blockers.length === 0;
  if (!facts.policy?.installed) blockers.push('network-policy');
  const readyForAcceptance = canInitialize && facts.policy?.installed === true;
  if (facts.runtime?.compatible !== true) blockers.push('runtime-capability');
  if (!facts.publicMode) blockers.push('public-mode');
  if (!facts.functionalAcceptance) blockers.push('functional-acceptance');
  return {
    ...facts,
    canInitialize,
    readyForAcceptance,
    canEnable: blockers.length === 0,
    blockers,
  };
}

export async function inspectHelperSignature(helperPath) {
  const code =
    "$ErrorActionPreference='Stop'; $s=Get-AuthenticodeSignature -LiteralPath $env:WINDOWS_SANDBOX_READINESS_HELPER; $digest=$null; if($s.SignerCertificate){$sha=[Security.Cryptography.SHA256]::Create(); try{$digest=([BitConverter]::ToString($sha.ComputeHash($s.SignerCertificate.RawData))).Replace('-','').ToLowerInvariant()}finally{$sha.Dispose()}}; @{valid=($s.Status -eq 'Valid');status=[string]$s.Status;signerSha256=$digest;timestamped=($null -ne $s.TimeStamperCertificate)} | ConvertTo-Json -Compress";
  const { stdout } = await promisify(execFile)(
    path.join(
      process.env.SystemRoot ?? 'C:\\Windows',
      'System32/WindowsPowerShell/v1.0/powershell.exe',
    ),
    ['-NoProfile', '-NonInteractive', '-Command', code],
    {
      windowsHide: true,
      encoding: 'utf8',
      timeout: 15000,
      maxBuffer: 65536,
      env: { ...toolEnvironment(), WINDOWS_SANDBOX_READINESS_HELPER: helperPath },
    },
  );
  const result = JSON.parse(stdout.trim());
  if (typeof result.valid !== 'boolean') throw new Error('Invalid helper signature status');
  return result;
}

export function assertPinnedHelperManifest(manifest, signature, digest) {
  if (
    manifest?.version !== 1 ||
    manifest.timestamped !== true ||
    !/^[0-9a-f]{64}$/.test(manifest.helperSha256 ?? '') ||
    !/^[0-9a-f]{64}$/.test(manifest.signerSha256 ?? '') ||
    !signature?.valid ||
    !signature.timestamped ||
    signature.signerSha256 !== manifest.signerSha256 ||
    digest !== manifest.helperSha256
  )
    throw new Error(
      'Signed helper must match the pinned signer, timestamp and signing manifest; rebuilds require signing again',
    );
}

export async function validateSignedHelperAssets(
  root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
) {
  const manifest = JSON.parse(
    (
      await readFile(path.join(root, '.scratch/windows-sandbox-signing/manifest.json'), 'utf8')
    ).replace(/^\uFEFF/, ''),
  );
  for (const relative of [
    'packages/tools/windows-sandbox/yuantu-appcontainer.exe',
    'dist/packages/tools/windows-sandbox/yuantu-appcontainer.exe',
  ]) {
    const executable = path.join(root, relative);
    const digest = createHash('sha256')
      .update(await readFile(executable))
      .digest('hex');
    assertPinnedHelperManifest(manifest, await inspectHelperSignature(executable), digest);
  }
  return manifest;
}

export async function collectAppContainerReadiness({
  nodePath = process.env.WINDOWS_SANDBOX_NODE_EXECUTABLE || process.execPath,
  helperPath = path.resolve('packages/tools/windows-sandbox/yuantu-appcontainer.exe'),
} = {}) {
  const facts = {
    platform: process.platform,
    runtime: {
      executable: path.resolve(nodePath),
      validated: false,
      compatible: null,
      compatibilityChecked: false,
    },
    signature: { executable: helperPath, valid: false },
    signedAssets: { validated: false },
    preflight: { checked: false, passed: false },
    policy: { checked: false, installed: null },
    publicMode: SANDBOX_MODES.includes('appcontainer'),
    functionalAcceptance: false,
  };
  try {
    Object.assign(facts.runtime, await inspectWindowsRuntime(nodePath));
    assertWindowsRuntime(facts.runtime, { enhanced: true });
    facts.runtime.validated = true;
  } catch (error) {
    facts.runtime.error = error.message;
  }
  if (process.platform === 'win32') {
    try {
      facts.signature.sha256 = createHash('sha256')
        .update(await readFile(helperPath))
        .digest('hex');
      Object.assign(facts.signature, await inspectHelperSignature(helperPath));
    } catch (error) {
      facts.signature.error = error.message;
    }
  }
  // Do not execute an unsigned helper. These fixed operations inspect state only;
  // no network-setup/network-initialize, ACL grant or functional probe is invoked.
  if (facts.signature.valid && facts.signature.timestamped) {
    try {
      const manifest = await validateSignedHelperAssets();
      assertPinnedHelperManifest(manifest, facts.signature, facts.signature.sha256);
      facts.signedAssets.validated = true;
    } catch (error) {
      facts.signedAssets.error = error.message;
    }
  }
  if (
    facts.runtime.validated &&
    facts.signature.valid &&
    facts.signature.timestamped &&
    facts.signedAssets.validated
  ) {
    const execute = promisify(execFile);
    facts.preflight.checked = true;
    try {
      const { stdout } = await execute(helperPath, ['network-preflight'], {
        env: toolEnvironment(),
        windowsHide: true,
        encoding: 'utf8',
        timeout: 15000,
        maxBuffer: 65536,
      });
      const reply = JSON.parse(stdout);
      if (reply.version !== 1 || reply.ready !== true) throw new Error('Invalid release preflight');
      facts.preflight.passed = true;
    } catch (error) {
      facts.preflight.error = error.message;
    }
    if (facts.preflight.passed) {
      facts.policy.checked = true;
      try {
        const { stdout } = await execute(helperPath, ['network-status'], {
          env: toolEnvironment(),
          windowsHide: true,
          encoding: 'utf8',
          timeout: 15000,
          maxBuffer: 65536,
        });
        const reply = JSON.parse(stdout);
        if (
          reply.version !== 1 ||
          !Array.isArray(reply.profiles) ||
          reply.profiles.length < 1 ||
          reply.profiles.length > 16 ||
          reply.profiles.some(
            (p) =>
              typeof p.name !== 'string' ||
              !/^Yuantu\.Sandbox\.[0-9a-f-]{36}$/i.test(p.name) ||
              typeof p.sid !== 'string' ||
              !/^S-1-15-2-\d+(?:-\d+)*$/.test(p.sid),
          ) ||
          new Set(reply.profiles.map((p) => p.name)).size !== reply.profiles.length ||
          new Set(reply.profiles.map((p) => p.sid)).size !== reply.profiles.length
        )
          throw new Error('Invalid installed network policy');
        facts.policy.installed = true;
        facts.policy.profiles = reply.profiles;
      } catch (error) {
        facts.policy.error = error.message;
      }
    }
  }
  return evaluateReadiness(facts);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = { checkedAt: new Date().toISOString(), ...(await collectAppContainerReadiness()) };
  const directory = path.resolve('.scratch/windows-sandbox-acceptance');
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, 'appcontainer-readiness.json'),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
  if (!report.canEnable) process.exitCode = 2;
}
