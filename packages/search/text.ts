/**
 * The built-in text scanner: fixed-size chunks, real byte accounting, an explicit partial state.
 *
 * The defect this replaces was a fixed 256000-byte prefix. A file whose content continued past that prefix was
 * read as if it ended there, so a marker at byte 260000 was reported as "no matches" with `limited: false` — a
 * complete-sounding lie about a scan that had stopped in the middle of one file. Nothing here reads a whole file
 * into memory: chunks are 64 KiB, a line is assembled up to {@link MAX_SCAN_LINE_BYTES}, and the three budgets
 * (entries, bytes, wall clock) each record the reason they stopped rather than silently returning fewer matches.
 *
 * Matching stays on the JavaScript engine with the same flags the tool has always used — `i` for a
 * case-insensitive pattern, nothing else — because `literal` and `regex` are two spellings of one search and the
 * only thing that separates them is that a literal's metacharacters are escaped first. Case-insensitive
 * comparison deliberately does *not* go through `toLowerCase`: it is locale-dependent and the `i` flag is not,
 * so the two modes used to disagree about `İ` on some hosts.
 */
import path from 'node:path';
import { open, type FileHandle } from 'node:fs/promises';
import { MAX_SCAN_LINE_BYTES, SEARCH_MAX_SCAN_BYTES, SEARCH_TIMEOUT_MS } from './inventory.ts';
import {
  emptyCoverage,
  markStop,
  type Coverage,
  type FileEntry,
  type ScanStop,
  type SearchHit,
  type SearchOptions,
  type SearchPage,
  type WorkspaceAccess,
} from './types.ts';

/** Read granularity. Large enough to amortise the syscall, small enough to stay out of the way of a cancel. */
const CHUNK_BYTES = 64 * 1024;
/** Characters of a matched line either form shows. Kept in step with `search-worker.ts` and `files.ts`. */
export const MAX_MATCH_TEXT = 500;

/**
 * The whole request, so a caller passes only what it means to override.
 *
 * The defaults are the S2 budgets: two hundred thousand entries, 256 MiB of real bytes, five seconds, one
 * hundred results. They are budgets, not estimates of what a repository needs, and may only be changed with a
 * measurement recorded beside the change.
 */
export function searchOptions(input: Partial<SearchOptions> & { query: string }): SearchOptions {
  return {
    mode: 'literal',
    caseMode: 'sensitive',
    maxResults: 100,
    maxOutputChars: 24_000,
    maxScanBytes: SEARCH_MAX_SCAN_BYTES,
    timeoutMs: SEARCH_TIMEOUT_MS,
    signal: new AbortController().signal,
    ...input,
  };
}

/** A case-insensitive query follows the engine's `i` flag, exactly as the tool has always done. */
export function isSensitive(options: Pick<SearchOptions, 'query' | 'caseMode'>): boolean {
  return (
    options.caseMode === 'sensitive' ||
    (options.caseMode === 'smart' && /[A-Z]/.test(options.query))
  );
}

/** Every RegExp metacharacter, escaped, so a literal query is matched as text. */
export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The predicate one line is tested with.
 *
 * `literal` and `regex` share the engine and the flags; only the escaping differs. A case-sensitive literal uses
 * `String.prototype.includes`, which is the same relation the escaped pattern implements and skips building a
 * RegExp per scan — but the insensitive and regex paths stay on `RegExp`, because that is where the `i` flag and
 * lookaround live.
 */
function matcherFor(options: SearchOptions): (line: string) => boolean {
  const sensitive = isSensitive(options);
  if (options.mode === 'literal' && sensitive) {
    const needle = options.query;
    return (line) => line.includes(needle);
  }
  const expression = new RegExp(
    options.mode === 'literal' ? escapeRegExp(options.query) : options.query,
    sensitive ? '' : 'i',
  );
  return (line) => expression.test(line);
}

/** How many characters one hit costs in the text form: `path:line: text`, plus its newline. */
function renderedLength(path: string, line: number, text: string): number {
  return path.length + String(line).length + 2 + text.length + 1;
}

