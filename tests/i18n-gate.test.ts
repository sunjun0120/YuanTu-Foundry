import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scanI18n, withoutComments } from '../scripts/i18n-gate.mjs';
import { projectRoot } from './process-fixture.ts';

/**
 * The gate's own coverage is the thing under test.
 *
 * `i18n:check` is a rule about files nobody has written yet, so the only way to know it still holds is to break it
 * on purpose: a Chinese string in a main-process module must be reported *without* anyone remembering to add that
 * module to a list, a comment must not be, and the modules that are legitimately Chinese must stay outside. The
 * first version of the gate named six files, and every module it did not name — `mcp-settings.ts` was one — was
 * covered by nothing at all, so the first case below is that file's shape rather than a hypothetical.
 */
const EXCLUDED = [
  'apps/desktop/renderer.ts',
  'apps/desktop/renderer-tasks.ts',
  'apps/desktop/i18n.ts',
  'apps/desktop/session-management.ts',
  'apps/desktop/attachment-contract.ts',
];
/**
 * A tree with one file per exception, because the exceptions are checked to still match something.
 *
 * That check is what makes a rename loud instead of silent, so a fixture without the excluded files would report
 * the exceptions rather than the thing a case is about.
 */
async function tree(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-i18n-'));
  for (const file of EXCLUDED) await put(root, file, 'export const x = 1;\n');
  for (const [file, source] of Object.entries(files)) await put(root, file, source);
  return root;
}
async function put(root: string, file: string, source: string): Promise<void> {
  await mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await writeFile(path.join(root, file), source, 'utf8');
}

test('a Chinese string in a module nobody listed is reported by position', async (t) => {
  const root = await tree({
    // The shape of the file that motivated the directory scan: it was never in the old list, and this string
    // would have been shown to an English interface unchanged.
    'apps/desktop/mcp-settings.ts': [
      '/**',
      ' * A block comment, which the scan strips — including its newlines, or this report would name line 1.',
      ' */',
      'export class McpSettingsStore {',
      "  private probe = '临时中文';",
      '}',
      '',
    ].join('\n'),
  });
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.deepEqual(await scanI18n(root), [
    'apps/desktop/mcp-settings.ts:5: Chinese text in a module a person reads; move it to apps/desktop/i18n.ts and read it with mainText()',
  ]);
});

test('a comment is not copy, and the renderer and the dictionary are outside the rule', async (t) => {
  const root = await tree({
    'apps/desktop/permission-settings.ts': [
      '// 这是注释，不是文案',
      '/* 多行注释里的中文也不该被报 */',
      'export const label = "Sandbox preset";',
      '',
    ].join('\n'),
  });
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.deepEqual(await scanI18n(root), []);
});

test('a guest worker keeps its own text in English, and a desktop worker does not', async (t) => {
  const root = await tree({
    'packages/tools/code-worker.ts': "const failure = '子进程失败';\n",
    'apps/desktop/attachment-worker.ts': "const failure = '附件读取失败';\n",
  });
  t.after(() => rm(root, { recursive: true, force: true }));
  const problems = await scanI18n(root);
  // The guest worker's words reach the model and a caller's log, so the answer is "English", not "the dictionary";
  // the desktop worker's are read by a person, so it answers to the interface rule instead.
  assert.equal(problems.length, 2);
  assert.match(
    problems[0]!,
    /^apps\/desktop\/attachment-worker\.ts:1: Chinese text in a module a person reads/,
  );
  assert.match(problems[1]!, /^packages\/tools\/code-worker\.ts:1: Chinese text in a guest worker/);
});

test('a content label is exempt inside a scanned file, and does not shelter copy on its own line', async (t) => {
  const root = await tree({
    'apps/desktop/attachment-reader.ts': [
      'const page = `\\u7b2c ${index} \\u9875`;',
      "const sheet = '\\u5de5\\u4f5c\\u8868\\uff1a' + name;",
      // A label and a message on one line: the exemption strips the label and still reports the message.
      "const mixed = '\\u5de5\\u4f5c\\u8868\\uff1a' + '读取失败';",
      '',
    ].join('\n'),
  });
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.deepEqual(await scanI18n(root), [
    'apps/desktop/attachment-reader.ts:3: Chinese text in a module a person reads; move it to apps/desktop/i18n.ts and read it with mainText()',
  ]);
});

test('an exception that matches nothing is reported, so a rename cannot silently drop a module', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-i18n-missing-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await put(root, 'apps/desktop/renderer.ts', 'export const x = 1;\n');
  const problems = await scanI18n(root);
  // Three of the four exceptions matched nothing here, and each one is named: the file it used to cover is now
  // guarded by nobody, which is the state the whole gate is written against.
  assert.equal(problems.length, 3);
  for (const problem of problems)
    assert.match(problem, /^scripts\/i18n-gate\.mjs: the exception .* matches no module/);
});

test('stripping comments preserves the line numbers of everything after them', () => {
  const source = [
    '/*',
    ' * three',
    ' * lines',
    ' */',
    'const after = 1;',
    '// one line',
    'const last = 2;',
  ].join('\n');
  assert.deepEqual(withoutComments(source).split('\n'), [
    '',
    '',
    '',
    '',
    'const after = 1;',
    '',
    'const last = 2;',
  ]);
});

test('the gate passes on this repository', async () => {
  assert.deepEqual(await scanI18n(projectRoot), []);
});
