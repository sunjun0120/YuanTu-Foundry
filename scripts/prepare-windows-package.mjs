import { copyFile, mkdir, writeFile, readFile, mkdtemp, rename, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertWindowsRuntime, inspectWindowsRuntime } from './windows-runtime.mjs';
import { validateSignedHelperAssets, inspectHelperSignature } from './windows-helper-signature.mjs';
import { validateRuntimeCandidate, sha256 } from './windows-runtime-product.mjs';

export async function prepareWindowsRuntime({
  executable,
  candidateDirectory = process.env.WINDOWS_SANDBOX_NODE_CANDIDATE,
  directory = path.resolve('.scratch/packaging/runtime'),
  production = process.env.WINDOWS_SANDBOX_PROTECTED_RELEASE === '1',
} = {}) {
  const candidate = candidateDirectory
    ? await validateRuntimeCandidate(candidateDirectory, { production })
    : null;
  if (production && !candidate)
    throw new Error('Production packaging requires an explicit candidate directory');
  executable ??= candidateDirectory
    ? path.join(candidateDirectory, 'node.exe')
    : process.env.WINDOWS_SANDBOX_NODE_EXECUTABLE || process.execPath;
  if (candidate && sha256(await readFile(executable)) !== candidate.sha256)
    throw new Error('Selected executable differs from explicit runtime candidate');
  const info = await inspectWindowsRuntime(executable);
  assertWindowsRuntime(info);
  const signing = production ? await validateSignedHelperAssets() : null;
  if (production) {
    const signature = await inspectHelperSignature(executable);
    if (
      !signature.valid ||
      !signature.timestamped ||
      signature.signerSha256 !== signing.signerSha256
    )
      throw new Error(
        'Production Node needs a valid timestamped signature matching the helper signer',
      );
  }
  // Include the complete upstream distribution license when redistributing Node.
  const licenseUrl = `https://raw.githubusercontent.com/nodejs/node/v${info.nodeVersion}/LICENSE`;
  let licenseText = candidate?.licenseBytes.toString('utf8');
  if (!licenseText)
    try {
      const previous = JSON.parse(await readFile(path.join(directory, 'runtime.json'), 'utf8'));
      if (previous.nodeVersion === info.nodeVersion && previous.licenseUrl === licenseUrl) {
        const cached = await readFile(path.join(directory, 'LICENSE.node'), 'utf8');
        if (
          cached.startsWith('Node.js is licensed for use as follows:') &&
          (!previous.licenseSha256 ||
            previous.licenseSha256 === createHash('sha256').update(cached).digest('hex'))
        )
          licenseText = cached;
      }
    } catch {
      /* A new runtime needs its own distribution license. */
    }
  if (!licenseText) {
    const license = await fetch(licenseUrl, { signal: AbortSignal.timeout(30000) });
    if (!license.ok)
      throw new Error(`Unable to obtain Node distribution license: ${license.status}`);
    licenseText = await license.text();
    if (!licenseText.startsWith('Node.js is licensed for use as follows:'))
      throw new Error('Invalid Node distribution license');
  }
  await mkdir(path.dirname(directory), { recursive: true });
  const stage = await mkdtemp(path.join(path.dirname(directory), '.windows-runtime-'));
  try {
    await copyFile(executable, path.join(stage, 'node.exe'));
    const copied = await inspectWindowsRuntime(path.join(stage, 'node.exe'));
    assertWindowsRuntime(copied);
    if (JSON.stringify(copied) !== JSON.stringify(info))
      throw new Error('Selected Windows runtime changed while packaging');
    const binarySha256 = sha256(await readFile(path.join(stage, 'node.exe')));
    if (candidate && binarySha256 !== candidate.sha256)
      throw new Error('Candidate binary changed while packaging');
    const manifest = {
      nodeVersion: copied.nodeVersion,
      uvVersion: copied.uv,
      platform: copied.platform,
      architecture: copied.arch,
      selection: candidate ? 'candidate' : 'explicit-or-host',
      profile: candidate?.profile ?? 'upstream-unqualified',
      sha256: createHash('sha256')
        .update(await readFile(path.join(stage, 'node.exe')))
        .digest('hex'),
      licenseUrl,
      licenseSha256: createHash('sha256').update(licenseText).digest('hex'),
      ...(candidate ? { provenanceSha256: sha256(candidate.provenanceBytes) } : {}),
      ...(signing ? { signedHelper: signing } : {}),
    };
    await writeFile(path.join(stage, 'LICENSE.node'), licenseText);
    if (candidate) await writeFile(path.join(stage, 'provenance.json'), candidate.provenanceBytes);
    await writeFile(path.join(stage, 'runtime.json'), JSON.stringify(manifest, null, 2));
    await mkdir(directory, { recursive: true });
    // Publish the manifest last: an interrupted copy cannot claim the new identity.
    for (const name of [
      'LICENSE.node',
      'node.exe',
      ...(candidate ? ['provenance.json'] : []),
      'runtime.json',
    ]) {
      if (name === 'runtime.json' && !candidate)
        await rm(path.join(directory, 'provenance.json'), { force: true });
      await rename(path.join(stage, name), path.join(directory, name));
    }
    return manifest;
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== '--protected' && !arg.startsWith('--candidate=')))
    throw new Error('Use --protected, --candidate=directory or no arguments');
  const production =
    args.includes('--protected') || process.env.WINDOWS_SANDBOX_PROTECTED_RELEASE === '1';
  const candidateDirectory =
    args.find((arg) => arg.startsWith('--candidate='))?.slice(12) ||
    process.env.WINDOWS_SANDBOX_NODE_CANDIDATE;
  const manifest = await prepareWindowsRuntime({ production, candidateDirectory });
  console.log(
    `Prepared bundled Node ${manifest.nodeVersion} (libuv ${manifest.uvVersion}) for Windows x64`,
  );
}
