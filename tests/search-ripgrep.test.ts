/**
 * The fast backend: what it is allowed to run, and what it does when it cannot finish.
 *
 * Two halves, and the second is the one that matters. The first pins the trust rules — a program is used only
 * when a checked-in digest matches the bytes on disk, it is never found on `PATH`, and a path inside the
 * workspace is refused even when it would hash correctly. The second pins the failure behaviour on a *fake*
 * backend that speaks the same JSONL: a batch that exits in error, an event too large to buffer, an event naming
 * a file the tool never asked about, and a cancellation. None of them may produce a result that looks complete.
 *
 * The fake is a program rather than a mock on purpose. Everything between the arguments and the coverage comes
 * from a real child process with real pipes, which is exactly the layer a mock would have replaced with its own
 * assumptions.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  binaryName,
  loadSearchAssetLock,
  platformArchKey,
  resolveSearchBinary,
  type SearchAssetLock,
} from '../packages/search/ripgrep-assets.ts';
import {
  ripgrepArgv,
  runRipgrep,
  type ManagedSearchChild,
  type ManagedSearchProcess,
} from '../packages/search/ripgrep.ts';
import { scanText, searchOptions } from '../packages/search/text.ts';
import { createTools } from '../packages/catalog/index.ts';
import {
  type Coverage,
  type FileEntry,
  type SearchPage,
  type WorkspaceAccess,
} from '../packages/search/types.ts';
import { tempRoot } from './temp-fixture.ts';

const digest = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex');

async function tempDir(t: test.TestContext, prefix: string): Promise<string> {
  const directory = await tempRoot(t, prefix);
  return directory;
}

function access(root: string): WorkspaceAccess {
  return {
    root,
    resolve: async (relative) => path.join(root, relative),
    isExcluded: () => false,
  };
}

function entry(root: string, name: string, size: number): FileEntry {
  return {
    path: name,
    absolutePath: path.join(root, name),
    fingerprint: { size, mtimeMs: 1, sha256: null },
  };
}

async function* listed(files: readonly FileEntry[]): AsyncGenerator<FileEntry> {
  for (const file of files) yield file;
}

/** The program the fake backend "is": `/rg`-compatible JSONL, driven by an environment variable. */
const FAKE_RG = `
const fs = require('node:fs');
const args = process.argv.slice(2);
const separator = args.indexOf('--');
const pattern = args[separator + 1];
const files = args.slice(separator + 2);
const mode = process.env.FAKE_RG_MODE || 'ok';
if (mode === 'crash') { process.stderr.write('boom\\n'); process.exit(3); }
const events = [];
for (const file of files) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
  const lines = text.split(/\\r?\\n/);
  for (let index = 0; index < lines.length; index++) {
    if (!lines[index].includes(pattern)) continue;
    events.push({ type: 'match', data: {
      path: mode === 'external' ? { text: '/etc/passwd' } : { text: file },
      lines: mode === 'base64' ? { bytes: Buffer.from(lines[index]).toString('base64') } : { text: lines[index] + '\\n' },
      line_number: index + 1,
    } });
  }
}
events.push({ type: 'summary', data: { stats: { searches: files.length } } });
if (mode === 'partial') {
  if (events.length > 1) process.stdout.write(JSON.stringify(events[0]) + '\\n');
  process.exit(2);
}
for (const event of events) process.stdout.write(JSON.stringify(event) + '\\n');
// Exit only after the oversized event is flushed: on POSIX a piped stdout is asynchronous, and process.exit()
// would drop most of the 3 MiB before the parser could see it exceed its bound.
if (mode === 'oversized')
  process.stdout.write('x'.repeat(3 * 1024 * 1024), () => process.exit(events.length > 1 ? 0 : 1));
else process.exit(events.length > 1 ? 0 : 1);
`;

/** A real child process, started the way the tool layer would start one. */
function fakeProcesses(script: string): ManagedSearchProcess {
  return {
    async start(_executable, argv, signal): Promise<ManagedSearchChild> {
      return spawnManaged(process.execPath, [script, ...argv], signal);
    },
  };
}

