#!/usr/bin/env node
/**
 * The frozen retrieval benchmark: fixed fixtures, fixed queries, a written-down result.
 *
 * The point of a benchmark is comparability, so everything it varies is a named flag and everything it does not
 * vary is fixed here: the fixture shapes, the query set, and what is measured. It refuses unknown arguments rather
 * than ignoring them, because a typo in `--sizes` would otherwise produce a run that looks like the one the caller
 * meant and numbers that belong to another.
 *
 * Two ways to run one query, and the difference is what makes a before/after possible at all:
 *
 * - `--via=service` drives the search package directly. It is the precise measurement, and it only works in a
 *   checkout that has `packages/search` — that is, after this work.
 * - `--via=tool` drives `createTools` and the `search_files`/`read_file` tools, which every checkout of this
 *   project has. That is the mode a *baseline* is measured in: freeze a worktree at the commit before the change,
 *   run this same file there, and the two reports describe the same queries through the same interface.
 *
 * `baseline` is not a backend this script implements — it is a recorded result from such a run.
 * `--compare=<previous.json>` prints the two side by side, per query, with the deltas that matter: whether the
 * target was found, whether a complete scan claimed zero matches for text that exists, and how long each took.
 */
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

process.env.YUANTU_BUILTIN_SERVICES = '0';

const args = process.argv.slice(2);
const options = {
  out: null,
  sizes: [10_000],
  repeats: 5,
  backends: ['builtin'],
  keep: false,
  via: 'service',
  compare: null,
};
for (const arg of args) {
  if (arg.startsWith('--out=')) options.out = arg.slice('--out='.length);
  else if (arg.startsWith('--sizes='))
    options.sizes = arg
      .slice('--sizes='.length)
      .split(',')
      .map((value) => Number(value));
  else if (arg.startsWith('--repeats=')) options.repeats = Number(arg.slice('--repeats='.length));
  else if (arg.startsWith('--backend='))
    options.backends = arg.slice('--backend='.length).split(',');
  else if (arg.startsWith('--via=')) options.via = arg.slice('--via='.length);
  else if (arg.startsWith('--compare=')) options.compare = arg.slice('--compare='.length);
  else if (arg === '--keep') options.keep = true;
  else throw new Error(`Unsupported argument: ${arg}`);
}
if (!options.out) throw new Error('--out=<new directory> is required');
if (options.via === 'tool' && options.backends.some((backend) => backend !== 'builtin'))
  throw new Error(
    'Tool mode uses the product-selected backend; explicit rg comparisons require --via=service',
  );
if (!Number.isSafeInteger(options.repeats) || options.repeats < 1 || options.repeats > 20)
  throw new Error('--repeats must be a positive integer up to 20');
for (const size of options.sizes)
  if (!Number.isSafeInteger(size) || size < 1) throw new Error(`Invalid --sizes value: ${size}`);
for (const backend of options.backends)
  if (!['baseline', 'builtin', 'ripgrep'].includes(backend))
    throw new Error(`Unknown backend: ${backend}`);
if (options.backends.includes('baseline'))
  throw new Error(
    'baseline is a recorded result, not something this script runs: measure a frozen checkout with `--via=tool`\n' +
      'and compare the two reports with `--compare=<previous.json>`',
  );
if (!['service', 'tool'].includes(options.via))
  throw new Error(`Unknown --via value: ${options.via}`);

/** The frozen query set. Every entry names the fixture it belongs to and what a correct answer looks like. */
export const QUERIES = [
  { id: 'literal-last-file', fixture: 'many', query: 'NEEDLE_IN_LAST_FILE', expectPath: true },
  {
    id: 'include-last-file',
    fixture: 'many',
    // The pattern's leading wildcard is load-bearing twice over: it matches a file inside a shard, and it keeps
    // the directory-pruning rule honest, because a pattern with no literal prefix may not prune any directory.
    query: 'NEEDLE_IN_LAST_FILE',
    include: ['**/zz-last.ts'],
    expectPath: true,
  },
  { id: 'regex-deep', fixture: 'deep', query: 'DEEP_[M]ARKER', mode: 'regex', expectPath: true },
  { id: 'literal-deep', fixture: 'deep', query: 'DEEP_MARKER', expectPath: true },
  {
    id: 'no-such-text',
    fixture: 'many',
    query: 'TEXT_THAT_IS_NOT_THERE_AT_ALL',
    expectPath: false,
  },
];

