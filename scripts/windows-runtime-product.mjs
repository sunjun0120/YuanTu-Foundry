import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/**
 * A runtime candidate is an official Node release proven against the release key's signed checksums.
 * Production additionally requires our release re-signing, which records the upstream bytes it replaced.
 */
export async function validateRuntimeCandidate(directory, { production = false } = {}) {
  const provenanceBytes = await readFile(path.join(directory, 'provenance.json'));
  const provenance = JSON.parse(provenanceBytes.toString('utf8').replace(/^﻿/, ''));
  if (provenance.profile !== 'official' || provenance.source?.signedChecksumsVerified !== true)
    throw new Error('Candidate must be an official Node release with verified signed checksums');
  if (
    production &&
    (!/^[a-f0-9]{64}$/.test(provenance.binary?.signerSha256 ?? '') ||
      !/^[a-f0-9]{64}$/.test(provenance.binary?.upstreamSha256 ?? ''))
  )
    throw new Error('Production packaging requires a release-signed official runtime');
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
    profile: provenance.profile,
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
  if (production && (manifest.selection !== 'candidate' || manifest.profile !== 'official'))
    throw new Error('Protected production packaging requires the official runtime candidate');
  return manifest;
}
