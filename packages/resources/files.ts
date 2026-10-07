import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
export function resourcePath(root: string, relative: string): string {
  const base = realpathSync(root),
    target = path.resolve(base, relative),
    rel = path.relative(base, target);
  if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel))
    throw new Error('Resource is outside workspace');
  let current = base;
  for (const part of rel.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if (lstatSync(current).isSymbolicLink())
      throw new Error('Resource symbolic links are not allowed');
  }
  return target;
}
export function resourceText(root: string, relative: string): string {
  const file = resourcePath(root, relative),
    stat = lstatSync(file);
  if (!stat.isFile() || stat.size > 32768)
    throw new Error(`Resource must be a regular file <=32KB: ${relative}`);
  const bytes = readFileSync(file);
  if (bytes.length > 32768) throw new Error('Resource exceeds 32KB');
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error('Resource must be UTF-8');
  }
}
export function resourceEntries(root: string, relative: string): string[] {
  try {
    const entries = readdirSync(resourcePath(root, relative));
    if (entries.length > 64) throw new Error('Resource directory exceeds 64 entries');
    return entries.sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}