/** The fixtures every query is measured against. Written once, so both modes see identical bytes. */
async function buildFixture(root, size) {
  const directory = path.join(root, 'files');
  await mkdir(directory, { recursive: true });
  const createdShards = new Set();
  for (let first = 0; first < size; first += 16) {
    const files = Array.from({ length: Math.min(16, size - first) }, (_, offset) => first + offset);
    for (const index of files) {
      const shard = path.join(
        directory,
        `shard-${String(Math.floor(index / 500)).padStart(4, '0')}`,
      );
      if (!createdShards.has(shard)) {
        await mkdir(shard, { recursive: true });
        createdShards.add(shard);
      }
    }
    // Only fixture construction overlaps. Queries remain sequential with their original budgets.
    // Wait for every write even on failure, so cleanup cannot race a still-writing helper.
    const writes = await Promise.allSettled(
      files.map((index) =>
        writeFile(
          path.join(
            directory,
            `shard-${String(Math.floor(index / 500)).padStart(4, '0')}`,
            `f-${String(index).padStart(6, '0')}.txt`,
          ),
          `line one of ${index}\nline two of ${index}\n`,
        ),
      ),
    );
    const failed = writes.find((result) => result.status === 'rejected');
    if (failed) throw failed.reason;
  }
  /**
   * The target lives in the *last* shard, which is the whole point of the fixture.
   *
   * A file at the root is reached among the first few entries however large the tree is, so it would prove
   * nothing. Inside the last shard it sits past the thousand-file budget the old walk stopped at — which is
   * exactly the shape of the reported defect: a file that exists, that a caller even named by `include`, and that
   * a bounded enumeration never reached before the filters were consulted.
   */
  const lastShard = path.join(
    directory,
    `shard-${String(Math.floor((size - 1) / 500)).padStart(4, '0')}`,
  );
  await mkdir(lastShard, { recursive: true });
  await writeFile(
    path.join(lastShard, 'zz-last.ts'),
    'export const marker = "NEEDLE_IN_LAST_FILE";\n',
  );
  // A marker past the old 256000-byte prefix, in a file whose head is uninteresting.
  const deep = Array.from({ length: 70_000 }, (_, index) => `line ${index}`);
  deep.push('DEEP_MARKER');
  await writeFile(path.join(root, 'deep.txt'), `${deep.join('\n')}\n`);
}

/** The file names a query is allowed to count as having found. */
const TARGETS = ['zz-last.ts', 'deep.txt'];

/**
 * One query through the search service.
 *
 * A fresh service per repeat, so the range-instance caches — the line index, the symbol index — cannot make the
 * second repeat a different measurement from the first.
 */
async function measureViaService(root, entry, backendName) {
  const { Workspace, workspaceAccess } = await import('../packages/tools/files.ts');
  const { WorkspaceSearchService } = await import('../packages/search/service.ts');
  const { searchOptions } = await import('../packages/search/text.ts');
  const { createSearchBackend } = await import('../packages/tools/search-backend.ts');
  const { executionPolicy } = await import('../packages/sandbox/execution-policy.ts');
  const service = new WorkspaceSearchService(workspaceAccess(new Workspace(root)), {
    indexDirectory: null,
  });
  try {
    let backendUsed = false;
    let fallbackUsed = false;
    const pinned = backendName === 'ripgrep' ? createSearchBackend(root) : undefined;
    const backend = pinned
      ? {
          ...pinned,
          async search(input, context) {
            backendUsed = true;
            return pinned.search(
              {
                ...input,
                fallback: (...args) => {
                  fallbackUsed = true;
                  return input.fallback(...args);
                },
              },
              context,
            );
          },
        }
      : undefined;
    if (backend && !(await backend.available()))
      throw new Error(
        'The pinned ripgrep asset is unavailable; refusing to mislabel a built-in measurement as rg',
      );
    const context = backend
      ? {
          signal: new AbortController().signal,
          approve: async () => true,
          // Host cannot enforce a read-only process. This opt-in benchmark runs the verified binary
          // against its disposable fixture with the actual host capability, without claiming isolation.
          executionPolicy: executionPolicy('host', {
            files: 'workspace-write',
            network: 'unrestricted',
          }),
        }
      : undefined;
    const started = performance.now();
    const page = await service.search(
      searchOptions({ query: entry.query, mode: entry.mode ?? 'literal', maxResults: 10 }),
      backend,
      context,
      { include: entry.include ?? [] },
    );
    return {
      ms: performance.now() - started,
      page,
      matchingEngine: backendUsed
        ? fallbackUsed
          ? 'ripgrep-with-builtin-fallback'
          : 'ripgrep'
        : 'builtin',
    };
  } finally {
    await service.close();
  }
}

