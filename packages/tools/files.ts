import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { lstat, realpath, readdir, open } from 'node:fs/promises';
import type { Tool, ToolContext, ToolResult } from '../protocol/index.ts';
import { toolOutput } from '../protocol/tool-result.ts';
import type { ToolOutputContract } from '../protocol/tool-result.ts';
import { MAX_IMAGE_BYTES, sniffImageType, validateImages } from '../protocol/images.ts';
import { MAX_TOOL_OUTPUT, bounded } from './registry.ts';
import { prepareFileChange } from './file-change.ts';
import {
  prepareApplyPatch,
  prepareBatchEdit,
  prepareDelete,
  prepareMove,
} from './file-mutation.ts';
import { loadInstructions } from '../resources/instructions.ts';
import { FileObservations, type MutationGates } from './fs-observation.ts';
import { workerExecArgv } from './environment.ts';
import { isCredentialFileName } from './credential-paths.ts';

/**
 * The read-only tools in this module may overlap a sibling call from the same assistant message.
 *
 * They only read — a path argument chooses what is read, never whether anything is written — so the promise
 * is the same for every argument and is stated once here instead of once per tool. A tool that can write, or
 * that mutates state this run owns (the checklist, a job, the language server session), does not get this
 * name: it stays exclusive, which is what an absent classifier means.
 */
const parallelRead = (): true => true;

const excluded = new Set(['.git', '.yuantu', 'node_modules', '.ssh', '.aws', '.azure', '.gnupg']);
function hidden(name: string): boolean {
  return (
    excluded.has(name.toLowerCase()) || /^\.env(?:\.|$)/i.test(name) || isCredentialFileName(name)
  );
}
/**
 * True for the store's own spilled tool output, which lives under the internal `.yuantu` directory. Reads
 * reach it, writes do not, and scoped instructions are never looked up inside it.
 */
