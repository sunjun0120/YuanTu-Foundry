/**
 * Range reads with a real line count, and the sparse index that makes the second read cheap.
 *
 * `read_file` used to read a 256000-byte prefix, split it, and slice the window out of *that* — so asking for
 * line 130001 of a 260021-byte file answered with empty text, `truncated: false`, and a total of 128002 lines.
 * Three separate lies from one shortcut. This module removes the shortcut: the file is read in chunks to EOF,
 * the count is the count, and the requested window is the only thing retained in memory.
 *
 * The second read of the same file must not pay for the first one again, so every 256th line start is recorded
 * as `{line, byteOffset}` and the index is kept against the file's size and mtime. A cached index is used only
 * when those still match; that is a heuristic — a same-size rewrite inside one timestamp tick slips past it —
 * which is why {@link FileFingerprint.sha256} stays `null` here rather than claiming content evidence. The
 * consequence of being wrong is a stale window from one file, never a wrong edit: what the model writes is
 * checked against the file itself by the change tools.
 */
import path from 'node:path';
import { open, type FileHandle } from 'node:fs/promises';
import { MAX_COUNT_BYTES } from './inventory.ts';
import type { FileFingerprint, RangeRead, WorkspaceAccess } from './types.ts';

const CHUNK_BYTES = 64 * 1024;
/** One sparse entry every this many lines. Small enough to bound the rescan, large enough to stay cheap. */
export const LINES_PER_INDEX_ENTRY = 256;
/** A single retained line longer than this is clipped; the window is presentation, the count is not. */
export const MAX_RETAIN_LINE_BYTES = 1_048_576;
/** Total bytes a single range read will retain. The window is bounded even when the caller asks for the file. */
export const MAX_RETAIN_TOTAL_BYTES = 4 * 1024 * 1024;
/** How long one complete line count may run. */
export const RANGE_TIMEOUT_MS = 5_000;
/** How many verified indexes stay in memory. */
const INDEX_CACHE_LIMIT = 64;

export interface LineIndex {
  fingerprint: FileFingerprint;
  /** Exact filesystem timestamp for cache validity; display fingerprints are rounded separately. */
  statMtimeMs: number;
  totalLines: number;
  /** The file's decoded text ends with a newline. */
  endsWithNewline: boolean;
  /** `{line, byteOffset}` for lines 1, 257, 513, … — the start of the line, not of its terminator. */
  entries: { line: number; byteOffset: number }[];
}

const indexCache = new Map<string, LineIndex>();

/** Drops every cached index. Used by tests and by a caller that knows the tree changed underneath it. */
export function clearLineIndexCache(): void {
  indexCache.clear();
}

export function cachedLineIndex(file: string): LineIndex | undefined {
  return indexCache.get(file);
}

function remember(file: string, index: LineIndex): void {
  indexCache.delete(file);
  indexCache.set(file, index);
  while (indexCache.size > INDEX_CACHE_LIMIT) {
    const oldest = indexCache.keys().next().value;
    if (oldest === undefined) break;
    indexCache.delete(oldest);
  }
}

/**
 * Reads lines `startLine`–`endLine` of one workspace file.
 *
 * `totalLines` is the file's true length and is only ever the result of counting every line, or of a verified
 * cached count. When neither is available within the budget this throws: an incomplete answer that looks like a
 * successful read is the failure mode this whole module exists to remove.
 */