/**
 * One query through the tools, which is what every checkout of this project has.
 *
 * This is the mode a baseline is measured in: the same `createTools` call, the same `search_files` arguments, on
 * a tree that predates `packages/search` entirely.
 */
async function measureViaTool(root, entry) {
  const { createTools } = await import('../packages/catalog/index.ts');
  const tools = createTools(root);
  try {
    const context = { signal: new AbortController().signal, approve: async () => true };
    // A read first, because the fixture's other queries may follow an edit in a real session and the file tools
    // are gated on having looked; it also keeps the two modes' per-query shape comparable.
    await tools.execute(
      { id: 'read', name: 'read_file', arguments: { path: 'zz-last.ts' } },
      context,
    );
    const started = performance.now();
    const result = await tools.execute(
      {
        id: 'search',
        name: 'search_files',
        arguments: {
          query: entry.query,
          ...(entry.mode ? { mode: entry.mode } : {}),
          ...(entry.include ? { include: entry.include } : {}),
          max_results: 10,
        },
      },
      context,
    );
    const ms = performance.now() - started;
    if (result.isError) throw new Error(result.content);
    const value = (result.output && result.output.value) || {};
    return {
      ms,
      page: {
        matches: value.matches ?? [],
        coverage: value.coverage ?? null,
        outputTruncated: value.outputTruncated ?? null,
        // The old payload had no coverage at all, and its `limited: false` was the completeness claim. Recording
        // it is what lets one metric mean the same thing on both sides of the change.
        limited: value.limited ?? false,
      },
    };
  } finally {
    await tools.close();
  }
}

const report = {
  generatedAt: new Date().toISOString(),
  node: process.version,
  platform: process.platform,
  via: options.via,
  runs: [],
};

