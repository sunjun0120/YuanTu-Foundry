import path from 'node:path';
import { lstat, realpath, open } from 'node:fs/promises';
import type { Tool, ToolContext, ToolResult } from '../protocol/index.ts';
import type { PreparedTool } from '../protocol/index.ts';
import { toolOutput } from '../protocol/tool-result.ts';
import { MAX_IMAGE_BYTES, sniffImageType, validateImages } from '../protocol/images.ts';
import { MAX_TOOL_OUTPUT, bounded } from './registry.ts';
import { withRetrievalMetadata } from './retrieval-metadata.ts';
import { prepareFileChange } from './file-change.ts';
import {
  prepareApplyPatch,
  prepareBatchEdit,
  prepareDelete,
  prepareMove,
} from './file-mutation.ts';
import { loadInstructions } from './instructions.ts';
import { FileObservations, type MutationGates } from './fs-observation.ts';
import { isCredentialFileName } from '../platform/credential-paths.ts';
import {
  LEGACY_MAX_ENTRIES,
  LEGACY_MAX_FILES,
  SEARCH_MAX_ENTRIES,
  SEARCH_TIMEOUT_MS,
  collectInventory,
  iterateInventory,
} from '../search/inventory.ts';
import { readRange } from '../search/lines.ts';
import { mergeCoverage, scanText, searchOptions } from '../search/text.ts';
import type { WorkspaceSearchService } from '../search/service.ts';
import {
  markStop,
  type InventoryOptions,
  type InventoryResult,
  type SearchBackend,
  type SearchPage,
  type WorkspaceAccess,
} from '../search/types.ts';
import {
  LIST_FILES_LIMIT,
  MAX_LIST_FILES_LIMIT,
  READ_FILE_OUTPUT,
  REGEX_MAX_FILES,
  SEARCH_FILES_OUTPUT,
  clippedDisplay,
  fromFiles,
  languageOf,
  noMatchNotice,
  regexSearch,
  schema,
  shownMatches,
  str,
} from './file-search.ts';

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
/** Apply name rules to both the caller's spelling and the filesystem's canonical spelling. */
function assertVisiblePath(root: string, target: string, allowSpill: boolean): void {
  const parts = path.relative(root, target).split(path.sep).filter(Boolean);
  const spill = allowSpill && parts[0] === '.yuantu' && parts[1] === 'spill';
  if (parts.some((part, index) => hidden(part) && !(spill && index === 0)))
    throw new Error('Access to internal or credential paths is blocked');
}
/**
 * True for the store's own spilled tool output, which lives under the internal `.yuantu` directory. Reads
 * reach it, writes do not, and scoped instructions are never looked up inside it.
 *
 * The argument is the file's **resolved** workspace-relative path, never the argument as written: `./.yuantu/…`
 * and `x/../.yuantu/…` name the same file, and reading the raw string made this exception depend on how the
 * model spelled the path — the equivalent spellings then fell through to the instruction lookup, which refuses
 * everything under `.yuantu`. The comparison stays exact-case, because the canonical path `Workspace.resolve`
 * returns carries the on-disk spelling a case-insensitive filesystem hands back.
 */
function isSpillIdentity(relative: string): boolean {
  const parts = relative.split('/').filter(Boolean);
  return parts[0] === '.yuantu' && parts[1] === 'spill';
}
/**
 * The workspace-relative spelling of an already-resolved file.
 *
 * Both sides are canonicalized: `Workspace.resolve` answers with a realpath, so comparing it to
 * `workspace.root` as written would misname every file in a workspace that is itself reached through a link.
 */
async function canonicalRelative(workspace: Workspace, file: string): Promise<string> {
  const relative = path.relative(await realpath(workspace.root), file);
  return relative.split(path.sep).join('/');
}
function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === '' ||
    (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))
  );
}
/**
 * The exclusion policy expressed the way the search package needs it: a workspace-relative path and what kind of
 * entry it names.
 *
 * One implementation, used by enumeration and by the search scan, because two spellings of "is this path
 * allowed" is how a credential file becomes searchable through the back door. `Workspace.resolve` asks the same
 * questions about the same segments when a single path is opened; this is its bulk form. `.yuantu/spill` is
 * deliberately *not* exempt here: a read may reach spilled output, but enumeration never advertises it, or a
 * tool result would become searchable content and a result set could grow to contain itself.
 */
