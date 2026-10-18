/**
 * The fixed ripgrep backend: one executable, one argument vector, one JSONL parser, no shell.
 *
 * Three decisions keep this from becoming a second search tool with its own behaviour.
 *
 * 1. **Only a fast path for the easiest query.** The backend is used for a case-sensitive literal — the case a
 *    fixed-string scan answers exactly — and everything else stays on the built-in engine. `literal` and `regex`
 *    are one search spelled two ways, and handing lookaround, Unicode case folding or the `i` flag to a program
 *    with different rules is how the two modes would start disagreeing about the same file.
 * 2. **The caller supplies the files.** ripgrep is given an explicit, already-admitted path list and never walks
 *    the workspace itself, so the path policy keeps deciding what is searchable and the argv estimate — not the
 *    repository — bounds one process.
 * 3. **Partial output is partial coverage.** A batch that failed, a summary that never arrived, an event too
 *    large to buffer: each leaves the remaining files to the built-in scanner and marks the coverage incomplete.
 *    A fast backend that guessed would be worse than the slow one it replaced.
 */
import type { ChildProcess } from 'node:child_process';
import {
  emptyCoverage,
  markStop,
  type Coverage,
  type FileEntry,
  type ScanStop,
  type SearchHit,
  type SearchOptions,
  type SearchPage,
} from './types.ts';
import { isSensitive, MAX_MATCH_TEXT } from './text.ts';

/** Injected by the tool layer, which owns the execution policy and the sandbox cleanup. */
export interface ManagedSearchChild {
  child: ChildProcess;
  stop(): Promise<void>;
  close(): Promise<void>;
}
export interface ManagedSearchProcess {
  start(
    executable: string,
    argv: readonly string[],
    signal: AbortSignal,
  ): Promise<ManagedSearchChild>;
}

export interface RipgrepInput {
  executable: string;
  processes: ManagedSearchProcess;
  files: readonly FileEntry[];
  options: SearchOptions;
  /** Enumeration coverage, so a search that never enumerated everything cannot report otherwise. */
  inventory?: () => Coverage;
  /**
   * The built-in scanner, applied to whatever this backend did not cover.
   *
   * Required for honesty rather than convenience: without it there is no way to answer for the files a failed
   * batch left behind, and the alternative — returning what arrived — is the false-complete result this whole
   * plan exists to remove.
   */
  fallback?: (files: readonly FileEntry[], coverage: Coverage) => Promise<SearchPage>;
}

/** Windows measures an argv in UTF-16 code units and CreateProcess has a hard ceiling; 16000 leaves room. */
const MAX_ARGV_UNITS = 16_000;
/** Bytes of one `--json` event this will buffer. A minified line can exceed it, and then the batch gives up. */
const MAX_EVENT_BYTES = 2 * 1024 * 1024;
/** Files per batch, so one runaway directory cannot produce a single enormous argv. */
const MAX_BATCH_FILES = 256;

/**
 * Runs the fixed backend over an admitted file list, falling back for anything it could not answer.
 *
 * The returned page always describes the whole list: matches from both backends, deduplicated, with one coverage
 * that says whether either of them left something unscanned.
 */
