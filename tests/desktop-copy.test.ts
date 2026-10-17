import test from 'node:test';
import assert from 'node:assert/strict';
import { setLocale, translate } from '../apps/desktop/i18n.ts';
import { runStatusText, type SessionRunStatus } from '../apps/desktop/renderer-status.ts';
import { conversationMarkdown } from '../apps/desktop/renderer-export.ts';
import {
  attachmentFailureLine,
  attachmentFailureText,
  type AttachmentFailure,
} from '../apps/desktop/renderer-attachment-copy.ts';

/**
 * The renderer's own copy, in the interface's language.
 *
 * These three surfaces are why `desktop-app-1` was invisible to both gates: the renderer is exempt from the source
 * scan on the grounds that the walker translates what it draws, and the walker only translates what the dictionary
 * already contains. The run status line had eleven literals and four of them were absent from the dictionary; the
 * export is a file no walker ever sees; and the attachment refusals were concatenated with a file name, which
 * defeats a whole-string lookup even when the words are registered.
 *
 * `translate` answers with the key it was given when an entry is missing, and a key is ASCII — so "no Chinese in
 * English" alone would pass a lookup that found nothing. Every case below therefore also asserts the answer is a
 * word rather than a key.
 */
const HAN = /\p{Script=Han}/u;
const isKey = (value: string): boolean => /^[a-z][\w]*(\.[\w]+)+$/.test(value);
const STATUSES: readonly SessionRunStatus[] = [
  'idle',
  'running',
  'completed',
  'needs_review',
  'cancelled',
  'limited',
  'failed',
];
const FAILURES: readonly AttachmentFailure[] = [
  'count',
  'vision',
  'imageBytes',
  'imageRead',
  'documentBytes',
];

test('running status distinguishes preparation, model waiting, thinking, text and tools', (t) => {
  t.after(() => setLocale('zh-CN'));
  setLocale('zh-CN');
  const say = (over: Partial<Parameters<typeof runStatusText>[0]>) =>
    runStatusText({
      status: 'running',
      compacting: false,
      approvals: 0,
      ready: true,
      loading: false,
      ...over,
    });
  assert.equal(say({}), '正在准备请求…');
  assert.equal(say({ activity: { kind: 'model' } }), '正在等待模型响应…');
  assert.equal(say({ activity: { kind: 'model', phase: 'reasoning' } }), '正在推理…');
  assert.equal(say({ activity: { kind: 'model', phase: 'text' } }), '正在生成回复…');
  assert.equal(say({ activity: { kind: 'model', phase: 'tool_call' } }), '正在生成工具调用…');
  assert.equal(say({ activity: { kind: 'tool' } }), '正在执行工具…');
  assert.equal(say({ tools: 1 }), '正在执行工具…');
  assert.equal(say({ tools: 1, approvals: 1 }), '等待你的确认');
  setLocale('en-US');
  assert.equal(say({ activity: { kind: 'model' } }), 'Waiting for the model…');
});

test('every run status reads in the interface language', (t) => {
  t.after(() => setLocale('zh-CN'));
  setLocale('en-US');
  for (const status of STATUSES) {
    const english = runStatusText({
      status,
      compacting: false,
      approvals: 0,
      ready: true,
      loading: false,
    });
    assert.doesNotMatch(english, HAN, `${status} still shows Chinese in English`);
    assert.equal(isKey(english), false, `${status} resolved to the key ${english}`);
  }
  setLocale('zh-CN');
  for (const status of STATUSES) {
    const chinese = runStatusText({
      status,
      compacting: false,
      approvals: 0,
      ready: true,
      loading: false,
    });
    assert.match(chinese, HAN, `${status} lost its Chinese wording`);
    assert.equal(isKey(chinese), false, `${status} resolved to the key ${chinese}`);
  }
});

test('the conditions the status line reports outrank each other in a fixed order', (t) => {
  t.after(() => setLocale('zh-CN'));
  setLocale('en-US');
  const say = (over: Partial<Parameters<typeof runStatusText>[0]>): string =>
    runStatusText({
      status: 'running',
      compacting: false,
      approvals: 0,
      ready: true,
      loading: false,
      ...over,
    });
  // A compaction in flight is the one thing the line can say that explains why nothing else is moving.
  assert.equal(
    say({ compacting: true, approvals: 2, ready: false, loading: true }),
    'Tidying up the context…',
  );
  // An approval outranks a connection that is not ready: the run is waiting on the person, not on the Host.
  assert.equal(say({ approvals: 1, ready: false, loading: true }), 'Waiting for your confirmation');
  assert.equal(say({ ready: false, loading: true }), 'The connection is not ready');
  assert.equal(say({ loading: true }), 'Loading the session…');
  assert.equal(say({}), 'Preparing the request…');
  // And with nothing else true, the status itself decides.
  assert.equal(say({ status: 'limited' }), 'The run limit was reached');
});

test('the exported conversation is written in the interface language and keeps its content verbatim', (t) => {
  t.after(() => setLocale('zh-CN'));
  const messages = [
    { role: 'user', content: '问题：这条内容属于用户，不该被改写' },
    { role: 'assistant', content: 'Answer body.' },
    { role: 'tool', content: 'exit 0' },
  ];
  setLocale('en-US');
  const english = conversationMarkdown({ title: '', messages });
  assert.match(english, /^# New session\n/);
  assert.match(english, /## You\n\n问题：这条内容属于用户，不该被改写/);
  assert.match(english, /## Assistant\n\nAnswer body\./);
  assert.match(english, /## Tool\n\nexit 0$/);
  setLocale('zh-CN');
  const chinese = conversationMarkdown({ title: '', messages });
  assert.match(chinese, /^# 新会话\n/);
  assert.match(chinese, /## 你\n/);
  assert.match(chinese, /## 助手\n/);
  assert.match(chinese, /## 工具\n/);
  // A real title is the user's own text, so it is used as it is in either language.
  assert.match(
    conversationMarkdown({ title: '发布检查', messages: [] }),
    /^# 发布检查\n/,
    'a session title is content, not copy',
  );
});

test('the attachment refusals read in the interface language and name the file', (t) => {
  t.after(() => setLocale('zh-CN'));
  setLocale('en-US');
  for (const kind of FAILURES) {
    const english = attachmentFailureText(kind);
    assert.doesNotMatch(english, HAN, `${kind} still shows Chinese in English`);
    assert.equal(isKey(english), false, `${kind} resolved to the key ${english}`);
    assert.equal(attachmentFailureLine('report.xlsx', english), `report.xlsx: ${english}`);
  }
  setLocale('zh-CN');
  for (const kind of FAILURES) {
    const chinese = attachmentFailureText(kind);
    assert.match(chinese, HAN, `${kind} lost its Chinese wording`);
    assert.equal(attachmentFailureLine('报表.xlsx', chinese), `报表.xlsx：${chinese}`);
  }
  // One situation, one wording: the renderer's vision refusal is the entry the kernel's message is keyed by, so
  // the two consumers cannot drift apart the way they did when this file had its own literal.
  setLocale('en-US');
  assert.equal(
    attachmentFailureText('vision'),
    translate('attach.visionModelRequired', 'en-US'),
    'the renderer and the kernel must share one wording for the same refusal',
  );
});