test('ripgrep stops admitting files when the total byte budget is spent', async (t) => {
  const root = await tempDir(t, 'yuantu-rg-byte-budget-');
  const script = path.join(root, 'fake-rg.cjs');
  await writeFile(script, FAKE_RG);
  for (const name of ['a.txt', 'b.txt']) await writeFile(path.join(root, name), 'needle\n');
  const options = { ...searchOptions({ query: 'needle' }), maxScanBytes: 7 };
  const page = await runRipgrep({
    executable: 'unused',
    processes: fakeProcesses(script),
    files: [entry(root, 'a.txt', 7), entry(root, 'b.txt', 7)],
    options,
  });
  assert.deepEqual(
    page.matches.map((match) => match.path),
    ['a.txt'],
  );
  assert.equal(page.coverage.filesScanned, 1);
  assert.equal(page.coverage.complete, false);
  assert.ok(page.coverage.reasons.includes('byte-limit'));
});

/**
 * The verified binary itself, started without a sandbox.
 *
 * The tool layer runs it through the execution environment, which is the right place for a policy decision and
 * the wrong place for a parser test: what is under test here is whether the JSONL this program emits is read the
 * same way the built-in scanner reads the same files. The sandboxed path is exercised through the tool below.
 */
function directProcesses(): ManagedSearchProcess {
  return {
    async start(executable, argv, signal): Promise<ManagedSearchChild> {
      return spawnManaged(executable, argv, signal);
    },
  };
}

function spawnManaged(
  executable: string,
  argv: readonly string[],
  signal: AbortSignal,
): ManagedSearchChild {
  const child = spawn(executable, argv, { stdio: ['ignore', 'pipe', 'pipe'] });
  let stopping: Promise<void> | undefined;
  const stop = (): Promise<void> =>
    (stopping ??= new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      child.once('close', () => resolve());
      child.kill();
    }));
  signal.addEventListener('abort', () => void stop(), { once: true });
  return {
    child,
    stop,
    close: async () => {
      await stop();
    },
  };
}

test('the checked-in lock file pins no fabricated digest', async () => {
  const lock = await loadSearchAssetLock();
  // The lock is either a real pin, or it is explicitly unprepared. What it may never be is a digest that was
  // written down without being verified, which is why an empty target map is a supported state.
  if (lock && lock.version !== 'unprepared')
    for (const [key, target] of Object.entries(lock.targets))
      assert.match(target.archiveSha256, /^[0-9a-f]{64}$/, `${key} carries a real archive digest`);
  else assert.deepEqual(lock?.targets ?? {}, {});
});

test('an unprepared lock yields no binary, and the built-in scanner is the answer', async (t) => {
  const root = await tempDir(t, 'yuantu-rg-unprepared-');
  const resolved = await resolveSearchBinary({
    workspaceRoot: root,
    lock: { version: 'unprepared', targets: {} },
  });
  assert.equal(resolved, null);
  const missing = await resolveSearchBinary({
    workspaceRoot: root,
    lock: { version: '1.0.0', targets: {} },
  });
  assert.equal(missing, null, 'a version with no entry for this platform has no asset');
});

test('a binary inside the workspace is refused even when its digest matches', async (t) => {
  const root = await tempDir(t, 'yuantu-rg-workspace-');
  // The shape of the attack: a repository the model can write to supplies the program the search tool runs.
  const directory = path.join(root, 'vendor', 'rg');
  await mkdir(directory, { recursive: true });
  const binary = path.join(directory, binaryName());
  await writeFile(binary, 'not really ripgrep');
  const lock: SearchAssetLock = {
    version: '1.0.0',
    targets: {
      [platformArchKey()]: {
        url: 'https://example.invalid/rg.tar.gz',
        archiveSha256: digest('archive'),
        binarySha256: digest('not really ripgrep'),
        licenseSha256: digest('license'),
      },
    },
  };
  assert.equal(await resolveSearchBinary({ workspaceRoot: root, lock, directory }), null);
});

test('a digest mismatch is refused, and a matching digest resolves', async (t) => {
  const workspace = await tempDir(t, 'yuantu-rg-workspace-');
  const directory = await tempDir(t, 'yuantu-rg-assets-');
  const binary = path.join(directory, binaryName());
  await writeFile(binary, 'genuine bytes');
  const target = {
    url: 'https://example.invalid/rg.tar.gz',
    archiveSha256: digest('archive'),
    binarySha256: digest('genuine bytes'),
    licenseSha256: digest('license'),
  };
  const lock: SearchAssetLock = { version: '1.0.0', targets: { [platformArchKey()]: target } };

  assert.equal(
    await resolveSearchBinary({
      workspaceRoot: workspace,
      lock,
      directory,
    }).then((found) => found?.sha256),
    digest('genuine bytes'),
    'a verified asset outside the workspace is the one that is allowed',
  );

  await writeFile(binary, 'tampered bytes');
  assert.equal(await resolveSearchBinary({ workspaceRoot: workspace, lock, directory }), null);
});

