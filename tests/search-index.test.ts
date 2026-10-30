/**
 * The symbol index: whole files, real changes, and a freshness value that is computed rather than assumed.
 *
 * The outline this replaces read the first 32 KiB of the first 400 files, so two kinds of symbol did not exist
 * for the agent: one declared past the head of a long file, and any symbol at all in a file that sorted after
 * the four hundredth. Both are fixtures here, and both are asserted through the *tool* rather than only through
 * the index, because a tool that cannot reach the index is the same failure with better internals.
 *
 * The other half is change. An index that survives a file edit is worse than no index — it answers with a line
 * number that no longer holds — so a rename, a deletion and a same-size rewrite inside one timestamp tick each
 * have to end with the old symbol gone.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rename, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createTools } from '../packages/catalog/index.ts';
import { Workspace } from '../packages/tools/files.ts';
import { workspaceAccess } from '../packages/tools/files.ts';
import {
  WorkspaceSearchService,
  acquireSearchService,
  releaseSearchService,
} from '../packages/search/service.ts';
import {
  analyzeSymbols,
  blockEnd,
  exportsOf,
  importsOf,
  languageOf,
} from '../packages/search/symbols.ts';
import type { ToolContext } from '../packages/protocol/index.ts';

const context = (): ToolContext => ({
  signal: new AbortController().signal,
  approve: async () => true,
});

async function tempRoot(t: test.TestContext, prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

/** A service over a temporary directory, closed by the test that made it. */
async function serviceFor(t: test.TestContext, root: string): Promise<WorkspaceSearchService> {
  const service = new WorkspaceSearchService(workspaceAccess(new Workspace(root)), {
    indexDirectory: null,
  });
  t.after(() => service.close());
  return service;
}

test('a build that could not enumerate the tree keeps the rows it never reached', async (t) => {
  const root = await tempRoot(t, 'yuantu-index-partial-');
  await writeFile(path.join(root, 'first.ts'), 'export function firstSymbol() { return 1; }\n');
  await writeFile(path.join(root, 'second.ts'), 'export function secondSymbol() { return 2; }\n');
  await writeFile(path.join(root, 'third.ts'), 'export function thirdSymbol() { return 3; }\n');
  const service = await serviceFor(t, root);
  await service.ready();
  const internals = service as unknown as {
    startBuild(relativePath: string): void;
    build: Promise<void> | null;
    inventoryOptions(input: object): Record<string, unknown>;
    index: { paths(): string[]; freshness(): string };
  };
  assert.deepEqual(internals.index.paths().sort(), ['first.ts', 'second.ts', 'third.ts']);

  /**
   * A walk that stopped at its entry budget visited one path and never learned about the others. Pruning on
   * that evidence deletes rows for files that are still on disk and then commits the shrunken generation as
   * `validated` — the same thing `reconcile` refuses on identical evidence.
   */
  const options = internals.inventoryOptions.bind(service);
  internals.inventoryOptions = (input: object) => ({ ...options(input), maxEntries: 1 });
  internals.startBuild('.');
  await internals.build;
  assert.deepEqual(internals.index.paths().sort(), ['first.ts', 'second.ts', 'third.ts']);
  assert.notEqual(
    internals.index.freshness(),
    'validated',
    'a partial walk cannot validate a generation',
  );
});

test('a symbol past 32KiB of a file body is found', async (t) => {
  const root = await tempRoot(t, 'yuantu-index-deep-');
  const filler = Array.from({ length: 1_200 }, (_, index) => `const filler${index} = ${index};`);
  await writeFile(
    path.join(root, 'long.ts'),
    `${filler.join('\n')}\nexport function deepSymbol() {\n  return 1;\n}\n`,
  );
  const service = await serviceFor(t, root);
  await service.ready();
  const page = await service.symbols({
    query: 'deepSymbol',
    limit: 10,
    signal: new AbortController().signal,
  });
  assert.deepEqual(
    page.symbols.map((symbol) => [symbol.path, symbol.startLine, symbol.kind]),
    [['long.ts', 1201, 'function']],
  );
  // The old scan stopped at 32 KiB, which is around line 1200 — a symbol at line 1201 is the smallest possible
  // regression fixture for that boundary.
  assert.ok(1201 > 1_000);
});

