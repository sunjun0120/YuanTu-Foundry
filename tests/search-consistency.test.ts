import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { repoMapTools } from '../packages/tools/repo-map.ts';
import { Workspace, workspaceAccess } from '../packages/tools/files.ts';
import { createTools } from '../packages/tools/index.ts';
import {
  WorkspaceSearchService,
  acquireSearchService,
  releaseSearchService,
} from '../packages/search/service.ts';
import { MAX_SYMBOL_FILE_BYTES } from '../packages/search/symbols.ts';
import { CURSOR_INVALID } from '../packages/search/cursor.ts';
import type { ToolContext } from '../packages/protocol/index.ts';

const context = (): ToolContext => ({
  signal: new AbortController().signal,
  approve: async () => true,
});

test('a partial freshness inventory cannot preserve a complete validation claim', async (t) => {
  const { root, service } = await fixture(t);
  await writeFile(path.join(root, 'a.ts'), 'export function existing() {}');
  await service.ready();
  await writeFile(path.join(root, 'z.ts'), 'export function hiddenNew() {}');
  const inventory = service.inventory.bind(service);
  service.inventory = (input) => inventory({ ...input, maxEntries: 1 });
  const page = await service.symbols({ query: 'hiddenNew', limit: 10, signal: context().signal });
  assert.equal(page.coverage.complete, false);
  assert.ok(page.coverage.reasons.includes('entry-limit'));
  assert.notEqual(page.freshness, 'validated');
});

test('a failed source read is retried after access recovers without a metadata change', async (t) => {
  const { root, service } = await fixture(t);
  const file = path.join(root, 'source.ts');
  await writeFile(file, 'export function recoveredSymbol() {}');
  const original = fs.readFile;
  let fail = true;
  t.mock.method(fs, 'readFile', (...args: Parameters<typeof fs.readFile>) => {
    if (String(args[0]) === file && fail)
      return Promise.reject(new Error('transient read failure'));
    return original(...args);
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  await service.ready();
  fail = false;
  const page = await service.symbols({
    query: 'recoveredSymbol',
    limit: 10,
    signal: context().signal,
  });
  assert.equal(page.symbols.length, 1);
  assert.equal(page.coverage.complete, true);
});

test('cancelling a symbol query stops its wait without cancelling the shared rebuild', async (t) => {
  const { root, service } = await fixture(t);
  const file = path.join(root, 'source.ts');
  await writeFile(file, 'export function original() {}');
  await service.ready();
  await writeFile(file, 'export function replacement() {}');
  const original = fs.readFile;
  let entered!: () => void;
  let release!: () => void;
  const reading = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  t.mock.method(fs, 'readFile', async (...args: Parameters<typeof fs.readFile>) => {
    if (String(args[0]) === file) {
      entered();
      await gate;
    }
    return original(...args);
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  const controller = new AbortController();
  const result = service.symbols({ query: 'replacement', limit: 10, signal: controller.signal });
  await reading;
  const reason = new Error('cancelled query');
  controller.abort(reason);
  try {
    await Promise.race([
      assert.rejects(result, (error) => error === reason),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('query ignored cancellation')), 100),
      ),
    ]);
  } finally {
    release();
  }
  await service.ready();
  assert.equal(
    (await service.symbols({ query: 'replacement', limit: 10, signal: context().signal })).symbols
      .length,
    1,
  );
});

test('repo_map paginates LSP declarations and rejects changed query or source snapshots', async () => {
  let hits = Array.from({ length: 205 }, (_, i) => ({
    path: 'source.rs',
    line: i + 1,
    kind: 'function',
    name: `match${i}`,
  }));
  const tool = repoMapTools('test-root', async () => hits)[0]!;
  const names: string[] = [];
  let cursor: string | null = null;
  let firstCursor = '';
  for (let page = 0; page < 4; page++) {
    const result = await tool.execute(
      { query: 'match', limit: 100, ...(cursor ? { cursor } : {}) },
      context(),
    );
    names.push(...[...result.content.matchAll(/function (match\d+)/g)].map((match) => match[1]!));
    cursor = JSON.parse(result.content.split('Retrieval metadata: ')[1]!).nextCursor;
    if (page === 0) firstCursor = cursor!;
    if (!cursor) break;
  }
  assert.equal(names.length, 205);
  assert.equal(new Set(names).size, 205);
  assert.equal(cursor, null);
  await assert.rejects(
    tool.execute({ query: 'other', cursor: firstCursor }, context()),
    /cursor-invalid/,
  );
  hits = hits.slice(1);
  await assert.rejects(
    tool.execute({ query: 'match', cursor: firstCursor }, context()),
    /cursor-invalid/,
  );
});

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-index-consistency-'));
  const service = new WorkspaceSearchService(workspaceAccess(new Workspace(root)), {
    indexDirectory: null,
  });
  t.after(async () => {
    await service.close();
    await rm(root, { recursive: true, force: true });
  });
  return { root, service };
}

