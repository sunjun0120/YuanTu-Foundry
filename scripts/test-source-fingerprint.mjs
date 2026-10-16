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
      if (['node_modules', '.git', '.scratch', 'dist', 'artifacts'].includes(entry.name)) continue;
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (entry.isFile()) files.push(file);
    }
  }
  for (const directory of ['packages', 'apps', 'scripts', 'tests']) await walk(directory);
  for (const file of ['package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.build.json'])
    try {
      await readFile(path.join(root, file));
      files.push(file);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
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
