import { realpathSync } from 'node:fs';
import path from 'node:path';

/**
 * How this runtime decides whether two paths name the same directory.
 *
 * Windows makes this a real question rather than a formality, and getting it wrong is not cosmetic: a binding
 * whose execution root is spelled `E:\Repo\.yuantu\worktrees\x` and the directory Git actually reported as
 * `e:\repo\.yuantu\worktrees\x` are the same place, and a comparison that said otherwise would refuse to restore
 * a perfectly good workspace — or worse, treat a second spelling of the parent's own directory as an isolated
 * child and let two agents write the same tree.
 *
 * So comparison is by *canonical key*: the resolved absolute path, with separators normalised and, on a
 * case-insensitive filesystem, folded to lower case. The path kept for use is the resolved one, not the folded
 * one — folding is for comparison only, because a program that received a lower-cased path would name a real
 * file the user did not choose on a case-sensitive volume mounted beside it.
 */
export function canonicalKey(value: string): string {
  const resolved = path.resolve(value).replaceAll('\\', '/').replace(/\/+$/, '');
  return process.platform === 'win32' || process.platform === 'darwin'
    ? resolved.toLowerCase()
    : resolved;
}

/** Whether two paths name the same directory, by the rule above. */
export function samePath(left: string, right: string): boolean {
  return canonicalKey(left) === canonicalKey(right);
}

/**
 * The directory a path really is, following every symlink and junction.
 *
 * Used for identity, never for what a child is handed: a worktree reached through a junction has a canonical
 * location outside the parent's tree, and the execution root must be the real one or a child's writes would be
 * attributed to the directory it was reached through.
 */
export function realPathOrNull(value: string): string | null {
  try {
    return realpathSync.native(value);
  } catch {
    return null;
  }
}

/**
 * Whether `child` is `parent` itself or sits underneath it.
 *
 * Segment-wise rather than by string prefix, because `/repo-other` starts with `/repo` as text and is a
 * different directory. Both sides go through the same canonical key, so the answer does not depend on how either
 * was spelled.
 */
export function isWithin(parent: string, child: string): boolean {
  const base = canonicalKey(parent);
  const candidate = canonicalKey(child);
  if (base === candidate) return true;
  return candidate.startsWith(base.endsWith('/') ? base : `${base}/`);
}

/** The relative path from `parent` to `child`, or null when `child` is not inside `parent`. */
export function relativeWithin(parent: string, child: string): string | null {
  if (!isWithin(parent, child)) return null;
  const base = canonicalKey(parent);
  const candidate = canonicalKey(child);
  if (base === candidate) return '';
  return candidate.slice(base.length + 1);
}

/**
 * A repository-relative path in the one spelling every other part of this feature uses.
 *
 * Git reports paths with forward slashes and accepts them that way, but a path assembled from `path.join` on
 * Windows carries backslashes, and a manifest that mixed the two would report one file as two. Trailing
 * separators are dropped for the same reason.
 */
export function gitPath(value: string): string {
  return value.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/+$/, '');
}

/** True when Git would read this path as "outside the repository" however it is spelled. */
export function isUnsafeGitPath(value: string): boolean {
  const normalised = gitPath(value);
  return (
    !normalised ||
    normalised.startsWith('/') ||
    /^[a-zA-Z]:/.test(normalised) ||
    normalised.split('/').some((segment) => segment === '..' || segment === '')
  );
}
