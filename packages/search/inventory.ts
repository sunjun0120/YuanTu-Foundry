/**
 * Ordered enumeration of the workspace, with filters applied *before* the candidate budget.
 *
 * The defect this replaces was an ordering one: the old walk collected one thousand file names and the caller
 * filtered afterwards, so a search that named a file by `include` could report "no matches" while the file sat
 * on disk exactly as described — the walk had already spent its budget on files the caller never wanted. Here
 * the include/exclude filters and the credential policy decide first, and only a file that survives them counts
 * against `maxFiles`. Entries the filters reject still count against `maxEntries`, because that budget exists to
 * bound the *work* rather than the result.
 *
 * Traversal is depth-first with each directory's entries ordered by their UTF-8 bytes, so the same tree always
 * produces the same sequence on every platform and in every locale. `collectInventory` sorts its result by the
 * same order, which is also the order text-search results are reported in.
 */
import path from 'node:path';
import { lstat, readdir } from 'node:fs/promises';
import { Buffer } from 'node:buffer';
import {
  emptyCoverage,
  markStop,
  type FileEntry,
  type FileFingerprint,
  type InventoryOptions,
  type InventoryResult,
  type InventoryStream,
  type WorkspaceAccess,
} from './types.ts';

/**
 * The glob dialect the file tools have always used, kept exactly as it was.
 *
 * `*` and `?` stop at a separator and `**` crosses one. It is not minimatch and it never claimed to be; the
 * point of copying it here rather than reaching for a library is that `search_files` and the new inventory must
 * agree about what an include pattern means, and the only way to be sure of that is one implementation.
 *
 * Note the consequence of the `**` spelling: `a/**\/b` compiles to `a/.*\/b`, which does *not* match `a/b`.
 * That is the behaviour the tool has always had, and changing it here would silently widen every existing
 * include pattern.
 */
export function compileGlob(glob: string): RegExp {
  let source = '^';
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i]!;
    if (char === '*') {
      if (glob[i + 1] === '*') {
        source += '.*';
        i++;
      } else source += '[^/]*';
    } else if (char === '?') source += '[^/]';
    else source += char.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
  }
  return new RegExp(source + '$');
}

/** True when any pattern matches the workspace-relative, forward-slash path. */
export function matchesAny(patterns: readonly RegExp[], relative: string): boolean {
  return patterns.some((pattern) => pattern.test(relative));
}

/**
 * The literal part of a glob, up to its first wildcard.
 *
 * Any path a glob can match must start with this string, which is what makes directory pruning a proof rather
 * than a guess: a directory can be skipped only when neither it nor anything under it can start with the prefix.
 */
export function globPrefix(glob: string): string {
  const stop = glob.search(/[*?]/);
  return stop === -1 ? glob : glob.slice(0, stop);
}

/**
 * Whether a directory can possibly hold a match for any of these include patterns.
 *
 * Two ways to survive: the pattern's literal prefix runs through the directory (`src/` for `src/*.ts`), or the
 * directory path is itself a prefix of that literal (`src/deep` for `src/deep/nested/*.ts`). Everything else is
 * pruned. Patterns with no literal prefix — `**\/*.ts`, `*.md` — keep every directory, which is the safe answer.
 *
 * Excludes are never used to prune. Priority has to stay with the file-level filter (an exclude wins there),
 * and "this whole directory is excluded" is only provable for patterns this dialect spells in ways it is not
 * worth special-casing; skipping the pruning costs a listing, and getting it wrong loses a match.
 */
export function mayContainMatch(prefixes: readonly string[], relativeDirectory: string): boolean {
  if (!prefixes.length) return true;
  // A file under this directory is `directory + name`, so it starts with the literal only when the two are
  // prefix-compatible. An empty prefix (a pattern that starts with a wildcard) is compatible with everything.
  const directory = `${relativeDirectory}/`;
  for (const prefix of prefixes)
    if (directory.startsWith(prefix) || prefix.startsWith(directory)) return true;
  return false;
}