function isSpillPath(input: string): boolean {
  const parts = input.split(/[\\/]+/).filter(Boolean);
  return parts[0] === '.yuantu' && parts[1] === 'spill';
}
function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === '' ||
    (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))
  );
}
// Budget for the "read these scoped instructions first" notice. Merged instructions can legally
// reach 64KB (32KB per file), which is far more than a tool result should carry, so the text is
// trimmed rather than rejected — see guidance().
const MAX_GUIDANCE_CHARS = 18000;
export class Workspace {
  root: string;
  constructor(root: string) {
    this.root = path.resolve(root);
  }
  async resolve(input: string, allowNew = false, allowSpill = false): Promise<string> {
    if (
      /^[a-z][a-z0-9+.-]*:\/\//i.test(input) ||
      (process.platform !== 'win32' && /^[a-z]:[\\/]/i.test(input))
    )
      throw new Error('Foreign path identity is not supported by the local workspace');
    if (
      input.includes('\0') ||
      (process.platform === 'win32' && /[:]/.test(input.replace(/^[A-Za-z]:/, '')))
    )
      throw new Error('Invalid path');
    const root = await realpath(this.root),
      target = path.resolve(root, input);
    if (!inside(root, target)) throw new Error('Path is outside workspace');
    const parts = path.relative(root, target).split(path.sep).filter(Boolean);
    // Spilled tool output lives under `.yuantu/spill`, which reads may reach — the model has to be able to
    // page through output that did not fit in a result. Nothing else under `.yuantu` opens up, and `allowSpill`
    // is only ever passed by a read.
    const spill = allowSpill && parts[0] === '.yuantu' && parts[1] === 'spill';
    if (parts.some((part, index) => hidden(part) && !(spill && index === 0)))
      throw new Error('Access to internal or credential paths is blocked');
    // Reject all links, including in-root links, to reduce ambiguity for mutation tools.
    let current = root;
    for (let i = 0; i < parts.length; i++) {
      current = path.join(current, parts[i]!);
      try {
        if ((await lstat(current)).isSymbolicLink())
          throw new Error('Symbolic links are not allowed');
      } catch (error) {
        if (
          allowNew &&
          i === parts.length - 1 &&
          (error as NodeJS.ErrnoException).code === 'ENOENT'
        )
          return current;
        throw error;
      }
    }
    const canonical = await realpath(target);
    if (!inside(root, canonical)) throw new Error('Resolved path is outside workspace');
    return canonical;
  }
  async read(input: string, limit = 256_000, allowSpill = false): Promise<string> {
    const file = await this.resolve(input, false, allowSpill);
    const handle = await open(file, 'r');
    try {
      if (!(await handle.stat()).isFile()) throw new Error('Expected a regular file');
      const buffer = Buffer.alloc(limit + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      const text = buffer.subarray(0, Math.min(bytesRead, limit)).toString('utf8');
      if (text.includes('\0')) throw new Error('Binary files are not supported');
      return text + (bytesRead > limit ? '\n[file truncated]' : '');
    } finally {
      await handle.close();
    }
  }
  async walk(input: string, context: ToolContext): Promise<string[]> {
    const start = await this.resolve(input);
    const files: string[] = [];
    const queue = [start];
    let scanned = 0;
    while (queue.length && scanned < 5000 && files.length < 1000) {
      context.signal.throwIfAborted();
      const dir = queue.shift()!;
      const entries = await readdir(dir, { withFileTypes: true });
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (++scanned > 5000 || files.length >= 1000) break;
        if (hidden(entry.name) || entry.isSymbolicLink()) continue;
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) queue.push(file);
        else if (entry.isFile())
          files.push(path.relative(this.root, file).split(path.sep).join('/'));
      }
    }
    return files;
  }
}
function compileGlob(glob: string): RegExp {
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
 * How much of a matched line either form shows.
 *
 * A single line of a minified bundle can be megabytes long, and one such line would otherwise become the whole
 * result. Kept in step with the same constant in `./search-worker.ts`, which cannot import this module: the
 * worker is a separate thread and pulling the tool module into it would load the registry, Ajv and every sibling
 * tool for a job that reads files and matches lines.
 */
const MAX_MATCH_TEXT = 500;
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
function languageOf(file: string): string | undefined {
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
const READ_FILE_OUTPUT: ToolOutputContract = {
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
const SEARCH_FILES_OUTPUT: ToolOutputContract = {
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
function shownMatches(rendered: readonly string[]): number {
  let used = 0;
  for (let index = 0; index < rendered.length; index++) {
    const next = used + (index ? 1 : 0) + rendered[index]!.length;
    if (next > MAX_TOOL_OUTPUT) return index;
    used = next;
  }
  return rendered.length;
}
function regexSearch(
  root: string,
  files: string[],
  query: string,
  sensitive: boolean,
  limit: number,
  signal: AbortSignal,
): Promise<{ matches: SearchMatch[]; limited: boolean }> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const workerUrl = new URL(
      import.meta.url.endsWith('.ts') ? './search-worker.ts' : './search-worker.js',
      import.meta.url,
    );
    const worker = new Worker(workerUrl, {
      execArgv: workerExecArgv(),
      workerData: {
        files: files.map((label) => ({ path: path.join(root, ...label.split('/')), label })),
        query,
        sensitive,
        limit,
      },
    });
    let settled = false;
    const finish = (error?: unknown, value?: { matches: SearchMatch[]; limited: boolean }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      void worker.terminate();
      if (error) reject(error);
      else resolve(value!);
    };
    const abort = () => finish(signal.reason ?? new Error('Search cancelled'));
    const timer = setTimeout(() => finish(new Error('Regular expression search timed out')), 2000);
    signal.addEventListener('abort', abort, { once: true });
    worker.once('message', (value) => finish(undefined, value));
    worker.once('error', finish);
    worker.once('exit', (code) => {
      if (!settled && code !== 0) finish(new Error('Regular expression search worker failed'));
    });
  });
}

const str = { type: 'string', minLength: 1, maxLength: 4096 };
function schema(
  properties: Record<string, unknown>,
  required: string[] = [],
): Record<string, unknown> {
  return { type: 'object', properties, required, additionalProperties: false };
}
export function fileTools(root: string, options: { observe?: boolean } = {}): Tool[] {
  const workspace = new Workspace(root);
  /**
   * What this run has read, shared by every read and change tool from this call.
   *
   * Per tool set rather than per session on purpose: the record is evidence about *this* run's picture of the
   * files, and a resumed session that inherited the last run's record would be trusting a memory nobody can
   * check. See `./fs-observation.ts` for the whole policy.
   */
  const observations = new FileObservations(workspace, options.observe ?? true);
  const gates: MutationGates = { instructions: guidance, observations };
  const known = new Set<string>([loadInstructions(root).text]);
  async function guidance(input: string): Promise<string> {
    // Spilled output is read like any other file, and the scoped-instruction lookup must not refuse the
    // path the read itself was allowed to open.
    const file = await workspace.resolve(input, true, true);
    const loaded = loadInstructions(root, path.dirname(file));
    if (known.has(loaded.text)) return '';
    // Record the full text before returning anything. Recording only on the success path meant an
    // over-budget directory threw on every later call (the set was never updated), so the whole
    // subtree became unreachable for read_file and every mutation tool — including the instruction
    // file that needed shortening, because reading it resolves to the same directory.
    known.add(loaded.text);
    if (loaded.text.length <= MAX_GUIDANCE_CHARS) return loaded.text;
    const notice =
      '\n\n[Scoped instructions truncated to fit the tool output budget. ' +
      'Read the instruction files listed above directly to see the remainder.]';
    return loaded.text.slice(0, MAX_GUIDANCE_CHARS - notice.length) + notice;
  }
  return [
    {
      name: 'list_files',
      isConcurrencySafe: parallelRead,
      description:
        'List up to 1000 files recursively relative to workspace; skips links, credentials and dependency directories.',
      inputSchema: schema({ path: str }),
      async execute(args, ctx) {
        return {
          isError: false,
          content: bounded((await workspace.walk(String(args.path ?? '.'), ctx)).join('\n')),
        };
      },
    },
    {
      name: 'read_file',
      isConcurrencySafe: parallelRead,
      output: READ_FILE_OUTPUT,
      description:
        'Read a UTF-8 file. Returns numbered lines; use start_line and end_line for slices. Files are limited to the first 256KB. Output a tool could not return is stored under .yuantu/spill and is readable here.',
      inputSchema: schema(
        {
          path: str,
          start_line: { type: 'integer', minimum: 1 },
          end_line: { type: 'integer', minimum: 1 },
        },
        ['path'],
      ),
      async execute(args) {
        const start = Number(args.start_line ?? 1),
          end = Number(args.end_line ?? start + 199);
        if (end < start) throw new Error('end_line must be >= start_line');
        // Reads reach the spill directory so output that was too large to return is still usable.
        const split = (await workspace.read(String(args.path), 256_000, true)).split(/\r?\n/);
        // The model has now seen this file's bytes, which is what a later change to it will be checked against.
        await observations.record(String(args.path));
        // Scoped instructions live in the workspace, not in the internal directory a spill lives in.
        const instructions = isSpillPath(String(args.path))
          ? ''
          : await guidance(String(args.path));
        /**
         * The split produces one more element than the file has lines when the file ends in a newline, and the
         * numbering the model reads has always shown that element (`5: ` on a four-line file). The payload drops
         * it: `totalLines` is what a card prints beside "lines 2–3 of N", and counting a split artifact there
         * would put the number one too high on essentially every source file in existence. So `shown` is the
         * window exactly as the model receives it, and `slice` is the same window as lines of the file.
         */
        const shown = split.slice(start - 1, end);
        const slice = (split.at(-1) === '' ? split.slice(0, -1) : split).slice(start - 1, end);
        const text = slice.join('\n');
        /**
         * The path in the payload is the resolved one, not the argument as written.
         *
         * `a/../b.txt`, `./b.txt` and `b.txt` are the same file, and a card that compared a `file-read` payload
         * with a `search-results` hit by string equality would treat them as three — so both tools publish the
         * workspace-relative spelling the walk produces, in the same forward-slash form.
         */
        const file = await workspace.resolve(String(args.path), false, true);
        const language = languageOf(file);
        const body = text.slice(0, MAX_TOOL_OUTPUT);
        return {
          isError: false,
          content: bounded(
            (instructions ? instructions + '\n\n' : '') +
              shown.map((line, i) => `${start + i}: ${line}`).join('\n'),
          ),
          output: toolOutput(READ_FILE_OUTPUT, {
            path: path.relative(workspace.root, file).split(path.sep).join('/'),
            ...(language === undefined ? {} : { language }),
            startLine: start,
            endLine: start + slice.length - 1,
            totalLines: split.at(-1) === '' ? split.length - 1 : split.length,
            text: body,
            truncated: body.length < text.length,
          }),
        };
      },
    },
    {
      name: 'read_image',
      isConcurrencySafe: parallelRead,
      description:
        'Read an image file in the workspace (PNG, JPEG, GIF or WebP, up to 5MB) and return it as a picture you can actually look at. Use it on a screenshot or diagram instead of asking what is in it; read_file refuses binary files, and a path alone tells you nothing about the picture.',
      inputSchema: schema({ path: str }, ['path']),
      async execute(args): Promise<ToolResult> {
        const file = await workspace.resolve(String(args.path));
        const handle = await open(file, 'r');
        let bytes: Buffer;
        try {
          const stat = await handle.stat();
          if (!stat.isFile()) throw new Error('Expected a regular file');
          if (stat.size > MAX_IMAGE_BYTES)
            throw new Error(
              `Image is ${Math.round(stat.size / 1024)}KB; the limit is ${MAX_IMAGE_BYTES / (1024 * 1024)}MB`,
            );
          bytes = Buffer.alloc(Number(stat.size));
          await handle.read(bytes, 0, bytes.length, 0);
        } finally {
          await handle.close();
        }
        /**
         * The type comes from the bytes, never from the extension.
         *
         * A `.png` that is really a JPEG would be rejected by the endpoint on the next request, which turns a
         * readable file into a failed run one step later and somewhere else. Sniffing here means the failure —
         * if there is one — is this tool's, in this result, naming the file.
         */
        const mimeType = sniffImageType(bytes);
        if (!mimeType)
          throw new Error(
            'Not a PNG, JPEG, GIF or WebP image; read_file handles text, and there is no way to show other formats to a model',
          );
        // Validated through the same gate as a user's attachment: one place decides what an image may be.
        const [image] = validateImages([
          { mimeType, data: bytes.toString('base64'), name: path.basename(file) },
        ]);
        return {
          isError: false,
          content: `Image ${path.basename(file)} (${mimeType}, ${bytes.length} bytes) attached for you to look at.`,
          images: [image!],
        };
      },
    },
    {
      name: 'search_files',
      isConcurrencySafe: parallelRead,
      output: SEARCH_FILES_OUTPUT,
      description:
        'Search text in up to 1000 workspace files (first 256KB each). Defaults remain literal, case-sensitive, and 100 results; supports regex, case modes, include/exclude globs, and a bounded result limit.',
      inputSchema: schema(
        {
          query: { type: 'string', minLength: 1, maxLength: 1000 },
          path: str,
          mode: { type: 'string', enum: ['literal', 'regex'] },
          case: { type: 'string', enum: ['sensitive', 'insensitive', 'smart'] },
          include: {
            type: 'array',
            items: { type: 'string', minLength: 1, maxLength: 256 },
            maxItems: 32,
          },
          exclude: {
            type: 'array',
            items: { type: 'string', minLength: 1, maxLength: 256 },
            maxItems: 32,
          },
          max_results: { type: 'integer', minimum: 1, maximum: 1000 },
        },
        ['query'],
      ),
      async execute(args, ctx) {
        const query = String(args.query);
        const mode = String(args.mode ?? 'literal');
        const caseMode = String(args.case ?? 'sensitive');
        const sensitive = caseMode === 'sensitive' || (caseMode === 'smart' && /[A-Z]/.test(query));
        if (mode === 'regex') {
          try {
            new RegExp(query, sensitive ? '' : 'i');
          } catch (error) {
            throw new Error(
              `Invalid regular expression: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
        const includes = Array.isArray(args.include)
          ? args.include.map(String).map(compileGlob)
          : [];
        const excludes = Array.isArray(args.exclude)
          ? args.exclude.map(String).map(compileGlob)
          : [];
        const limit = Number(args.max_results ?? 100);
        const files = (await workspace.walk(String(args.path ?? '.'), ctx)).filter(
          (file) =>
            (!includes.length || includes.some((pattern) => pattern.test(file))) &&
            !excludes.some((pattern) => pattern.test(file)),
        );
        /**
         * One scan, two forms.
         *
         * `found` is the payload's list and `rendered` is the text form the model reads, appended together so
         * neither can drift from the other: a hit that reaches the payload reached the text too, and the other
         * way round. Both paths below end in this same tail, which is what keeps the two modes from growing two
         * different ideas of what "limited" and "No matches" mean.
         */
        const found: SearchMatch[] = [];
        const rendered: string[] = [];
        /**
         * `display` defaults to the payload's own text, and the literal path passes it explicitly because its
         * rendered line has always carried `bounded`'s `[output truncated]` marker while the payload may not:
         * the marker is presentation, not part of the file, and dropping it from a card is the point — but
         * dropping it from the text as well would change what the model reads, which this change must not do.
         */
        const add = (file: string, line: number, text: string, display = text): void => {
          found.push({ path: file, line, text });
          rendered.push(`${file}:${line}: ${display}`);
        };
        let limited = false;
        if (mode === 'regex') {
          const result = await regexSearch(
            workspace.root,
            files,
            query,
            sensitive,
            limit,
            ctx.signal,
          );
          for (const match of result.matches) add(match.path, match.line, match.text);
          limited = result.limited;
        } else {
          scan: for (const file of files) {
            ctx.signal.throwIfAborted();
            let text: string;
            try {
              text = await workspace.read(file);
            } catch {
              continue;
            }
            const lines = text.split(/\r?\n/);
            for (let i = 0; i < lines.length; i++) {
              const line = lines[i]!;
              const matched = sensitive
                ? line.includes(query)
                : line.toLocaleLowerCase().includes(query.toLocaleLowerCase());
              if (!matched) continue;
              add(file, i + 1, line.slice(0, MAX_MATCH_TEXT), bounded(line, MAX_MATCH_TEXT));
              if (found.length >= limit) {
                limited = true;
                break scan;
              }
            }
          }
        }
        const shown = shownMatches(rendered);
        return {
          isError: false,
          content: bounded(
            rendered.join('\n') +
              (limited ? '\n[match limit reached]' : rendered.length ? '' : 'No matches'),
          ),
          output: toolOutput(SEARCH_FILES_OUTPUT, {
            query,
            mode,
            matches: found.slice(0, shown),
            // Two different cuts end in the same answer for a card: the scan stopped at the result limit, or the
            // payload dropped matches the text form could not show either. Both mean "this is not every match".
            limited: limited || shown < found.length,
          }),
        };
      },
    },
    {
      name: 'edit_file',
      description:
        'Replace exactly one occurrence of old_text in an existing UTF-8 file, preserving other bytes. Read before editing. Rejects ambiguous matches and files over 1MB.',
      permission: 'write',
      inputSchema: schema(
        {
          path: str,
          old_text: { type: 'string', minLength: 1, maxLength: 1_000_000 },
          new_text: { type: 'string', maxLength: 1_000_000 },
        },
        ['path', 'old_text', 'new_text'],
      ),
      prepare: (args, ctx) => prepareFileChange(workspace, args, 'edit', ctx, gates),
      async execute(args, ctx) {
        return (await prepareFileChange(workspace, args, 'edit', ctx, gates)).execute(ctx);
      },
    },
    {
      name: 'write_file',
      description:
        'Create a new UTF-8 file in an existing directory. Refuses to overwrite an existing file; use edit_file for changes.',
      permission: 'write',
      inputSchema: schema({ path: str, content: { type: 'string', maxLength: 1_000_000 } }, [
        'path',
        'content',
      ]),
      prepare: (args, ctx) => prepareFileChange(workspace, args, 'create', ctx, gates),
      async execute(args, ctx) {
        return (await prepareFileChange(workspace, args, 'create', ctx, gates)).execute(ctx);
      },
    },
    {
      name: 'apply_patch',
      description:
        'Apply one exact unified diff to an existing UTF-8 file. The file is rechecked after approval before mutation.',
      permission: 'write',
      inputSchema: schema(
        { path: str, patch: { type: 'string', minLength: 1, maxLength: 1_000_000 } },
        ['path', 'patch'],
      ),
      prepare: (args, ctx) => prepareApplyPatch(workspace, args, ctx, gates),
      async execute(args, ctx) {
        return (await prepareApplyPatch(workspace, args, ctx, gates)).execute(ctx);
      },
    },
    {
      name: 'delete_file',
      description:
        'Delete one existing UTF-8 file after approval and an exact post-approval byte check.',
      permission: 'write',
      inputSchema: schema({ path: str }, ['path']),
      prepare: (args, ctx) => prepareDelete(workspace, args, ctx, gates),
      async execute(args, ctx) {
        return (await prepareDelete(workspace, args, ctx, gates)).execute(ctx);
      },
    },
    {
      name: 'move_file',
      description:
        'Move one existing UTF-8 file to a nonexistent path in an existing directory. Source and destination are rechecked after approval.',
      permission: 'write',
      inputSchema: schema({ from: str, to: str }, ['from', 'to']),
      prepare: (args, ctx) => prepareMove(workspace, args, ctx, gates),
      async execute(args, ctx) {
        return (await prepareMove(workspace, args, ctx, gates)).execute(ctx);
      },
    },
    {
      name: 'batch_edit',
      description:
        'Apply 1 to 100 ordered exact replacements across UTF-8 files. Effects are sequential and journaled as one group, not filesystem-atomic.',
      permission: 'write',
      approvalDescription:
        'This batch is applied sequentially and is not filesystem-atomic. A partial failure remains journaled as uncertain.',
      inputSchema: schema(
        {
          edits: {
            type: 'array',
            minItems: 1,
            maxItems: 100,
            items: schema(
              {
                path: str,
                old_text: { type: 'string', minLength: 1, maxLength: 1_000_000 },
                new_text: { type: 'string', maxLength: 1_000_000 },
              },
              ['path', 'old_text', 'new_text'],
            ),
          },
        },
        ['edits'],
      ),
      prepare: (args, ctx) => prepareBatchEdit(workspace, args, ctx, gates),
      async execute(args, ctx) {
        return (await prepareBatchEdit(workspace, args, ctx, gates)).execute(ctx);
      },
    },
  ];
}
