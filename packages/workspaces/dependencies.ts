import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { DependencyWarning } from '../protocol/workspaces.ts';
export type { DependencyWarning } from '../protocol/workspaces.ts';

/** Report an absent local Node install; never install packages or reuse a writable parent tree. */
export async function nodeDependencyWarning(
  executionRoot: string,
  signal: AbortSignal,
): Promise<DependencyWarning | null> {
  signal.throwIfAborted();
  const manifestPath = path.join(executionRoot, 'package.json');
  const info = await lstat(manifestPath).catch(() => null);
  if (!info?.isFile() || info.isSymbolicLink() || info.size > 512 * 1024) return null;
  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(await readFile(manifestPath, { encoding: 'utf8', signal }));
  } catch (error) {
    signal.throwIfAborted();
    return null;
  }
  signal.throwIfAborted();
  if (!manifest || typeof manifest !== 'object') return null;
  const declared = [manifest.dependencies, manifest.devDependencies, manifest.optionalDependencies];
  if (!declared.some((value) => value && typeof value === 'object' && Object.keys(value).length))
    return null;
  const local = await lstat(path.join(executionRoot, 'node_modules')).catch(() => null);
  signal.throwIfAborted();
  if (local?.isDirectory() && !local.isSymbolicLink()) return null;
  return {
    code: 'WORKSPACE_DEPENDENCIES_MISSING',
    paths: ['node_modules'],
    message:
      'This isolated Node project has no local node_modules install. Source inspection can continue, but dependency-dependent checks need a separate local install through the normal approval flow. Do not borrow or link the parent workspace’s writable dependencies. This check does not verify the completeness of an existing install.',
  };
}
