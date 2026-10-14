/**
 * Everything past the first 256000 bytes.
 *
 * The three defects this pins all had the same shape: a fixed prefix read presented as the whole file. A marker
 * at byte 260000 was "not found"; line 130001 of a 130001-line file was an empty slice at line 128002; and a
 * file larger than the prefix was searched only in its head. Each test below puts the interesting byte where the
 * old code stopped looking, and each one checks the *reported* state as well as the result — a scan that cannot
 * finish must say so rather than answer as if it had.
 *
 * The fixtures are built from the byte counts in the plan rather than approximated, so a regression moves the
 * boundary rather than merely changing an outcome.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createTools } from '../packages/tools/index.ts';
import { Workspace } from '../packages/tools/files.ts';
import { cachedLineIndex, clearLineIndexCache, readRange } from '../packages/search/lines.ts';
import { scanText, searchOptions } from '../packages/search/text.ts';
import type { Coverage, FileEntry, WorkspaceAccess } from '../packages/search/types.ts';

/**
 * This suite is about the *built-in* scanner’s accounting — real bytes read, files read to EOF, the reason a
 * scan stopped — so it pins the engine rather than accepting whichever backend this machine happens to have a
 * verified asset for. The fast backend is exercised where it belongs: tests/search-ripgrep.test.ts runs it
 * against the built-in scanner on the same fixture and requires the two to agree match for match.
 */
process.env.YUANTU_SEARCH_RG = '0';

const context = () => ({ signal: new AbortController().signal, approve: async () => true });

/** The 260021-byte fixture from the plan: 130000 `x` lines and a marker on line 130001. */
const TAIL_MARKER = 'TAIL-MARKER-XY-12345';
const TAIL_FIXTURE = 'x\n'.repeat(130_000) + `${TAIL_MARKER}\n`;

async function workspaceFor(t: test.TestContext, files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-streaming-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(files))
    await writeFile(path.join(root, name), content, 'utf8');
  return root;
}

/** The workspace as the search package sees it, without going through the tools. */
async function accessFor(root: string): Promise<WorkspaceAccess> {
  const workspace = new Workspace(root);
  const canonical = await workspace.resolve('.');
  return {
    root: canonical,
    resolve: (relative, allowSpill) => workspace.resolve(relative, false, allowSpill),
    isExcluded: () => false,
  };
}

function entry(root: string, name: string, size: number): FileEntry {
  return {
    path: name,
    absolutePath: path.join(root, name),
    fingerprint: { size, mtimeMs: 0, sha256: null },
  };
}

async function* listed(files: readonly FileEntry[]): AsyncGenerator<FileEntry> {
  for (const file of files) yield file;
}

test('a marker past the old prefix is searchable, and the file ends where it really ends', async (t) => {
  const root = await workspaceFor(t, { 'big.txt': TAIL_FIXTURE });
  assert.equal(Buffer.byteLength(TAIL_FIXTURE), 260_021, 'the plan fixture is the fixture');
  const workspace = new Workspace(root);
  const access = await accessFor(root);

  // 1. The literal scan reaches the last line.
  const access1 = access;
  const stream = (async function* () {
    yield entry(root, 'big.txt', 260_021);
  })();
  const page = await scanText(access1, stream, searchOptions({ query: TAIL_MARKER }));
  assert.deepEqual(
    page.matches.map((match) => [match.path, match.line]),
    [['big.txt', 130_001]],
  );
  assert.equal(page.coverage.complete, true);
  assert.equal(page.coverage.filesScanned, 1);
  assert.equal(page.coverage.bytesRead, 260_021);

  // 2. The range read knows the file is 130001 lines and can produce the last one.
  const range = await readRange(access, 'big.txt', 130_001, 130_001, context().signal);
  assert.equal(range.totalLines, 130_001, 'a real count, not the count of a prefix');
  assert.equal(range.startLine, 130_001);
  assert.equal(range.endLine, 130_001);
  assert.equal(range.text, TAIL_MARKER);
  assert.equal(range.truncated, false);
  assert.equal(range.endsWithNewline, true);
  assert.equal(range.fileFingerprint.size, 260_021);

  // 3. The tool's own answers agree, and the numbered text shows the line the model asked for. The trailing
  //    empty element is the convention the numbering has always had on a file that ends in a newline.
  const tools = createTools(root);
  const read = await tools.execute(
    { id: 'read', name: 'read_file', arguments: { path: 'big.txt', start_line: 130_001 } },
    context(),
  );
  assert.equal(read.isError, false, read.content);
  assert.equal(read.content, `130001: ${TAIL_MARKER}\n130002: `);
  assert.equal((read.output!.value as { totalLines: number }).totalLines, 130_001);

  const found = await tools.execute(
    { id: 'search', name: 'search_files', arguments: { query: TAIL_MARKER } },
    context(),
  );
  assert.equal(found.isError, false, found.content);
  assert.equal(found.content, `big.txt:130001: ${TAIL_MARKER}`);
  const payload = found.output!.value as { coverage: Coverage; limited: boolean };
  assert.equal(payload.limited, false);
  assert.equal(payload.coverage.complete, true);
  await tools.close();
  void workspace;
});

