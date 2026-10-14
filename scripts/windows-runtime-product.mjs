import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

export async function validateRuntimeCandidate(directory, { production = false } = {}) {
  const provenanceBytes = await readFile(path.join(directory, 'provenance.json'));
  const provenance = JSON.parse(provenanceBytes.toString('utf8').replace(/^\uFEFF/, ''));
  if (provenance.source?.signedChecksumsVerified !== true || provenance.build?.exitCode !== 0)
    throw new Error('Candidate needs verified source checksums and a successful build');
  if (
    production &&
    (provenance.build.profile !== 'production' || provenance.build.opensslAssembly !== true)
  )
    throw new Error('Production packaging refuses a diagnostic or unqualified build profile');
  const binary = await readFile(path.join(directory, 'node.exe'));
  if (sha256(binary) !== provenance.binary?.sha256)
    throw new Error('Candidate binary hash differs from provenance');
  const licenseBytes = await readFile(path.join(directory, 'LICENSE'));
  if (sha256(licenseBytes) !== provenance.binary?.licenseSHA256)
    throw new Error('Candidate license hash differs from provenance');
  if (!licenseBytes.toString('utf8').startsWith('Node.js is licensed for use as follows:'))
    throw new Error('Candidate lacks the complete Node distribution license');
  return {
    provenance,
    provenanceBytes,
    licenseBytes,
    sha256: sha256(binary),
    profile:
      provenance.build.profile ??
      (provenance.build.opensslAssembly === false ? 'diagnostic' : 'unknown'),
  };
}

export async function validatePackagedWindowsRuntime(directory, { production = false } = {}) {
  const manifest = JSON.parse(await readFile(path.join(directory, 'runtime.json'), 'utf8'));
  for (const [name, expected] of [
    ['node.exe', manifest.sha256],
    ['LICENSE.node', manifest.licenseSha256],
    ...(manifest.selection === 'candidate' ? [['provenance.json', manifest.provenanceSha256]] : []),
  ]) {
    if (
      !/^[a-f0-9]{64}$/.test(expected ?? '') ||
      sha256(await readFile(path.join(directory, name))) !== expected
    )
      throw new Error(`Packaged ${name} hash differs from runtime manifest`);
  }
  if (production && (manifest.selection !== 'candidate' || manifest.profile !== 'production'))
    throw new Error('Protected production packaging requires a production candidate');
  return manifest;
}
