import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setLocale, translate } from '../apps/desktop/i18n.ts';
import {
  runStatusText,
  visibleRunError,
  type SessionRunStatus,
} from '../apps/desktop/renderer-status.ts';
import { throughputReading } from '../apps/desktop/renderer-statistics.ts';
import { environmentModelLabel } from '../apps/desktop/renderer-settings.ts';
import {
  localizedRunError,
  runErrorWantsModelSettings,
} from '../apps/desktop/renderer-error-text.ts';
import { localizedQuestion } from '../apps/desktop/renderer-question-copy.ts';
import { projectConfigKind } from '../apps/desktop/approval-view.ts';
import { toolFailureNote } from '../apps/desktop/renderer-messages.ts';
import { emptyStatistics } from '../packages/protocol/statistics.ts';
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
  // A silent model past the threshold is counted, so a 30 s first token does not read as a hang.
  assert.equal(
    say({ activity: { kind: 'model', startedAt: 0 }, now: 10_000 }),
    '正在等待模型响应…',
  );
  assert.equal(
    say({ activity: { kind: 'model', startedAt: 0 }, now: 31_500 }),
    '仍在等待模型响应（已等待 31 秒）…',
  );
  // A check the environment could not run is not a failed acceptance.
  assert.equal(
    say({ status: 'needs_review', completionReason: 'repeated-failure' }),
    '验收未通过，需检查',
  );
  assert.equal(
    say({ status: 'needs_review', completionReason: 'environment-error' }),
    '未能验证：检查在当前环境里无法运行',
  );
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

test('a refusal the kernel writes in English gets one sentence in the interface language', (t) => {
  t.after(() => setLocale('zh-CN'));
  const tool = (content: string, isError = true) =>
    ({ role: 'tool', isError, content }) as Parameters<typeof toolFailureNote>[0];
  setLocale('zh-CN');
  const invalid = toolFailureNote(
    tool('Invalid arguments: data must NOT have additional properties. Allowed: command, cwd.'),
  );
  assert.match(invalid ?? '', /工具参数/);
  assert.match(
    toolFailureNote(tool('Verification checks are already registered')) ?? '',
    /不能替换/,
  );
  assert.match(
    toolFailureNote(tool('Git tools need the repository root inside the workspace: …')) ?? '',
    /子目录/,
  );
  // A permission preset refused the call, so the card must not read as "you denied it".
  const policy = toolFailureNote(
    tool(
      "Blocked by the session's permission policy (for example a read-only preset). No effect was executed. …",
    ),
  );
  assert.match(policy ?? '', /权限预设/);
  assert.doesNotMatch(policy ?? '', /已拒绝/);
  const refusals = [
    ['Permission was not granted: no approval responder is available.', /审批端/],
    ['Permission was not granted: nobody answered the approval request within 10ms.', /超时/],
    ['Permission denied by user.', /你拒绝/],
  ] as const;
  for (const [content, expected] of refusals)
    assert.match(toolFailureNote(tool(content)) ?? '', expected);
  // Only a failed tool result is annotated; a successful one that happens to contain the words is not.
  assert.equal(toolFailureNote(tool('Invalid arguments: …', false)), null);
  assert.equal(toolFailureNote(tool('2 passing')), null);
  setLocale('en-US');
  assert.match(toolFailureNote(tool('Invalid arguments: …')) ?? '', /tool arguments did not match/);
  setLocale('zh-CN');
  assert.match(toolFailureNote(tool('Invalid arguments: …')) ?? '', /工具参数/);
});

test('a project configuration edit is named as one in the approval card', () => {
  // In a real run the agent edited the project's test script to make its own check pass, and the card only said
  // 修改文件. The rule is about the path, not the file's contents, so it cannot be talked around by the model.
  assert.equal(projectConfigKind('package.json'), 'commands');
  assert.equal(projectConfigKind('packages/app/package.json'), 'commands');
  assert.equal(projectConfigKind('tsconfig.build.json'), 'build');
  assert.equal(projectConfigKind('.github/workflows/ci.yml'), 'build');
  assert.equal(projectConfigKind('vite.config.ts'), 'build');
  assert.equal(projectConfigKind('Dockerfile'), 'build');
  for (const ordinary of ['src/pricing.mjs', 'README.md', 'docs/report.docx', undefined])
    assert.equal(projectConfigKind(ordinary), null, String(ordinary));
});

