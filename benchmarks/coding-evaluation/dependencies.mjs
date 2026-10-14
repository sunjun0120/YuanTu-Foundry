import path from 'node:path';
import { readFile, mkdir, writeFile, lstat } from 'node:fs/promises';
import { copyFiles, inventory, inventoryLinked, hash } from './materialize.mjs';

/** Clone existing installed production dependencies, never install or use the network.
 * The receipt binds exact file content and package versions to the frozen lockfile.
 * Missing/linked/version-drifted installations are preparation blockers.
 */
export async function copyLockedDependencies({ sourceDirectory, targetDirectory, packages }) {
  const source = path.resolve(sourceDirectory),
    target = path.resolve(targetDirectory);
  if ((await lstat(source)).isSymbolicLink())
    throw new Error('Linked dependency source directory is forbidden');
  if (source === target) throw new Error('Private dependencies must have a distinct destination');
  const lockBytes = await readFile(path.join(source, 'package-lock.json'));
  const targetLock = await readFile(path.join(target, 'package-lock.json'));
  if (hash(lockBytes) !== hash(targetLock))
    throw new Error('Source and frozen dependency lockfiles differ');
  const lock = JSON.parse(lockBytes);
  const metadata = JSON.parse(await readFile(path.join(source, 'package.json'), 'utf8'));
  const sourceModules = path.join(source, 'node_modules');
  if ((await lstat(sourceModules)).isSymbolicLink())
    throw new Error('Linked source dependency installation is not accepted');
  await mkdir(path.join(target, 'node_modules'));
  const visited = new Set(),
    versions = [];
  async function visit(name, importer = source) {
    let current = importer,
      directory;
    while (current.startsWith(source)) {
      const candidate = path.join(current, 'node_modules', name);
      try {
        await lstat(path.join(candidate, 'package.json'));
        directory = candidate;
        break;
      } catch {
        /* npm hoisting */
      }
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
    if (!directory) throw new Error(`Missing locked dependency ${name}`);
    const relative = path.relative(sourceModules, directory).split(path.sep).join('/');
    if (relative.startsWith('..') || path.isAbsolute(relative))
      throw new Error('Dependency escaped source node_modules');
    if (visited.has(relative)) return;
    visited.add(relative);
    if ((await lstat(directory)).isSymbolicLink()) throw new Error(`Linked dependency ${name}`);
    const packageMetadata = JSON.parse(
      await readFile(path.join(directory, 'package.json'), 'utf8'),
    );
    if (lock.packages?.[`node_modules/${relative}`]?.version !== packageMetadata.version)
      throw new Error(`Installed/lock version mismatch for ${relative}`);
    const files = await inventory(directory, { includeExcluded: true });
    await copyFiles(
      directory,
      path.join(target, 'node_modules', relative),
      files.filter((file) => !file.path.startsWith('node_modules/')),
    );
    if (hash(await inventory(directory, { includeExcluded: true })) !== hash(files))
      throw new Error(`Dependency input changed: ${relative}`);
    versions.push({ name: relative, version: packageMetadata.version, filesHash: hash(files) });
    for (const dependency of Object.keys(packageMetadata.dependencies ?? {}))
      await visit(dependency, directory);
    for (const dependency of Object.keys(packageMetadata.optionalDependencies ?? {})) {
      // Optional native packages absent on this OS are not installed. Those present
      // still receive the same lock/content checks; do not suppress drift errors.
      const installed = lock.packages?.[`node_modules/${dependency}`];
      if (installed?.os && !installed.os.includes(process.platform)) continue;
      if (installed?.cpu && !installed.cpu.includes(process.arch)) continue;
      try {
        await lstat(path.join(sourceModules, dependency, 'package.json'));
      } catch (error) {
        if (error.code === 'ENOENT') continue;
        throw error;
      }
      await visit(dependency, directory);
    }
  }
  for (const name of packages ?? Object.keys(metadata.dependencies ?? {})) await visit(name);
  const files = await inventory(path.join(target, 'node_modules'), { includeExcluded: true });
  const receipt = {
    version: 1,
    private: true,
    source: 'copied-existing-locked-installation',
    lockHash: hash(lockBytes),
    filesHash: hash(files),
    packages: versions.sort((a, b) => (a.name < b.name ? -1 : 1)),
    platform: process.platform,
    arch: process.arch,
  };
  await writeFile(
    path.join(target, '.evaluation-dependencies.json'),
    JSON.stringify(receipt, null, 2),
    { flag: 'wx' },
  );
  return receipt;
}

/**
 * Bind one directory to its own private installation, or report why it cannot be.
 *
 * A directory either already carries a receipt that still matches its lockfile and its installed content, or it is
 * prepared from an existing locked installation on this machine. Nothing here installs, reaches the network or
 * leaves a link standing in for a package directory: an installation this machine does not already have is a
 * preparation blocker, not something to fetch.
 *
 * Files are copied, never hard-linked: editing a sample dependency must not rewrite the trusted runtime or grader.
 */
export async function preparePrivateDependencies({
  targetDirectory,
  sourceDirectory,
  packages,
  verifyContent: _verifyContent = true,
}) {
  const target = path.resolve(targetDirectory);
  let receipt;
  try {
    receipt = JSON.parse(
      await readFile(path.join(target, '.evaluation-dependencies.json'), 'utf8'),
    );
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (receipt) {
    if (receipt.private !== true)
      throw new Error('Dependency receipt is not a private installation');
    if (receipt.lockHash !== hash(await readFile(path.join(target, 'package-lock.json'))))
      throw new Error('Lockfile changed under an existing dependency receipt');
    const files = await inventory(path.join(target, 'node_modules'), { includeExcluded: true });
    if (hash(files) !== receipt.filesHash)
      throw new Error('Private dependency installation content changed');
    if ((await inventoryLinked(path.join(target, 'node_modules'))).some((file) => file.links !== 1))
      throw new Error('Private dependencies contain shared hard links');
    return receipt;
  }
  const source = path.resolve(sourceDirectory ?? target);
  if (source === target)
    throw new Error('Private dependencies require a distinct installed source');
  const canonicalReceipt = await readFile(
    path.join(source, '.evaluation-dependencies.json'),
    'utf8',
  ).catch(() => null);
  if (canonicalReceipt) {
    const parsed = JSON.parse(canonicalReceipt);
    if (
      parsed.private !== true ||
      parsed.lockHash !== hash(await readFile(path.join(target, 'package-lock.json')))
    )
      throw new Error('Canonical dependency receipt does not match this lockfile');
    const listed = await inventory(path.join(source, 'node_modules'), { includeExcluded: true });
    if (hash(listed) !== parsed.filesHash)
      throw new Error('Canonical dependency installation content changed');
    await copyFiles(path.join(source, 'node_modules'), path.join(target, 'node_modules'), listed);
    const copy = {
      ...parsed,
      source: 'copied-verified-installation',
      links: false,
    };
    if (
      hash(await inventory(path.join(target, 'node_modules'), { includeExcluded: true })) !==
      parsed.filesHash
    )
      throw new Error('Private dependency copy changed content');
    await writeFile(
      path.join(target, '.evaluation-dependencies.json'),
      JSON.stringify(copy, null, 2),
      {
        flag: 'wx',
      },
    );
    return copy;
  }
  return copyLockedDependencies({ sourceDirectory: source, targetDirectory: target, packages });
}
