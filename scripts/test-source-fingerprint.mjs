import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

/** Stable source/test inputs for serial-vs-parallel evidence, including new untracked files. */
export async function sourceFingerprint(root) {
  const files = [];
  async function walk(directory) {
    let entries;
    try {
      entries = await readdir(path.join(root, directory), { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      if (
        ['node_modules', '.git', '.scratch', 'dist', 'artifacts', 'target'].includes(entry.name) ||
        (directory === 'build' && entry.name === 'search-assets')
      )
        continue;
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (entry.isFile()) files.push(file);
    }
  }
  for (const directory of [
    'packages',
    'apps',
    'scripts',
    'tests',
    'build',
    '.github',
    'benchmarks',
    'sdk',
    'examples',
  ])
    await walk(directory);
  for (const entry of await readdir(root, { withFileTypes: true }))
    if (
      entry.isFile() &&
      /^(?:package(?:-lock)?\.json|tsconfig(?:\.[\w-]+)*\.json|electron-builder(?:\.[\w-]+)*\.cjs|\.prettier(?:ignore|rc(?:\.json)?)|\.env\.example|README\.md)$/.test(
        entry.name,
      )
    )
      files.push(entry.name);
  const hash = createHash('sha256');
  for (const file of files.sort()) {
    hash.update(file.replaceAll('\\', '/') + '\0');
    hash.update(
      createHash('sha256')
        .update(await readFile(path.join(root, file)))
        .digest(),
    );
  }
  return { algorithm: 'sha256', digest: hash.digest('hex'), files: files.length };
}