test('the argument vector is fixed, and the query reaches the program behind a separator', () => {
  const options = searchOptions({ query: '--looks-like-a-flag', mode: 'literal' });
  const argv = ripgrepArgv(options, [entry('C:/ws', 'a.ts', 1)]);
  assert.deepEqual(argv.slice(0, 7), [
    '--json',
    '--no-config',
    '--no-ignore',
    '--no-ignore-dot',
    '--hidden',
    '--fixed-strings',
    '--case-sensitive',
  ]);
  // The pattern is a positional after `--`, so a query that begins with a dash is a pattern and never an option.
  const separator = argv.indexOf('--');
  assert.equal(argv[separator + 1], '--looks-like-a-flag');
  assert.equal(argv[separator + 2], path.join('C:/ws', 'a.ts'));
});

test('the two backends agree, match for match, on the same fixture', async (t) => {
  const root = await tempDir(t, 'yuantu-rg-agree-');
  const script = path.join(root, 'fake-rg.cjs');
  await writeFile(script, FAKE_RG);
  const files = ['a.txt', 'b.txt', 'c.txt'];
  for (const file of files) await writeFile(path.join(root, file), 'the needle here\nplain\n');
  const entries = files.map((file) => entry(root, file, 20));
  const options = searchOptions({ query: 'needle' });

  const builtin = await scanText(access(root), listed(entries), options);
  const fast = await runRipgrep({
    executable: process.execPath,
    processes: fakeProcesses(script),
    files: entries,
    options,
    fallback: (remaining) => scanText(access(root), listed(remaining), options),
  });
  assert.deepEqual(fast.matches, builtin.matches);
  assert.equal(fast.coverage.complete, builtin.coverage.complete);
  assert.equal(fast.coverage.filesScanned, 3);
  // ripgrep cannot report the bytes it read, so the honest answer is null rather than a size estimate.
  assert.equal(fast.coverage.bytesRead, null);
  assert.equal(fast.outputTruncated, false);
});

/**
 * The packaged layout: the only one where the fast path is actually shipped.
 *
 * Every asset test above runs with this module where a checkout keeps it, so `buildRoot()` is `<repo>/build` and
 * both the lock and the binary are found there. That says nothing about the application. In a package the module
 * sits under `resources/app/dist/packages/search`, `buildRoot()` resolves to `resources/app/dist/build` — a
 * directory no package contains — and both files have to come from `process.resourcesPath` instead. The lock and
 * the binary are looked up by two separate code paths, so only a test that builds the packaged shape makes them
 * meet; a staging script that forgets the lock, or a runtime that never looks beside its own resources, fails
 * here instead of in a release that silently ships a program it never runs.
 *
 * The layout is produced by the real staging script, and read by a copy of the real module, so this is the
 * pipeline under test rather than a description of it.
 */