export async function runRipgrep(input: RipgrepInput): Promise<SearchPage> {
  const { options } = input;
  const coverage: Coverage = emptyCoverage();
  const matches: SearchHit[] = [];
  const seen = new Set<string>();
  const deadline = Math.min(options.deadlineMs ?? Infinity, Date.now() + options.timeoutMs);
  let scanned = 0;
  let admittedBytes = 0;
  let cursor = 0;
  /** Set when the backend could not answer for files it was given, which is when a fallback is owed. */
  let failure: ScanStop | null = null;
  /** Set when the scan stopped because a budget ran out rather than because the backend failed. */
  let limitStop: ScanStop | null = null;
  let outputTruncated = false;

  while (cursor < input.files.length) {
    if (Date.now() >= deadline) {
      failure = 'time-limit';
      break;
    }
    const batch = takeBatch(input.files, cursor, admittedBytes, options.maxScanBytes);
    if (!batch.files.length) {
      // Nothing fits the admission budget — either the first file alone exceeds it, or the bytes are spent.
      limitStop = 'byte-limit';
      break;
    }
    admittedBytes += batch.bytes;
    const result = await runBatch(input, batch.files, deadline - Date.now());
    for (const match of result.matches) add(match);
    scanned += result.scanned;
    coverage.unreadableFiles += result.unreadable;
    if (result.failed) {
      failure = result.reason ?? 'read-error';
      cursor += result.consumed;
      break;
    }
    cursor += batch.files.length;
    if (matches.length >= options.maxResults) {
      limitStop = 'result-limit';
      break;
    }
  }

  if (failure) markStop(coverage, failure);
  if (limitStop) markStop(coverage, limitStop);

  if (failure && input.fallback) {
    // From the first file the backend did not finish with. A file it did finish is never handed to the built-in
    // scanner as well, so a replayed row cannot turn into two hits for one match.
    const remainder = dedupeFiles(input.files.slice(cursor));
    if (remainder.length) {
      // The remainder is scanned against the enumeration's coverage, not a fresh complete one: the file list
      // itself may already have been truncated before this backend ever saw it.
      const page = await input.fallback(remainder, input.inventory?.() ?? emptyCoverage());
      for (const match of page.matches) add(match);
      scanned += page.coverage.filesScanned;
      coverage.unreadableFiles += page.coverage.unreadableFiles;
      coverage.partialFiles += page.coverage.partialFiles;
      if (page.outputTruncated) outputTruncated = true;
      if (!page.coverage.complete)
        for (const reason of page.coverage.reasons) markStop(coverage, reason);
    }
  }

  coverage.filesScanned += scanned;
  // ripgrep does not report the bytes it read in a form this can trust, so the honest value is `null` rather
  // than the file sizes that were used to admit the batch.
  coverage.bytesRead = null;
  if (input.inventory) {
    const latest = input.inventory();
    coverage.entriesVisited = latest.entriesVisited;
    coverage.filesConsidered = latest.filesConsidered;
    coverage.complete = coverage.complete && latest.complete;
    for (const reason of latest.reasons) markStop(coverage, reason);
  }

  matches.sort((left, right) => {
    const byPath = Buffer.compare(Buffer.from(left.path, 'utf8'), Buffer.from(right.path, 'utf8'));
    return byPath !== 0 ? byPath : left.line - right.line;
  });
  if (matches.length > options.maxResults) {
    matches.length = options.maxResults;
    outputTruncated = true;
  }

  return { matches, coverage, outputTruncated, nextCursor: null, sourceVersion: null };

  function add(match: SearchHit): void {
    const key = `${match.path}\u0000${String(match.line)}`;
    if (seen.has(key)) return;
    seen.add(key);
    matches.push(match);
  }
}

/** The text of a ripgrep JSON field, or `null` when it arrived base64-encoded (i.e. not UTF-8). */
function textField(field: { text?: string } | { bytes?: string } | undefined): string | null {
  if (!field) return null;
  if ('text' in field && typeof field.text === 'string') return field.text;
  return null;
}

function dedupeFiles(files: readonly FileEntry[]): FileEntry[] {
  const seen = new Set<string>();
  const result: FileEntry[] = [];
  for (const file of files) {
    if (seen.has(file.absolutePath)) continue;
    seen.add(file.absolutePath);
    result.push(file);
  }
  return result;
}

/** The longest prefix of files that fits the argv and byte budgets. */
function takeBatch(
  files: readonly FileEntry[],
  from: number,
  admittedBytes: number,
  maxScanBytes: number,
): { files: FileEntry[]; bytes: number } {
  const batch: FileEntry[] = [];
  let units = 0;
  let bytes = 0;
  for (let index = from; index < files.length && batch.length < MAX_BATCH_FILES; index++) {
    const file = files[index]!;
    const cost = file.absolutePath.length + 3;
    if (batch.length && units + cost > MAX_ARGV_UNITS) break;
    if (admittedBytes + bytes + file.fingerprint.size > maxScanBytes) break;
    units += cost;
    bytes += file.fingerprint.size;
    batch.push(file);
  }
  return { files: batch, bytes };
}

/** The fixed argument vector. Nothing here is built from the query except the pattern behind `--`. */
export function ripgrepArgv(
  options: SearchOptions,
  files: readonly FileEntry[],
): readonly string[] {
  return [
    '--json',
    '--no-config',
    '--no-ignore',
    '--no-ignore-dot',
    '--hidden',
    '--fixed-strings',
    ...(isSensitive(options) ? ['--case-sensitive'] : ['--ignore-case']),
    '--',
    options.query,
    ...files.map((file) => file.absolutePath),
  ];
}

interface BatchResult {
  matches: SearchHit[];
  scanned: number;
  unreadable: number;
  failed: boolean;
  reason: ScanStop | null;
  /** Files the batch got through before it failed. */
  consumed: number;
}

/**
 * One process, one batch.
 *
 * `stop()` is called on every exit path — including the timeout and the abort — and awaited before the result is
 * built, so a cancelled search never leaves a child behind and never resolves while one is still writing.
 */