/**
 * Scans an admitted file list and returns the matches with the coverage that produced them.
 *
 * The inventory coverage is passed in as a thunk rather than as a value because enumeration and scanning are one
 * pass: the stream is still being pulled while this runs, and only the stream itself knows how far it got. When
 * no thunk is given the coverage describes the scan alone, which is what a caller working from a prepared file
 * list — the ripgrep backend, an index rebuild — actually has.
 */
export async function scanText(
  access: WorkspaceAccess,
  files: AsyncIterable<FileEntry>,
  options: SearchOptions,
  inventory?: () => Coverage,
): Promise<SearchPage> {
  const scan = emptyCoverage();
  const matches: SearchHit[] = [];
  const matchesLine = matcherFor(options);
  const deadline = Math.min(options.deadlineMs ?? Infinity, Date.now() + options.timeoutMs);
  let bytesRead = 0;
  let renderedChars = 0;
  let outputTruncated = false;
  let stopped = false;

  const stop = (reason: ScanStop): void => {
    markStop(scan, reason);
    stopped = true;
  };
  options.signal.throwIfAborted();
  if (Date.now() >= deadline) stop('time-limit');

  for await (const file of files) {
    if (stopped) break;
    options.signal.throwIfAborted();
    if (Date.now() >= deadline) {
      stop('time-limit');
      break;
    }
    await scanFile(file);
  }
  scan.bytesRead = bytesRead;

  // Sorted by path bytes and then by line, so the answer does not depend on the order the walk happened to
  // produce — a directory listing order is an implementation detail, not part of what was asked for.
  matches.sort((left, right) => {
    const byPath = Buffer.compare(Buffer.from(left.path, 'utf8'), Buffer.from(right.path, 'utf8'));
    return byPath !== 0 ? byPath : left.line - right.line;
  });

  return {
    matches,
    coverage: inventory ? mergeCoverage(inventory(), scan) : scan,
    outputTruncated,
    nextCursor: null,
    sourceVersion: null,
  };

  /**
   * One file, from open to close, with the accounting the caller needs.
   *
   * A file that turns out to be binary is counted as scanned and skipped: it cannot match a text query, and
   * calling it unreadable would mark every repository holding an image as incompletely searched. A file that
   * could not be *opened* is unreadable and does make the coverage incomplete, because there is no way to know
   * what was in it.
   */
  async function scanFile(file: FileEntry): Promise<void> {
    // Checked again here, not merely trusted from enumeration: the list can come from a caller that built it
    // itself, and a path outside the workspace is never opened whatever the reason it is on the list.
    const relative = path.relative(access.root, file.absolutePath);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      scan.unreadableFiles++;
      markStop(scan, 'read-error');
      return;
    }
    let handle: FileHandle | undefined;
    try {
      handle = await open(file.absolutePath, 'r');
    } catch {
      scan.unreadableFiles++;
      markStop(scan, 'read-error');
      return;
    }
    const before = matches.length;
    let partial = false;
    let binary = false;
    let eof = false;
    let position = 0;
    let lineNo = 1;
    let pending: Buffer[] = [];
    let pendingBytes = 0;
    /** Set while discarding the tail of a line longer than the assembly cap. */
    let skipping = false;
    const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
    try {
      const stats = await handle.stat();
      if (!stats.isFile()) {
        scan.unreadableFiles++;
        markStop(scan, 'read-error');
        return;
      }
      reading: for (;;) {
        options.signal.throwIfAborted();
        if (Date.now() >= deadline) {
          stop('time-limit');
          partial = true;
          break;
        }
        if (bytesRead + buffer.length > options.maxScanBytes) {
          stop('byte-limit');
          partial = true;
          break;
        }
        const read = (await handle.read(buffer, 0, buffer.length, position)).bytesRead;
        if (read === 0) {
          eof = true;
          break;
        }
        position += read;
        bytesRead += read;
        const chunk = buffer.subarray(0, read);
        if (chunk.includes(0)) {
          // A NUL byte means binary (or UTF-16). Nothing in this file is text to match, and the lines already
          // collected from its prefix are discarded with it.
          binary = true;
          break;
        }
        let start = 0;
        for (let index = 0; index < read; index++) {
          if (chunk[index] !== 0x0a) continue;
          const decision = pushSegment(chunk.subarray(start, index));
          start = index + 1;
          if (decision === 'result-limit') break reading;
          if (skipping) skipping = false;
          else if (emitLine(collect()) === 'result-limit') break reading;
        }
        if (start < read) pushSegment(chunk.subarray(start, read));
        if (stopped) break;
      }
      if (!stopped && !binary && !skipping && pendingBytes > 0) emitLine(collect());
      if (binary) {
        /**
         * A binary file is out of scope rather than a failure.
         *
         * It cannot hold text to match, so it is counted as neither scanned nor unreadable — counting it either
         * way would make every repository that contains an image report itself as incompletely searched, and a
         * coverage flag that is always false is a coverage flag nobody reads.
         */
        matches.length = before;
      } else {
        // Only a file read to the end counts as scanned. A file the byte or time budget cut short is a partial
        // read, and saying it was scanned would be the same false-complete claim this change removes, one file
        // smaller.
        if (eof) scan.filesScanned++;
        if (!eof || partial) scan.partialFiles++;
        const after = eof ? await handle.stat().catch(() => null) : null;
        if (after && (after.size !== stats.size || after.mtimeMs !== stats.mtimeMs)) {
          // Rewritten under the scan: what was read is not a picture of any single version of the file.
          markStop(scan, 'changed');
          scan.partialFiles++;
        }
      }
    } catch {
      scan.unreadableFiles++;
      markStop(scan, 'read-error');
    } finally {
      if (handle) await handle.close().catch(() => {});
    }

    /** Accumulates line bytes, clipping at the cap and testing the head of an over-long line once. */
    function pushSegment(segment: Buffer): 'ok' | 'result-limit' {
      if (!segment.length || skipping) return 'ok';
      const room = MAX_SCAN_LINE_BYTES - pendingBytes;
      if (segment.length <= room) {
        // Copied, not referenced: `segment` is a view into the chunk buffer, which the next read overwrites. A
        // retained view would silently become the *next* chunk's bytes, which is how a multi-byte character
        // split across a boundary turned into replacement characters.
        pending.push(Buffer.from(segment));
        pendingBytes += segment.length;
        return 'ok';
      }
      pending.push(Buffer.from(segment.subarray(0, room)));
      pendingBytes += room;
      skipping = true;
      partial = true;
      markStop(scan, 'line-limit');
      const decision = emitLine(collect());
      return decision;
    }

    /** The pending bytes as one line, with the terminator's `\r` removed. */
    function collect(): string {
      const text = Buffer.concat(pending).toString('utf8');
      pending = [];
      pendingBytes = 0;
      return text.endsWith('\r') ? text.slice(0, -1) : text;
    }

    /** Tests one line and records it, stopping the scan once a budget is spent. */
    function emitLine(line: string): 'ok' | 'result-limit' {
      const current = lineNo++;
      if (!line || !matchesLine(line)) return 'ok';
      const text = line.slice(0, MAX_MATCH_TEXT);
      matches.push({ path: file.path, line: current, text });
      renderedChars += renderedLength(file.path, current, text);
      if (matches.length >= options.maxResults) {
        stop('result-limit');
        return 'result-limit';
      }
      if (renderedChars >= options.maxOutputChars) {
        // The payload cannot carry another hit, so there is nothing left for the scan to produce.
        outputTruncated = true;
        stop('result-limit');
        return 'result-limit';
      }
      return 'ok';
    }
  }
}

/**
 * Keeps the enumeration's own numbers, and only lets the scan add to them.
 *
 * The inventory owns how many entries were visited and how many files were considered; the scan owns how many
 * were read and how many bytes that took. Merging in the other direction — letting the scan's zeroed counters
 * win — is how a "complete" claim would quietly lose the enumeration limit that made it false.
 */
export function mergeCoverage(latest: Coverage, scan: Coverage): Coverage {
  return {
    complete: latest.complete && scan.complete,
    reasons: [...new Set([...latest.reasons, ...scan.reasons])],
    entriesVisited: latest.entriesVisited,
    filesConsidered: latest.filesConsidered,
    filesScanned: scan.filesScanned,
    partialFiles: scan.partialFiles,
    unreadableFiles: latest.unreadableFiles + scan.unreadableFiles,
    bytesRead: scan.bytesRead,
  };
}