test('a marker beyond one mebibyte is found by both the literal and the regex backend', async (t) => {
  const root = await workspaceFor(t, {
    'deep.txt': 'y\n'.repeat(700_000) + 'DEEP-MARKER\n',
  });
  const tools = createTools(root);
  const literal = await tools.execute(
    { id: 'search', name: 'search_files', arguments: { query: 'DEEP-MARKER' } },
    context(),
  );
  assert.equal(literal.isError, false, literal.content);
  assert.equal(literal.content, 'deep.txt:700001: DEEP-MARKER');

  // The regex path lives in a worker, and it used to stop at the same prefix. It must not any more.
  const regex = await tools.execute(
    { id: 'search', name: 'search_files', arguments: { query: 'DEEP-[M]ARKER', mode: 'regex' } },
    context(),
  );
  assert.equal(regex.isError, false, regex.content);
  assert.equal(regex.content, 'deep.txt:700001: DEEP-MARKER');

  const read = await tools.execute(
    { id: 'read', name: 'read_file', arguments: { path: 'deep.txt', start_line: 700_001 } },
    context(),
  );
  assert.equal(read.content, '700001: DEEP-MARKER\n700002: ');
  assert.equal((read.output!.value as { totalLines: number }).totalLines, 700_001);
  await tools.close();
});

test('a multi-byte character split across two chunks is decoded, not replaced', async (t) => {
  // The chunk size is 64 KiB, so a character starting one byte before that boundary has its bytes split.
  const line = `${'a'.repeat(65_535)}中文标记`;
  const root = await workspaceFor(t, { 'utf8.txt': `${line}\n` });
  const access = await accessFor(root);
  const page = await scanText(
    access,
    listed([entry(root, 'utf8.txt', Buffer.byteLength(`${line}\n`))]),
    searchOptions({ query: '中文标记' }),
  );
  assert.deepEqual(
    page.matches.map((match) => match.line),
    [1],
  );
  const range = await readRange(access, 'utf8.txt', 1, 1, context().signal);
  assert.equal(range.text, line);
  assert.equal(range.text.includes('\uFFFD'), false, 'no replacement characters were introduced');
  assert.ok(range.text.endsWith('中文标记'));
});

test('a CRLF pair split across two chunks yields a line without the carriage return', async (t) => {
  const first = 'a'.repeat(65_534);
  const root = await workspaceFor(t, { 'crlf.txt': `${first}\r\nneedle\r\n` });
  const access = await accessFor(root);
  const page = await scanText(
    access,
    listed([entry(root, 'crlf.txt', Buffer.byteLength(`${first}\r\nneedle\r\n`))]),
    searchOptions({ query: 'needle' }),
  );
  assert.deepEqual(
    page.matches.map((match) => [match.line, match.text]),
    [[2, 'needle']],
  );
  const range = await readRange(access, 'crlf.txt', 2, 2, context().signal);
  assert.equal(range.text, 'needle');
  assert.equal(range.totalLines, 2);
});

test('a file with no trailing newline has the last line it really has', async (t) => {
  const root = await workspaceFor(t, { 'plain.txt': 'alpha\nbeta' });
  const access = await accessFor(root);
  const page = await scanText(
    access,
    listed([entry(root, 'plain.txt', 10)]),
    searchOptions({ query: 'beta' }),
  );
  assert.deepEqual(
    page.matches.map((match) => [match.line, match.text]),
    [[2, 'beta']],
  );
  const range = await readRange(access, 'plain.txt', 1, 10, context().signal);
  assert.equal(range.totalLines, 2);
  assert.equal(range.text, 'alpha\nbeta');
  assert.equal(range.endsWithNewline, false);
});