function isExcludedRelative(relative: string): boolean {
  return relative.split('/').filter(Boolean).some(hidden);
}
// Budget for the "read these scoped instructions first" notice. Merged instructions can legally
// reach 64KB (32KB per file), which is far more than a tool result should carry, so the text is
// trimmed rather than rejected — see guidance().
const MAX_GUIDANCE_CHARS = 18000;
/**
 * The workspace as the search package sees it.
 *
 * The `resolve` adapter is written out rather than bound, because the second positional parameter differs:
 * `Workspace.resolve`'s is `allowNew` and `WorkspaceAccess.resolve`'s is `allowSpill`. Binding it would hand a
 * spill read the ability to name a file that does not exist, and a missing path is precisely what a write is
 * allowed to create — the wrong one of the two permissions is also the more dangerous one.
 */
export function workspaceAccess(workspace: Workspace): WorkspaceAccess {
  return {
    root: workspace.root,
    resolve: (relative, allowSpill = false) => workspace.resolve(relative, false, allowSpill),
    isExcluded: (relative) => isExcludedRelative(relative),
  };
}
/**
 * Whether Windows opens `segment` as a device rather than a file in its directory.
 *
 * `NUL`, `CON`, `COM1` and the rest name a device in every directory, with any extension and with trailing dots
 * or spaces. `lstat` and `realpath` report them as missing, so `resolve(…, allowNew)` used to take one for a new
 * file in the workspace, and a write went to the device instead: a write boundary that did not hold, and on
 * `CON` or a serial port one that could block.
 */
