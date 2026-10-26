import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scanI18n, withoutComments } from '../scripts/i18n-gate.mjs';
import { projectRoot } from './process-fixture.ts';
import { tempRoot } from './temp-fixture.ts';

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
  const root = await tempRoot(t, 'yuantu-i18n-missing-');
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

/**
 * The kernel is the process no dictionary reaches, which is how `R1-core-4` happened: both gates passed while
 * `packages/core` produced Chinese a person reads. The rule there is a list of decisions rather than the interface
 * rule, because not every string in the kernel is copy — so what has to hold is that an *unrecorded* one is
 * reported, a recorded one is not, and the list cannot go stale in silence.
 */
test('an unrecorded Chinese string in the kernel is reported, and a recorded one is not', async (t) => {
  const root = await tree({
    // The file the recorded entries actually name: a decision is about a file, so putting the same string in
    // another module and calling it approved would prove nothing.
    'packages/core/agent.ts': [
      // Real characters, not `\uXXXX` escapes: the gate scans the source *text*, so an escape sequence is ASCII and
      // would leave the rule unexercised — the mistake the first version of this test made.
      //
      // The shape of the two the assessment found: fallback copy a person reads, produced where no dictionary in
      // that process can translate it. Recorded by hand in CORE_ALLOWED, with its reason saying the choice of
      // language is still open rather than settled.
      "throw new Error('当前连接未启用图片输入，请选择支持视觉的模型。');",
      "export const probe = '这是未登记的中文';",
      '// 中文注释不是文案',
      'export const clean = "Ready";',
      '',
    ].join('\n'),
  });
  t.after(() => rm(root, { recursive: true, force: true }));
  const problems = await scanI18n(root);
  // Exactly one line of this file is reported: the recorded refusal on line 1 is silent, the unrecorded string on
  // line 2 is not, and the comment is not text. The other entries are stale here — this tree has no session-title
  // or task-spec module — and that is asserted separately below.
  const kernel = problems.filter((problem) => problem.startsWith('packages/core/agent.ts:'));
  assert.equal(kernel.length, 1);
  assert.match(kernel[0]!, /^packages\/core\/agent\.ts:2: Chinese text produced by the kernel/);
});

/**
 * A decision vouches for the text it matches, not for the line that text happens to sit on.
 *
 * The rule used to be "some recorded entry matched this line", so a recorded prompt sheltered anything written
 * beside it: appending to the same literal, or adding a second string after it, kept the gate silent. Both are
 * text no decision covers. The first line below is the control — the recorded prompt alone has to stay silent, or
 * the rule would be "no Chinese in the kernel" rather than "no unexamined Chinese".
 */
test('a recorded kernel string does not shelter unrecorded text on the same line', async (t) => {
  const root = await tree({
    'packages/core/agent.ts': [
      // The recorded refusal alone on its line. Real characters, not `\uXXXX`: the scan reads source text.
      "throw new Error('当前连接未启用图片输入，请选择支持视觉的模型。');",
      // The same literal with unrecorded Chinese appended inside the one string.
      "throw new Error('当前连接未启用图片输入，请选择支持视觉的模型。这是未登记的补充说明');",
      // A second string on the same line, which a line-level match used to shelter.
      "const mixed = '当前连接未启用图片输入，请选择支持视觉的模型。' + '以及后来新增的文案';",
      '',
    ].join('\n'),
  });
  t.after(() => rm(root, { recursive: true, force: true }));
  const kernel = (await scanI18n(root)).filter((problem) =>
    problem.startsWith('packages/core/agent.ts:'),
  );
  assert.equal(kernel.length, 2, kernel.join('\n'));
  assert.match(kernel[0]!, /^packages\/core\/agent\.ts:2: Chinese text produced by the kernel/);
  assert.match(kernel[1]!, /^packages\/core\/agent\.ts:3: Chinese text produced by the kernel/);
  // The wording says the decision still stands for the text it matches, so the reader knows to extend the line's
  // text rather than doubt the entry.
  assert.match(kernel[0]!, /covers only the text it matches/);
});

test('a kernel decision that matches nothing is reported, so the list cannot go stale', async (t) => {
  const root = await tree({ 'packages/core/empty.ts': 'export const nothing = 1;\n' });
  t.after(() => rm(root, { recursive: true, force: true }));
  const problems = await scanI18n(root);
  // Every problem here is a recorded decision that matched nothing, because this tree's one kernel module holds no
  // Chinese at all. Nothing is reported as unrecorded text, and each decision names the module it was made about —
  // which is the whole check: the string it vouched for is gone, so whatever replaced it is unexamined rather than
  // implicitly approved.
  assert.ok(problems.length > 0);
  for (const problem of problems)
    assert.match(
      problem,
      /^scripts\/i18n-gate\.mjs: the CORE_ALLOWED entry for packages\/(?:core|protocol)\/.* matches nothing/,
    );
  // Named by module rather than counted, so this case does not need the list itself imported and cannot pass by
  // agreeing with a number the test and the gate both read from the same wrong place.
  // The task-draft defaults live in protocol now, beside the validator that stores them.
  for (const file of ['core/agent.ts', 'core/session-title.ts', 'protocol/task-spec.ts'])
    assert.ok(
      problems.some((problem) => problem.includes(`the CORE_ALLOWED entry for packages/${file} `)),
      `no decision reported for ${file}`,
    );
});

test('a tree with no kernel is not asked about the kernel decisions', async (t) => {
  // A fixture that builds three modules to test the carrier rule has no `packages/core`, and ten unmatched
  // decisions there would bury the thing the fixture is about.
  const root = await tree({ 'packages/carrier/service.ts': 'export const status = "Ready";\n' });
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.deepEqual(await scanI18n(root), []);
});

test('shared carrier modules cannot introduce untranslated copy, including nested modules', async (t) => {
  const root = await tree({
    'packages/carrier/service.ts': "throw new Error('连接断开');\n",
    'packages/carrier/nested/status.ts': "export const status = '正在恢复';\n",
    'packages/carrier/comments.ts': '// 中文注释\nexport const status = "Ready";\n',
  });
  t.after(() => rm(root, { recursive: true, force: true }));
  const problems = await scanI18n(root);
  assert.equal(problems.length, 2);
  assert.ok(problems.some((problem) => problem.startsWith('packages/carrier/service.ts:1:')));
  assert.ok(problems.some((problem) => problem.startsWith('packages/carrier/nested/status.ts:1:')));
});

/**
 * The React UI is the first interface directory written after the gate existed.
 *
 * `.tsx` holds copy in element text and in attributes, so a scan that only reads `.ts` would let the whole new
 * layer ship Chinese into an English interface. The two cases below are the mechanism and the exception: JSX text
 * and attribute values are copy and are reported, while a JSX comment is a comment.
 */
test('a .tsx module is scanned for copy like every other interface module', async (t) => {
  const root = await tree({
    'apps/desktop/ui/panel.tsx':
      'export function Panel() {\n  return <button aria-label="搜索会话">新建会话</button>;\n}\n',
  });
  t.after(() => rm(root, { recursive: true, force: true }));
  const problems = await scanI18n(root);
  assert.equal(problems.length, 1);
  assert.match(problems[0]!, /^apps\/desktop\/ui\/panel\.tsx:2: Chinese text/);
});

test('a JSX comment is a comment, not copy', async (t) => {
  const root = await tree({
    'apps/desktop/ui/panel.tsx':
      'export function Panel() {\n  return <div>{/* 这是注释，不是文案 */}</div>;\n}\n',
  });
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.deepEqual(await scanI18n(root), []);
});
