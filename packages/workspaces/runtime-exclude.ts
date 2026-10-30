import { mkdir, readFile, appendFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { parseSetting } from '../protocol/settings.ts';
import { workspaceGit } from './git.ts';

/**
 * Keeps the runtime's own state under `<workspace>/.yuantu` out of the user's `git status`.
 *
 * The session database, its WAL, the search index, spilled results and workspace snapshots are all written inside
 * the project, and nothing told Git about them: `git status --untracked-files=all` listed every one, and a
 * `git add -A` would commit whole snapshots of the tree. The file tools already hide the directory from the model;
 * this is the same boundary for Git.
 *
 * The repository's private `info/exclude`, not `.gitignore`: it is local to this clone, is never committed, and
 * changes nothing a teammate sees. Only the directory's *contents* are excluded, with what a person may mean to
 * share put back — `lsp.json` (language server configuration), `memory/` (the workspace memory, one file per
 * entry) and the single `memory.md` of earlier versions, until it is migrated.
 *
 * Best effort and idempotent: a workspace that is not inside a Git working tree, or whose exclude file cannot be
 * written, is left alone, and a block already present is not written twice. A block written by an earlier
 * version is completed with the lines it lacks instead, since its presence would otherwise keep them out for
 * good. Returns whether anything was added.
 */
export async function excludeRuntimeState(
  workspace: string,
  options: { signal?: AbortSignal; env?: NodeJS.ProcessEnv } = {},
): Promise<boolean> {
  // `YUANTU_GIT_EXCLUDE=0` leaves the repository's metadata alone. The test runner sets it: a suite's temporary
  // workspaces sit inside this repository, and a test must never write to its `.git`.
  if (parseSetting(options.env ?? process.env, 'YUANTU_GIT_EXCLUDE') === false) return false;
  const { signal } = options;
  const root = await realpath(workspace).catch(() => null);
  if (!root) return false;
  let output: string;
  try {
    output = await workspaceGit(['rev-parse', '--show-toplevel', '--git-common-dir'], {
      cwd: root,
      ...(signal ? { signal } : {}),
    });
  } catch {
    return false;
  }
  const [top, commonDir] = output.split(/\r?\n/);
  if (!top || !commonDir) return false;
  const topLevel = await realpath(top).catch(() => null);
  if (!topLevel) return false;
  const common = path.isAbsolute(commonDir) ? commonDir : path.join(root, commonDir);
  const relative = path.relative(topLevel, root).split(path.sep).join('/');
  if (relative.startsWith('..')) return false;
  // Anchored to the workspace's own directory, so a `.yuantu` elsewhere in the repository is not swept up.
  const prefix = `/${relative ? `${escapePattern(relative)}/` : ''}.yuantu`;
  const block = [
    '# YuanTu runtime state; configuration it reads from .yuantu stays visible.',
    `${prefix}/*`,
    `!${prefix}/lsp.json`,
    `!${prefix}/memory.md`,
    `!${prefix}/memory/`,
  ];
  const file = path.join(common, 'info', 'exclude');
  const existing = await readFile(file, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return '';
    throw error;
  });
  const present = new Set(existing.split(/\r?\n/));
  const missing = present.has(block[1]!)
    ? block.slice(2).filter((line) => !present.has(line))
    : block;
  if (!missing.length) return false;
  await mkdir(path.dirname(file), { recursive: true });
  const separator = existing && !existing.endsWith('\n') ? '\n' : '';
  await appendFile(file, `${separator}${missing.join('\n')}\n`, 'utf8');
  return true;
}

/** A path segment as a gitignore pattern: the characters the pattern syntax would otherwise interpret. */
function escapePattern(value: string): string {
  return value.replace(/[\\*?[\]!#]/g, (character) => `\\${character}`);
}