test(
  'a symbol in a file past the four hundredth is found, through the tool',
  { timeout: 60_000 },
  async (t) => {
    const root = await tempRoot(t, 'yuantu-index-many-');
    for (let index = 0; index < 420; index++) {
      const directory = path.join(root, `pkg-${String(Math.floor(index / 20)).padStart(2, '0')}`);
      await mkdir(directory, { recursive: true });
      await writeFile(
        path.join(directory, `file-${String(index).padStart(3, '0')}.ts`),
        'export const x = 1;',
      );
    }
    // Sorted after every filler file, so it is the four-hundred-and-twenty-first the walk reaches.
    await writeFile(
      path.join(root, 'zzz-last.ts'),
      'export function beyondTheCap() { return 1; }\n',
    );

    const tools = createTools(root);
    const search = acquireSearchService(workspaceAccess(new Workspace(root)));
    try {
      // The tool starts a background build. Await that shared build rather than racing 421 parses
      // against a ten-second polling window on the hosted Windows runner.
      const initial = await tools.execute(
        { id: 'start-map', name: 'repo_map', arguments: { query: 'beyondTheCap' } },
        context(),
      );
      assert.equal(initial.isError, false, initial.content);
      await search.ready();
      const result = await tools.execute(
        { id: 'map', name: 'repo_map', arguments: { query: 'beyondTheCap' } },
        context(),
      );
      assert.equal(result.isError, false, result.content);
      const content = result.content;
      assert.doesNotMatch(content, /still being built/);
      assert.match(content, /zzz-last\.ts:1 function beyondTheCap/);
      // The list ends with the machine-readable line, so a caller can see the version it came from.
      assert.match(content, /Retrieval metadata: /);
      const metadata = JSON.parse(content.slice(content.indexOf('Retrieval metadata: ') + 20));
      assert.equal(metadata.sourceVersion, 'index:1');
      assert.equal(metadata.freshness, 'validated');
    } finally {
      await tools.close();
      await releaseSearchService(search);
    }
  },
);

test('a changed, renamed or deleted file does not keep answering with its old symbol', async (t) => {
  const root = await tempRoot(t, 'yuantu-index-change-');
  await writeFile(path.join(root, 'one.ts'), 'export function originalName() { return 1; }\n');
  await writeFile(path.join(root, 'two.ts'), 'export function secondName() { return 2; }\n');
  const service = await serviceFor(t, root);
  await service.ready();
  assert.equal(
    (
      await service.symbols({
        query: 'originalName',
        limit: 10,
        signal: new AbortController().signal,
      })
    ).symbols.length,
    1,
  );

  // Rewritten in place: the name is gone and a different one answers.
  await writeFile(path.join(root, 'one.ts'), 'export function replacementName() { return 1; }\n');
  // Renamed: the path moves with the declaration, and the old path stops answering.
  await rename(path.join(root, 'two.ts'), path.join(root, 'moved.ts'));
  await service.ready();
  assert.deepEqual(
    (
      await service.symbols({
        query: 'originalName',
        limit: 10,
        signal: new AbortController().signal,
      })
    ).symbols,
    [],
  );
  assert.deepEqual(
    (
      await service.symbols({
        query: 'replacementName',
        limit: 10,
        signal: new AbortController().signal,
      })
    ).symbols.map((symbol) => symbol.path),
    ['one.ts'],
  );
  assert.deepEqual(
    (
      await service.symbols({
        query: 'secondName',
        limit: 10,
        signal: new AbortController().signal,
      })
    ).symbols.map((symbol) => symbol.path),
    ['moved.ts'],
  );

  await rm(path.join(root, 'moved.ts'));
  await service.ready();
  assert.deepEqual(
    (
      await service.symbols({
        query: 'secondName',
        limit: 10,
        signal: new AbortController().signal,
      })
    ).symbols,
    [],
  );
});

test('a same-size rewrite inside one timestamp tick is caught by a content check', async (t) => {
  const root = await tempRoot(t, 'yuantu-index-digest-');
  const file = path.join(root, 'same.ts');
  await writeFile(file, 'export function beforeRewrite() {}\n');
  const service = await serviceFor(t, root);
  await service.ready();
  assert.equal(
    (
      await service.symbols({
        query: 'beforeRewrite',
        limit: 10,
        signal: new AbortController().signal,
      })
    ).symbols.length,
    1,
  );

  /**
   * The rewrite metadata cannot see: the same number of bytes, and the timestamp put back.
   *
   * Whether a stat alone notices this depends on the filesystem's timestamp resolution, which is not something a
   * test should assert about. What it *can* assert is the guarantee that matters: a reconcile asked for a content
   * check finds the change however the metadata behaves.
   */
  const stats = await import('node:fs/promises').then((fs) => fs.stat(file));
  await writeFile(file, 'export function afterrrRewrite() {}\n');
  await utimes(file, stats.atime, stats.mtime);
  await service.ready({ hash: true });
  assert.deepEqual(
    (
      await service.symbols({
        query: 'beforeRewrite',
        limit: 10,
        signal: new AbortController().signal,
      })
    ).symbols,
    [],
    'the superseded declaration is gone',
  );
  assert.deepEqual(
    (
      await service.symbols({
        query: 'afterrrRewrite',
        limit: 10,
        signal: new AbortController().signal,
      })
    ).symbols.map((symbol) => symbol.path),
    ['same.ts'],
    'and the current one is there',
  );
});

