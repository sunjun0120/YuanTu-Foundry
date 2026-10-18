/**
 * What a search result says about the part of the workspace it did not read.
 *
 * The regression this pins is behavioural, not cosmetic. A workspace with more files than the walk's budget held
 * a file the caller had named explicitly by `include`, and the search answered "no matches" with
 * `limited: false` — a statement about the workspace made by a scan that had stopped inside it. Two separate
 * faults produced it: the budget was spent before the filters were applied, and nothing in the result said the
 * scan had stopped at all.
 *
 * So every test here asks the same question in a different shape: can this result be mistaken for a complete
 * answer? The fixtures are built rather than borrowed, so the counts are exact — a thousand qualifying files is
 * a thousand, and the one that decides `file-limit` is the thousand-and-first.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createTools } from '../packages/catalog/index.ts';
import { Workspace } from '../packages/tools/files.ts';
import {
  LEGACY_MAX_ENTRIES,
  LEGACY_MAX_FILES,
  collectInventory,
  compileGlob,
  globPrefix,
  iterateInventory,
  mayContainMatch,
} from '../packages/search/inventory.ts';
import { scanText, searchOptions } from '../packages/search/text.ts';
import { WorkspaceSearchService } from '../packages/search/service.ts';
import { workspaceAccess } from '../packages/tools/files.ts';
import {
  emptyCoverage,
  type Coverage,
  type FileEntry,
  type WorkspaceAccess,
} from '../packages/search/types.ts';
import { toolCardModel } from '../apps/desktop/tool-card-model.ts';
import type { ToolContext } from '../packages/protocol/index.ts';

test('backend preparation and enumeration cannot grant a search a fresh time budget', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-search-deadline-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'target.ts'), 'TARGET\n');
  const service = new WorkspaceSearchService(workspaceAccess(new Workspace(root)), {
    indexDirectory: null,
  });
  let backendCalls = 0;
  try {
    const page = await service.search(
      searchOptions({ query: 'TARGET', timeoutMs: 10 }),
      {
        name: 'ripgrep',
        available: async () => {
          await new Promise((resolve) => setTimeout(resolve, 30));
          return true;
        },
        search: async () => {
          backendCalls++;
          return {
            matches: [],
            coverage: emptyCoverage(),
            outputTruncated: false,
            nextCursor: null,
            sourceVersion: null,
          };
        },
      },
      context(),
    );
    assert.equal(backendCalls, 0, 'do not start a process after its request budget expired');
    assert.equal(page.coverage.complete, false);
    assert.ok(page.coverage.reasons.includes('time-limit'));
  } finally {
    await service.close();
  }
});

test('a backend fallback keeps the enumeration coverage it was given', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-search-fallback-coverage-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'target.ts'), 'TARGET\n');
  const access = workspaceAccess(new Workspace(root));
  const service = new WorkspaceSearchService(access, { indexDirectory: null });
  const inventory = await collectInventory(access, {
    path: '.',
    include: [],
    exclude: [],
    maxEntries: 1_000,
    maxFiles: null,
    timeoutMs: 1_000,
    signal: new AbortController().signal,
  });
  const incomplete: Coverage = {
    ...emptyCoverage(),
    complete: false,
    reasons: ['entry-limit'],
    entriesVisited: 200_000,
    filesConsidered: 1,
  };
  // The backend fails to prepare its execution environment. The service already enumerated these files, and
  // that enumeration said the list was incomplete.
  (service as unknown as { inventory: () => Promise<unknown> }).inventory = async () => ({
    files: inventory.files,
    coverage: incomplete,
  });
  try {
    const page = await service.search(
      searchOptions({ query: 'TARGET' }),
      {
        name: 'ripgrep',
        available: async () => true,
        search: async (input) => input.fallback(input.files, input.inventory()),
      },
      context(),
    );
    assert.deepEqual(
      page.matches.map((hit) => hit.path),
      ['target.ts'],
    );
    assert.equal(
      page.coverage.complete,
      false,
      'a partial enumeration must not become a complete scan',
    );
    assert.deepEqual(page.coverage.reasons, ['entry-limit']);
    assert.equal(page.coverage.entriesVisited, 200_000);
  } finally {
    await service.close();
  }
});

test('service search honours a declared include scope instead of scanning unrelated files', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-search-scope-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'a-unrelated.txt'), 'TARGET\n');
  await writeFile(path.join(root, 'b-target.ts'), 'TARGET\n');
  const service = new WorkspaceSearchService(workspaceAccess(new Workspace(root)), {
    indexDirectory: null,
  });
  try {
    const page = await service.search(searchOptions({ query: 'TARGET' }), undefined, undefined, {
      include: ['b-target.ts'],
    });
    assert.deepEqual(
      page.matches.map((hit) => hit.path),
      ['b-target.ts'],
    );
    assert.equal(page.coverage.filesConsidered, 1);
    assert.equal(page.coverage.complete, true);
  } finally {
    await service.close();
  }
});

/**
 * This suite is about the *built-in* scanner’s accounting — real bytes read, files read to EOF, the reason a
 * scan stopped — so it pins the engine rather than accepting whichever backend this machine happens to have a
 * verified asset for. The fast backend is exercised where it belongs: tests/search-ripgrep.test.ts runs it
 * against the built-in scanner on the same fixture and requires the two to agree match for match.
 */