test('a packaged layout reaches its verified binary through resourcesPath alone', async (t) => {
  const key = platformArchKey();
  const repoLock = await loadSearchAssetLock();
  const target = repoLock?.targets[key];
  if (!repoLock || repoLock.version === 'unprepared' || !target) {
    t.diagnostic(`no asset is pinned for ${key}; the packaged layout cannot be staged here`);
    return;
  }

  const stage = await tempDir(t, 'yuantu-rg-packaged-');
  const assets = path.join(stage, 'search-assets');
  const staging = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL('../scripts/copy-search-assets.mjs', import.meta.url)),
      `--platform=${process.platform}`,
      `--arch=${process.arch}`,
      `--out=${assets}`,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(staging.status, 0, staging.stderr);
  if (existsSync(path.join(assets, 'unavailable.json'))) {
    t.diagnostic(`the pinned ${key} asset has not been prepared on this machine`);
    return;
  }

  const binary = path.join(assets, repoLock.version, key, binaryName());
  assert.ok(existsSync(binary), `the staging script placed ${binary}`);
  assert.ok(
    existsSync(path.join(assets, 'search-assets.lock.json')),
    'the lock has to be staged beside the binary, or a packaged runtime cannot verify it',
  );

  // The module as the package would carry it, with nothing above it that could answer for `build`.
  const app = path.join(stage, 'app', 'dist', 'packages', 'search');
  await mkdir(app, { recursive: true });
  await writeFile(path.join(stage, 'app', 'package.json'), '{"type":"module"}\n');
  const module = path.join(app, 'ripgrep-assets.ts');
  await copyFile(
    fileURLToPath(new URL('../packages/search/ripgrep-assets.ts', import.meta.url)),
    module,
  );
  assert.equal(
    existsSync(path.join(stage, 'app', 'dist', 'build')),
    false,
    'the point of the fixture is that no build directory exists inside the package',
  );

  /**
   * `resourcesPath` is the only route left to either file, which is what makes the assertions below evidence
   * about the packaged path rather than about the checkout the test happens to run in.
   */
  const previous = (process as { resourcesPath?: string }).resourcesPath;
  (process as { resourcesPath?: string }).resourcesPath = stage;
  t.after(() => {
    if (previous === undefined) delete (process as { resourcesPath?: string }).resourcesPath;
    else (process as { resourcesPath?: string }).resourcesPath = previous;
  });

  const packaged = (await import(
    pathToFileURL(module).href
  )) as typeof import('../packages/search/ripgrep-assets.ts');
  /**
   * The candidate list is asserted, not assumed: the second entry is the compiled-layout path and the assertion
   * above already proved no such directory exists, so a lock read successfully can only have come from the
   * staged resources.
   */
  assert.deepEqual(packaged.lockFiles(), [
    path.join(stage, 'search-assets', 'search-assets.lock.json'),
    path.join(stage, 'app', 'dist', 'build', 'search-assets.lock.json'),
  ]);
  assert.deepEqual(await packaged.loadSearchAssetLock(), repoLock);
  // What the lookup used to read, and nothing else: this is the null that made the packaged fast path dead code.
  assert.equal(
    await packaged.loadSearchAssetLock(
      path.join(stage, 'app', 'dist', 'build', 'search-assets.lock.json'),
    ),
    null,
  );
  const workspace = await tempDir(t, 'yuantu-rg-packaged-workspace-');
  const resolved = await packaged.resolveSearchBinary({ workspaceRoot: workspace });
  assert.ok(resolved, 'a packaged layout resolves the binary it ships');
  assert.equal(resolved.sha256, target.binarySha256);
  assert.equal(resolved.version, repoLock.version);
  assert.ok(
    resolved.executable.startsWith(stage),
    `resolved inside the package rather than the checkout: ${resolved.executable}`,
  );
});

/**
 * The real thing, when this checkout has a verified asset.
 *
 * The fake backend above proves the protocol; this proves the *program*. It runs the pinned, digest-checked
 * ripgrep against the built-in scanner on one fixture and requires the two to agree item for item — the check a
 * second engine is worth having only if it passes. Without a prepared asset the test reports a diagnostic and
 * skips rather than passing quietly, so "ripgrep works here" is never a claim nobody made.
 */
test('the verified ripgrep asset agrees with the built-in scanner, item for item', async (t) => {
  const root = await tempDir(t, 'yuantu-rg-real-');
  const binary = await resolveSearchBinary({ workspaceRoot: root });
  if (!binary) {
    t.diagnostic(
      'no verified ripgrep asset for this platform; run scripts/prepare-search-assets.mjs',
    );
    return;
  }
  assert.match(binary.sha256, /^[0-9a-f]{64}$/);

  // A fixture with the shapes the two engines could disagree about: a metacharacter-filled literal, a
  // non-ASCII line, a path with spaces, a line with a trailing carriage return, and a binary file.
  const files: Record<string, string> = {
    'a+b[0].txt': 'a+b[0] needle here\nplain\n',
    'unicode.txt': '中文needle 与 emoji 😀\n',
    'spaced name.txt': 'the needle here\n',
    'crlf.txt': 'first\r\nneedle after crlf\r\n',
  };
  for (const [name, content] of Object.entries(files))
    await writeFile(path.join(root, name), content);
  await writeFile(
    path.join(root, 'blob.bin'),
    Buffer.concat([Buffer.from('ne\0edle'), Buffer.alloc(8)]),
  );
  const entries = Object.keys(files).map((name, index) => entry(root, name, index + 1));
  entries.push(entry(root, 'blob.bin', 16));
  const options = searchOptions({ query: 'needle', maxResults: 50 });

  const builtin = await scanText(access(root), listed(entries), options);
  const fast = await runRipgrep({
    executable: binary.executable,
    processes: directProcesses(),
    files: entries,
    options,
    // A fallback that fails loudly would hide a disagreement; this one is the built-in scanner, so a batch the
    // real program could not answer is still answered the same way the product does.
    fallback: (remaining) => scanText(access(root), listed(remaining), options),
  });
  assert.deepEqual(
    fast.matches,
    builtin.matches,
    'the two engines must not disagree about one fixture',
  );
  assert.ok(
    fast.matches.length >= 4,
    `the fixture has hits in every text file (${fast.matches.length})`,
  );
  assert.equal(
    fast.matches.some((match) => match.path === 'blob.bin'),
    false,
    'binary stays skipped',
  );
  assert.equal(fast.coverage.complete, true);
  assert.equal(
    fast.coverage.bytesRead,
    null,
    'the fast backend reports no byte count rather than an estimate',
  );

  // And the same query through the tool, which is what a model actually reaches.
  const tools = createTools(root);
  try {
    const result = await tools.execute(
      { id: 'search', name: 'search_files', arguments: { query: 'needle', max_results: 50 } },
      { signal: new AbortController().signal, approve: async () => true },
    );
    assert.equal(result.isError, false, result.content);
    const value = result.output!.value as { matches: { path: string; line: number }[] };
    assert.deepEqual(
      value.matches.map((match) => `${match.path}:${String(match.line)}`).sort(),
      builtin.matches.map((match) => `${match.path}:${String(match.line)}`).sort(),
    );
  } finally {
    await tools.close();
  }
});