test('an empty file is empty, and a range past the end is empty without inventing lines', async (t) => {
  const root = await workspaceFor(t, { 'empty.txt': '', 'two.txt': 'a\nb\n' });
  const access = await accessFor(root);
  const empty = await readRange(access, 'empty.txt', 1, 200, context().signal);
  assert.equal(empty.totalLines, 0);
  assert.equal(empty.endLine, 0);
  assert.equal(empty.text, '');
  assert.equal(empty.endsWithNewline, false);

  const past = await readRange(access, 'two.txt', 9, 200, context().signal);
  assert.equal(past.totalLines, 2);
  assert.equal(past.endLine, 8, 'an empty window is startLine - 1');
  assert.equal(past.text, '');

  // The tool-level convention is unchanged: a file ending in a newline numbers one empty line past the end,
  // while a window that starts past even that is empty text.
  const tools = createTools(root);
  const artifact = await tools.execute(
    { id: 'read', name: 'read_file', arguments: { path: 'two.txt', start_line: 3, end_line: 3 } },
    context(),
  );
  assert.equal(artifact.content, '3: ');
  const beyond = await tools.execute(
    { id: 'read', name: 'read_file', arguments: { path: 'two.txt', start_line: 9 } },
    context(),
  );
  assert.equal(beyond.content, '');
  await tools.close();
});

test('a line longer than the assembly cap is scanned as far as it goes, and says it was cut', async (t) => {
  const head = `${'z'.repeat(64)}HEAD-NEEDLE${'z'.repeat(2 * 1024 * 1024)}`;
  const root = await workspaceFor(t, {
    'long.txt': `${head}\n`,
    'tail-needle.txt': `${'z'.repeat(2 * 1024 * 1024)}${'z'.repeat(0)}TAIL-ONLY\n`,
  });
  const access = await accessFor(root);
  const page = await scanText(
    access,
    listed([
      entry(root, 'long.txt', Buffer.byteLength(`${head}\n`)),
      entry(root, 'tail-needle.txt', 2 * 1024 * 1024 + 10),
    ]),
    searchOptions({ query: 'HEAD-NEEDLE' }),
  );
  // The head of the over-long line was matched — a hit in it is real — and the file is reported as partly read.
  assert.deepEqual(
    page.matches.map((match) => match.line),
    [1],
  );
  assert.equal(page.coverage.partialFiles, 2);
  assert.ok(page.coverage.reasons.includes('line-limit'));
  assert.equal(page.coverage.complete, false);

  // A marker past the cap on an over-long line is not found, and that is reported rather than passed off as a
  // complete zero. This is the case where "we did not look" and "it is not there" must not be the same answer.
  const missed = await scanText(
    access,
    listed([entry(root, 'tail-needle.txt', 2 * 1024 * 1024 + 10)]),
    searchOptions({ query: 'TAIL-ONLY' }),
  );
  assert.deepEqual(missed.matches, []);
  assert.equal(missed.coverage.complete, false);
  assert.ok(missed.coverage.reasons.includes('line-limit'));
});

test('a binary file is skipped as binary rather than counted as a failed read', async (t) => {
  const root = await workspaceFor(t, {});
  const binary = Buffer.concat([Buffer.from('the needle\0'), Buffer.alloc(64, 7)]);
  await writeFile(path.join(root, 'blob.bin'), binary);
  const access = await accessFor(root);
  const page = await scanText(
    access,
    listed([entry(root, 'blob.bin', binary.length)]),
    searchOptions({ query: 'needle' }),
  );
  assert.deepEqual(page.matches, []);
  assert.equal(page.coverage.unreadableFiles, 0);
  // Out of scope, not half-read: a binary file cannot hold text to match, so it is neither a failure nor a
  // completed text scan. Counting it as either would make every repository holding an image incomplete.
  assert.equal(page.coverage.filesScanned, 0);
  assert.equal(page.coverage.partialFiles, 0);
  assert.equal(page.coverage.complete, true);

  await assert.rejects(
    readRange(access, 'blob.bin', 1, 1, context().signal),
    /Binary files are not supported/,
  );
});

test('a cancelled scan and a cancelled range read reject with the caller’s reason', async (t) => {
  const root = await workspaceFor(t, { 'a.txt': 'alpha\nbeta\n' });
  const access = await accessFor(root);
  const signal = AbortSignal.abort(new Error('cancelled by the test'));
  await assert.rejects(readRange(access, 'a.txt', 1, 1, signal), /cancelled by the test/);
  await assert.rejects(
    scanText(access, listed([entry(root, 'a.txt', 11)]), searchOptions({ query: 'a', signal })),
    /cancelled by the test/,
  );
});

