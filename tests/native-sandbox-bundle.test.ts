import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runInNewContext } from 'node:vm';

const { commonJsModuleUrl } = await import(
  new URL('../scripts/commonjs-module-url.mjs', import.meta.url).href
);

test('CommonJS desktop bundle loads native providers and their packaged helper', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-native-bundle-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const desktop = path.join(root, 'dist/desktop');
  const assets = path.join(root, 'dist/packages/tools/windows-sandbox');
  await mkdir(desktop, { recursive: true });
  await mkdir(assets, { recursive: true });
  await copyFile('packages/tools/windows-sandbox/acl.ps1', path.join(assets, 'acl.ps1'));
  const result = await build({
    stdin: {
      contents: `import { sandboxProviders, checkSandboxAvailability } from './packages/tools/sandbox.ts'; console.log(JSON.stringify(sandboxProviders().map(p => p.mode))); void checkSandboxAvailability('host').then(answer => console.log(answer));`,
      resolveDir: process.cwd(),
      sourcefile: 'native-bundle-entry.ts',
      loader: 'ts',
    },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    ...commonJsModuleUrl,
    write: false,
    logLevel: 'silent',
  });
  const entry = path.join(desktop, 'probe.cjs');
  const output = result.outputFiles?.[0];
  assert.ok(output, 'bundler produced an executable');
  await writeFile(entry, output.contents);
  const { stdout } = await promisify(execFile)(process.execPath, [entry]);
  const firstLine = stdout.split('\n')[0];
  assert.ok(firstLine);
  assert.deepEqual(JSON.parse(firstLine), ['host', 'windows', 'seatbelt', 'native']);
  assert.match(stdout, /null/);
  assert.deepEqual(
    result.warnings,
    [],
    'desktop bundles must preserve module URLs without warnings',
  );
});

test('CommonJS desktop regex search loads its packaged worker from another cwd', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-search #%-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const desktop = path.join(root, 'dist/desktop');
  const assets = path.join(root, 'dist/packages/tools/windows-sandbox');
  const workspace = path.join(root, 'workspace');
  await mkdir(desktop, { recursive: true });
  await mkdir(assets, { recursive: true });
  await mkdir(workspace);
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ type: 'module' }));
  await writeFile(path.join(workspace, 'match.txt'), 'alpha 123\nother\n');
  /**
   * The same case fixture the source regression uses, one case per line.
   *
   * `literal` runs in the desktop bundle while `regex` runs in the packaged worker, so this is where the two
   * matching strategies are compared across the bundle boundary rather than inside one process.
   */
  await writeFile(
    path.join(workspace, 'locale.txt'),
    ['I', 'i', 'İ', 'ı', '中文', 'a+b[0]', 'S', 'ſ'].join('\n') + '\n',
  );
  await copyFile('packages/tools/windows-sandbox/acl.ps1', path.join(assets, 'acl.ps1'));
  await build({
    entryPoints: ['packages/tools/search-worker.ts'],
    outfile: path.join(root, 'dist/packages/tools/search-worker.js'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    logLevel: 'silent',
  });
  const entry = path.join(desktop, 'search.cjs');
  /**
   * The plan is computed here, not in the fixture, so the escape rule under test is written once and in the
   * open. The fixture only runs each query both ways and reports what each mode matched.
   */
  const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const queries = ['I', 'i', 'İ', 'ı', '中文', 'a+b[0]', 'S', 'ſ'];
  const plan = queries.flatMap((query) =>
    ['insensitive', 'sensitive'].map((caseMode) => ({
      query,
      case: caseMode,
      pattern: escape(query),
    })),
  );
  const result = await build({
    stdin: {
      contents: `import { fileTools } from './packages/tools/files.ts';
        const plan = JSON.parse(process.argv[3]);
        const search = fileTools(process.argv[2]).find(tool => tool.name === 'search_files');
        const context = { signal: new AbortController().signal, approve: async () => true };
        const pick = (result) => ({ isError: result.isError, lines: (result.output?.value?.matches ?? []).map(match => match.line) });
        void (async () => {
          const answers = [];
          for (const item of plan) {
            const literal = await search.execute({ query: item.query, mode: 'literal', case: item.case, include: ['locale.txt'] }, context);
            const regex = await search.execute({ query: item.pattern, mode: 'regex', case: item.case, include: ['locale.txt'] }, context);
            answers.push([item.query, item.case, pick(literal), pick(regex)]);
          }
          const regex = await search.execute({ query: '^alpha [0-9]+$', mode: 'regex' }, context);
          console.log(JSON.stringify({ regex, answers }));
        })().catch(error => { console.error(error); process.exitCode = 1; });`,
      resolveDir: process.cwd(),
      sourcefile: 'search-bundle-entry.ts',
      loader: 'ts',
    },
    outfile: entry,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    ...commonJsModuleUrl,
    logLevel: 'silent',
  });
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [entry, workspace, JSON.stringify(plan)],
    {
      cwd: tmpdir(),
    },
  );
  const answer = JSON.parse(stdout);
  assert.equal(answer.regex.isError, false);
  assert.match(answer.regex.content, /match\.txt:1: alpha 123/);
  assert.equal(answer.answers.length, plan.length, 'every planned query ran both ways');
  for (const [query, caseMode, literal, regex] of answer.answers) {
    assert.equal(literal.isError, false, `${query}/${caseMode}: literal failed`);
    assert.equal(regex.isError, false, `${query}/${caseMode}: regex failed`);
    assert.deepEqual(
      literal.lines,
      regex.lines,
      `packaged literal and escaped regex disagree for ${JSON.stringify(query)} (${caseMode})`,
    );
  }
  /**
   * The characters the source regression names, asserted in the packaged pair too: `İ` lowercases to `i` plus a
   * combining dot, so the old locale-folding literal counted it as a hit for `i` while the worker's `i` flag —
   * and therefore `regex` mode — did not. Both bundles answer [1, 2] now.
   */
  const insensitiveI = answer.answers.find(
    ([query, caseMode]: [string, string]) => query === 'i' && caseMode === 'insensitive',
  );
  assert.ok(insensitiveI, 'the `i` insensitive plan entry must be present');
  assert.deepEqual(insensitiveI[2].lines, [1, 2]);
  assert.deepEqual(insensitiveI[3].lines, [1, 2]);
  assert.deepEqual(result.warnings, [], 'bundled search must not erase module URLs');
});

test('CommonJS module URL shim does not load Node builtins while preload initializes', () => {
  let requireCalls = 0;
  runInNewContext(commonJsModuleUrl.banner.js, {
    require() {
      requireCalls++;
      throw new Error('Node builtin unavailable in sandboxed preload');
    },
  });
  assert.equal(requireCalls, 0);
});
