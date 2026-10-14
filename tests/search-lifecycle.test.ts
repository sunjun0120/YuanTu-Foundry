/**
 * Resource ownership: who closes the index, and when it is safe to.
 *
 * A search index is shared state with a lifecycle longer than the tool set that uses it, which is exactly the
 * shape that produces the two classic defects 鈥?closing it while somebody else is still reading, and never
 * closing it at all. Both are checked here from the outside: two registries over one workspace, a build running
 * when a close arrives, and a workspace whose service was released and acquired again.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createTools } from '../packages/tools/index.ts';
import { Workspace, workspaceAccess, fileTools } from '../packages/tools/files.ts';
import {
  WorkspaceSearchService,
  acquireSearchService,
  closeAllSearchServices,
  releaseSearchService,
} from '../packages/search/service.ts';
import type { ToolContext } from '../packages/protocol/index.ts';

const context = (): ToolContext => ({
  signal: new AbortController().signal,
  approve: async () => true,
});

async function tempRoot(t: test.TestContext, prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  t.after(async () => {
    await closeAllSearchServices();
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

test('two registries over one workspace share the service, and the first to finish does not close it', async (t) => {
  const root = await tempRoot(t, 'yuantu-life-two-');
  await writeFile(path.join(root, 'a.ts'), 'export function sharedSymbol() {}\n');
  const first = createTools(root);
  const second = createTools(root);
  // The same service instance, ref-counted twice: one index per workspace, not one per run.
  const service = acquireSearchService(workspaceAccess(new Workspace(root)));
  assert.ok(service.refCount() >= 2);

  await first.close();
  assert.ok(
    service.refCount() >= 1,
    'the registry that finished first did not close the shared index',
  );
  const result = await second.execute(
    { id: 'map', name: 'repo_map', arguments: { query: 'sharedSymbol' } },
    context(),
  );
  assert.equal(result.isError, false, result.content);

  await second.close();
  await releaseSearchService(service);
  assert.equal(service.refCount(), 0);
  await t.test('and a fresh acquire is a fresh service', async () => {
    // A workspace whose service was released gets a new one rather than a closed one handed back.
    const again = acquireSearchService(workspaceAccess(new Workspace(root)));
    assert.equal(again.refCount(), 1);
    assert.doesNotThrow(() => again.retain());
    await releaseSearchService(again);
  });
});

test('two workspaces never share an index', async (t) => {
  const first = await tempRoot(t, 'yuantu-life-a-');
  const second = await tempRoot(t, 'yuantu-life-b-');
  await writeFile(path.join(first, 'a.ts'), 'export function onlyInFirst() {}\n');
  await writeFile(path.join(second, 'b.ts'), 'export function onlyInSecond() {}\n');
  const serviceA = acquireSearchService(workspaceAccess(new Workspace(first)), {
    indexDirectory: null,
  });
  const serviceB = acquireSearchService(workspaceAccess(new Workspace(second)), {
    indexDirectory: null,
  });
  assert.notEqual(serviceA, serviceB);
  await serviceA.ready();
  await serviceB.ready();
  assert.deepEqual(
    (await serviceA.symbols({ query: 'onlyInSecond', limit: 5, signal: AbortSignal.abort() }))
      .symbols,
    [],
  );
  assert.deepEqual(
    (
      await serviceA.symbols({ query: 'onlyInFirst', limit: 5, signal: AbortSignal.abort() })
    ).symbols.map((symbol) => symbol.path),
    ['a.ts'],
  );
  await releaseSearchService(serviceA);
  await releaseSearchService(serviceB);
});

test('closing waits for a running build instead of tearing it down underneath', async (t) => {
  const root = await tempRoot(t, 'yuantu-life-close-');
  for (let index = 0; index < 40; index++)
    await writeFile(path.join(root, `f-${index}.ts`), `export function name${index}() {}\n`);
  const service = new WorkspaceSearchService(workspaceAccess(new Workspace(root)), {
    indexDirectory: path.join(root, '.yuantu', 'search'),
  });
  // Start a build and close immediately: the close must settle it rather than leave it writing into a closed
  // database, which is how a half-written generation becomes the next query's answer.
  void service.symbols({ query: 'name', limit: 5, signal: AbortSignal.abort() });
  await service.close();
  assert.equal(service.cursorCount(), 0, 'closing drops the cursors it issued');
  // Closing twice is a no-op rather than an error: a registry may be closed more than once in a failed run.
  await service.close();
});

test('a closed service issues nothing, and its cursors do not survive it', async (t) => {
  const root = await tempRoot(t, 'yuantu-life-stale-');
  for (let index = 0; index < 6; index++) await writeFile(path.join(root, `f-${index}.txt`), 'x\n');
  const service = new WorkspaceSearchService(workspaceAccess(new Workspace(root)), {
    indexDirectory: null,
  });
  const page = await service.listingPage({ limit: 2 }, new AbortController().signal);
  assert.ok(page.nextCursor);
  assert.ok(service.cursorCount() > 0);
  await service.close();
  assert.equal(service.cursorCount(), 0);
  assert.throws(
    () => service.retain(),
    /closed/,
    'a closed service cannot be handed to another owner',
  );
});

test('the shared map is emptied when the last reference goes, so a host restart leaves nothing behind', async (t) => {
  const root = await tempRoot(t, 'yuantu-life-map-');
  await writeFile(path.join(root, 'a.ts'), 'export const x = 1;\n');
  const service = acquireSearchService(workspaceAccess(new Workspace(root)), {
    indexDirectory: null,
  });
  await releaseSearchService(service);
  const fresh = acquireSearchService(workspaceAccess(new Workspace(root)), {
    indexDirectory: null,
  });
  assert.notEqual(fresh, service, 'a released service is not handed out again');
  assert.equal(fresh.refCount(), 1);
  await releaseSearchService(fresh);
});

test('a search result never claims more coverage than the enumeration granted', async (t) => {
  const root = await tempRoot(t, 'yuantu-life-coverage-');
  for (let index = 0; index < 30; index++)
    await writeFile(path.join(root, `f-${index}.txt`), 'needle\n');
  const service = new WorkspaceSearchService(workspaceAccess(new Workspace(root)), {
    indexDirectory: null,
  });
  const page = await service.listingPage({ limit: 10 }, new AbortController().signal);
  assert.equal(page.files.length, 10);
  // The walk was abandoned at the tenth file, so the coverage is not complete 鈥?and the cursor is the honest
  // way to say "there is more", rather than a `complete` flag contradicted by a cursor.
  assert.equal(page.coverage.complete, false);
  assert.ok(page.nextCursor);
  await service.close();
});

test('list_files pages through a tree larger than its own limit, without repeating a file', async (t) => {
  const root = await tempRoot(t, 'yuantu-life-listing-');
  const names = Array.from({ length: 12 }, (_, index) => `f-${String(index).padStart(2, '0')}.txt`);
  for (const name of names) await writeFile(path.join(root, name), 'x\n');
  const tools = createTools(root);
  try {
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 6; page++) {
      const result = await tools.execute(
        {
          id: `ls-${page}`,
          name: 'list_files',
          arguments: { limit: 5, ...(cursor ? { cursor } : {}) },
        },
        context(),
      );
      assert.equal(result.isError, false, result.content);
      const metadata = JSON.parse(
        result.content.slice(result.content.indexOf('Retrieval metadata: ') + 20),
      ) as { nextCursor: string | null; coverage: { complete: boolean } };
      seen.push(
        ...result.content
          .split('\n')
          .filter((line) => line && !line.startsWith('Retrieval metadata: ')),
      );
      cursor = metadata.nextCursor;
      if (!cursor) {
        assert.equal(metadata.coverage.complete, true, 'the last page is the end of the walk');
        break;
      }
      assert.equal(
        metadata.coverage.complete,
        false,
        'a page with a cursor did not finish the walk',
      );
    }
    assert.deepEqual([...seen].sort(), [...names].sort());
    assert.equal(new Set(seen).size, names.length, 'no file is listed twice');
  } finally {
    await tools.close();
  }
});

test('a cursor from another workspace is refused instead of reinterpreted', async (t) => {
  const root = await tempRoot(t, 'yuantu-life-cursor-');
  for (let index = 0; index < 4; index++) await writeFile(path.join(root, `f-${index}.txt`), 'x\n');
  const foreignRoot = await tempRoot(t, 'yuantu-life-other-');
  for (let index = 0; index < 4; index++)
    await writeFile(path.join(foreignRoot, `g-${index}.txt`), 'x\n');
  const tools = createTools(root);
  const foreign = acquireSearchService(workspaceAccess(new Workspace(foreignRoot)), {
    indexDirectory: null,
  });
  try {
    const page = await foreign.listingPage({ limit: 2 }, new AbortController().signal);
    assert.ok(page.nextCursor);
    const rejected = await tools.execute(
      { id: 'ls', name: 'list_files', arguments: { limit: 2, cursor: page.nextCursor } },
      context(),
    );
    assert.equal(rejected.isError, true);
    assert.match(rejected.content, /cursor-invalid/);
    const unknown = await tools.execute(
      { id: 'ls-2', name: 'list_files', arguments: { limit: 2, cursor: 'not-a-token' } },
      context(),
    );
    assert.equal(unknown.isError, true);
    assert.match(unknown.content, /cursor-invalid/);
  } finally {
    await releaseSearchService(foreign);
    await tools.close();
  }
});

test('a write invalidates the symbol rows that described the old content', async (t) => {
  const root = await tempRoot(t, 'yuantu-life-write-');
  await writeFile(path.join(root, 'a.ts'), 'export function beforeTheWrite() {}\n');
  const tools = createTools(root);
  try {
    const found = await tools.execute(
      { id: 'map', name: 'repo_map', arguments: { query: 'beforeTheWrite' } },
      context(),
    );
    assert.match(found.content, /beforeTheWrite/);

    // A read first: the change tools require the model to have looked at what it is changing.
    await tools.execute({ id: 'read', name: 'read_file', arguments: { path: 'a.ts' } }, context());
    const edited = await tools.execute(
      {
        id: 'edit',
        name: 'edit_file',
        arguments: { path: 'a.ts', old_text: 'beforeTheWrite', new_text: 'afterTheWrite' },
      },
      context(),
    );
    assert.equal(edited.isError, false, edited.content);

    /**
     * The index is now known to be out of date, and the tool says so rather than answering as if it were current.
     * A hit from a list that is being rebuilt still goes out — withholding it would be a worse answer — but never
     * without the freshness beside it.
     */
    const after = await tools.execute(
      { id: 'map-2', name: 'repo_map', arguments: { query: 'beforeTheWrite' } },
      context(),
    );
    assert.match(after.content, /may lag recent writes|still being built/);
  } finally {
    await tools.close();
  }
});

test('a bare file tool set pages with limit and refuses a cursor it cannot honour', async (t) => {
  const root = await tempRoot(t, 'yuantu-life-bare-');
  for (let index = 0; index < 4; index++) await writeFile(path.join(root, `f-${index}.txt`), 'x\n');
  // No service: the bounded walk the tool has always been, with the listing limit now askable.
  const tools = fileTools(root);
  const tool = tools.find((entry) => entry.name === 'list_files')!;
  const page = await tool.execute({ limit: 2 }, context());
  assert.equal(page.content.split('\n')[0], 'f-0.txt');
  const metadata = JSON.parse(
    page.content.slice(page.content.indexOf('Retrieval metadata: ') + 20),
  );
  assert.equal(metadata.nextCursor, null, 'a walk has no cursor to continue from');
  await assert.rejects(tool.execute({ limit: 2, cursor: 'anything' }, context()), /cursor-invalid/);
});
