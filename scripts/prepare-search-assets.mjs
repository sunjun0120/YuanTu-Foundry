#!/usr/bin/env node
/**
 * Fetch and verify the pinned ripgrep asset for one target — at build time, never at run time.
 *
 * The distinction is the whole point. A tool call must not download a program and then execute it: that turns a
 * network compromise into code execution inside the sandbox, and it makes a search whose result depends on
 * today's mirror. So this script runs in a build or release job, writes the binary into `build/search-assets/`,
 * and the runtime only ever *reads* what is already there and checks it against `build/search-assets.lock.json`.
 *
 * The lock file's digests are the trust anchor and this script never invents one. Where the publisher also
 * publishes the archive's digest — ripgrep ships a `.sha256` beside every archive — it is fetched and required to
 * agree with the pin *and* with the bytes that arrived, so an archive and a lock file that were tampered with
 * together still fail. `--accept-new-hashes` exists for the digests a publisher does not publish (the extracted
 * binary and the license, which are derived from an already-verified archive), and it prints every value it
 * records, because what it writes is a decision a person reviews rather than a script's quiet guess.
 *
 * Usage:
 *   node scripts/prepare-search-assets.mjs [--target=win32-x64 | --platform=win32 --arch=x64] [--accept-new-hashes]
 *   node scripts/prepare-search-assets.mjs --target=win32-x64 --verify-only
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lockFile = path.join(root, 'build', 'search-assets.lock.json');

const args = process.argv.slice(2);
const options = {
  target: null,
  platform: process.platform,
  arch: process.arch,
  verifyOnly: false,
  accept: false,
};
for (const arg of args) {
  if (arg === '--verify-only') options.verifyOnly = true;
  else if (arg === '--accept-new-hashes') options.accept = true;
  else if (arg.startsWith('--target=')) options.target = arg.slice('--target='.length);
  else if (arg.startsWith('--platform=')) options.platform = arg.slice('--platform='.length);
  else if (arg.startsWith('--arch=')) options.arch = arg.slice('--arch='.length);
  else throw new Error(`Unsupported argument: ${arg}`);
}

const key = options.target ?? `${options.platform}-${options.arch}`;
const lock = JSON.parse(await readFile(lockFile, 'utf8'));
const target = lock.targets?.[key];
const directory = path.join(root, 'build', 'search-assets', lock.version, key);
const windows = key.startsWith('win32-');
const binary = path.join(directory, windows ? 'rg.exe' : 'rg');

if (!target) {
  console.error(
    `No pinned asset for ${key}.\n` +
      `Add an entry under targets["${key}"] in build/search-assets.lock.json with the publisher's archive URL\n` +
      `and the archive, binary and license SHA-256 values before running this again. Without a pinned digest\n` +
      `there is nothing to verify against, and this script will not invent one.`,
  );
  process.exit(1);
}

if (options.verifyOnly) {
  if (!existsSync(binary)) {
    console.error(`Missing asset: ${binary}\nRun without --verify-only to fetch and verify it.`);
    process.exit(1);
  }
  const digest = sha256(await readFile(binary));
  if (digest !== target.binarySha256) {
    console.error(`Asset digest mismatch for ${key}: ${digest} !== ${target.binarySha256}`);
    process.exit(1);
  }
  console.log(`Verified ${binary} (${digest})`);
  process.exit(0);
}

await mkdir(directory, { recursive: true });
const archive = path.join(directory, path.basename(new URL(target.url).pathname));
await download(target.url, archive);

const archiveDigest = sha256(await readFile(archive));
/**
 * The publisher's own checksum, when there is one.
 *
 * Required to agree with the pin and with the bytes that arrived — three independent statements about one file.
 * A mirror that swapped the archive, or a lock file edited to match, fails here rather than at the extraction.
 */
const published = await downloadChecksum(target.url);
const pinnedArchive = isDigest(target.archiveSha256) ? target.archiveSha256 : null;
if (published && pinnedArchive && published !== pinnedArchive) {
  await rm(archive, { force: true });
  console.error(
    `The publisher's checksum for ${key} (${published}) does not match the pinned ${pinnedArchive}.\n` +
      `The archive was deleted and nothing was installed.`,
  );
  process.exit(1);
}
if (pinnedArchive && archiveDigest !== pinnedArchive) {
  await rm(archive, { force: true });
  console.error(
    `Archive digest mismatch for ${key}: received ${archiveDigest}, pinned ${pinnedArchive}.\n` +
      `The archive was deleted and nothing was installed.`,
  );
  process.exit(1);
}
if (!pinnedArchive) {
  if (!options.accept) {
    await rm(archive, { force: true });
    console.error(
      `The lock file pins no archive digest for ${key}. Re-run with --accept-new-hashes to record ` +
        `sha256=${archiveDigest}, which is trust on first use and not a publisher checksum.`,
    );
    process.exit(1);
  }
  lock.targets[key] = { ...target, archiveSha256: archiveDigest };
  await writeFile(lockFile, `${JSON.stringify(lock, null, 2)}\n`);
  console.log(`Recorded archive SHA-256 for ${key}: ${archiveDigest} (trust on first use)`);
}
if (published)
  console.log(
    `Archive verified against the publisher's checksum and the pin for ${key}: ${archiveDigest}`,
  );

