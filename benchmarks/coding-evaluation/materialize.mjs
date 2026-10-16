import path from 'node:path';
import { createHash } from 'node:crypto';
import { lstat, link, readdir, readFile, mkdir, writeFile, realpath } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
export const hash = (value) =>
  createHash('sha256')
    .update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value))
    .digest('hex');
async function mapFiles(items, action) {
  let cursor = 0;
  let firstError;
  const results = new Array(items.length);
  await Promise.all(
    Array.from({ length: Math.min(32, items.length) }, async () => {
      for (;;) {
        if (firstError) return;
        const index = cursor++;
        if (index >= items.length) return;
        try {
          results[index] = await action(items[index]);
        } catch (error) {
          firstError ??= error;
          return;
        }
      }
    }),
  );
  if (firstError) throw firstError;
  return results;
}
const productionRoots = new Set(['apps', 'packages', 'tests', 'scripts']);
const excludedDirectories =
  /(^|\/)(?:node_modules|dist|\.git|\.scratch|\.yuantu|\.codex|\.agents|\.aws|__pycache__)(\/|$)/i;
/**
 * Credential *data* is excluded; a source module that happens to be named
 * `credentials.ts` is product code and must stay in the snapshot. The former
 * pattern also matched `packages/providers/credentials.ts`, which silently
 * produced a frozen runtime the Host could not even import.
 *
 * The private dependency receipt is excluded too: it describes what was copied into a *destination*, so it must
 * never travel with a frozen source or reappear inside a task workspace's own change set.
 */
const excludedFiles =
  /(?:^|\/)(?:\.env(?:\..*)?|credentials(?:\.json|\.ya?ml|\.txt)|\.evaluation-dependencies\.json|.*\.(?:sqlite|db|pem|key|pfx|p12))$/i;
const excluded = (p) => excludedDirectories.test(p) || excludedFiles.test(p);
const permitted = (p) =>
  !excluded(p) &&
  (productionRoots.has(p.split('/')[0]) ||
    /^(?:package(?:-lock)?\.json|tsconfig(?:\.[a-z-]+)?\.json|AGENTS\.md|build\/[^/]+\.lock\.json)$/.test(
      p,
    ));
export async function inventory(
  directory,
  { productionOnly = false, includeExcluded = false, pruneDirectories = [] } = {},
) {
  const root = await realpath(directory);
  const files = [];
  async function walk(relative) {
    for (const entry of (await readdir(path.join(root, relative), { withFileTypes: true })).sort(
      (a, b) => (a.name < b.name ? -1 : 1),
    )) {
      const p = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory() && pruneDirectories.includes(p)) continue;
      if (
        !includeExcluded &&
        (productionOnly
          ? excluded(p)
          : /^(?:\.git|\.yuantu|node_modules)(?:\/|$)|^\.evaluation-dependencies\.json$/.test(p))
      )
        continue;
      if (
        productionOnly &&
        !permitted(p) &&
        !(entry.isDirectory() && (productionRoots.has(p.split('/')[0]) || p === 'build'))
      )
        continue;
      const absolute = path.join(root, p);
      if (entry.isSymbolicLink()) throw new Error(`Link input is forbidden: ${p}`);
      if (entry.isDirectory()) {
        if ((await lstat(absolute)).isSymbolicLink())
          throw new Error(`Link input is forbidden: ${p}`);
        await walk(p);
      } else if (entry.isFile()) files.push(p);
      else throw new Error(`Non-regular input: ${p}`);
    }
  }
  await walk('');
  return mapFiles(files, async (p) => {
    const stat = await lstat(path.join(root, p));
    if (stat.isSymbolicLink() || !stat.isFile())
      throw new Error(`Link/non-regular input is forbidden: ${p}`);
    const content = await readFile(path.join(root, p));
    return { path: p, size: content.length, sha256: hash(content) };
  });
}
export async function captureSourceManifest(directory) {
  if (!path.isAbsolute(directory)) throw new Error('Source path must be absolute');
  if ((await lstat(directory)).isSymbolicLink())
    throw new Error('Source directory cannot be a link');
  const files = await inventory(directory, { productionOnly: true });
  if (!files.length) throw new Error('Empty production input');
  return { version: 1, files, hash: hash(files) };
}
export async function newDirectory(directory) {
  if (!path.isAbsolute(directory)) throw new Error('Output directory must be absolute');
  await mkdir(path.dirname(directory), { recursive: true });
  await mkdir(directory);
}
export async function copyFiles(source, target, files) {
  await newDirectory(target);
  const directories = new Map();
  await mapFiles(files, async (file) => {
    const contents = await readFile(path.join(source, file.path));
    if (hash(contents) !== file.sha256) throw new Error(`Input changed during copy: ${file.path}`);
    const directory = path.dirname(path.join(target, file.path));
    if (!directories.has(directory))
      directories.set(directory, mkdir(directory, { recursive: true }));
    await directories.get(directory);
    await writeFile(path.join(target, file.path), contents, { flag: 'wx' });
  });
}
/**
 * Fingerprint a tree whose files are hard links to a copy that was already hashed.
 *
 * This exists because a grader machinery copy of `node_modules` is 100k+ files: hashing every byte again for each
 * of the 24 control copies costs minutes and proves nothing new, since the receipt already binds the content. What
 * *does* need proving is that the link still points at a file of the recorded size that has exactly one more name
 * than it had — a hard link cannot have been quietly replaced or written through without changing one of those.
 * It is therefore deliberately a cheap, weaker check than {@link inventory}, and callers must not use it where a
 * content comparison is what matters.
 */