export async function readRange(
  access: WorkspaceAccess,
  relative: string,
  startLine: number,
  endLine: number,
  signal: AbortSignal,
  allowSpill = false,
): Promise<RangeRead> {
  if (!Number.isSafeInteger(startLine) || startLine < 1) throw new Error('start_line must be >= 1');
  signal.throwIfAborted();
  const file = await access.resolve(relative, allowSpill);
  const handle = await open(file, 'r');
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) throw new Error('Expected a regular file');
    const fingerprint: FileFingerprint = {
      size: stats.size,
      /**
       * Whole milliseconds, not the raw `mtimeMs`.
       *
       * Node hands back a float, so the same file can be described as `…432.681` in one run and `…432.6` in the
       * next — and a value that crosses a tool-result payload has to have a stable *length*, or every consumer
       * that measures one (token accounting, a snapshot, a digest of the text form) drifts for a reason that has
       * nothing to do with the file. A millisecond is also the resolution a filesystem actually promises; the
       * fractional part is an artefact of the API, and nothing here claims to detect two writes inside one
       * millisecond.
       */
      mtimeMs: Math.round(stats.mtimeMs),
      sha256: null,
    };
    const cached = indexCache.get(file);
    const reusable =
      cached && cached.fingerprint.size === stats.size && cached.statMtimeMs === stats.mtimeMs;
    const started = Date.now();
    const retention = new RetainedWindow(startLine, endLine);
    let totalLines: number;
    let endsWithNewline: boolean;

    if (reusable && startLine > 1) {
      // Seek to the nearest recorded line start at or before the window and read forward from there. A hit does
      // not read the file to the end: the count is already known and verified against size and mtime.
      const entry = nearestEntry(cached!.entries, startLine);
      await readLines(handle, file, entry.byteOffset, entry.line, {
        stopAfter: endLine,
        signal,
        started,
        retention,
      });
      totalLines = cached!.totalLines;
      endsWithNewline = cached!.endsWithNewline;
      assertUnchanged(await handle.stat().catch(() => null), stats);
    } else {
      const outcome = await readLines(handle, file, 0, 1, {
        stopAfter: null,
        signal,
        started,
        retention,
      });
      totalLines = outcome.totalLines;
      endsWithNewline = outcome.endsWithNewline;
      remember(file, {
        fingerprint,
        statMtimeMs: stats.mtimeMs,
        totalLines,
        endsWithNewline,
        entries: outcome.entries,
      });
    }

    const kept = retention.lines;
    const lastLine = kept.length ? startLine + kept.length - 1 : startLine - 1;
    return {
      path: path.relative(access.root, file).split(path.sep).join('/'),
      startLine,
      endLine: lastLine,
      totalLines,
      text: kept.join('\n'),
      truncated: retention.truncated,
      fileFingerprint: fingerprint,
      endsWithNewline,
    };
  } finally {
    await handle.close().catch(() => {});
  }
}

/** The recorded line start closest to (and not after) `line`. */
function nearestEntry(
  entries: readonly { line: number; byteOffset: number }[],
  line: number,
): { line: number; byteOffset: number } {
  let best = { line: 1, byteOffset: 0 };
  for (const entry of entries) {
    if (entry.line > line) break;
    best = entry;
  }
  return best;
}

interface LineOutcome {
  totalLines: number;
  endsWithNewline: boolean;
  entries: { line: number; byteOffset: number }[];
  sawEof: boolean;
}

/** The requested window, retained as it streams past, with the caps that keep it bounded. */
class RetainedWindow {
  readonly lines: string[] = [];
  truncated = false;
  private startLine: number;
  private endLine: number;
  private bytes = 0;
  constructor(startLine: number, endLine: number) {
    this.startLine = startLine;
    this.endLine = endLine;
  }
  /** Offers one decoded line; the window keeps it only when it was asked for. */
  offer(lineNumber: number, bytes: Buffer): void {
    if (lineNumber < this.startLine || lineNumber > this.endLine) return;
    const clipped =
      bytes.length > MAX_RETAIN_LINE_BYTES ? bytes.subarray(0, MAX_RETAIN_LINE_BYTES) : bytes;
    if (bytes.length > MAX_RETAIN_LINE_BYTES) this.truncated = true;
    if (this.bytes + clipped.length > MAX_RETAIN_TOTAL_BYTES) {
      this.truncated = true;
      return;
    }
    this.bytes += clipped.length;
    const text = clipped.toString('utf8');
    this.lines.push(text.endsWith('\r') ? text.slice(0, -1) : text);
  }
}

