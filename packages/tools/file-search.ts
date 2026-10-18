/** Search and read helpers behind the file tools: match rendering, language detection, the regex worker and output contracts. */
import path from 'node:path';
import type { ToolOutputContract } from '../protocol/tool-result.ts';
import { MAX_MATCH_TEXT } from '../search/text.ts';
import { COVERAGE_SCHEMA, type Coverage, type FileEntry } from '../search/types.ts';
import { workerExecArgv } from './environment.ts';
import { MAX_TOOL_OUTPUT, TRUNCATION_MARKER } from './registry.ts';
import { Worker } from 'node:worker_threads';

/**
 * One match as data, rather than as the line the text form lays out for the model.
 *
 * The two forms exist for different readers and are built from one scan, so they cannot disagree about *which*
 * matches were found: the text is what the model reads, and this is what a card lists.
 */
interface SearchMatch {
  path: string;
  line: number;
  text: string;
}
/**
 * The extension-to-language hint a card can hand to a syntax highlighter.
 *
 * A hint and not a decision: it is the file's extension and nothing else, so a file with an unusual name is
 * reported with no language rather than with a wrong one. The values are highlight.js ids, because that is what
 * a carrier highlights with, and a card renders plain text when the hint is absent — which is why an unknown
 * extension is omitted from the payload instead of guessed at.
 */
const LANGUAGES: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  md: 'markdown',
  markdown: 'markdown',
  py: 'python',
  rb: 'ruby',
  go: 'go',
  rs: 'rust',
  java: 'java',
  kt: 'kotlin',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  php: 'php',
  swift: 'swift',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  ps1: 'powershell',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'ini',
  ini: 'ini',
  sql: 'sql',
  html: 'xml',
  htm: 'xml',
  xml: 'xml',
  css: 'css',
  scss: 'scss',
  diff: 'diff',
  patch: 'diff',
};
export function languageOf(file: string): string | undefined {
  const extension = path.extname(file).slice(1).toLowerCase();
  return LANGUAGES[extension];
}
/**
 * `read_file`'s declared result shape.
 *
 * `path`, the range and `totalLines` are in the payload because a card has to answer "which part of which file
 * am I looking at" without the tool call's arguments, and `totalLines` is what lets it say "lines 1–200 of 540"
 * rather than presenting a window as the whole file. `text` is the slice *without* the numbering the text form
 * adds, so the card can draw its own gutter while starting at `startLine` — and for that reason the numbers
 * here count lines of the file, not elements of the split the numbering walks (see the read tool below).
 *
 * `text` is capped at `MAX_TOOL_OUTPUT` characters — the point at which the text form stops being a result and
 * becomes a spill — with `truncated` saying so. Without that cap a read of a 256KB file would put a quarter of
 * a megabyte on the live channel and in the session log for a payload the model never sees, and the client would
 * be handed more than the run it belongs to is ever allowed to read.
 */
export const READ_FILE_OUTPUT: ToolOutputContract = {
  render: 'file-read',
  schema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        minLength: 1,
        description: 'Workspace-relative path, always with forward slashes.',
      },
      language: {
        type: 'string',
        description: 'Highlight.js language id guessed from the extension; absent when unknown.',
      },
      startLine: { type: 'integer', minimum: 1, description: 'First line in `text`, one-based.' },
      endLine: {
        type: 'integer',
        minimum: 0,
        description: 'Last line in `text`; startLine - 1 when the range is empty.',
      },
      totalLines: {
        type: 'integer',
        minimum: 0,
        description: 'Lines in the file, not counting the element a trailing newline splits off.',
      },
      text: { type: 'string', description: 'The lines themselves, without line numbering.' },
      truncated: { type: 'boolean', description: 'True when `text` is not the whole slice.' },
      fileFingerprint: {
        type: 'object',
        description:
          'The file this slice came from: size and mtime, with a null digest because a range read verifies freshness by metadata.',
        properties: {
          size: { type: 'integer', minimum: 0 },
          mtimeMs: { type: 'number' },
          sha256: { type: ['string', 'null'] },
        },
        required: ['size', 'mtimeMs', 'sha256'],
        additionalProperties: false,
      },
    },
    required: ['path', 'startLine', 'endLine', 'totalLines', 'text', 'truncated'],
    additionalProperties: false,
  },
};
/**
 * `search_files`'s declared result shape.
 *
 * `matches` is the same list the text form prints, as data: the text form still spells each hit out for the
 * model, and a card lists them without parsing `path:line: text` back out of a string, which would break the
 * first time a path contained a colon. `limited` means the list is not every match that exists — the tool's
 * result limit stopped the scan, or the payload cap below dropped the tail — so a card can say "showing the
 * first N" instead of implying the workspace holds only these.
 */