async function runBatch(
  input: RipgrepInput,
  files: readonly FileEntry[],
  remainingMs: number,
): Promise<BatchResult> {
  const { options } = input;
  options.signal.throwIfAborted();
  if (remainingMs <= 0)
    return {
      matches: [],
      scanned: 0,
      unreadable: 0,
      failed: true,
      reason: 'time-limit',
      consumed: 0,
    };
  const controller = new AbortController();
  const forward = (): void => controller.abort(options.signal.reason);
  options.signal.addEventListener('abort', forward, { once: true });
  const timer = setTimeout(() => controller.abort(new Error('Search timed out')), remainingMs);
  let child: ManagedSearchChild | null = null;
  try {
    child = await input.processes.start(
      input.executable,
      ripgrepArgv(options, files),
      controller.signal,
    );
    options.signal.throwIfAborted();
    const result = await collect(child, files);
    options.signal.throwIfAborted();
    return controller.signal.aborted
      ? { ...result, failed: true, reason: 'time-limit', consumed: 0 }
      : result;
  } catch (error) {
    if (options.signal.aborted) throw options.signal.reason ?? error;
    return {
      matches: [],
      scanned: 0,
      unreadable: 0,
      failed: true,
      reason: controller.signal.aborted ? 'time-limit' : 'read-error',
      consumed: 0,
    };
  } finally {
    clearTimeout(timer);
    options.signal.removeEventListener('abort', forward);
    if (child) {
      await child.stop().catch(() => {});
      await child.close().catch(() => {});
    }
  }
}

/** Reads the child's JSONL to completion, which is where the summarised coverage comes from. */
async function collect(
  child: ManagedSearchChild,
  files: readonly FileEntry[],
): Promise<BatchResult> {
  const result: BatchResult = {
    matches: [],
    scanned: 0,
    unreadable: 0,
    failed: false,
    reason: null,
    consumed: files.length,
  };
  const pathFor = new Map<string, string>();
  for (const file of files) pathFor.set(file.absolutePath, file.path);
  let buffered = '';
  let oversized = false;
  let summarised = false;
  let done = false;

  const handle = (line: string): void => {
    if (!line.trim()) return;
    let event: { type?: string; data?: Record<string, unknown> };
    try {
      event = JSON.parse(line) as typeof event;
    } catch {
      // A half-written line means the stream is not trustworthy; the batch fails rather than dropping matches.
      oversized = true;
      return;
    }
    if (event.type === 'summary') {
      summarised = true;
      const stats = event.data?.stats as { searches?: number } | undefined;
      if (typeof stats?.searches === 'number') result.scanned += stats.searches;
      return;
    }
    if (event.type !== 'match' || !event.data) return;
    const data = event.data as {
      path?: { text?: string } | { bytes?: string };
      lines?: { text?: string } | { bytes?: string };
      line_number?: number;
    };
    // A path or line delivered as base64 is not UTF-8 text; the built-in scanner skips those files as binary,
    // and so does this — inventing characters for them would be worse than a missing hit.
    const pathText = textField(data.path);
    const linesText = textField(data.lines);
    const lineNumber = data.line_number;
    if (pathText === null || linesText === null || typeof lineNumber !== 'number') return;
    const label = pathFor.get(pathText);
    // An event naming a file this batch never asked about is not a result; the backend does not get to widen the
    // scope the tool was given.
    if (label === undefined) return;
    const text = linesText.replace(/\r?\n$/, '').slice(0, MAX_MATCH_TEXT);
    result.matches.push({ path: label, line: lineNumber, text });
  };

  const onData = (chunk: Buffer): void => {
    if (done) return;
    buffered += chunk.toString('utf8');
    let index: number;
    while ((index = buffered.indexOf('\n')) !== -1) {
      const line = buffered.slice(0, index);
      buffered = buffered.slice(index + 1);
      handle(line);
      if (oversized) {
        done = true;
        return;
      }
    }
    if (buffered.length > MAX_EVENT_BYTES) {
      // The bound has to stop the accumulation, not merely mark it: otherwise the buffer keeps growing to the
      // whole event and every chunk rescans it from the start, which is the cost this limit exists to avoid.
      oversized = true;
      done = true;
    }
  };
  child.child.stdout?.on('data', onData);
  // Errors are counted from the exit code and the missing summary; stderr is diagnostics, not results, and is
  // drained so a chatty child cannot block on a full pipe.
  child.child.stderr?.on('data', () => {});

  const exit = await new Promise<{ code: number | null; error?: Error }>((resolve) => {
    let settled = false;
    child.child.once('error', (error: Error) => {
      if (settled) return;
      settled = true;
      resolve({ code: null, error });
    });
    child.child.once('close', (code: number | null) => {
      if (settled) return;
      settled = true;
      resolve({ code });
    });
  });
  done = true;
  if (oversized) return { ...result, failed: true, reason: 'line-limit', consumed: 0 };
  if (exit.error) return { ...result, failed: true, reason: 'read-error', consumed: 0 };
  // 0 means matches, 1 means none, anything else is an error. A batch that ended in an error did not scan the
  // files it was given, and saying otherwise is exactly the false-complete result this replaces.
  if (exit.code === 1) {
    if (!summarised) result.scanned += files.length;
    return result;
  }
  if (exit.code !== 0) {
    result.unreadable += files.length;
    return { ...result, failed: true, reason: 'read-error', consumed: 0 };
  }
  if (!summarised) result.scanned += files.length;
  return result;
}