/**
 * Reads from `from` to EOF (or to `stopAfter`) counting lines and retaining the window.
 *
 * `stopAfter` is only given when a verified count is already in hand; the caller that needs the count reads to
 * the end, because that is the only way to know it. The budget failure names both limits so the caller can tell
 * a genuinely huge file from a stalled read.
 */
async function readLines(
  handle: FileHandle,
  file: string,
  from: number,
  firstLine: number,
  options: {
    stopAfter: number | null;
    signal: AbortSignal;
    started: number;
    retention: RetainedWindow;
  },
): Promise<LineOutcome> {
  const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
  const buildIndex = from === 0;
  const entries: { line: number; byteOffset: number }[] = buildIndex
    ? [{ line: 1, byteOffset: 0 }]
    : [];
  let position = from;
  let lineNo = firstLine;
  let bytes = 0;
  let lastByte: number | null = null;
  let pending: Buffer[] = [];
  let pendingBytes = 0;
  let finishedWindow = false;
  let sawEof = false;

  for (;;) {
    options.signal.throwIfAborted();
    if (Date.now() - options.started > RANGE_TIMEOUT_MS)
      throw new Error(
        `Unable to read ${path.basename(file)} within the range-read budget (${RANGE_TIMEOUT_MS} ms). Narrow the range.`,
      );
    if (bytes > MAX_COUNT_BYTES)
      throw new Error(
        `File exceeds the ${Math.round(MAX_COUNT_BYTES / (1024 * 1024))}MB range-read budget, so its true line count cannot be verified. Read a smaller file.`,
      );
    const read = (await handle.read(buffer, 0, buffer.length, position)).bytesRead;
    if (read === 0) {
      sawEof = true;
      break;
    }
    const chunk = buffer.subarray(0, read);
    if (chunk.includes(0)) throw new Error('Binary files are not supported');
    position += read;
    bytes += read;
    lastByte = chunk[read - 1]!;
    let start = 0;
    for (let index = 0; index < read; index++) {
      if (chunk[index] !== 0x0a) continue;
      const tail = chunk.subarray(start, index);
      const parts = pending.length ? [...pending, tail] : [tail];
      pending = [];
      pendingBytes = 0;
      options.retention.offer(lineNo, Buffer.concat(parts));
      lineNo++;
      if (buildIndex && lineNo % LINES_PER_INDEX_ENTRY === 1)
        entries.push({ line: lineNo, byteOffset: position - read + index + 1 });
      if (options.stopAfter !== null && lineNo > options.stopAfter) {
        finishedWindow = true;
        break;
      }
      start = index + 1;
    }
    if (finishedWindow) break;
    if (start < read) {
      // Copied, not referenced: this view would be overwritten by the next read into the same buffer, and the
      // line it belongs to would silently become the following chunk's bytes.
      pending.push(Buffer.from(chunk.subarray(start, read)));
      pendingBytes += chunk.length - start;
    }
  }

  // Only a read that reached EOF can say whether the file's text ends with a newline. A window that stopped
  // early says nothing about the end of the file, and guessing there is how a trailing empty line appears in a
  // file that has none.
  const endsWithNewline = sawEof && lastByte === 0x0a;
  let totalLines = sawEof ? lineNo - 1 : 0;
  if (sawEof && pendingBytes > 0) {
    // A final line with no terminator is still a line.
    options.retention.offer(lineNo, Buffer.concat(pending));
    totalLines = lineNo;
  }
  if (sawEof && entries.length && entries[entries.length - 1]!.line > totalLines) entries.pop();
  return { totalLines, endsWithNewline, entries, sawEof };
}

/** Refuses to answer from a file that changed while it was being read. */
function assertUnchanged(
  after: { size: number; mtimeMs: number } | null,
  before: { size: number; mtimeMs: number },
): void {
  if (!after) return;
  if (after.size !== before.size || after.mtimeMs !== before.mtimeMs)
    throw new Error('File changed while it was being read; read it again');
}