for (const backend of options.backends) {
  for (const size of options.sizes) {
    const root = await mkdtemp(path.join(tmpdir(), `yuantu-retrieval-${size}-`));
    try {
      await buildFixture(root, size);
      for (const entry of QUERIES) {
        const durations = [];
        const matchingEngines = new Set();
        const repeats = [];
        let last = null;
        for (let repeat = 0; repeat < options.repeats; repeat++) {
          const measured =
            options.via === 'service'
              ? await measureViaService(root, entry, backend)
              : await measureViaTool(root, entry);
          durations.push(measured.ms);
          matchingEngines.add(measured.matchingEngine ?? 'product-selected');
          last = measured.page;
          const foundPaths = new Set(last.matches.map((match) => path.basename(match.path)));
          repeats.push({
            ms: measured.ms,
            matchingEngine: measured.matchingEngine ?? 'product-selected',
            recallAt10: entry.expectPath
              ? TARGETS.some((target) => foundPaths.has(target))
                ? 1
                : 0
              : null,
            falseCompleteZero: Boolean(
              entry.expectPath &&
              last.matches.length === 0 &&
              (last.coverage ? last.coverage.complete : !last.limited),
            ),
            complete: last.coverage?.complete ?? null,
            reasons: last.coverage?.reasons ?? [],
            matches: last.matches.length,
          });
        }
        const sorted = [...durations].sort((left, right) => left - right);
        // By base name: a hit's path is workspace-relative and the fixture's target sits in a shard, so comparing
        // whole paths would score a found file as missed.
        report.runs.push({
          backend,
          matchingEngine: [...matchingEngines].sort().join(','),
          include: entry.include ?? [],
          size,
          query: entry.id,
          // `null` where there is no target to find: a recall of zero for "no such text" would be a category
          // error dressed as a measurement.
          recallAt10: entry.expectPath
            ? repeats.reduce((sum, repeat) => sum + repeat.recallAt10, 0) / repeats.length
            : null,
          repeats,
          /**
           * A zero that claims to be the whole answer for text that is really there.
           *
           * The completeness claim is read from whichever field the checkout has: `coverage.complete` where the
           * payload carries one, and `limited === false` where it predates coverage — which is precisely the old
           * result's claim, and precisely what made a bounded scan's zero indistinguishable from a real one.
           */
          falseCompleteZero: repeats.some((repeat) => repeat.falseCompleteZero),
          medianMs: sorted[Math.floor(sorted.length / 2)],
          rangeMs: [sorted[0], sorted[sorted.length - 1]],
          matches: last.matches.length,
          characters: last.matches.reduce((total, match) => total + match.text.length, 0),
          filesScanned: last.coverage?.filesScanned ?? null,
          bytesRead: last.coverage?.bytesRead ?? null,
          complete: repeats.every((repeat) => repeat.complete === true)
            ? true
            : repeats.some((repeat) => repeat.complete === false)
              ? false
              : null,
          reasons: [...new Set(repeats.flatMap((repeat) => repeat.reasons))],
          memory: {
            rssBytes: process.memoryUsage().rss,
            heapUsedBytes: process.memoryUsage().heapUsed,
            processPeakRssKiB: process.resourceUsage().maxRSS,
            scope:
              'cumulative process high-water mark, including fixture setup and earlier queries; not per-query peak',
          },
        });
      }
    } finally {
      if (!options.keep) await rm(root, { recursive: true, force: true });
    }
  }
}

// The directory is created rather than reusing an existing one: a second run must not overwrite the numbers the
// first one is being compared against.
const directory = path.resolve(options.out);
await mkdir(directory, { recursive: false });
const target = path.join(directory, 'retrieval.json');
await writeFile(target, `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`Wrote ${String(report.runs.length)} measurement(s) to ${target}\n`);
for (const run of report.runs)
  process.stdout.write(
    `${run.backend} ${String(run.size).padStart(6)} ${run.query.padEnd(18)} ` +
      `median=${run.medianMs.toFixed(1)}ms range=[${run.rangeMs.map((value) => value.toFixed(1)).join(', ')}] ` +
      `matches=${run.matches} recall=${run.recallAt10 ?? '-'} falseComplete=${run.falseCompleteZero} ` +
      `complete=${run.complete} reasons=${run.reasons.join('|') || '-'}\n`,
  );

if (options.compare) {
  const previous = JSON.parse(await readFile(path.resolve(options.compare), 'utf8'));
  const key = (run) => `${run.backend}/${String(run.size)}/${run.query}`;
  const before = new Map(previous.runs.map((run) => [key(run), run]));
  process.stdout.write('\nCompared with ' + options.compare + ':\n');
  for (const run of report.runs) {
    const was = before.get(key(run));
    if (!was) {
      process.stdout.write(`  ${key(run)}: not in the previous report\n`);
      continue;
    }
    process.stdout.write(
      `  ${key(run)}: recall ${String(was.recallAt10 ?? '-')} -> ${String(run.recallAt10 ?? '-')}, ` +
        `false-complete ${String(was.falseCompleteZero)} -> ${String(run.falseCompleteZero)}, ` +
        `median ${was.medianMs.toFixed(1)}ms -> ${run.medianMs.toFixed(1)}ms ` +
        `(${run.medianMs >= was.medianMs ? '+' : ''}${(run.medianMs - was.medianMs).toFixed(1)}ms)\n`,
    );
  }
}