test('a subdirectory or file scope keeps workspace-relative results and include filters', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-search-path-scope-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'src'));
  await writeFile(path.join(root, 'src', 'target.ts'), 'TARGET\n');
  await writeFile(path.join(root, 'src', 'other.ts'), 'TARGET\n');
  const service = new WorkspaceSearchService(workspaceAccess(new Workspace(root)), {
    indexDirectory: null,
  });
  try {
    for (const scopedPath of ['src', 'src/target.ts']) {
      const page = await service.search(searchOptions({ query: 'TARGET' }), undefined, undefined, {
        path: scopedPath,
        include: ['src/target.ts'],
      });
      assert.deepEqual(
        page.matches.map((hit) => hit.path),
        ['src/target.ts'],
      );
      assert.equal(page.coverage.filesConsidered, 1);
      assert.equal(page.coverage.complete, true);
    }
    const stream = iterateInventory(workspaceAccess(new Workspace(root)), {
      path: 'src/target.ts',
      include: [],
      exclude: [],
      maxEntries: 10,
      maxFiles: null,
      timeoutMs: 5_000,
      signal: new AbortController().signal,
    });
    for await (const file of stream) {
      assert.equal(file.path, 'src/target.ts');
      break;
    }
    assert.equal(
      stream.coverage().complete,
      false,
      'an early consumer stop is still partial coverage',
    );
  } finally {
    await service.close();
  }
});

process.env.YUANTU_SEARCH_RG = '0';

const context = (): ToolContext => ({
  signal: new AbortController().signal,
  approve: async () => true,
});

/** A tree of `count` filler files carrying one marker file, named so the walk order is unambiguous. */
async function filledTree(
  root: string,
  count: number,
  options: { marker?: string } = {},
): Promise<void> {
  for (let index = 0; index < count; index++) {
    const directory = path.join(root, `module-${String(Math.floor(index / 50)).padStart(3, '0')}`);
    await mkdir(directory, { recursive: true });
    await writeFile(
      path.join(directory, `file-${String(index).padStart(4, '0')}.ts`),
      'export const filler = 1;\n',
    );
  }
  if (options.marker) await writeFile(path.join(root, options.marker), 'the needle\n');
  else await writeFile(path.join(root, 'zz-marker.ts'), 'the needle\n');
}

test('a file named by include is found even when the tree is larger than the walk budget', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-coverage-include-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  // 1005 filler files before the target, which is more candidates than the legacy budget holds.
  await filledTree(root, 1005, { marker: 'z-target.ts' });
  await writeFile(path.join(root, 'z-target.ts'), 'const marker = "NEEDLE-IN-TARGET";\n');

  const tools = createTools(root);
  const result = await tools.execute(
    { id: 'search', name: 'search_files', arguments: { query: 'NEEDLE-IN-TARGET' } },
    context(),
  );
  assert.equal(result.isError, false, result.content);
  const payload = result.output!.value as { matches: { path: string }[] };
  assert.deepEqual(
    payload.matches.map((match) => match.path),
    ['z-target.ts'],
  );
  await tools.close();
});

