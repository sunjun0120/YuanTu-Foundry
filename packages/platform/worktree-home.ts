import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { canonicalKey } from './workspace-paths.ts';

/**
 * Where the runtime keeps the isolated worktrees it allocates for delegated work.
 *
 * Outside every repository, and on a path with no protected component. Both halves matter. Inside the repository —
 * the old `<repository>/.yuantu/worktrees/` — a child's directory sat under a name every native sandbox protects
 * (`.yuantu`), so a write-capable child confined to its own worktree could not write to it at all; and it sat inside
 * the delegator's root, so the delegator's own commands could reach into a child's tree. A per-user data directory
 * is neither: the child's sandbox grants exactly its worktree, and the parent's grants nothing of it.
 *
 * `YUANTU_WORKTREE_DIR` overrides the location (it must be absolute); the test runner points it at a scratch
 * directory so suites never allocate into the real user's data.
 */
export function managedWorktreeHome(env: NodeJS.ProcessEnv = process.env): string {
  return realLocation(configuredHome(env));
}

function configuredHome(env: NodeJS.ProcessEnv): string {
  const configured = env.YUANTU_WORKTREE_DIR?.trim();
  if (configured) {
    if (!path.isAbsolute(configured))
      throw new Error('YUANTU_WORKTREE_DIR must be an absolute path');
    return path.normalize(configured);
  }
  if (process.platform === 'win32') {
    const local = env.LOCALAPPDATA?.trim();
    return path.join(
      local && path.isAbsolute(local) ? local : path.join(homedir(), 'AppData', 'Local'),
      'YuanTu',
      'worktrees',
    );
  }
  if (process.platform === 'darwin')
    return path.join(homedir(), 'Library', 'Application Support', 'YuanTu', 'worktrees');
  const data = env.XDG_DATA_HOME?.trim();
  return path.join(
    data && path.isAbsolute(data) ? data : path.join(homedir(), '.local', 'share'),
    'yuantu',
    'worktrees',
  );
}

/**
 * The location with every link in its existing part resolved, and the not-yet-created rest appended.
 *
 * A worktree's execution root must be its real path — validation refuses one reached through a link — so the home
 * is spelled the way the filesystem will report it once created (`/var` → `/private/var` on macOS, a junctioned
 * profile directory on Windows), before any of it exists.
 */
function realLocation(location: string): string {
  const pending: string[] = [];
  let current = location;
  for (;;) {
    try {
      return path.join(realpathSync.native(current), ...pending.reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return location;
      pending.push(path.basename(current));
      current = parent;
    }
  }
}

/**
 * The directory one repository's worktrees share under the home, named by the repository rather than chosen by it.
 *
 * A digest of the canonical root, so two checkouts never share a directory, the same checkout always finds its own,
 * and nothing a repository contains (its name, a remote URL) can steer where the runtime writes.
 */
export function repositoryWorktreeKey(repositoryRoot: string): string {
  return createHash('sha256').update(canonicalKey(repositoryRoot)).digest('hex').slice(0, 16);
}

/** `<home>/<repository key>`: the parent of every worktree this repository's delegations own. */
export function repositoryWorktreeParent(
  repositoryRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(managedWorktreeHome(env), repositoryWorktreeKey(repositoryRoot));
}