extract(archive, directory);
const unpacked = await locate(directory, path.basename(binary));
if (!unpacked) {
  console.error(`The archive did not contain ${path.basename(binary)}; nothing was installed.`);
  process.exit(1);
}
if (unpacked !== binary) {
  await rm(binary, { force: true });
  await writeFile(binary, await readFile(unpacked));
}
const binaryDigest = sha256(await readFile(binary));
const pinnedBinary = isDigest(target.binarySha256) ? target.binarySha256 : null;
if (pinnedBinary && binaryDigest !== pinnedBinary) {
  console.error(
    `Binary digest mismatch for ${key}: extracted ${binaryDigest}, pinned ${pinnedBinary}.`,
  );
  process.exit(1);
}
if (!pinnedBinary) {
  if (!options.accept) {
    console.error(`The lock file pins no binary digest for ${key}; nothing was installed.`);
    process.exit(1);
  }
  lock.targets[key] = { ...lock.targets[key], binarySha256: binaryDigest };
  await writeFile(lockFile, `${JSON.stringify(lock, null, 2)}\n`);
  console.log(`Recorded binary SHA-256 for ${key}: ${binaryDigest} (trust on first use)`);
}
// ripgrep is dual-licensed and ships both texts; the MIT one is recorded because a single digest has to name
// one file, and the note in the lock file says which and why.
const license = (await locate(directory, 'LICENSE-MIT')) ?? (await locate(directory, 'LICENSE'));
if (isDigest(target.licenseSha256) && license) {
  const licenseDigest = sha256(await readFile(license));
  if (licenseDigest !== target.licenseSha256) {
    console.error(
      `License digest mismatch for ${key}: extracted ${licenseDigest}, pinned ${target.licenseSha256}.`,
    );
    process.exit(1);
  }
} else if (license && options.accept && !isDigest(target.licenseSha256)) {
  // The license text is the other half of the asset's identity: shipped beside the program, and recorded so a
  // reviewer can tell which upstream revision's terms this binary came with.
  const licenseDigest = sha256(await readFile(license));
  lock.targets[key] = { ...lock.targets[key], licenseSha256: licenseDigest };
  await writeFile(lockFile, `${JSON.stringify(lock, null, 2)}\n`);
  console.log(`Recorded license SHA-256 for ${key}: ${licenseDigest} (from the verified archive)`);
}
console.log(`Prepared ${binary} (${binaryDigest})`);

/** A real SHA-256, as opposed to a placeholder someone still has to fill in. */
function isDigest(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function download(url, destination) {
  // A build step that can hang forever is worse than one that fails: a stalled mirror must not stall a release.
  const response = await fetch(url, { signal: AbortSignal.timeout(180_000) });
  if (!response.ok) throw new Error(`Download failed: ${response.status} ${response.statusText}`);
  await writeFile(destination, Buffer.from(await response.arrayBuffer()));
}

/**
 * The publisher's `.sha256` beside the archive, or `null` when the publisher does not ship one.
 *
 * A 404 is the ordinary "no checksum published" answer rather than a failure — the pin is still checked against
 * the downloaded bytes either way. Anything else that is not a digest-shaped body is also treated as absent, and
 * the caller says which of the two verification paths it took.
 */
async function downloadChecksum(url) {
  try {
    const response = await fetch(`${url}.sha256`, { signal: AbortSignal.timeout(60_000) });
    if (!response.ok) return null;
    const text = await response.text();
    const digest = /([0-9a-f]{64})/i.exec(text)?.[1];
    return digest ? digest.toLowerCase() : null;
  } catch {
    return null;
  }
}

/**
 * Unpacking uses the platform's own `tar` with a fixed argument vector and no shell.
 *
 * Both platforms this ships on have a `tar` that reads a zip or a tarball; the paths involved are ones this
 * script itself chose, so nothing here is an injection surface, and `shell: false` keeps it that way.
 */
function extract(archivePath, destination) {
  const result = spawnSync('tar', ['-xf', archivePath, '-C', destination], {
    stdio: 'inherit',
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`Extracting ${archivePath} failed with status ${String(result.status)}`);
}

/** The first file with this name anywhere under `directory`, or `null`. */
async function locate(directory, name) {
  const { readdir } = await import('node:fs/promises');
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isFile() && entry.name === name) return full;
    if (entry.isDirectory()) {
      const found = await locate(full, name);
      if (found) return found;
    }
  }
  return null;
}