test('rejected files do not consume the candidate budget, but they are still visited entries', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-coverage-order-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await filledTree(root, 1200, { marker: 'z-target.ts' });
  await writeFile(path.join(root, 'z-target.ts'), 'the needle\n');
  const workspace = new Workspace(root);
  const access: WorkspaceAccess = {
    root: workspace.root,
    resolve: (relative, allowSpill) => workspace.resolve(relative, false, allowSpill),
    isExcluded: () => false,
  };
  const { files, coverage } = await collectInventory(access, {
    path: '.',
    // A leading wildcard, so the pattern prunes nothing and every file is genuinely visited and then rejected.
    // The narrower pattern is covered by its own test, where pruning is the point.
    include: ['*.ts'],
    exclude: [],
    maxEntries: LEGACY_MAX_ENTRIES,
    maxFiles: LEGACY_MAX_FILES,
    timeoutMs: 5_000,
    signal: new AbortController().signal,
  });
  // The 1201 rejected files spent entries — the work was really done — and none of the candidate budget.
  assert.deepEqual(
    files.map((file) => file.path),
    ['z-target.ts'],
  );
  assert.equal(coverage.filesConsidered, 1);
  assert.ok(
    coverage.entriesVisited > 1000,
    `every rejected file was still visited (${coverage.entriesVisited})`,
  );
  assert.equal(coverage.complete, true, 'the enumeration reached the end of the tree');
});

test('a provably irrelevant directory is not even listed, and the result says so by staying complete', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-coverage-pruned-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await filledTree(root, 1200, { marker: 'z-target.ts' });
  const workspace = new Workspace(root);
  const access: WorkspaceAccess = {
    root: workspace.root,
    resolve: (relative, allowSpill) => workspace.resolve(relative, false, allowSpill),
    isExcluded: () => false,
  };
  const { files, coverage } = await collectInventory(access, {
    path: '.',
    include: ['z-target.ts'],
    exclude: [],
    maxEntries: LEGACY_MAX_ENTRIES,
    maxFiles: LEGACY_MAX_FILES,
    timeoutMs: 5_000,
    signal: new AbortController().signal,
  });
  assert.deepEqual(
    files.map((file) => file.path),
    ['z-target.ts'],
  );
  // Pruning is only ever done when the pattern cannot match inside the directory, so the enumeration still
  // reached every file the request could have matched — and "complete" is a claim about that scope, not about
  // how many directories were opened.
  assert.equal(coverage.complete, true);
  assert.ok(coverage.entriesVisited < 100, `only the root was listed (${coverage.entriesVisited})`);
});

test('a tree larger than the candidate budget reports an incomplete scan instead of a result', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-coverage-limit-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await filledTree(root, 1005, { marker: 'z-target.ts' });
  const workspace = new Workspace(root);
  const access: WorkspaceAccess = {
    root: workspace.root,
    resolve: (relative, allowSpill) => workspace.resolve(relative, false, allowSpill),
    isExcluded: () => false,
  };
  const options = {
    path: '.',
    include: [],
    exclude: [],
    maxEntries: LEGACY_MAX_ENTRIES,
    maxFiles: LEGACY_MAX_FILES,
    timeoutMs: 5_000,
    signal: new AbortController().signal,
  };
  const { files, coverage } = await collectInventory(access, options);
  assert.equal(files.length, LEGACY_MAX_FILES);
  assert.equal(coverage.complete, false);
  assert.deepEqual(coverage.reasons, ['file-limit']);

  // The same enumeration with no candidate cap reaches everywhere, which is what "complete" is claiming.
  const whole = await collectInventory(access, { ...options, maxFiles: null });
  assert.equal(whole.files.length, 1006);
  assert.equal(whole.coverage.complete, true);
  assert.deepEqual(whole.coverage.reasons, []);
});

test('a search whose zero matches came from a cut scan never says the scope has no such text', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-coverage-zero-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await filledTree(root, 1005);
  const tools = createTools(root);
  const result = await tools.execute(
    { id: 'search', name: 'search_files', arguments: { query: 'NOT-ANYWHERE-AT-ALL' } },
    context(),
  );
  assert.equal(result.isError, false, result.content);
  const payload = result.output!.value as {
    limited: boolean;
    matches: unknown[];
    coverage: { complete: boolean; reasons: string[] };
  };
  assert.deepEqual(payload.matches, []);
  await tools.close();
  // Under a loaded machine the scan's own clock can cut it; that is an honest incomplete answer, and the one
  // thing it must not do is the thing this test is about — claim the scope has no such text.
  if (!payload.coverage.complete) {
    assert.deepEqual(payload.coverage.reasons, ['time-limit']);
    assert.notEqual(result.content, 'No matches in the requested scope.');
    return;
  }
  // Nothing was cut here — the tree is enumerated to the end — so this really is a complete zero.
  assert.equal(payload.limited, false);
  assert.equal(result.content, 'No matches in the requested scope.');
});