test('a batch that ends in error hands its files to the built-in scanner instead of reporting a result', async (t) => {
  const root = await tempDir(t, 'yuantu-rg-error-');
  const script = path.join(root, 'fake-rg.cjs');
  await writeFile(script, FAKE_RG);
  await writeFile(path.join(root, 'a.txt'), 'the needle here\n');
  const entries = [entry(root, 'a.txt', 16)];
  const options = searchOptions({ query: 'needle' });
  const previous = process.env.FAKE_RG_MODE;
  process.env.FAKE_RG_MODE = 'crash';
  t.after(() => {
    if (previous === undefined) delete process.env.FAKE_RG_MODE;
    else process.env.FAKE_RG_MODE = previous;
  });

  const page = await runRipgrep({
    executable: process.execPath,
    processes: fakeProcesses(script),
    files: entries,
    options,
    fallback: (remaining, coverage) => fallbackPage(root, remaining, options, coverage),
  });
  // The fallback found the match, and the failure is still visible in the coverage: a backend that died must
  // not look like a backend that finished and found nothing more.
  assert.deepEqual(
    page.matches.map((match) => match.path),
    ['a.txt'],
  );
  assert.equal(page.coverage.complete, false);
  assert.ok(page.coverage.reasons.includes('read-error'));
});

test('a partial batch is de-duplicated against the fallback rather than reported twice', async (t) => {
  const root = await tempDir(t, 'yuantu-rg-partial-');
  const script = path.join(root, 'fake-rg.cjs');
  await writeFile(script, FAKE_RG);
  await writeFile(path.join(root, 'a.txt'), 'the needle here\n');
  const entries = [entry(root, 'a.txt', 16)];
  const options = searchOptions({ query: 'needle' });
  const previous = process.env.FAKE_RG_MODE;
  process.env.FAKE_RG_MODE = 'partial';
  t.after(() => {
    if (previous === undefined) delete process.env.FAKE_RG_MODE;
    else process.env.FAKE_RG_MODE = previous;
  });
  const page = await runRipgrep({
    executable: process.execPath,
    processes: fakeProcesses(script),
    files: entries,
    options,
    fallback: (remaining, coverage) => fallbackPage(root, remaining, options, coverage),
  });
  assert.equal(page.matches.length, 1, 'one line, one row, whichever backend reported it');
  assert.equal(page.coverage.complete, false);
});

test('an event larger than the buffer gives up on the fast path instead of buffering it', async (t) => {
  const root = await tempDir(t, 'yuantu-rg-oversized-');
  const script = path.join(root, 'fake-rg.cjs');
  await writeFile(script, FAKE_RG);
  await writeFile(path.join(root, 'a.txt'), 'the needle here\n');
  const entries = [entry(root, 'a.txt', 16)];
  const options = searchOptions({ query: 'needle' });
  const previous = process.env.FAKE_RG_MODE;
  process.env.FAKE_RG_MODE = 'oversized';
  t.after(() => {
    if (previous === undefined) delete process.env.FAKE_RG_MODE;
    else process.env.FAKE_RG_MODE = previous;
  });
  const page = await runRipgrep({
    executable: process.execPath,
    processes: fakeProcesses(script),
    files: entries,
    options,
    fallback: (remaining, coverage) => fallbackPage(root, remaining, options, coverage),
  });
  assert.ok(page.coverage.reasons.includes('line-limit'));
  assert.equal(page.coverage.complete, false);
  // The fallback still answers for the file, so the result is complete in content and incomplete in provenance.
  assert.deepEqual(
    page.matches.map((match) => match.line),
    [1],
  );
});