test('a range read reuses its verified line index, and refuses it after the file changes', async (t) => {
  const root = await workspaceFor(t, { 'lines.txt': 'a\nb\nc\nd\ne\n' });
  const access = await accessFor(root);
  clearLineIndexCache();
  const first = await readRange(access, 'lines.txt', 1, 5, context().signal);
  assert.equal(first.totalLines, 5);
  const cached = await readRange(access, 'lines.txt', 4, 5, context().signal);
  assert.equal(cached.text, 'd\ne');
  assert.equal(cached.totalLines, 5);

  // A changed file must not be answered from the index kept for the old one — not even when the new content
  // happens to be the same length, which is the case a size-only check would let through.
  await writeFile(path.join(root, 'lines.txt'), 'v\nw\nx\ny\nz\n');
  const changed = await readRange(access, 'lines.txt', 1, 5, context().signal);
  assert.equal(changed.text, 'v\nw\nx\ny\nz');
  assert.equal(changed.totalLines, 5);
});

test('a range read that cannot finish counting fails instead of reporting a prefix count', async (t) => {
  const root = await workspaceFor(t, { 'small.txt': 'a\nb\n' });
  const access = await accessFor(root);
  // A budget of one byte cannot reach the end of even this file, so there is no honest total to report.
  const tiny = searchOptions({ query: 'a', maxScanBytes: 1 });
  const page = await scanText(access, listed([entry(root, 'small.txt', 4)]), tiny);
  assert.equal(page.coverage.complete, false);
  assert.ok(page.coverage.reasons.includes('byte-limit'));
  assert.equal(
    page.coverage.filesScanned,
    0,
    'a file cut by the byte budget was not fully scanned',
  );
  assert.equal(page.coverage.partialFiles, 1);
});

test('the file is read as UTF-8 text through the tool, and the payload keeps the real count', async (t) => {
  const root = await workspaceFor(t, { 'emoji.txt': 'a\n😀 b\nc\n' });
  const tools = createTools(root);
  const result = await tools.execute(
    { id: 'read', name: 'read_file', arguments: { path: 'emoji.txt' } },
    context(),
  );
  const value = result.output!.value as {
    totalLines: number;
    endLine: number;
    text: string;
    truncated: boolean;
    fileFingerprint: { size: number; sha256: string | null };
  };
  assert.equal(value.totalLines, 3);
  assert.equal(value.endLine, 3);
  assert.equal(value.text, 'a\n😀 b\nc');
  assert.equal(value.truncated, false);
  assert.equal(value.fileFingerprint.size, Buffer.byteLength('a\n😀 b\nc\n'));
  assert.equal(
    value.fileFingerprint.sha256,
    null,
    'a metadata fingerprint claims no content evidence',
  );
  await tools.close();
});

test('range reads reuse an unchanged index with fractional timestamps, but invalidate same-size rewrites', async (t) => {
  const root = await workspaceFor(t, { 'cached.txt': 'one\ntwo\n' });
  const file = path.join(root, 'cached.txt');
  const access = await accessFor(root);
  await utimes(file, 1_700_000_000.123456, 1_700_000_000.123456);
  await readRange(access, 'cached.txt', 1, 1, context().signal);
  const index = cachedLineIndex(file);
  assert.ok(index);
  assert.equal((await readRange(access, 'cached.txt', 2, 2, context().signal)).text, 'two');
  assert.equal(
    cachedLineIndex(file),
    index,
    'the second slice should reuse the already-counted file',
  );
  await writeFile(file, 'one\nnew\n');
  await utimes(file, 1_700_000_000.123789, 1_700_000_000.123789);
  assert.equal((await readRange(access, 'cached.txt', 2, 2, context().signal)).text, 'new');
  assert.notEqual(cachedLineIndex(file), index, 'a fractional mtime change invalidates the index');
});

test('the bytes on disk are unchanged by reading them', async (t) => {
  const root = await workspaceFor(t, { 'stable.txt': 'ünïcödé\nsecond\n' });
  const before = await readFile(path.join(root, 'stable.txt'));
  const access = await accessFor(root);
  await readRange(access, 'stable.txt', 1, 2, context().signal);
  await readRange(access, 'stable.txt', 1, 2, context().signal);
  const after = await readFile(path.join(root, 'stable.txt'));
  assert.deepEqual(after, before);
});