export async function inventoryLinked(directory) {
  const root = await realpath(directory);
  const files = [];
  async function walk(relative) {
    for (const entry of (await readdir(path.join(root, relative), { withFileTypes: true })).sort(
      (a, b) => (a.name < b.name ? -1 : 1),
    )) {
      const p = relative ? `${relative}/${entry.name}` : entry.name;
      const absolute = path.join(root, p);
      if (entry.isSymbolicLink()) throw new Error(`Link input is forbidden: ${p}`);
      if (entry.isDirectory()) {
        if ((await lstat(absolute)).isSymbolicLink())
          throw new Error(`Link input is forbidden: ${p}`);
        await walk(p);
      } else if (entry.isFile()) files.push(p);
      else throw new Error(`Non-regular input: ${p}`);
    }
  }
  await walk('');
  return mapFiles(files, async (p) => {
    const stat = await lstat(path.join(root, p));
    if (stat.isSymbolicLink() || !stat.isFile())
      throw new Error(`Link/non-regular input is forbidden: ${p}`);
    return { path: p, size: stat.size, links: stat.nlink };
  });
}
/**
 * Build `target` as hard links to `source` rather than reading every byte again.
 *
 * `link()` is atomic per file: a file that is written through one name is the same inode, so a grader copy that
 * shares inodes with the frozen installation cannot drift from it silently. Cross-volume copies cannot link at
 * all, so that case falls back to the byte copy the caller already knows how to verify.
 */