export const SEARCH_FILES_OUTPUT: ToolOutputContract = {
  render: 'search-results',
  schema: {
    type: 'object',
    properties: {
      query: { type: 'string' },
      mode: { type: 'string', enum: ['literal', 'regex'] },
      matches: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            path: { type: 'string', minLength: 1 },
            line: { type: 'integer', minimum: 1 },
            text: {
              type: 'string',
              description: `Matched line, capped at ${MAX_MATCH_TEXT} characters.`,
            },
          },
          required: ['path', 'line', 'text'],
          additionalProperties: false,
        },
      },
      limited: { type: 'boolean' },
      coverage: COVERAGE_SCHEMA,
      outputTruncated: {
        type: 'boolean',
        description: 'True when matches were found but did not fit the result character budget.',
      },
      nextCursor: {
        type: ['string', 'null'],
        description: 'Continuation token for the next page; null when this page is the end.',
      },
      sourceVersion: {
        type: ['string', 'null'],
        description: 'The inventory or index version these matches were computed against.',
      },
    },
    required: ['query', 'mode', 'matches', 'limited'],
    additionalProperties: false,
  },
};
/**
 * How many rendered match lines the bounded text form actually shows.
 *
 * The payload must never be larger than the text it accompanies, or one search would carry a megabyte of
 * matches on the live channel and in the session log while the model was shown twenty-four thousand characters
 * of them. `bounded` cuts the joined text at `MAX_TOOL_OUTPUT` characters, so the honest payload is the largest
 * prefix of complete lines that fits in that same budget — the matches the model can actually see, with no
 * half-line at the end that the text form only shows part of.
 */
export function shownMatches(rendered: readonly string[]): number {
  let used = 0;
  for (let index = 0; index < rendered.length; index++) {
    const next = used + (index ? 1 : 0) + rendered[index]!.length;
    if (next > MAX_TOOL_OUTPUT) return index;
    used = next;
  }
  return rendered.length;
}
/**
 * One regular-expression scan, run out of process.
 *
 * The worker is the catastrophic-backtracking protection and stays that way: a pattern like `(a+)+$` cannot be
 * interrupted from this thread, so the only reliable stop is terminating the thread that runs it. What changed
 * is everything else — the worker now streams each file to EOF instead of reading a 256000-byte prefix, and it
 * returns coverage rather than a bare match list, so `regex` mode can no longer report a complete-looking zero
 * for a scan that stopped inside a file.
 *
 * Two deadlines, and the difference between them matters. The worker's own budget is the smaller of the
 * request's and {@link REGEX_WORKER_BUDGET_MS}: when it expires the worker answers with what it has and says
 * `time-limit`, which is a *partial result*. The outer timer is that budget plus slack and exists for the case
 * the inner one cannot cover — a single test that never returns, where the thread is still alive at the deadline
 * and the only honest answer is the error this has always returned.
 */
