/**
 * Where a trusted ripgrep may come from — and why nowhere else counts.
 *
 * A search backend that executes a binary has two ways to be turned into an attack: put a program named `rg` in
 * the workspace and let the tool find it, or plant one earlier on `PATH`. Both are refused here by construction:
 * the asset root is a directory this build ships, the candidates inside it are checked for being regular files
 * and not links, and the bytes must hash to the digest the lock file records. A host `PATH` is never consulted,
 * and a workspace path is refused even when it would hash correctly.
 *
 * The lock file is checked in and names one entry per `platform-arch`. A platform with no entry has no asset —
 * which is the honest state, not a reason to look for a program the operator happens to have installed. Filling
 * in a digest that was never verified would turn this whole module into a formality.
 */
import path from 'node:path';
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export interface SearchAssetTarget {
  url: string;
  archiveSha256: string;
  binarySha256: string;
  licenseSha256: string;
}

export interface SearchAssetLock {
  version: string;
  targets: Record<string, SearchAssetTarget>;
}

export interface ResolvedSearchBinary {
  executable: string;
  version: string;
  sha256: string;
}

/** The lock file's platform key, e.g. `win32-x64`. */
export function platformArchKey(platform = process.platform, arch = process.arch): string {
  return `${platform}-${arch}`;
}

/**
 * The directories that may hold the checked-in lock file, resolved from this module rather than the workspace.
 *
 * From source the module is `packages/search/` and the checkout's `build/` is two levels up. Compiled (tsc output
 * in `dist/packages/search/`, or the Host bundle in `dist/packages/tools/`) two levels up is `dist/`, which holds no
 * `build/`, so the checkout's one beside `dist/` is the candidate there.
 */
export function buildRoots(): string[] {
  const above = fileURLToPath(new URL('../../', import.meta.url));
  const roots = [path.join(above, 'build')];
  if (path.basename(above.replace(/[\\/]$/, '')) === 'dist')
    roots.push(path.join(above, '..', 'build'));
  return roots;
}

/** Where per-target assets live once `scripts/prepare-search-assets.mjs` has verified them. */
function assetDirectoriesUnder(version: string, key: string): string[] {
  return buildRoots().map((root) => path.join(root, 'search-assets', version, key));
}

/** `process.resourcesPath` when this build is a packaged desktop application, otherwise `null`. */
function resourcesRoot(): string | null {
  const resources = (process as unknown as { resourcesPath?: unknown }).resourcesPath;
  return typeof resources === 'string' && resources ? resources : null;
}

/**
 * Every place a verified asset may live, most-specific first.
 *
 * A packaged desktop application carries the binary as a resource beside its own `app.asar`, so
 * `process.resourcesPath` is the first candidate there; a checkout, a CLI install or a test finds it in the
 * checkout's `build` directory (`buildRoots`). All are checked by digest, so trying several places costs a failed
 * lookup each and never widens what is trusted.
 */
export function assetDirectories(version: string, key = platformArchKey()): string[] {
  const directories: string[] = [];
  const resources = resourcesRoot();
  if (resources) directories.push(path.join(resources, 'search-assets', version, key));
  directories.push(...assetDirectoriesUnder(version, key));
  return directories;
}

/**
 * Every place the lock file may live, most-specific first — deliberately the same order as `assetDirectories`,
 * because the two have to agree to be any use.
 *
 * A packaged application stages its verified binary under `resources/search-assets`, and a lock that is only
 * ever looked for beside the compiled module makes that binary *unreachable*: the runtime answers "no verified
 * asset" while a verified asset sits next to its own `resources`. The compiled layout is what exposes it —
 * `buildRoots()` from `resources/app/dist/packages/search` are `resources/app/dist/build` and
 * `resources/app/build`, and no package contains either directory. So `scripts/copy-search-assets.mjs` stages the lock beside the binary it
 * describes, and this list looks there first.
 */
export function lockFiles(): string[] {
  const files: string[] = [];
  const resources = resourcesRoot();
  if (resources) files.push(path.join(resources, 'search-assets', 'search-assets.lock.json'));
  for (const root of buildRoots()) files.push(path.join(root, 'search-assets.lock.json'));
  return files;
}

/**
 * Reads the lock file, from the first place one is actually found.
 *
 * A missing or unparsable lock is `null` rather than an error: it means this build has no verified asset, which
 * is a supported configuration — the built-in scanner is the backend then. Passing a path reads exactly that
 * path and nothing else, which is what callers that already know where their lock is want.
 */
export async function loadSearchAssetLock(file?: string): Promise<SearchAssetLock | null> {
  for (const candidate of file === undefined ? lockFiles() : [file]) {
    const lock = await readLockFile(candidate);
    if (lock) return lock;
  }
  return null;
}

async function readLockFile(file: string): Promise<SearchAssetLock | null> {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as Partial<SearchAssetLock>;
    if (typeof parsed.version !== 'string' || typeof parsed.targets !== 'object' || !parsed.targets)
      return null;
    return { version: parsed.version, targets: parsed.targets };
  } catch {
    return null;
  }
}

/**
 * The executable path of a verified asset for this platform, or `null` when there is none.
 *
 * `workspaceRoot` is passed so an asset directory placed *inside* the workspace can be refused: a repository the
 * model can write to must never be able to supply the program the search tool runs, however well it hashes.
 */
export async function resolveSearchBinary(options: {
  workspaceRoot: string;
  lock?: SearchAssetLock | null;
  directory?: string;
}): Promise<ResolvedSearchBinary | null> {
  const lock = options.lock === undefined ? await loadSearchAssetLock() : options.lock;
  if (!lock || !lock.version || lock.version === 'unprepared') return null;
  const key = platformArchKey();
  const target = lock.targets[key];
  if (!target) return null;
  const directories = options.directory ? [options.directory] : assetDirectories(lock.version, key);
  for (const directory of directories) {
    const found = await verifyBinary(
      path.join(directory, binaryName()),
      target,
      options.workspaceRoot,
      lock.version,
    );
    if (found) return found;
  }
  return null;
}

/** The program's file name on this platform. */
export function binaryName(platform = process.platform): string {
  return platform === 'win32' ? 'rg.exe' : 'rg';
}

async function verifyBinary(
  candidate: string,
  target: SearchAssetTarget,
  workspaceRoot: string,
  version: string,
): Promise<ResolvedSearchBinary | null> {
  try {
    const stats = await lstat(candidate);
    // A link is refused even inside the asset root: it is the one way a file that verifies could be swapped for
    // one that does not between the check and the spawn.
    if (!stats.isFile() || stats.isSymbolicLink()) return null;
    const canonical = await realpath(candidate);
    const workspace = await realpath(path.resolve(workspaceRoot)).catch(() => null);
    if (workspace && inside(workspace, canonical)) return null;
    const bytes = await readFile(canonical);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (sha256 !== target.binarySha256) return null;
    return { executable: canonical, version, sha256 };
  } catch {
    return null;
  }
}

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === '' ||
    (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))
  );
}