test('the entry budget is recorded as its own reason, separately from the candidate budget', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-coverage-entries-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (let index = 0; index < 20; index++)
    await writeFile(path.join(root, `file-${index}.ts`), 'export const x = 1;\n');
  const workspace = new Workspace(root);
  const { coverage } = await workspace.walkWithCoverage('.', context(), {
    maxEntries: 3,
    maxFiles: LEGACY_MAX_FILES,
  });
  assert.equal(coverage.complete, false);
  assert.deepEqual(coverage.reasons, ['entry-limit']);
  assert.equal(coverage.entriesVisited, 3);
});

test('an unreadable file makes the scan incomplete rather than silently empty', async () => {
  const missing: FileEntry = {
    path: 'gone.txt',
    absolutePath: path.join(tmpdir(), 'yuantu-does-not-exist', 'gone.txt'),
    fingerprint: { size: 1, mtimeMs: 1, sha256: null },
  };
  const access: WorkspaceAccess = {
    root: tmpdir(),
    resolve: async (relative) => path.join(tmpdir(), relative),
    isExcluded: () => false,
  };
  const page = await scanText(access, listed([missing]), searchOptions({ query: 'anything' }));
  assert.deepEqual(page.matches, []);
  assert.equal(page.coverage.unreadableFiles, 1);
  assert.equal(page.coverage.complete, false);
  assert.ok(page.coverage.reasons.includes('read-error'));
  // The count of what was considered is kept even though the file could not be read: "we looked and failed"
  // is not the same as "there was nothing there".
  assert.equal(page.coverage.filesScanned, 0);
});

test('a planned file list carries no enumeration claim it cannot support', async () => {
  const access: WorkspaceAccess = {
    root: tmpdir(),
    resolve: async (relative) => path.join(tmpdir(), relative),
    isExcluded: () => false,
  };
  const page = await scanText(access, listed([]), searchOptions({ query: 'x' }));
  assert.equal(page.coverage.complete, true);
  assert.equal(page.coverage.entriesVisited, 0);
  assert.equal(page.coverage.bytesRead, 0);
});

test('the coverage a search reports is a complete, closed payload', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-coverage-payload-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'a.txt'), 'alpha\n');
  const tools = createTools(root);
  const result = await tools.execute(
    { id: 'search', name: 'search_files', arguments: { query: 'alpha' } },
    context(),
  );
  const value = result.output!.value as Record<string, unknown>;
  assert.deepEqual(Object.keys(value).sort(), [
    'coverage',
    'limited',
    'matches',
    'mode',
    'nextCursor',
    'outputTruncated',
    'query',
    'sourceVersion',
  ]);
  const coverage = value.coverage as Record<string, unknown>;
  assert.deepEqual(Object.keys(coverage).sort(), [
    'bytesRead',
    'complete',
    'entriesVisited',
    'filesConsidered',
    'filesScanned',
    'partialFiles',
    'reasons',
    'unreadableFiles',
  ]);
  assert.equal(coverage.filesScanned, 1);
  assert.equal(coverage.bytesRead, 6);
  await tools.close();
});