export function isWindowsDeviceName(segment: string): boolean {
  const stem = segment
    .replace(/[. ]+$/, '')
    .split('.')[0]!
    .trimEnd();
  return /^(?:con|prn|aux|nul|conin\$|conout\$|(?:com|lpt)[0-9¹²³])$/i.test(stem);
}
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
    if (process.platform === 'win32' && parts.some(isWindowsDeviceName))
      throw new Error('Windows device names are not workspace files');
    // Spilled tool output lives under `.yuantu/spill`, which reads may reach — the model has to be able to
    // page through output that did not fit in a result. Nothing else under `.yuantu` opens up, and `allowSpill`
    // is only ever passed by a read.
    assertVisiblePath(root, target, allowSpill);
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
        ) {
          const canonical = path.join(
            await realpath(path.dirname(current)),
            path.basename(current),
          );
          if (!inside(root, canonical)) throw new Error('Resolved path is outside workspace');
          assertVisiblePath(root, canonical, allowSpill);
          return canonical;
        }
        throw error;
      }
    }
    const canonical = await realpath(target);
    if (!inside(root, canonical)) throw new Error('Resolved path is outside workspace');
    assertVisiblePath(root, canonical, allowSpill);
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
  /**
   * Enumerates the workspace and says how much of it was reached.
   *
   * The default budgets are the ones `walk` has always had — five thousand entries, one thousand candidate
   * files — because this is the compatibility entry point and a caller that never asked about coverage must not
   * silently start paying for a bigger scan. `search_files` passes the search budgets explicitly.
   *
   * The filters decide *before* the candidate budget, which is the whole point: a file the caller named by
   * `include` is a candidate, and a thousand files the caller did not ask for never consume the room it needs.
   */
  async walkWithCoverage(
    input: string,
    context: ToolContext,
    options: Partial<Omit<InventoryOptions, 'path' | 'signal'>> = {},
  ): Promise<InventoryResult> {
    return collectInventory(workspaceAccess(this), {
      path: input,
      include: options.include ?? [],
      exclude: options.exclude ?? [],
      maxEntries: options.maxEntries ?? LEGACY_MAX_ENTRIES,
      maxFiles: options.maxFiles === undefined ? LEGACY_MAX_FILES : options.maxFiles,
      timeoutMs: options.timeoutMs ?? SEARCH_TIMEOUT_MS,
      signal: context.signal,
    });
  }
  /**
   * The old bounded walk, kept as the compatibility wrapper it now is.
   *
   * Its signature and its return type are unchanged: an array of workspace-relative paths, at most a thousand
   * of them. What it can no longer do is imply that the array is the workspace — nothing here says whether the
   * walk stopped at a limit, and a caller that needs to know asks `walkWithCoverage` instead.
   */
  async walk(input: string, context: ToolContext): Promise<string[]> {
    const { files } = await this.walkWithCoverage(input, context);
    return files.map((file) => file.path);
  }
}
export function fileTools(
  root: string,
  setup: {
    observe?: boolean;
    searchBackend?: SearchBackend;
    /**
     * The shared search service, when the assembly layer has one.
     *
     * Structural (`Pick<…>`) rather than the whole service: what this module needs from it is a paged listing,
     * a way to record that paths changed, and how current its index is — and a bare `fileTools` in a test or an
     * embedder must keep working with none of it.
     */
    search?: Pick<WorkspaceSearchService, 'listingPage' | 'invalidate' | 'freshness'>;
  } = {},
): Tool[] {
  const workspace = new Workspace(root);
  /** The workspace as the search package sees it: one path policy, stated once. */
  const access = workspaceAccess(workspace);
  /**
   * What this run has read, shared by every read and change tool from this call.
   *
   * Per tool set rather than per session on purpose: the record is evidence about *this* run's picture of the
   * files, and a resumed session that inherited the last run's record would be trusting a memory nobody can
   * check. See `./fs-observation.ts` for the whole policy.
   */
  const observations = new FileObservations(workspace, setup.observe ?? true);
  const gates: MutationGates = { instructions: guidance, observations };
  const known = new Set<string>([loadInstructions(root).text]);
  async function guidance(input: string): Promise<string> {
    const { text, shown } = await pendingGuidance(input);
    shown();
    return text;
  }
  /**
   * The scoped instructions a call would hand over, and the step that records them as handed over.
   *
   * Separate steps so the instructions are recorded as shown only once the read has succeeded.
   */
  async function pendingGuidance(input: string): Promise<{ text: string; shown: () => void }> {
    // Spilled output is read like any other file, and the scoped-instruction lookup must not refuse the
    // path the read itself was allowed to open.
    const file = await workspace.resolve(input, true, true);
    const loaded = loadInstructions(root, path.dirname(file));
    if (known.has(loaded.text)) return { text: '', shown: () => {} };
    // Record the full text before returning anything. Recording only on the success path meant an
    // over-budget directory threw on every later call (the set was never updated), so the whole
    // subtree became unreachable for read_file and every mutation tool — including the instruction
    // file that needed shortening, because reading it resolves to the same directory.
    const shown = () => known.add(loaded.text);
    return { text: truncatedGuidance(loaded.text), shown };
  }
  function truncatedGuidance(text: string): string {
    if (text.length <= MAX_GUIDANCE_CHARS) return text;
    const notice =
      '\n\n[Scoped instructions truncated to fit the tool output budget. ' +
      'Read the instruction files listed above directly to see the remainder.]';
    return text.slice(0, MAX_GUIDANCE_CHARS - notice.length) + notice;
  }
  const tools: Tool[] = [
    {
      name: 'list_files',
      isConcurrencySafe: parallelRead,
      description:
        'List files recursively relative to workspace; skips links, credentials and dependency directories. Up to 1000 per page; pass limit, and the nextCursor of a previous result to reach the rest. The list ends with a retrieval-metadata line saying whether it is the whole scope or was cut short.',
      inputSchema: schema({
        path: str,
        limit: { type: 'integer', minimum: 1, maximum: MAX_LIST_FILES_LIMIT },
        cursor: { type: 'string', minLength: 1, maxLength: 128 },
      }),
      async execute(args, ctx) {
        const input = String(args.path ?? '.');
        const limit =
          typeof args.limit === 'number' && Number.isSafeInteger(args.limit)
            ? Math.min(MAX_LIST_FILES_LIMIT, Math.max(1, args.limit))
            : LIST_FILES_LIMIT;
        const cursor = typeof args.cursor === 'string' && args.cursor ? args.cursor : null;
        /**
         * With a shared service the listing is paged by it, which is what makes the cursor a real continuation:
         * the token is bound to this workspace, this path and the position, and an unknown or stale one is
         * refused rather than reinterpreted. Without one — a bare `fileTools` in a test or an embedder — the
         * listing is the bounded walk it has always been, and a cursor is refused rather than silently ignored.
         */
        if (setup.search) {
          const page = await setup.search.listingPage({ path: input, limit, cursor }, ctx.signal);
          return {
            isError: false,
            content: withRetrievalMetadata(page.files.map((file) => file.path).join('\n'), {
              coverage: page.coverage,
              sourceVersion: page.sourceVersion,
              nextCursor: page.nextCursor,
              freshness: setup.search.freshness(),
            }),
          };
        }
        if (cursor)
          throw new Error(
            'cursor-invalid: this tool set has no shared listing cursor. Search again without a cursor.',
          );
        const { files, coverage } = await workspace.walkWithCoverage(input, ctx, {
          maxFiles: limit,
        });
        return {
          isError: false,
          content: withRetrievalMetadata(files.map((file) => file.path).join('\n'), {
            coverage,
            sourceVersion: null,
            nextCursor: null,
            freshness: 'unknown',
          }),
        };
      },
    },
    {
      name: 'read_file',
      isConcurrencySafe: parallelRead,
      output: READ_FILE_OUTPUT,
      description:
        'Read a UTF-8 file. Returns numbered lines; use start_line and end_line for slices. The whole file is searchable, so a slice may start anywhere in it, and totalLines is the file’s real length. Output a tool could not return is stored under .yuantu/spill and is readable here.',
      inputSchema: schema(
        {
          path: str,
          start_line: { type: 'integer', minimum: 1 },
          end_line: { type: 'integer', minimum: 1 },
        },
        ['path'],
      ),
      async execute(args, ctx) {
        const start = Number(args.start_line ?? 1),
          end = Number(args.end_line ?? start + 199);
        if (end < start) throw new Error('end_line must be >= start_line');
        const input = String(args.path);
        /**
         * The real range read, not a slice of a truncated prefix.
         *
         * `Workspace.read` keeps its 256000-byte default for its existing callers, and this tool no longer uses
         * it: reading a prefix and slicing a window out of that answered "line 130001" with empty text and a
         * total of 128002 for a file that has 130001 lines. The range read either knows the count or fails.
         */
        const range = await readRange(access, input, start, end, ctx.signal, true);
        // The model sees this file's bytes once the result is delivered, which is what a later change to it will
        // be checked against.
        await observations.record(input);
        /**
         * The path in the payload is the resolved one, not the argument as written.
         *
         * `a/../b.txt`, `./b.txt` and `b.txt` are the same file, and a card that compared a `file-read` payload
         * with a `search-results` hit by string equality would treat them as three — so both tools publish the
         * workspace-relative spelling the walk produces, in the same forward-slash form.
         */
        const file = await workspace.resolve(input, false, true);
        // Scoped instructions live in the workspace, not in the internal directory a spill lives in — and the
        // question is which file this read opened, so it is answered from the resolved path rather than from the
        // spelling of the argument (see `isSpillIdentity`). Resolving first is what makes that possible.
        const pending = isSpillIdentity(await canonicalRelative(workspace, file))
          ? undefined
          : await pendingGuidance(input);
        pending?.shown();
        const instructions = pending?.text ?? '';
        /**
         * The numbered text keeps the convention it has always had, and the payload keeps the count.
         *
         * A file ending in a newline splits into one more element than it has lines, and the numbering the model
         * reads has always shown that element (`5: ` on a four-line file). The payload drops it: `totalLines` is
         * what a card prints beside "lines 2–3 of N", and counting a split artifact there would put the number
         * one too high on essentially every source file in existence. `shown` reproduces the model's window
         * exactly; `lines` is the same window as lines of the file.
         */
        const lines = range.endLine >= range.startLine ? range.text.split('\n') : [];
        const shown = [...lines];
        const artifact = range.endsWithNewline || range.totalLines === 0;
        if (artifact && range.totalLines >= start - 1 && range.totalLines < end) shown.push('');
        const text = lines.join('\n');
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
            endLine: range.endLine,
            totalLines: range.totalLines,
            text: body,
            truncated: body.length < text.length || range.truncated,
            fileFingerprint: range.fileFingerprint,
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
          // Filled to the size that was stat-ed. A short read would otherwise leave the tail as NUL bytes and
          // hand the model a truncated picture that still passes the header sniff below.
          bytes = Buffer.alloc(Number(stat.size));
          let offset = 0;
          while (offset < bytes.length) {
            const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
            if (!bytesRead) throw new Error('File changed while reading its image; reopen it');
            offset += bytesRead;
          }
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
        'Search workspace text. Defaults remain literal, case-sensitive, and 100 results; supports regex, case modes, include/exclude globs and a bounded result limit. Files are read to EOF, and the result says whether the scan was complete — an incomplete scan never reports that the workspace has no such text.',
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
        // Narrowed rather than cast: the input schema enumerates both values, so anything else is a caller that
        // bypassed the schema, and the tool's own defaults are what it falls back to.
        const mode: 'literal' | 'regex' = args.mode === 'regex' ? 'regex' : 'literal';
        const caseMode: 'sensitive' | 'insensitive' | 'smart' =
          args.case === 'insensitive' || args.case === 'smart' ? args.case : 'sensitive';
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
        const includes = Array.isArray(args.include) ? args.include.map(String) : [];
        const excludes = Array.isArray(args.exclude) ? args.exclude.map(String) : [];
        const limit = Number(args.max_results ?? 100);
        const options = searchOptions({
          query,
          mode,
          caseMode,
          maxResults: limit,
          maxOutputChars: MAX_TOOL_OUTPUT,
          signal: ctx.signal,
          deadlineMs: Date.now() + SEARCH_TIMEOUT_MS,
        });
        /**
         * One set of enumeration options for every backend.
         *
         * The filters travel as strings and are compiled inside the search package, so `search_files` and the
         * inventory cannot end up with two ideas of what an include pattern means. `maxFiles` is `null` — the
         * entry budget is what bounds a search now, and a repository with more candidate files than results
         * should still be *searched*, not truncated to the first thousand.
         */
        const inventoryOptions: InventoryOptions = {
          path: String(args.path ?? '.'),
          include: includes,
          exclude: excludes,
          maxEntries: SEARCH_MAX_ENTRIES,
          maxFiles: null,
          timeoutMs: SEARCH_TIMEOUT_MS,
          deadlineMs: options.deadlineMs,
          signal: ctx.signal,
        };
        const page = await search();
        /**
         * One scan, two forms — still.
         *
         * `found` is the payload's list and `rendered` is the text form the model reads, built from the same
         * matches so neither can drift from the other. The only difference between the two modes is the one that
         * has always been there: the literal path marks a clipped line with `bounded`'s marker in the text form,
         * while the regex path shows the clipped line itself. That marker is presentation, not part of the file,
         * and dropping it would change what the model reads.
         */
        const found = page.matches;
        const rendered = found.map(
          (match) =>
            `${match.path}:${match.line}: ${
              mode === 'literal' ? clippedDisplay(match.text) : match.text
            }`,
        );
        const shown = shownMatches(rendered);
        const limited =
          !page.coverage.complete ||
          page.outputTruncated ||
          page.nextCursor !== null ||
          shown < found.length;
        return {
          isError: false,
          content: bounded(
            found.length
              ? rendered.join('\n') + (limited ? '\n[match limit reached]' : '')
              : noMatchNotice(page.coverage),
          ),
          output: toolOutput(SEARCH_FILES_OUTPUT, {
            query,
            mode,
            matches: found.slice(0, shown),
            limited,
            coverage: page.coverage,
            outputTruncated: page.outputTruncated || shown < found.length,
            nextCursor: page.nextCursor,
            sourceVersion: page.sourceVersion,
          }),
        };

        /**
         * The backend decision, made in one place.
         *
         * `regex` goes to its worker — the only thing that can stop a pathological pattern — and everything else
         * is a case-sensitive literal the built-in scanner answers, unless the assembly layer supplied a verified
         * fast backend and it can actually run here. When it cannot, the built-in scanner is used directly rather
         * than the backend being asked to fall back to it: the same engine either way, and one less indirection
         * in the way a partial result would be explained.
         */
        async function search(): Promise<SearchPage> {
          if (mode === 'regex') {
            // The worker cannot enumerate — path policy lives here — so it is handed one flat, admitted list.
            const inventory = await collectInventory(access, inventoryOptions);
            const remainingMs = Math.max(0, options.deadlineMs! - Date.now());
            if (remainingMs === 0)
              return scanText(
                access,
                fromFiles(inventory.files),
                options,
                () => inventory.coverage,
              );
            const result = await regexSearch(
              workspace.root,
              inventory.files.slice(0, REGEX_MAX_FILES).map((file) => file.path),
              query,
              sensitive,
              limit,
              ctx.signal,
              { ...options, timeoutMs: remainingMs },
            );
            const truncated = inventory.files.length > REGEX_MAX_FILES;
            if (truncated) markStop(inventory.coverage, 'file-limit');
            return {
              matches: result.matches.map((match) => ({
                path: match.path,
                line: match.line,
                text: match.text,
              })),
              coverage: mergeCoverage(inventory.coverage, result.coverage),
              outputTruncated: result.outputTruncated,
              nextCursor: null,
              sourceVersion: null,
            };
          }
          const backend = setup.searchBackend;
          if (backend && (await backend.available())) {
            const inventory = await collectInventory(access, inventoryOptions);
            if (Date.now() >= options.deadlineMs!)
              return scanText(
                access,
                fromFiles(inventory.files),
                options,
                () => inventory.coverage,
              );
            return backend.search(
              {
                files: inventory.files,
                options,
                inventory: () => inventory.coverage,
                fallback: (files, coverage) =>
                  scanText(access, fromFiles(files), options, () => coverage),
              },
              ctx,
            );
          }
          const stream = iterateInventory(access, inventoryOptions);
          return scanText(access, stream, options, () => stream.coverage());
        }
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
  /**
   * A change this run made is news the index has to hear.
   *
   * The index is built from the files as they were, so a write that lands and does not reach it leaves the next
   * `repo_map` answering with a symbol at a line that no longer holds it. Recording the paths here — rather than
   * rebuilding — is deliberate: a batch of writes should cost one reconcile, and the paths are all the index
   * needs to know which rows to re-check.
   *
   * Only a change that *happened* is recorded, and the paths come from the arguments as well as from the result,
   * because a rename touches two paths and only one of them is in `change`.
   */
  return setup.search
    ? tools.map((tool) =>
        tool.permission === 'write' ? withInvalidation(tool, setup.search!) : tool,
      )
    : tools;
}

/**
 * Wraps one write tool so a change it made invalidates the index rows that described the old content.
 *
 * Both dispatch paths are covered on purpose. A tool the registry calls directly goes through `execute` here, but
 * a tool with a `prepare` does not: the registry asks `prepare` for the preview it shows a person and then runs
 * `prepared.execute`, never touching `tool.execute` again. Wrapping only the obvious one left the invalidation
 * unreachable for every mutation tool in the product — which is exactly what the lifecycle test caught.
 */
function withInvalidation(tool: Tool, search: Pick<WorkspaceSearchService, 'invalidate'>): Tool {
  const reminder = async (args: Record<string, unknown>, result: ToolResult): Promise<void> => {
    if (result.isError) return;
    const paths = touchedPaths(args, result);
    if (paths.length) await search.invalidate({ paths, reason: 'tool-write' }).catch(() => {});
  };
  const wrapPrepared = (args: Record<string, unknown>, prepared: PreparedTool): PreparedTool => ({
    ...prepared,
    execute: async (context) => {
      const result = await prepared.execute(context);
      await reminder(args, result);
      return result;
    },
  });
  const wrapped: Tool = {
    ...tool,
    async execute(args, context) {
      const result = await tool.execute(args, context);
      await reminder(args, result);
      return result;
    },
  };
  if (tool.prepare)
    wrapped.prepare = async (args, context) => {
      const prepared = await tool.prepare!(args, context);
      return prepared ? wrapPrepared(args, prepared) : prepared;
    };
  return wrapped;
}

/** Every workspace path one write call named, from its arguments and from the change it produced. */
function touchedPaths(args: Record<string, unknown>, result: ToolResult): string[] {
  const paths = new Set<string>();
  const add = (value: unknown): void => {
    if (typeof value === 'string' && value.trim()) paths.add(value);
  };
  add(args.path);
  add(args.from);
  add(args.to);
  if (Array.isArray(args.edits))
    for (const edit of args.edits)
      if (edit && typeof edit === 'object') add((edit as Record<string, unknown>).path);
  const change = result.change;
  if (change) {
    add(change.path);
    for (const nested of change.changes ?? []) add(nested.path);
  }
  return [...paths];
}
