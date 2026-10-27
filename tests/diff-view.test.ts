/**
 * How a patch is drawn: a *content* line that begins with `+` or `-` is not a file header.
 *
 * The desktop paints a unified diff by looking at the first character of each line. That is one character too
 * few: an added line whose own text starts with `++` renders as `+++i;`, and a removed line of SQL comment
 * renders as `--- keep this comment` — both look exactly like the `+++ b/file` / `--- a/file` headers, so they
 * were drawn as unchanged context in the approval card, which is precisely where a person decides whether to
 * allow a file change. The patches below come from the same `diff` dependency the tools use, so the input is a
 * real patch rather than a hand-shaped string.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createTwoFilesPatch } from 'diff';
import type { FileChange } from '../packages/protocol/index.ts';
import { classifyDiffLine, diffView } from '../apps/desktop/diff-view.ts';

const ORIGINAL = 'SELECT 1;\n-- keep this comment\ntail\n';
const UPDATED = 'SELECT 1;\n++i;\ntail\n';

/** The elements `diffView` builds: create, set `className`/`textContent`, append children. */
class FakeElement {
  readonly tagName: string;
  readonly children: FakeElement[] = [];
  className = '';
  textContent = '';
  open = false;
  constructor(tagName: string) {
    this.tagName = tagName;
  }
  append(...nodes: FakeElement[]): void {
    this.children.push(...nodes);
  }
}
function installDocument(): () => void {
  const globals = globalThis as unknown as Record<string, unknown>;
  const previous = globals.document;
  globals.document = { createElement: (tag: string) => new FakeElement(tag) };
  return () => {
    globals.document = previous;
  };
}
function change(overrides: Partial<FileChange> = {}): FileChange {
  return {
    path: 'f.txt',
    kind: 'edit',
    patch: createTwoFilesPatch('a/f.txt', 'b/f.txt', ORIGINAL, UPDATED),
    added: 1,
    removed: 1,
    truncated: false,
    ...overrides,
  };
}
/** The `<pre>` a rendered change draws, so a row can be found by the exact text it shows. */
function rows(root: unknown): FakeElement[] {
  const details = root as FakeElement;
  const pre = details.children.find((child) => child.tagName === 'pre');
  assert.ok(pre, 'a change with a patch is drawn as a preformatted body');
  return pre.children;
}
function classOf(root: unknown, line: string): string | undefined {
  const row = rows(root).find((candidate) => candidate.textContent === `${line}\n`);
  assert.ok(row, `the patch has a row for ${JSON.stringify(line)}`);
  return row.className;
}

test('added and removed content that looks like a header is not drawn as context', async (t) => {
  const restore = installDocument();
  t.after(restore);
  const rendered = diffView(change());
  assert.equal(classOf(rendered, '+++i;'), 'diff-added');
  assert.equal(classOf(rendered, '--- keep this comment'), 'diff-removed');
  assert.equal(classOf(rendered, '+++ b/f.txt'), 'diff-context');
  assert.equal(classOf(rendered, '--- a/f.txt'), 'diff-context');
  assert.equal(classOf(rendered, '@@ -1,3 +1,3 @@'), 'diff-hunk');
  assert.equal(classOf(rendered, ' SELECT 1;'), 'diff-context');
  assert.equal(classOf(rendered, ' tail'), 'diff-context');
});

test('a truncated change still says so', async (t) => {
  const restore = installDocument();
  t.after(restore);
  const details = diffView(change({ truncated: true })) as unknown as FakeElement;
  assert.ok(
    details.children.some((child) => child.tagName === 'p' && child.className === 'diff-notice'),
    'the truncation notice is not lost while the classes change',
  );
});

test('a batch change draws each child with the same classes', async (t) => {
  const restore = installDocument();
  t.after(restore);
  const details = diffView(
    change({ kind: 'batch', changes: [change()] }),
  ) as unknown as FakeElement;
  const group = details.children.find((child) => child.className === 'file-diff-group');
  assert.ok(group, 'a batch is drawn as a group of child diffs');
  assert.equal(classOf(group.children[0], '+++i;'), 'diff-added');
  assert.equal(classOf(group.children[0], '--- keep this comment'), 'diff-removed');
});

test('a line is classified by its marker, not by its content', () => {
  assert.equal(classifyDiffLine('@@ -1,3 +1,3 @@'), 'diff-hunk');
  assert.equal(classifyDiffLine('+++i;'), 'diff-added');
  assert.equal(classifyDiffLine('++'), 'diff-added');
  assert.equal(classifyDiffLine('---comment'), 'diff-removed');
  assert.equal(classifyDiffLine('--'), 'diff-removed');
  assert.equal(classifyDiffLine('+++ b/f.txt'), 'diff-context');
  assert.equal(classifyDiffLine('--- a/f.txt'), 'diff-context');
  assert.equal(classifyDiffLine(' SELECT 1;'), 'diff-context');
  assert.equal(classifyDiffLine(''), 'diff-context');
  // A header cannot appear inside a hunk, so there every marker line is content. This is what tells a deleted
  // `-- keep this comment` from a header that reads the same by prefix.
  assert.equal(classifyDiffLine('--- keep this comment', true), 'diff-removed');
  assert.equal(classifyDiffLine('+++ x', true), 'diff-added');
  assert.equal(classifyDiffLine('--- a/f.txt', true), 'diff-removed');
  assert.equal(classifyDiffLine('@@ -1 +1 @@', true), 'diff-hunk');
});

test('a non-ASCII file name is shown as the name, not as octal escapes', async (t) => {
  const restore = installDocument();
  t.after(restore);
  // What the `diff` dependency writes for a Chinese name, quoted so the patch stays ASCII.
  const patch = [
    '===================================================================',
    '--- /dev/null',
    '+++ "\\346\\224\\266\\345\\205\\245\\346\\212\\245\\345\\221\\212.docx"',
    '@@ -0,0 +1,1 @@',
    '+hello',
  ].join('\n');
  const rendered = diffView(change({ path: '收入报告.docx', kind: 'create', patch }));
  const lines = rows(rendered).map((row) => row.textContent);
  assert.ok(lines.includes('+++ 收入报告.docx\n'), 'the header carries the readable name');
  assert.ok(!lines.some((line) => line.includes('\\346')), 'no octal escape survives in the view');
  assert.ok(lines.includes('+hello\n'), 'content lines are untouched');
});

test('the approval card draws through the same view', async () => {
  // The approval card moved to React (`Approvals.tsx`); the tool result's own change is rendered onto the transcript
  // from `ui/application.tsx`. Both must keep drawing through `diffView`, or the two accounts of one patch drift
  // apart. The renderer bootstrap no longer builds content at all, so it is not the place to assert this.
  const approvals = await readFile('apps/desktop/ui/conversation/Approvals.tsx', 'utf8');
  assert.match(approvals, /import \{ diffView \} from '\.\.\/\.\.\/diff-view\.ts';/);
  assert.match(approvals, /diffView\(approval\.change, true\)/);
  const application = await readFile('apps/desktop/ui/application.tsx', 'utf8');
  assert.match(application, /import \{ diffView \} from '\.\.\/diff-view\.ts';/);
  assert.match(application, /diffView\(message\.change\)/);
});