test('a stopped run offers a way on, and a tool card never shows an internal call id', async () => {
  // The paused line is a sentence today; the only way to carry on was to retype the request.
  const transcript = await readFile('apps/desktop/renderer-transcript.ts', 'utf8');
  assert.match(transcript, /onContinue\?\(\): void/);
  assert.match(transcript, /node\('button', t\('ui\.continueRun'\)/);
  assert.match(transcript, /function pausedNotice\(\)/);
  // An interrupted tool used to read `操作未完成 · call_01_K3UyNHn…`: the call id is an internal handle.
  const messages = await readFile('apps/desktop/renderer-messages.ts', 'utf8');
  assert.doesNotMatch(messages, /message\.toolCallId\s*\)/);
  assert.match(messages, /const preview =/);
});

test('the plan approval question is read in Chinese, and the digest stays out of it', () => {
  const question = [
    'Approve this plan and start carrying it out in this run?',
    '',
    '# README 补充',
    '',
    '1. 读取 README',
    '',
    'Plan digest: f04f4f93e4c9…',
  ].join('\n');
  const copy = localizedQuestion('Plan approval', question, false);
  assert.equal(copy.header, '计划批准');
  assert.match(copy.question, /批准这份计划，并在本轮开始执行吗？/);
  assert.match(copy.question, /# README 补充/);
  assert.doesNotMatch(copy.question, /Plan digest/);
  assert.equal(copy.label('Approve and execute'), '批准并执行');
  assert.equal(copy.label('Keep planning'), '继续修改计划');
  assert.equal(
    copy.description('Lift read-only mode now and carry out the plan in this run.'),
    '现在就解除只读模式，在本轮执行这份计划。',
  );
  // Only the product's own question is reworded: a question the model wrote is its text, not ours.
  const asked = localizedQuestion('模型提问', 'Which database?', false);
  assert.equal(asked.header, '模型提问');
  assert.equal(asked.question, 'Which database?');
  assert.equal(asked.label('Postgres'), 'Postgres');
  // The English interface keeps the kernel's wording.
  const english = localizedQuestion('Plan approval', question, true);
  assert.equal(english.header, 'Plan approval');
  assert.equal(english.label('Approve and execute'), 'Approve and execute');
});

test('a run waiting on a question says so instead of "running tools"', (t) => {
  t.after(() => setLocale('zh-CN'));
  setLocale('zh-CN');
  const say = (over: Partial<Parameters<typeof runStatusText>[0]>) =>
    runStatusText({
      status: 'running',
      compacting: false,
      approvals: 0,
      questions: 0,
      ready: true,
      loading: false,
      tools: 1,
      ...over,
    });
  assert.equal(say({ questions: 1 }), '等待你的回答');
  // An approval outranks a question: the person has two things to look at, and the approval is the blocking one.
  assert.equal(say({ questions: 1, approvals: 1 }), '等待你的确认');
  assert.equal(say({}), '正在执行工具…');
});

test('a provider failure is explained in the interface language', () => {
  const rejected =
    'Model API returned HTTP 401: Authentication Fails, Your api key: ****test is invalid';
  const chinese = localizedRunError(rejected, false);
  assert.ok(chinese);
  assert.match(chinese, /HTTP 401/);
  assert.match(chinese, /设置 → 模型设置/);
  assert.doesNotMatch(chinese, /request_id|api key/);
  const english = localizedRunError(rejected, true);
  assert.ok(english);
  assert.match(english, /HTTP 401/);
  assert.match(english, /Model settings/);
  // The status code is what changes the advice, so each class says something different.
  assert.match(localizedRunError('Model API returned HTTP 429: busy', false) ?? '', /限流/);
  assert.match(localizedRunError('Model API returned HTTP 503: down', false) ?? '', /服务端出错/);
  // An error with no known shape is not reworded: a friendly sentence for an unknown failure hides the cause.
  assert.equal(localizedRunError('Something odd happened', false), null);
  assert.equal(localizedRunError('', false), null);
  // Only the errors fixed in model settings get the banner's 打开模型设置 button.
  assert.equal(runErrorWantsModelSettings(rejected), true);
  assert.equal(runErrorWantsModelSettings('Model API returned HTTP 404: no'), true);
  assert.equal(runErrorWantsModelSettings('Model API returned HTTP 429: busy'), false);
  assert.equal(runErrorWantsModelSettings('Model API returned HTTP 503: down'), false);
  assert.equal(runErrorWantsModelSettings('Something odd happened'), false);
});

test('a model carried by the launch environment is visible in the picker', () => {
  // The window worked while the picker said 尚无模型, because only saved connections were listed.
  assert.equal(
    environmentModelLabel({ source: 'environment', model: 'deepseek-flash' }, false),
    'deepseek-flash（环境变量）',
  );
  assert.equal(
    environmentModelLabel({ source: 'environment', model: 'deepseek-flash' }, true),
    'deepseek-flash (environment)',
  );
  // A saved connection, or no model at all, keeps the existing wording.
  assert.equal(environmentModelLabel({ source: 'saved', model: 'x' }, false), null);
  assert.equal(environmentModelLabel({ source: 'environment', model: '' }, false), null);
  assert.equal(environmentModelLabel({ source: 'empty', model: '' }, false), null);
});

test('a throughput reading exists only when the decode span was measured', () => {
  const measured = { ...emptyStatistics(), decodeMs: 1_000, decodeTokens: 180, decodeKnown: true };
  assert.equal(throughputReading(measured), '180 tok/s');
  // `decodeKnown` false means the spans could not be trusted; the panel used to print 输出速度（TPS）未知 for a
  // finished session, which reads as a broken feature rather than as a figure nobody measured.
  assert.equal(throughputReading({ ...measured, decodeKnown: false }), null);
  assert.equal(throughputReading({ ...measured, decodeMs: 0 }), null);
  // Too small a sample is arithmetic, not a rate: 24 tokens over 0.1 s used to read as 231 tok/s.
  assert.equal(throughputReading({ ...measured, decodeMs: 104, decodeTokens: 24 }), null);
  assert.equal(throughputReading({ ...measured, decodeTokens: 49 }), null);
});

test('the red banner shows failures, not run verdicts', () => {
  // A cancelled run is something the person did; the conversation already ends with the paused line.
  assert.equal(
    visibleRunError({ error: 'Run cancelled', sessionError: 'Run cancelled', completion: null }),
    '',
  );
  // Every review verdict is a status. It used to be suppressed only for `missing-verification`, so a run that
  // stopped because the environment could not execute its checks drew the kernel's English sentence across a
  // Chinese interface while the completion line under it said `验收未通过，需检查` in Chinese.
  for (const reason of ['repeated-failure', 'environment-error', 'cancelled', 'manual-review'])
    assert.equal(
      visibleRunError({
        error: 'Acceptance checks did not pass; review the evidence.',
        sessionError: 'Acceptance checks did not pass; review the evidence.',
        completion: { state: 'needs_review', reason },
      }),
      '',
      `${reason} must be left to the completion block`,
    );
  // A real failure still gets the banner — including a failed run that also carries a completion record.
  assert.equal(
    visibleRunError({
      error: 'Model API returned HTTP 401',
      sessionError: 'Model API returned HTTP 401',
      completion: { state: 'unverified', reason: 'checks-failed' },
    }),
    'Model API returned HTTP 401',
  );
  // A window-level error is not the run's error, so a review verdict must not hide it.
  assert.equal(
    visibleRunError({
      error: 'Agent Host connection lost',
      sessionError: 'Acceptance checks did not pass; review the evidence.',
      completion: { state: 'needs_review', reason: 'repeated-failure' },
    }),
    'Agent Host connection lost',
  );
  assert.equal(visibleRunError({ error: '' }), '');
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