export async function linkFiles(source, target, files) {
  // `target` may or may not exist: a validation copy is built from a frozen corpus first and only then gets its
  // dependencies, so an existing destination is expected here rather than a collision.
  await mkdir(target, { recursive: true });
  for (const file of files) {
    const from = path.join(source, file.path);
    const to = path.join(target, file.path);
    await mkdir(path.dirname(to), { recursive: true });
    try {
      await link(from, to);
    } catch (error) {
      if (error.code === 'EXDEV') return { linked: false, reason: 'cross-device link unavailable' };
      throw error;
    }
  }
  return { linked: true, reason: null };
}
async function freezeSource(spec, target) {
  if (!path.isAbsolute(spec.directory)) throw new Error('Source directory must be absolute');
  if (spec.kind === 'snapshot') {
    const before = await captureSourceManifest(spec.directory);
    if (before.hash !== spec.manifestSha256) throw new Error('Snapshot manifest hash mismatch');
    await copyFiles(spec.directory, target, before.files);
    const after = await captureSourceManifest(spec.directory);
    if (after.hash !== before.hash)
      throw new Error('Source file list/content changed while freezing');
    if ((await captureSourceManifest(target)).hash !== before.hash)
      throw new Error('Frozen copy mismatch');
    return before;
  }
  if (spec.kind !== 'commit' || !/^[a-f0-9]{40}$/.test(spec.revision))
    throw new Error('Immutable full commit required');
  const { stdout: revision } = await exec('git', ['rev-parse', `${spec.revision}^{commit}`], {
    cwd: spec.directory,
    windowsHide: true,
  });
  if (revision.trim() !== spec.revision) throw new Error('Commit identity mismatch');
  const { stdout } = await exec('git', ['ls-tree', '-r', '-z', spec.revision], {
    cwd: spec.directory,
    encoding: 'utf8',
    maxBuffer: 32_000_000,
    windowsHide: true,
  });
  await newDirectory(target);
  for (const line of stdout.split('\0').filter(Boolean)) {
    const [metadata, relative] = line.split('\t');
    if (!permitted(relative)) continue;
    if (!metadata.startsWith('100644 ') && !metadata.startsWith('100755 '))
      throw new Error(`Link/submodule input forbidden: ${relative}`);
    const { stdout: contents } = await exec('git', ['show', `${spec.revision}:${relative}`], {
      cwd: spec.directory,
      encoding: 'buffer',
      maxBuffer: 64_000_000,
      windowsHide: true,
    });
    await mkdir(path.dirname(path.join(target, relative)), { recursive: true });
    await writeFile(path.join(target, relative), contents, { flag: 'wx' });
  }
  return captureSourceManifest(target);
}
export async function freezeInputs({ runtimeSource, corpusSource, outputDirectory }) {
  const out = path.resolve(outputDirectory);
  for (const spec of [runtimeSource, corpusSource]) {
    const relative = path.relative(path.resolve(spec.directory), out);
    if (
      !relative ||
      (!relative.startsWith('..') &&
        !path.isAbsolute(relative) &&
        !relative.split(path.sep).includes('.scratch'))
    )
      throw new Error('Freeze output must be outside inputs or under excluded .scratch');
  }
  await newDirectory(out);
  const runtimeDirectory = path.join(out, 'runtime');
  const corpusDirectory = path.join(out, 'corpus');
  const runtime = await freezeSource(runtimeSource, runtimeDirectory);
  const corpus = await freezeSource(corpusSource, corpusDirectory);
  const frozen = {
    runtimeDirectory,
    corpusDirectory,
    runtimeHash: runtime.hash,
    corpusHash: corpus.hash,
    runtimeFiles: runtime.files,
    corpusFiles: corpus.files,
    /**
     * Where each frozen tree came from.
     *
     * A frozen copy deliberately carries no `node_modules`, so the one thing a later step cannot re-derive is the
     * installation the copy was made from. Recording it here is what lets private dependencies be copied from a
     * verified local installation instead of being guessed from the layout of `.scratch`.
     */
    runtimeSource: runtimeSource.directory,
    corpusSource: corpusSource.directory,
  };
  await writeFile(
    path.join(out, 'inputs.json'),
    JSON.stringify({ version: 1, sources: { runtimeSource, corpusSource }, ...frozen }, null, 2),
    { flag: 'wx' },
  );
  return frozen;
}
export async function assertFrozen(frozen) {
  for (const [directory, expected] of [
    [frozen.runtimeDirectory, frozen.runtimeHash],
    [frozen.corpusDirectory, frozen.corpusHash],
  ]) {
    if ((await captureSourceManifest(directory)).hash !== expected)
      throw new Error('Frozen input was tampered with');
  }
}
export async function materializeCase({ frozen, caseId, sampleId, outputDirectory }) {
  if (!/^E(?:0[1-9]|10)$/.test(caseId) || !/^[a-zA-Z0-9_-]{1,100}$/.test(sampleId))
    throw new Error('Invalid case/sample identity');
  await assertFrozen(frozen);
  const directory = path.resolve(outputDirectory);
  await copyFiles(frozen.corpusDirectory, directory, frozen.corpusFiles);
  return { directory, sampleId, baseHash: frozen.corpusHash, baseFiles: frozen.corpusFiles };
}
