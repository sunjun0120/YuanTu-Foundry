/**
 * Which Markdown destinations the window is allowed to turn into a clickable control.
 *
 * A web link goes through `openExternal`; a workspace-relative path goes through the main-process containment
 * check. Everything else — other schemes, fragments, absolute paths — stays text, so a document cannot smuggle an
 * arbitrary local or remote target into a button.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { safeLocalPath, safeWebUrl } from '../apps/desktop/markdown.ts';

test('workspace-relative file links are recognised', () => {
  assert.equal(safeLocalPath('report.md'), 'report.md');
  assert.equal(safeLocalPath('./out/report.docx'), './out/report.docx');
  assert.equal(safeLocalPath('../outside.md'), '../outside.md');
  assert.equal(safeLocalPath('report.md#intro'), 'report.md');
  assert.equal(safeLocalPath('  report.md  '), 'report.md');
});

test('spaces and percent escapes in a file name stay part of its path', () => {
  assert.equal(safeLocalPath('my file.md'), 'my file.md');
  assert.equal(safeLocalPath('my%20file.md'), 'my file.md');
  assert.equal(
    safeLocalPath('docs/%E6%94%B6%E5%85%A5%20%E6%8A%A5%E5%91%8A.docx'),
    'docs/收入 报告.docx',
  );
  assert.equal(safeLocalPath('report%23v2.md'), 'report#v2.md');
  assert.equal(safeLocalPath('100%25.md'), '100%.md');
  assert.equal(safeLocalPath('100%.md'), '100%.md', 'a bare percent is not an escape');
  assert.equal(safeLocalPath('100%zz.md'), '100%zz.md');
});

test('escaped separators and schemes cannot turn a local link into something else', () => {
  for (const value of ['%2Fetc%2Fpasswd', '%5C%5Cserver%5Cshare', 'javascript%3Aalert(1)', '%00'])
    assert.equal(safeLocalPath(value), null, value);
});

test('schemes, fragments and absolute paths are not workspace file links', () => {
  for (const value of [
    'https://example.com',
    'http://example.com',
    'mailto:someone@example.com',
    'file:///etc/passwd',
    'javascript:alert(1)',
    '#section',
    '/etc/passwd',
    '\\\\server\\share\\file',
    '',
    '   ',
  ])
    assert.equal(safeLocalPath(value), null, value);
});

test('web links keep their own allowlist', () => {
  assert.equal(safeWebUrl('https://example.com/a') !== null, true);
  assert.equal(safeWebUrl('http://example.com') !== null, true);
  assert.equal(safeWebUrl('file:///etc/passwd'), null);
  assert.equal(safeWebUrl('javascript:alert(1)'), null);
});
