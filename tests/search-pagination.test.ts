/**
 * Cursors: pages that neither skip nor repeat, and tokens that stop working when they should.
 *
 * A continuation token is the one part of a paginated listing a caller can hold across calls, so it is the one
 * part that can be wrong for a long time before anybody notices — a skipped file and a repeated file both look
 * like a listing. The fixtures therefore compare *sets* across pages rather than counting them, and the invalid
 * cases assert the refusal rather than any particular fallback.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Workspace, workspaceAccess } from '../packages/tools/files.ts';
import { WorkspaceSearchService } from '../packages/search/service.ts';
import { CURSOR_INVALID, CursorStore } from '../packages/search/cursor.ts';

async function tempRoot(t: test.TestContext, prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function serviceFor(t: test.TestContext, root: string): Promise<WorkspaceSearchService> {
  const service = new WorkspaceSearchService(workspaceAccess(new Workspace(root)), {
    indexDirectory: null,
  });
  t.after(() => service.close());
  return service;
}

const signal = (): AbortSignal => new AbortController().signal;

test('a paged listing covers every file exactly once', async (t) => {
  const root = await tempRoot(t, 'yuantu-page-listing-');
  const names = Array.from({ length: 25 }, (_, index) => `f-${String(index).padStart(2, '0')}.txt`);
  for (const name of names) await writeFile(path.join(root, name), 'text\n');
  const service = await serviceFor(t, root);

  const seen: string[] = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    const page = await service.listingPage({ limit: 7, cursor }, signal());
    seen.push(...page.files.map((file) => file.path));
    cursor = page.nextCursor;
    pages++;
    assert.ok(pages < 10, 'paging terminates');
  } while (cursor);
  assert.equal(seen.length, 25, 'every file appears exactly once');
  assert.deepEqual([...seen].sort(), [...names].sort());
  assert.equal(new Set(seen).size, 25, 'and no file appears twice');
});

test('the last page of a listing has no cursor behind it', async (t) => {
  const root = await tempRoot(t, 'yuantu-page-last-');
  for (let index = 0; index < 5; index++) await writeFile(path.join(root, `f-${index}.txt`), 'x\n');
  const service = await serviceFor(t, root);
  const page = await service.listingPage({ limit: 10 }, signal());
  assert.equal(page.files.length, 5);
  // A listing that ended exactly at its limit and a listing that ended because the walk did are different, and
  // only the walk ending means there is no next page.
  assert.equal(page.nextCursor, null);
});

test('a cursor is refused when the query, the path or the filters changed', async (t) => {
  const root = await tempRoot(t, 'yuantu-page-query-');
  for (let index = 0; index < 6; index++) await writeFile(path.join(root, `f-${index}.txt`), 'x\n');
  const service = await serviceFor(t, root);
  const first = await service.listingPage({ limit: 2 }, signal());
  assert.ok(first.nextCursor);

  await assert.rejects(
    service.listingPage({ limit: 2, cursor: first.nextCursor, include: ['f-*.txt'] }, signal()),
    (error: Error & { code?: string }) => error.code === CURSOR_INVALID,
  );
  await assert.rejects(
    service.listingPage({ limit: 2, cursor: first.nextCursor, path: 'sub' }, signal()),
    (error: Error & { code?: string }) => error.code === CURSOR_INVALID,
  );
  // The same request still works, which is what makes the refusals above about the change rather than the token.
  const again = await service.listingPage({ limit: 2, cursor: first.nextCursor }, signal());
  assert.equal(again.files.length, 2);
});

test('a cursor is refused across workspaces and after an unknown change', async (t) => {
  const first = await tempRoot(t, 'yuantu-page-a-');
  const second = await tempRoot(t, 'yuantu-page-b-');
  for (const root of [first, second])
    for (let index = 0; index < 6; index++)
      await writeFile(path.join(root, `f-${index}.txt`), 'x\n');
  const serviceA = await serviceFor(t, first);
  const serviceB = await serviceFor(t, second);
  const page = await serviceA.listingPage({ limit: 2 }, signal());
  assert.ok(page.nextCursor);
  await assert.rejects(
    serviceB.listingPage({ limit: 2, cursor: page.nextCursor }, signal()),
    (error: Error & { code?: string }) => error.code === CURSOR_INVALID,
  );
});

test('a cursor is refused once the file it ended on has changed', async (t) => {
  const root = await tempRoot(t, 'yuantu-page-witness-');
  for (let index = 0; index < 6; index++) await writeFile(path.join(root, `f-${index}.txt`), 'x\n');
  const service = await serviceFor(t, root);
  const page = await service.listingPage({ limit: 2 }, signal());
  assert.ok(page.nextCursor);
  const boundary = page.files[page.files.length - 1]!.path;
  await service.invalidate({ paths: [boundary], reason: 'tool-write' });
  await assert.rejects(
    service.listingPage({ limit: 2, cursor: page.nextCursor }, signal()),
    (error: Error & { code?: string }) => error.code === CURSOR_INVALID,
  );
});

test('a cursor whose boundary file is gone is refused instead of ending the listing', async (t) => {
  const root = await tempRoot(t, 'yuantu-page-boundary-');
  for (let index = 0; index < 6; index++) await writeFile(path.join(root, `f-${index}.txt`), 'x\n');
  const service = await serviceFor(t, root);
  const page = await service.listingPage({ limit: 2 }, signal());
  assert.ok(page.nextCursor);
  await rm(path.join(root, page.files[page.files.length - 1]!.path));
  // The boundary is what makes the window stable, so losing it is a stale cursor. It used to end the walk with
  // nothing found — an empty page with no next cursor, which reads as "there is nothing more in this workspace".
  await assert.rejects(
    service.listingPage({ limit: 2, cursor: page.nextCursor }, signal()),
    (error: Error & { code?: string }) => error.code === CURSOR_INVALID,
  );
});

test('a symbol page continues from where it stopped, without repeating a symbol', async (t) => {
  const root = await tempRoot(t, 'yuantu-page-symbols-');
  for (let index = 0; index < 12; index++)
    await writeFile(
      path.join(root, `s-${String(index).padStart(2, '0')}.ts`),
      `export function sym${index}() {}\n`,
    );
  const service = await serviceFor(t, root);
  await service.ready();

  const seen: string[] = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    const page = await service.symbols({ query: 'sym', limit: 5, cursor, signal: signal() });
    seen.push(...page.symbols.map((symbol) => symbol.name));
    cursor = page.nextCursor;
    pages++;
    assert.ok(pages < 10, 'paging terminates');
  } while (cursor);
  assert.equal(seen.length, 12);
  assert.equal(new Set(seen).size, 12, 'no symbol is repeated across pages');
  // `freshness` travels with every page, so a caller can tell a partial index from a complete one.
  assert.equal(service.freshness(), 'validated');
});

test('a listing cursor is not accepted as a symbol cursor', async (t) => {
  const root = await tempRoot(t, 'yuantu-page-kind-');
  for (let index = 0; index < 6; index++)
    await writeFile(path.join(root, `f-${index}.ts`), 'export const x = 1;\n');
  const service = await serviceFor(t, root);
  await service.ready();
  const listing = await service.listingPage({ limit: 2 }, signal());
  assert.ok(listing.nextCursor);
  await assert.rejects(
    service.symbols({ query: 'x', limit: 2, cursor: listing.nextCursor, signal: signal() }),
    (error: Error & { code?: string }) => error.code === CURSOR_INVALID,
  );
});

test('an expired or unknown token is refused, and the store keeps its bounds', () => {
  let now = 1_000;
  const store = new CursorStore({ now: () => now, ttlMs: 1_000, limit: 4 });
  const state = {
    workspace: '/w',
    queryHash: 'h',
    sourceVersion: null,
    after: null,
    witness: null,
  };
  const token = store.issue(state);
  assert.equal(store.take(token, { workspace: '/w', queryHash: 'h' }).queryHash, 'h');
  now += 1_001;
  assert.throws(
    () => store.take(token, { workspace: '/w', queryHash: 'h' }),
    (error: Error & { code?: string }) => error.code === CURSOR_INVALID,
  );
  assert.throws(
    () => store.take('not-a-token', { workspace: '/w', queryHash: 'h' }),
    (error: Error & { code?: string }) => error.code === CURSOR_INVALID,
  );

  // The cap is per workspace, so a caller that walks away from a listing cannot grow the map without bound.
  const tokens: string[] = [];
  for (let index = 0; index < 10; index++) tokens.push(store.issue(state));
  assert.ok(store.size() <= 4, `the store stayed bounded (${store.size()})`);
  assert.throws(
    () => store.take(tokens[0]!, { workspace: '/w', queryHash: 'h' }),
    (error: Error & { code?: string }) => error.code === CURSOR_INVALID,
    'the oldest token is the one that was dropped',
  );
  assert.equal(store.take(tokens[9]!, { workspace: '/w', queryHash: 'h' }).queryHash, 'h');
});