test('a result written before coverage existed still draws a card, and says the scope is unrecorded', () => {
  const legacy = toolCardModel({
    render: 'search-results',
    value: {
      query: 'needle',
      mode: 'literal',
      matches: [{ path: 'a.txt', line: 1, text: 'needle' }],
      limited: false,
    },
  });
  assert.ok(legacy && legacy.kind === 'search-results');
  // Absent, not defaulted to complete: a log that never recorded its coverage must not be rendered as one.
  assert.equal(legacy.coverage, undefined);
  assert.equal(legacy.limited, false);

  const current = toolCardModel({
    render: 'search-results',
    value: {
      query: 'needle',
      mode: 'literal',
      matches: [],
      limited: true,
      coverage: {
        complete: false,
        reasons: ['file-limit'],
        entriesVisited: 10,
        filesConsidered: 5,
        filesScanned: 4,
        partialFiles: 0,
        unreadableFiles: 0,
        bytesRead: 100,
      },
      outputTruncated: false,
      nextCursor: null,
      sourceVersion: null,
    },
  });
  assert.ok(current && current.kind === 'search-results');
  assert.deepEqual(current.coverage?.reasons, ['file-limit']);
  assert.equal(current.outputTruncated, false);

  // A present-but-malformed field is a skew, not something to ignore: the whole card falls back to the text.
  assert.equal(
    toolCardModel({
      render: 'search-results',
      value: {
        query: 'needle',
        mode: 'literal',
        matches: [],
        limited: false,
        coverage: { complete: 'yes' },
      },
    }),
    null,
  );
});

test('glob semantics and directory pruning stay exactly as the tool defined them', () => {
  // The dialect, spelled out: `**` crosses separators, `*` and `?` do not.
  assert.equal(compileGlob('src/*.ts').test('src/a.ts'), true);
  assert.equal(compileGlob('src/*.ts').test('src/deep/a.ts'), false);
  assert.equal(compileGlob('**/*.ts').test('src/deep/a.ts'), true);
  assert.equal(compileGlob('a?.ts').test('ab.ts'), true);
  assert.equal(globPrefix('src/*.ts'), 'src/');

  // Pruning is a proof, so the cases that must survive are the interesting ones.
  assert.equal(mayContainMatch(['src/'], 'src'), true);
  assert.equal(
    mayContainMatch(['src/'], 'src/deep'),
    true,
    'a `**` tail is not visible in the prefix',
  );
  assert.equal(mayContainMatch(['src/'], 'other'), false);
  assert.equal(mayContainMatch([''], 'anything'), true, 'a leading wildcard prunes nothing');
  assert.equal(mayContainMatch([], 'anything'), true, 'no include patterns means no pruning');
  assert.equal(mayContainMatch(['src/deep/nested/'], 'src'), true);
  assert.equal(mayContainMatch(['src/deep/nested/'], 'src/other'), false);
});

test('a pruned include search still finds files under the surviving directories', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-coverage-prune-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'src', 'nested'), { recursive: true });
  await mkdir(path.join(root, 'docs'), { recursive: true });
  await writeFile(path.join(root, 'src', 'nested', 'a.ts'), 'the needle\n');
  await writeFile(path.join(root, 'docs', 'b.ts'), 'the needle\n');
  const workspace = new Workspace(root);
  const access: WorkspaceAccess = {
    root: workspace.root,
    resolve: (relative, allowSpill) => workspace.resolve(relative, false, allowSpill),
    isExcluded: () => false,
  };
  const stream = iterateInventory(access, {
    path: '.',
    include: ['src/**'],
    exclude: [],
    maxEntries: LEGACY_MAX_ENTRIES,
    maxFiles: null,
    timeoutMs: 5_000,
    signal: new AbortController().signal,
  });
  const page = await scanText(access, stream, searchOptions({ query: 'needle' }), () =>
    stream.coverage(),
  );
  assert.deepEqual(
    page.matches.map((match) => match.path),
    ['src/nested/a.ts'],
  );
  assert.equal(page.coverage.complete, true);
});

test('an excluded path is never enumerated, whatever the include pattern says', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-coverage-credentials-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'node_modules'));
  await writeFile(path.join(root, 'node_modules', 'dep.ts'), 'the needle\n');
  await writeFile(path.join(root, '.env'), 'the needle\n');
  await writeFile(path.join(root, 'id_rsa'), 'the needle\n');
  await writeFile(path.join(root, 'ok.ts'), 'the needle\n');
  const workspace = new Workspace(root);
  const { files } = await workspace.walkWithCoverage('.', context(), { maxFiles: null });
  assert.deepEqual(
    files.map((file) => file.path),
    ['ok.ts'],
  );
});

test('an empty enumeration is complete, because there was nothing to miss', () => {
  const coverage = emptyCoverage();
  assert.equal(coverage.complete, true);
  assert.deepEqual(coverage.reasons, []);
});

async function* listed(files: readonly FileEntry[]): AsyncGenerator<FileEntry> {
  for (const file of files) yield file;
}