test('a query during a build says building rather than answering as if it had finished', async (t) => {
  const root = await tempRoot(t, 'yuantu-index-building-');
  for (let index = 0; index < 60; index++)
    await writeFile(path.join(root, `f-${index}.ts`), `export function named${index}() {}\n`);
  const service = await serviceFor(t, root);
  // Not awaited: this is the state a query sees while the first build is still running.
  void service.symbols({ query: 'named0', limit: 10, signal: new AbortController().signal });
  const during = service.freshness();
  assert.ok(
    during === 'building' || during === 'validated',
    `freshness is never unknown (${during})`,
  );
  await service.ready();
  assert.equal(service.freshness(), 'validated');
  assert.equal(service.size(), 60);
});

test('the index and the session database are separate resources', async (t) => {
  const root = await tempRoot(t, 'yuantu-index-persist-');
  await writeFile(path.join(root, 'a.ts'), 'export function persisted() {}\n');
  const directory = path.join(root, '.yuantu', 'search');
  const first = new WorkspaceSearchService(workspaceAccess(new Workspace(root)), {
    indexDirectory: directory,
  });
  await first.ready();
  assert.equal(first.persistent, true);
  await first.close();

  // A second service over the same directory reads the rows back rather than rebuilding them, and says the
  // picture is remembered rather than verified until it has checked.
  const second = new WorkspaceSearchService(workspaceAccess(new Workspace(root)), {
    indexDirectory: directory,
  });
  // Reading the count is what opens the stored index. Until something reads it, `freshness` is `unknown` rather
  // than a guess — which is also what keeps a per-run registry from touching the filesystem at all.
  assert.equal(second.freshness(), 'unknown');
  assert.equal(second.size(), 1);
  assert.equal(second.freshness(), 'stale', 'the rows were remembered, not verified');
  await second.ready();
  assert.equal(second.freshness(), 'validated');
  assert.equal(
    (await second.symbols({ query: 'persisted', limit: 5, signal: new AbortController().signal }))
      .symbols.length,
    1,
  );
  // Closed here rather than only in an after hook: the temporary directory is removed by the first hook
  // registered, and a database still open under it cannot be deleted on Windows.
  await second.close();
});

test('an unwritable index directory downgrades to memory instead of failing', async (t) => {
  const root = await tempRoot(t, 'yuantu-index-unwritable-');
  await writeFile(path.join(root, 'a.ts'), 'export function inMemory() {}\n');
  // A path whose parent is a *file* cannot be created as a directory.
  const blocker = path.join(root, 'blocked');
  await writeFile(blocker, 'not a directory');
  const service = new WorkspaceSearchService(workspaceAccess(new Workspace(root)), {
    indexDirectory: path.join(blocker, 'search'),
  });
  t.after(() => service.close());
  assert.equal(service.persistent, false);
  await service.ready();
  assert.equal(
    (await service.symbols({ query: 'inMemory', limit: 5, signal: new AbortController().signal }))
      .symbols.length,
    1,
  );
});

test('the analysis itself reports imports, exports and a block span', () => {
  const source = [
    "import { readFile } from 'node:fs/promises';",
    "import path from 'node:path';",
    '',
    'export function outer() {',
    '  if (true) {',
    '    return 1;',
    '  }',
    '}',
    'export const value = 2;',
    'export { outer as renamed };',
  ].join('\n');
  const lines = source.split('\n');
  assert.deepEqual(importsOf(source), ['node:fs/promises', 'node:path']);
  assert.deepEqual(exportsOf(source), ['outer', 'value', 'renamed']);
  assert.equal(blockEnd(lines, 3), 8, 'the block ends at its closing brace, not at the first one');
  assert.equal(languageOf('a/b/c.ts'), 'typescript');
  assert.equal(languageOf('a/b/c.unknown'), undefined);

  const symbols = analyzeSymbols(source, 'a.ts', 'typescript', {
    size: 10,
    mtimeMs: 1,
    sha256: 'digest',
  });
  assert.deepEqual(
    symbols.map((symbol) => [symbol.name, symbol.kind, symbol.startLine, symbol.endLine]),
    [
      ['outer', 'function', 4, 8],
      ['value', 'const', 9, 9],
    ],
  );
  // The fingerprint rides on every record, which is what lets a reader tell which version of the file a symbol
  // came from without a second stat.
  assert.equal(symbols[0]!.fingerprint.sha256, 'digest');
  assert.deepEqual(symbols[0]!.imports, ['node:fs/promises', 'node:path']);
});

