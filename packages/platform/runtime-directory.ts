import { lstatSync, mkdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { isWithin } from './workspace-paths.ts';

/** The workspace-local directory every piece of runtime state lives under. */
export const RUNTIME_DIRECTORY_NAME = '.yuantu';

/**
 * Create (or confirm) a directory for runtime state, refusing to follow a link out of the workspace.
 *
 * The session database, spill files, the search index and workspace metadata all live under `<workspace>/.yuantu`.
 * A cloned repository can ship that name as a symbolic link or a junction, and a plain `mkdir -p` would follow it
 * and write session content wherever it points. The file tools refuse links; the runtime's own state honours the
 * same boundary here, in one place.
 *
 * For a path inside a `.yuantu` segment, every component from that segment down is checked with `lstat` and created
 * one level at a time, and the result's real path must still sit under the workspace's real path. A path with no
 * `.yuantu` segment is not workspace runtime state, and gets an ordinary recursive `mkdir`.
 *
 * Returns the directory as given (resolved), so callers keep the spelling they report.
 */
export function ensureRuntimeDirectory(directory: string, options: { mode?: number } = {}): string {
  const resolved = path.resolve(directory);
  // Walk up to the nearest `.yuantu` segment; what lies above it is the workspace, what lies below is checked.
  const segments: string[] = [];
  let workspace: string | undefined;
  for (let cursor = resolved; cursor !== path.dirname(cursor); cursor = path.dirname(cursor)) {
    segments.unshift(path.basename(cursor));
    if (path.basename(cursor) === RUNTIME_DIRECTORY_NAME) {
      workspace = path.dirname(cursor);
      break;
    }
  }
  if (!workspace) {
    mkdirSync(resolved, {
      recursive: true,
      ...(options.mode === undefined ? {} : { mode: options.mode }),
    });
    return resolved;
  }
  const workspaceReal = realpathSync.native(workspace);
  let current = workspace;
  for (const segment of segments) {
    current = path.join(current, segment);
    ensureRealDirectory(current, options.mode);
  }
  const real = realpathSync.native(resolved);
  if (!isWithin(path.join(workspaceReal, RUNTIME_DIRECTORY_NAME), real))
    throw new Error(`Runtime directory escapes the workspace: ${resolved}`);
  return resolved;
}

function ensureRealDirectory(target: string, mode: number | undefined): void {
  let stat = lstatOrNull(target);
  if (!stat) {
    try {
      mkdirSync(target, mode === undefined ? {} : { mode });
    } catch (error) {
      // Another writer may have created it between the check and the mkdir; the re-check below decides.
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    stat = lstatOrNull(target);
  }
  if (!stat) throw new Error(`Runtime directory could not be created: ${target}`);
  if (stat.isSymbolicLink())
    throw new Error(`Runtime directory cannot be a symbolic link or junction: ${target}`);
  if (!stat.isDirectory()) throw new Error(`Runtime directory is not a directory: ${target}`);
}

function lstatOrNull(target: string) {
  try {
    return lstatSync(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
