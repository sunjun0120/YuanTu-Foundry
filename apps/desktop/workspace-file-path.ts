/**
 * Turn a path from a deliverable or a Markdown link into a real, contained workspace path.
 *
 * The renderer may name anything; the shell must not. Resolve against the workspace's real path, verify the
 * lexical result, then resolve symlinks/junctions and verify the real target as well. `.yuantu` is runtime state,
 * not a user-facing file, and is refused explicitly.
 */
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { isWithin } from '../../packages/platform/workspace-paths.ts';

export function workspaceFilePath(workspace: string, requested: string): string {
  if (!requested || requested.length > 4096 || requested.includes('\0'))
    throw new Error('Invalid workspace path');
  const root = realpathSync.native(workspace);
  const candidate = path.resolve(root, requested);
  if (!isWithin(root, candidate)) throw new Error('Path escapes the workspace');
  const target = realpathSync.native(candidate);
  if (!isWithin(root, target)) throw new Error('Path escapes the workspace');
  if (isWithin(path.join(root, '.yuantu'), target))
    throw new Error('Runtime state is not a workspace file');
  return target;
}