test('an event naming a file the tool never asked about is ignored', async (t) => {
  const root = await tempDir(t, 'yuantu-rg-external-');
  const script = path.join(root, 'fake-rg.cjs');
  await writeFile(script, FAKE_RG);
  await writeFile(path.join(root, 'a.txt'), 'the needle here\n');
  const entries = [entry(root, 'a.txt', 16)];
  const options = searchOptions({ query: 'needle' });
  const previous = process.env.FAKE_RG_MODE;
  process.env.FAKE_RG_MODE = 'external';
  t.after(() => {
    if (previous === undefined) delete process.env.FAKE_RG_MODE;
    else process.env.FAKE_RG_MODE = previous;
  });
  const page = await runRipgrep({
    executable: process.execPath,
    processes: fakeProcesses(script),
    files: entries,
    options,
  });
  // The backend does not get to widen the scope the tool was given, so a path outside the batch is not a result.
  assert.deepEqual(page.matches, []);
});

test('a non-UTF-8 event field is skipped rather than decoded into invented text', async (t) => {
  const root = await tempDir(t, 'yuantu-rg-base64-');
  const script = path.join(root, 'fake-rg.cjs');
  await writeFile(script, FAKE_RG);
  await writeFile(path.join(root, 'a.txt'), 'the needle here\n');
  const entries = [entry(root, 'a.txt', 16)];
  const options = searchOptions({ query: 'needle' });
  const previous = process.env.FAKE_RG_MODE;
  process.env.FAKE_RG_MODE = 'base64';
  t.after(() => {
    if (previous === undefined) delete process.env.FAKE_RG_MODE;
    else process.env.FAKE_RG_MODE = previous;
  });
  const page = await runRipgrep({
    executable: process.execPath,
    processes: fakeProcesses(script),
    files: entries,
    options,
  });
  assert.deepEqual(page.matches, [], 'the built-in scanner skips those files as binary too');
});

test('an aborted search rejects with the caller’s reason and leaves no child behind', async (t) => {
  const root = await tempDir(t, 'yuantu-rg-cancel-');
  const script = path.join(root, 'fake-rg.cjs');
  await writeFile(script, FAKE_RG);
  await writeFile(path.join(root, 'a.txt'), 'the needle here\n');
  const options = searchOptions({
    query: 'needle',
    signal: AbortSignal.abort(new Error('cancelled by the test')),
  });
  await assert.rejects(
    runRipgrep({
      executable: process.execPath,
      processes: fakeProcesses(script),
      files: [entry(root, 'a.txt', 16)],
      options,
    }),
    /cancelled by the test/,
  );
});

test('an unavailable backend is not consulted, and the built-in scanner answers instead', async (t) => {
  const root = await tempDir(t, 'yuantu-rg-fallback-');
  await writeFile(path.join(root, 'a.txt'), 'the needle here\n');
  const options = searchOptions({ query: 'needle' });
  // What `runRipgrep` is given when the very first batch cannot start: no matches, a failure, and a fallback
  // that owns the whole list. Nothing about the result may suggest the fast path ran.
  const processes: ManagedSearchProcess = {
    async start() {
      throw new Error('the sandbox refused to start a process');
    },
  };
  const page = await runRipgrep({
    executable: 'unused',
    processes,
    files: [entry(root, 'a.txt', 16)],
    options,
    fallback: (remaining, coverage) => fallbackPage(root, remaining, options, coverage),
  });
  assert.deepEqual(
    page.matches.map((match) => match.path),
    ['a.txt'],
  );
  assert.equal(page.coverage.complete, false);
  assert.ok(page.coverage.reasons.includes('read-error'));
});

/** The built-in scanner, as the tool layer supplies it. */
async function fallbackPage(
  root: string,
  files: readonly FileEntry[],
  options: ReturnType<typeof searchOptions>,
  _coverage: Coverage,
): Promise<SearchPage> {
  return scanText(access(root), listed(files), options);
}
