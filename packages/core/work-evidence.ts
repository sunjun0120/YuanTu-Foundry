import path from 'node:path';
import type { FileChange } from '../protocol/index.ts';

/** Runtime scratch probes are investigation, not a change to the user's deliverable. */
export function projectChangedPaths(change: FileChange, root?: string): string[] {
  if (change.changes?.length)
    return change.changes.flatMap((item) => projectChangedPaths(item, root));
  const relative = root ? path.relative(root, path.resolve(root, change.path)) : change.path;
  const normalized = relative.replaceAll('\\', '/').replace(/^\.\//, '');
  return normalized === '.scratch' || normalized.startsWith('.scratch/') ? [] : [change.path];
}
