import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/**
 * A runtime candidate is an official Node release proven against the release key's signed checksums.
 * Packaging no longer re-signs `node.exe`; the recorded binary hash is the upstream release's hash.
 */
export async function validateRuntimeCandidate(directory) {
  const provenanceBytes = await readFile(path.join(directory, 'provenance.json'));
  const provenance = JSON.parse(provenanceBytes.toString('utf8').replace(/^﻿/, ''));
  if (provenance.profile !== 'official' || provenance.source?.signedChecksumsVerified !== true)
    throw new Error('Candidate must be an official Node release with verified signed checksums');
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

export async function validatePackagedWindowsRuntime(directory) {
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
  return manifest;
}