const REGEX_WORKER_BUDGET_MS = 2_000;
const REGEX_WORKER_SLACK_MS = 250;
export function regexSearch(
  root: string,
  files: string[],
  query: string,
  sensitive: boolean,
  limit: number,
  signal: AbortSignal,
  budgets: { maxScanBytes: number; timeoutMs: number; maxOutputChars: number },
): Promise<{ matches: SearchMatch[]; coverage: Coverage; outputTruncated: boolean }> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const workerUrl =
      typeof __dirname === 'string'
        ? path.join(__dirname, '../packages/tools/search-worker.js')
        : new URL(
            import.meta.url.endsWith('.ts') ? './search-worker.ts' : './search-worker.js',
            import.meta.url,
          );
    const worker = new Worker(workerUrl, {
      execArgv: workerExecArgv(),
      workerData: {
        root,
        files: files.map((label) => ({ path: path.join(root, ...label.split('/')), label })),
        query,
        sensitive,
        limit,
        maxScanBytes: budgets.maxScanBytes,
        timeoutMs: Math.min(budgets.timeoutMs, REGEX_WORKER_BUDGET_MS),
        maxOutputChars: budgets.maxOutputChars,
      },
    });
    type Outcome = { matches: SearchMatch[]; coverage: Coverage; outputTruncated: boolean };
    let settled = false;
    const finish = (error?: unknown, value?: Outcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      void worker.terminate();
      if (error) reject(error);
      else resolve(value!);
    };
    const abort = () => finish(signal.reason ?? new Error('Search cancelled'));
    const timer = setTimeout(
      () => finish(new Error('Regular expression search timed out')),
      Math.min(budgets.timeoutMs, REGEX_WORKER_BUDGET_MS) + REGEX_WORKER_SLACK_MS,
    );
    signal.addEventListener('abort', abort, { once: true });
    worker.once('message', (value: Outcome) => finish(undefined, value));
    worker.once('error', finish);
    worker.once('exit', (code) => {
      if (!settled && code !== 0) finish(new Error('Regular expression search worker failed'));
    });
  });
}

/**
 * What a text search says when it found nothing — and the distinction this whole change is about.
 *
 * "No matches" is two different facts. A complete scan that found nothing is a statement about the workspace; a
 * bounded scan that found nothing is a statement about the part of it that was read. The reasons are listed
 * because a caller told "incomplete" and nothing else cannot decide whether to narrow the query or the scope.
 */
export function noMatchNotice(coverage: Coverage): string {
  if (coverage.complete) return 'No matches in the requested scope.';
  const reasons = coverage.reasons.length ? ` Stopped at: ${coverage.reasons.join(', ')}.` : '';
  return `No matches in the scanned portion; search is incomplete.${reasons}`;
}
/** A prepared file list as the async iterable the scanner takes. */
export async function* fromFiles(files: Iterable<FileEntry>): AsyncGenerator<FileEntry> {
  for (const file of files) yield file;
}
/**
 * How many files `list_files` keeps listing when the caller does not say.
 *
 * Unchanged from the tool's first version on purpose: the model asks for a listing to get oriented, and a listing
 * of a hundred thousand paths is not orientation. What changed is that the cap is now *askable* — the optional
 * `limit` and `cursor` inputs let a caller page past it — and that the result says the list was cut, so the cap
 * no longer reads as the size of the workspace.
 */
export const LIST_FILES_LIMIT = 1_000;
/** Files a caller may ask one listing page to hold. The same ceiling the tool has always promised. */
export const MAX_LIST_FILES_LIMIT = 1_000;
/**
 * How many admitted files a regular-expression scan hands to its worker.
 *
 * The worker takes one flat list, and handing it a hundred thousand paths would spend the whole regex budget
 * serialising them across the thread boundary before a single line was matched. The remainder is reported as
 * `file-limit` rather than dropped silently, so a regex search over a very large tree says it is partial instead
 * of pretending the tree is small.
 */
export const REGEX_MAX_FILES = 10_000;
/**
 * A matched line as the *text* form shows it, for the mode that has always marked a clipped line.
 *
 * The scanner hands back the first {@link MAX_MATCH_TEXT} characters and nothing about what came after, so a
 * line exactly at the cap and a line far past it are the same value here. Presenting the former as clipped is
 * the conservative direction: showing a clipped line as complete is the failure that matters, and the cost of
 * being wrong the other way is one marker beside one line.
 */
export function clippedDisplay(text: string): string {
  return text.length >= MAX_MATCH_TEXT ? text + TRUNCATION_MARKER : text;
}
export const str = { type: 'string', minLength: 1, maxLength: 4096 };
export function schema(
  properties: Record<string, unknown>,
  required: string[] = [],
): Record<string, unknown> {
  return { type: 'object', properties, required, additionalProperties: false };
}
