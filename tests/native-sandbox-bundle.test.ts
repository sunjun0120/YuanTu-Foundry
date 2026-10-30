import test from 'node:test';
import assert from 'node:assert/strict';
import { build, type BuildOptions } from 'esbuild';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import { tempRoot } from './temp-fixture.ts';
import { translate } from '../apps/desktop/i18n.ts';

const { commonJsModuleUrl } = await import(
  new URL('../scripts/commonjs-module-url.mjs', import.meta.url).href
);

async function bundleTo(options: BuildOptions) {
  const result = await build({ ...options, write: false });
  for (const output of result.outputFiles ?? []) {
    await mkdir(path.dirname(output.path), { recursive: true });
    await writeFile(output.path, output.contents);
  }
  return result;
}

for (const [format, relative] of [
  ['esm', 'dist/packages/tools/host.bundle.mjs'],
  ['esm', 'dist/packages/sandbox/account.mjs'],
  ['cjs', 'dist/desktop/account.cjs'],
] as const) {
  test(
    `${relative} reads the sandbox helper from a clean packaged layout`,
    { skip: process.platform !== 'win32' && 'Windows account backend needs Windows' },
    async (t) => {
      const root = await tempRoot(t, 'yuantu-helper-layout-');
      const assets = path.join(root, 'dist/packages/sandbox/windows-sandbox');
      await mkdir(assets, { recursive: true });
      // Replace only the external helper invocation with a read of its real resolved path.
      // No account initialization, ACL changes or machine-wide sandbox state are involved.
      await writeFile(
        path.join(assets, 'yuantu-sandbox.exe'),
        JSON.stringify({
          version: 1,
          ready: true,
          problems: [],
          details: [],
          accounts: [
            { account: 'offline', sid: 'S-1-5-21-1-2-3-1001' },
            { account: 'online', sid: 'S-1-5-21-1-2-3-1002' },
          ],
          group: 'S-1-5-21-1-2-3-1003',
          readRoots: [],
        }),
      );
      const entry = path.join(root, relative);
      await bundleTo({
        stdin: {
          contents: `import { readFile } from 'node:fs/promises';
            import { configureAccountBackend, windowsAccountSandboxProvider } from './packages/sandbox/sandbox-account.ts';
            configureAccountBackend({ run: helper => readFile(helper, 'utf8') });
            void windowsAccountSandboxProvider.available().then(result => console.log(JSON.stringify(result)));`,
          resolveDir: process.cwd(),
          sourcefile: 'helper-layout-entry.ts',
          loader: 'ts',
        },
        outfile: entry,
        bundle: true,
        platform: 'node',
        format,
        target: 'node24',
        ...(format === 'cjs' ? commonJsModuleUrl : {}),
        logLevel: 'silent',
      });
      const { stdout } = await promisify(execFile)(process.execPath, [entry], { cwd: tmpdir() });
      assert.equal(JSON.parse(stdout), null, 'the packaged helper must answer the readiness check');
    },
  );
}

test('CommonJS desktop bundle loads native providers and their packaged helper', async (t) => {
  const root = await tempRoot(t, 'yuantu-native-bundle-');
  const desktop = path.join(root, 'dist/desktop');
  const assets = path.join(root, 'dist/packages/sandbox/windows-sandbox');
  await mkdir(desktop, { recursive: true });
  await mkdir(assets, { recursive: true });
  await copyFile('packages/sandbox/windows-sandbox/acl.ps1', path.join(assets, 'acl.ps1'));
  const result = await build({
    stdin: {
      contents: `import { sandboxProviders, checkSandboxAvailability } from './packages/sandbox/sandbox.ts'; console.log(JSON.stringify(sandboxProviders().map(p => p.mode))); void checkSandboxAvailability('host').then(answer => console.log(answer));`,
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
  assert.deepEqual(JSON.parse(firstLine), ['host', 'windows-account', 'seatbelt', 'native']);
  assert.match(stdout, /null/);
  assert.deepEqual(
    result.warnings,
    [],
    'desktop bundles must preserve module URLs without warnings',
  );
});

test('CommonJS desktop regex search loads its packaged worker from another cwd', async (t) => {
  const root = await tempRoot(t, 'yuantu-search #%-');
  const desktop = path.join(root, 'dist/desktop');
  const assets = path.join(root, 'dist/packages/sandbox/windows-sandbox');
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
    ['I', 'i', 'İ', 'ı', translate('general.languageZh', 'zh-CN'), 'a+b[0]', 'S', 'ſ'].join('\n') +
      '\n',
  );
  await copyFile('packages/sandbox/windows-sandbox/acl.ps1', path.join(assets, 'acl.ps1'));
  /**
   * Keep esbuild from writing into the temporary fixture directly; the test process writes its in-memory output so
   * the regression runs consistently even when the esbuild executable has restricted filesystem integrity labels.
   */
  await bundleTo({
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
  const queries = [
    'I',
    'i',
    'İ',
    'ı',
    translate('general.languageZh', 'zh-CN'),
    'a+b[0]',
    'S',
    'ſ',
  ];
  const plan = queries.flatMap((query) =>
    ['insensitive', 'sensitive'].map((caseMode) => ({
      query,
      case: caseMode,
      pattern: escape(query),
    })),
  );
  const result = await bundleTo({
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