/** UTF-8 byte order, so a listing does not depend on the host's locale. */
export function comparePaths(left: string, right: string): number {
  if (left === right) return 0;
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function fingerprintOf(size: number, mtimeMs: number): FileFingerprint {
  // Metadata only. A digest would require reading every candidate, which is exactly the read this stage is
  // trying to schedule rather than perform; a null digest says so instead of implying content evidence.
  return { size, mtimeMs, sha256: null };
}

/**
 * Walks `options.path` depth-first and yields every admitted, filtered file.
 *
 * The returned object is both the iterable and the live coverage: a consumer that stops early leaves
 * `complete` false, because a partial pull is not a partial answer — it is no answer about the remainder.
 */
export function iterateInventory(
  access: WorkspaceAccess,
  options: InventoryOptions,
): InventoryStream {
  const coverage = emptyCoverage();
  const includePatterns = options.include.map(compileGlob);
  const excludePatterns = options.exclude.map(compileGlob);
  const includePrefixes = options.include.map(globPrefix);
  const deadline = Math.min(options.deadlineMs ?? Infinity, Date.now() + options.timeoutMs);
  let exhausted = false;
  let files = 0;

  async function* walk(): AsyncGenerator<FileEntry> {
    let start: string;
    try {
      start = await access.resolve(options.path || '.');
    } catch (error) {
      markStop(coverage, 'read-error');
      throw error;
    }
    const relativeStart = path.relative(access.root, start).split(path.sep).join('/');
    options.signal.throwIfAborted();
    if (Date.now() >= deadline) {
      markStop(coverage, 'time-limit');
      return;
    }
    const startStats = await lstat(start);
    if (startStats.isFile()) {
      options.signal.throwIfAborted();
      if (options.maxEntries < 1) {
        markStop(coverage, 'entry-limit');
        return;
      }
      coverage.entriesVisited++;
      if (
        access.isExcluded(relativeStart, 'file') ||
        (includePatterns.length && !matchesAny(includePatterns, relativeStart)) ||
        (excludePatterns.length && matchesAny(excludePatterns, relativeStart))
      ) {
        exhausted = true;
        return;
      }
      if (options.maxFiles !== null && options.maxFiles < 1) {
        markStop(coverage, 'file-limit');
        return;
      }
      coverage.filesConsidered++;
      try {
        yield {
          path: relativeStart,
          absolutePath: start,
          fingerprint: fingerprintOf(startStats.size, startStats.mtimeMs),
        };
        exhausted = true;
      } finally {
        if (!exhausted) coverage.complete = false;
      }
      return;
    }
    if (
      !startStats.isDirectory() ||
      (relativeStart && access.isExcluded(relativeStart, 'directory'))
    ) {
      exhausted = true;
      return;
    }
    const stack: { absolute: string; relative: string }[] = [
      { absolute: start, relative: relativeStart },
    ];
    try {
      while (stack.length) {
        options.signal.throwIfAborted();
        if (Date.now() >= deadline) {
          markStop(coverage, 'time-limit');
          return;
        }
        const directory = stack.pop()!;
        let entries;
        try {
          entries = await readdir(directory.absolute, { withFileTypes: true });
        } catch {
          coverage.unreadableFiles++;
          markStop(coverage, 'read-error');
          continue;
        }
        entries.sort((left, right) => comparePaths(left.name, right.name));
        // Directories are visited after their siblings' files so a shallow file is reported before a deep one
        // inside an earlier directory; the result list is sorted by path either way, and this keeps the walk from
        // walking a subtree before it has even listed the current one.
        const childDirectories: { absolute: string; relative: string }[] = [];
        for (const entry of entries) {
          options.signal.throwIfAborted();
          if (coverage.entriesVisited >= options.maxEntries) {
            markStop(coverage, 'entry-limit');
            return;
          }
          coverage.entriesVisited++;
          if (entry.isSymbolicLink()) continue;
          const relative = directory.relative ? `${directory.relative}/${entry.name}` : entry.name;
          if (entry.isDirectory()) {
            if (access.isExcluded(relative, 'directory')) continue;
            if (!mayContainMatch(includePrefixes, relative)) continue;
            childDirectories.push({
              absolute: path.join(directory.absolute, entry.name),
              relative,
            });
            continue;
          }
          if (!entry.isFile()) continue;
          if (access.isExcluded(relative, 'file')) continue;
          if (includePatterns.length && !matchesAny(includePatterns, relative)) continue;
          if (excludePatterns.length && matchesAny(excludePatterns, relative)) continue;
          if (options.maxFiles !== null && files >= options.maxFiles) {
            markStop(coverage, 'file-limit');
            return;
          }
          coverage.filesConsidered++;
          files++;
          let stats;
          try {
            stats = await lstat(path.join(directory.absolute, entry.name));
          } catch {
            coverage.unreadableFiles++;
            markStop(coverage, 'read-error');
            continue;
          }
          if (!stats.isFile()) continue;
          yield {
            path: relative,
            absolutePath: path.join(directory.absolute, entry.name),
            fingerprint: fingerprintOf(stats.size, stats.mtimeMs),
          };
        }
        // Depth-first, last sibling first, so popping yields the byte-ordered directory.
        for (let index = childDirectories.length - 1; index >= 0; index--)
          stack.push(childDirectories[index]!);
      }
      exhausted = true;
    } finally {
      if (!exhausted) coverage.complete = false;
    }
  }

  return {
    coverage() {
      return { ...coverage, reasons: [...coverage.reasons] };
    },
    [Symbol.asyncIterator]: walk,
  };
}

/** The whole inventory at once, sorted by path. For bounded listings and index preparation. */
export async function collectInventory(
  access: WorkspaceAccess,
  options: InventoryOptions,
): Promise<InventoryResult> {
  const stream = iterateInventory(access, options);
  const files: FileEntry[] = [];
  for await (const file of stream) files.push(file);
  files.sort((left, right) => comparePaths(left.path, right.path));
  return { files, coverage: stream.coverage() };
}

/** Entries a legacy walk may visit before it stops. Kept as the compatibility budget. */
export const LEGACY_MAX_ENTRIES = 5_000;
/** Candidate files a legacy walk may collect before it stops. Kept as the compatibility budget. */
export const LEGACY_MAX_FILES = 1_000;
/** The default budget for a text search: large enough for a real repository, still a budget. */
export const SEARCH_MAX_ENTRIES = 200_000;
export const SEARCH_TIMEOUT_MS = 5_000;
export const SEARCH_MAX_SCAN_BYTES = 268_435_456;
/** Longest line a streaming scan will assemble before it declares the file partly scanned. */
export const MAX_SCAN_LINE_BYTES = 1_048_576;
/** Largest file a complete line count will read before it refuses to guess. */
export const MAX_COUNT_BYTES = 134_217_728;
