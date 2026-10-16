#!/usr/bin/env node
/**
 * Stage the verified search asset for the platform being packaged.
 *
 * The runtime reads its search binary from the packaged resources, so the packaging pipeline has to put one
 * there — and the packaging pipeline is also the last place the digest can be checked before the bytes leave the
 * build machine. Both happen here: the lock file is the authority, the binary is hashed on the way through, and a
 * mismatch aborts the package rather than shipping a program the runtime will refuse to run.
 *
 * A platform with no pinned asset is not an error. The search tool falls back to its built-in scanner, which is a
 * supported configuration — so the directory is still created, with a note saying why it is empty, and
 * `electron-builder` finds the resource directory it was told to expect.
 *
 * Usage:
 *   node scripts/copy-search-assets.mjs [--platform=win32] [--arch=x64] [--out=.scratch/packaging/search-assets]
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const options = {
  platform: process.platform,
  arch: process.arch,
  out: '.scratch/packaging/search-assets',
};
for (const arg of args) {
  if (arg.startsWith('--platform=')) options.platform = arg.slice('--platform='.length);
  else if (arg.startsWith('--arch=')) options.arch = arg.slice('--arch='.length);
  else if (arg.startsWith('--out=')) options.out = arg.slice('--out='.length);
  else throw new Error(`Unsupported argument: ${arg}`);
}

const key = `${options.platform}-${options.arch}`;
const destination = path.resolve(options.out);
await mkdir(destination, { recursive: true });

/**
 * The lock is staged beside the assets it describes, because a packaged runtime can only use a binary it can
 * read the digests for. The runtime resolves both from `process.resourcesPath`; a lock left behind in `build/`
 * would make a verified binary unreachable, and the application would quietly fall back to the built-in scanner
 * while shipping a program it never ran.
 */
const lockFile = path.join(root, 'build', 'search-assets.lock.json');
let lockBytes = null;
let lock = null;
try {
  lockBytes = await readFile(lockFile);
  lock = JSON.parse(lockBytes.toString('utf8'));
} catch {
  lock = null;
}
if (lockBytes) await writeFile(path.join(destination, 'search-assets.lock.json'), lockBytes);
const target = lock?.targets?.[key];
const source = lock?.version
  ? path.join(
      root,
      'build',
      'search-assets',
      lock.version,
      key,
      options.platform === 'win32' ? 'rg.exe' : 'rg',
    )
  : null;

if (!target || !source || !existsSync(source)) {
  // No asset for this target: say so where the next reader looks, and leave the directory valid and empty.
  await writeFile(
    path.join(destination, 'unavailable.json'),
    `${JSON.stringify(
      {
        target: key,
        reason: target
          ? 'the pinned asset has not been prepared on this machine'
          : 'no asset is pinned for this platform',
        remedy: `node scripts/prepare-search-assets.mjs --target=${key}`,
      },
      null,
      2,
    )}\n`,
  );
  console.log(`No search asset for ${key}; the built-in scanner is the backend in this package.`);
  process.exit(0);
}

const expected = target.binarySha256;
if (!/^[0-9a-f]{64}$/.test(expected ?? '')) {
  console.error(
    `The lock file pins no verified binary digest for ${key}; refusing to package an unverified program.`,
  );
  process.exit(1);
}
const bytes = await readFile(source);
const digest = createHash('sha256').update(bytes).digest('hex');
if (digest !== expected) {
  console.error(
    `Search asset digest mismatch for ${key}: ${digest} !== ${expected}. The package was not produced.`,
  );
  process.exit(1);
}

const directory = path.join(destination, lock.version, key);
await mkdir(directory, { recursive: true });
await writeFile(path.join(directory, path.basename(source)), bytes);
const license = path.join(path.dirname(source), 'LICENSE-MIT');
if (existsSync(license))
  await writeFile(path.join(directory, 'LICENSE-MIT'), await readFile(license));
await rm(path.join(destination, 'unavailable.json'), { force: true });
console.log(`Staged search asset for ${key} (${digest}) into ${directory}`);