test('symbol queries notice external edits, renames, additions and deletions without a manual refresh', async (t) => {
  const { root, service } = await fixture(t);
  await writeFile(path.join(root, 'source.ts'), 'export function originalName() {}\n');
  await service.ready();
  await writeFile(path.join(root, 'source.ts'), 'export function replacementName() {}\n');
  await rename(path.join(root, 'source.ts'), path.join(root, 'moved.ts'));
  await writeFile(path.join(root, 'added.ts'), 'export function newlyAdded() {}\n');
  const query = (name: string) =>
    service.symbols({ query: name, limit: 10, signal: context().signal });
  assert.deepEqual(
    (await query('replacementName')).symbols.map((symbol) => symbol.path),
    ['moved.ts'],
  );
  assert.equal((await query('originalName')).symbols.length, 0);
  assert.deepEqual(
    (await query('newlyAdded')).symbols.map((symbol) => symbol.path),
    ['added.ts'],
  );
  await rm(path.join(root, 'moved.ts'));
  assert.equal((await query('replacementName')).symbols.length, 0);
  assert.equal((await query('newlyAdded')).freshness, 'validated');
});

test('external changes invalidate a symbol cursor before it can skip a changed generation', async (t) => {
  const { root, service } = await fixture(t);
  await writeFile(
    path.join(root, 'source.ts'),
    'export function matchFirst() {}\nexport function matchLast() {}\n',
  );
  await service.ready();
  const page = await service.symbols({ query: 'match', limit: 1, signal: context().signal });
  assert.ok(page.nextCursor);
  await writeFile(path.join(root, 'source.ts'), 'export function matchReplacement() {}\n');
  await assert.rejects(
    service.symbols({
      query: 'match',
      limit: 1,
      cursor: page.nextCursor,
      signal: context().signal,
    }),
    (error: Error & { code?: string }) => error.code === CURSOR_INVALID,
  );
});

test('oversized source files make symbol coverage incomplete and cannot leave an old declaration', async (t) => {
  const { root, service } = await fixture(t);
  const file = path.join(root, 'growing.ts');
  await writeFile(file, 'export function oldDeclaration() {}\n');
  await service.ready();
  await writeFile(
    file,
    ' '.repeat(MAX_SYMBOL_FILE_BYTES + 1) + '\nexport function hiddenLargeSymbol() {}\n',
  );
  const page = await service.symbols({
    query: 'oldDeclaration',
    limit: 10,
    signal: context().signal,
  });
  assert.equal(page.symbols.length, 0, 'a skipped file must not keep its old indexed content');
  assert.equal(page.coverage.complete, false);
  assert.ok(page.coverage.reasons.includes('byte-limit'));
  assert.equal(page.coverage.partialFiles, 1);
});

test('the public repo_map accepts its cursor and reaches every symbol, including declarations on one line', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-map-consistency-'));
  await writeFile(
    path.join(root, 'source.ts'),
    'export function matchOne() {} export function matchTwo() {} export function matchThree() {}\n',
  );
  const tools = createTools(root);
  const service = acquireSearchService(workspaceAccess(new Workspace(root)));
  t.after(async () => {
    await tools.close();
    await releaseSearchService(service);
    await rm(root, { recursive: true, force: true });
  });
  await service.ready();
  const names: string[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 5; page++) {
    const result = await tools.execute(
      {
        id: `page-${page}`,
        name: 'repo_map',
        arguments: { query: 'match', limit: 1, ...(cursor ? { cursor } : {}) },
      },
      context(),
    );
    assert.equal(result.isError, false, result.content);
    names.push(...[...result.content.matchAll(/function (match\w+)/g)].map((match) => match[1]!));
    const metadata = JSON.parse(result.content.split('Retrieval metadata: ')[1]!) as {
      nextCursor: string | null;
    };
    cursor = metadata.nextCursor;
    if (!cursor) break;
  }
  assert.equal(cursor, null);
  assert.deepEqual(names, ['matchOne', 'matchTwo', 'matchThree']);
});

test('the public repo_map describes an incomplete zero rather than a repository-wide absence', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-map-incomplete-'));
  await writeFile(
    path.join(root, 'huge.ts'),
    ' '.repeat(MAX_SYMBOL_FILE_BYTES + 1) + '\nexport function hiddenSymbol() {}\n',
  );
  const tools = createTools(root);
  const service = acquireSearchService(workspaceAccess(new Workspace(root)));
  t.after(async () => {
    await tools.close();
    await releaseSearchService(service);
    await rm(root, { recursive: true, force: true });
  });
  await service.ready();
  const result = await tools.execute(
    { id: 'query', name: 'repo_map', arguments: { query: 'hiddenSymbol' } },
    context(),
  );
  assert.equal(result.isError, false, result.content);
  assert.match(result.content, /incomplete/i);
  const metadata = JSON.parse(result.content.split('Retrieval metadata: ')[1]!) as {
    coverage: { complete: boolean };
  };
  assert.equal(metadata.coverage.complete, false);
});
