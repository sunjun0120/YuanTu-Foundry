import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { toolEnvironment } from '../packages/tools/environment.ts';

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

/** The signing manifest pins the signer certificate and the signed bytes of `yuantu-sandbox.exe`. */
export function assertPinnedHelperManifest(manifest, signature, digest) {
  if (
    manifest?.version !== 1 ||
    manifest.timestamped !== true ||
    !/^[0-9a-f]{64}$/.test(manifest.accountHelperSha256 ?? '') ||
    !/^[0-9a-f]{64}$/.test(manifest.signerSha256 ?? '') ||
    !signature?.valid ||
    !signature.timestamped ||
    signature.signerSha256 !== manifest.signerSha256 ||
    digest !== manifest.accountHelperSha256
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
    'packages/tools/windows-sandbox/yuantu-sandbox.exe',
    'dist/packages/tools/windows-sandbox/yuantu-sandbox.exe',
  ]) {
    const executable = path.join(root, relative);
    const digest = createHash('sha256')
      .update(await readFile(executable))
      .digest('hex');
    assertPinnedHelperManifest(manifest, await inspectHelperSignature(executable), digest);
  }
  return manifest;
}