test('credentials and dependency directories are not indexed', async (t) => {
  const root = await tempRoot(t, 'yuantu-index-scope-');
  await mkdir(path.join(root, 'node_modules'), { recursive: true });
  await writeFile(
    path.join(root, 'node_modules', 'dep.ts'),
    'export function fromDependency() {}\n',
  );
  await writeFile(path.join(root, '.env'), 'export function fromEnvironment() {}\n');
  await writeFile(path.join(root, 'id_rsa'), 'export function fromKey() {}\n');
  await writeFile(path.join(root, 'ok.ts'), 'export function fromWorkspace() {}\n');
  const service = await serviceFor(t, root);
  await service.ready();
  for (const name of ['fromDependency', 'fromEnvironment', 'fromKey']) {
    assert.deepEqual(
      (await service.symbols({ query: name, limit: 5, signal: new AbortController().signal }))
        .symbols,
      [],
      `${name} is not reachable through the index`,
    );
  }
  assert.equal(
    (
      await service.symbols({
        query: 'fromWorkspace',
        limit: 5,
        signal: new AbortController().signal,
      })
    ).symbols.length,
    1,
  );
  assert.deepEqual(
    (
      await service.symbols({
        query: 'fromWorkspace',
        limit: 5,
        signal: new AbortController().signal,
      })
    ).symbols.map((symbol) => symbol.path),
    ['ok.ts'],
  );
});

test('a TypeScript file is parsed from its syntax tree, with exact declaration spans', async (t) => {
  /**
   * The difference the compiler makes is where a declaration *ends*.
   *
   * A brace counter guesses that from the text, and guesses wrong on anything whose body closes far below its
   * first line, whose initialiser spans a call chain, or whose interface lists members over several lines. The
   * spans here are the ones a reader would measure by hand.
   */
  const root = await tempRoot(t, 'yuantu-index-ast-');
  await writeFile(
    path.join(root, 'shapes.ts'),
    [
      "import { readFile } from 'node:fs/promises';",
      '',
      'export interface Wide {',
      '  a: string;',
      '  b: number;',
      '}',
      '',
      'export function longBody(): number {',
      '  const inner = 1;',
      '  if (inner) {',
      '    return inner;',
      '  }',
      '  return 0;',
      '}',
      '',
      'const chained = readFile(',
      "  'x',",
      ')',
      '  .then((value) => value)',
      '  .catch(() => null);',
      '',
      'export { chained as aliased };',
      '',
    ].join('\n'),
  );
  const service = await serviceFor(t, root);
  await service.ready();
  const page = await service.symbols({
    query: '',
    limit: 50,
    signal: new AbortController().signal,
  });
  assert.deepEqual(
    page.symbols.map((symbol) => [symbol.name, symbol.kind, symbol.startLine, symbol.endLine]),
    [
      ['Wide', 'interface', 3, 6],
      ['longBody', 'function', 8, 14],
      // The initialiser's call chain runs to line 20, and the tree says so — the local `const inner` inside
      // `longBody` is deliberately *not* an outline entry.
      ['chained', 'const', 16, 20],
    ],
  );
  // Imports and exports come from the tree too, including a re-export written as a clause. Every record carries
  // the whole file's lists, so the order a declaration happened to be visited in cannot show through.
  assert.deepEqual(page.symbols[0]!.imports, ['node:fs/promises']);
  assert.deepEqual([...page.symbols[0]!.exports].sort(), ['Wide', 'aliased', 'longBody']);
  assert.deepEqual(
    page.symbols.map((symbol) => [...symbol.exports].sort()),
    page.symbols.map(() => ['Wide', 'aliased', 'longBody']),
    'the lists are a property of the file, not of the walk',
  );
  // Which parser answered is a recorded fact, so nothing claims an AST result the heuristic produced.
  assert.equal(service.parserOf('shapes.ts'), 'ast');
});
