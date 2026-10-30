import test from 'node:test';
import assert from 'node:assert/strict';
import { approvalSummary } from '../apps/desktop/approval-view.ts';
import { setLocale, translate } from '../apps/desktop/i18n.ts';
import type { Approval } from '../packages/protocol/index.ts';

const command: Approval = {
  kind: 'command',
  description: 'run_command: {"command":"node --test"}\nIsolation: ...',
  toolCall: { id: '1', name: 'run_command', arguments: { command: 'node --test', cwd: 'app' } },
  boundary: { processFiles: 'workspace-write-partial', network: 'unrestricted' },
};

test('a command approval reads in Chinese and leads with the command, not the JSON', (t) => {
  t.after(() => setLocale('zh-CN'));
  setLocale('zh-CN');
  const summary = approvalSummary(command);
  assert.equal(summary.title, translate('approval.title.command', 'zh-CN'));
  assert.match(summary.why, /run_command/);
  assert.equal(summary.subject, 'node --test');
  assert.equal(summary.directory, 'app');
  assert.match(summary.boundary!, /受限 Windows 令牌/);
  assert.match(summary.boundary!, /可以访问网络/);
  assert.doesNotMatch(
    summary.boundary!.replace('Windows', ''),
    /[A-Za-z]{4,}/,
    'no English left in the Chinese sentence',
  );
  setLocale('en-US');
  assert.match(
    approvalSummary(command).boundary!,
    /^Isolation: runs under a restricted Windows token/,
  );
});

test('a network escalation says so before the isolation sentence', (t) => {
  t.after(() => setLocale('zh-CN'));
  setLocale('zh-CN');
  const summary = approvalSummary({
    ...command,
    boundary: { processFiles: 'workspace-write', network: 'unrestricted' },
    escalation: { network: 'unrestricted' },
  });
  assert.match(summary.boundary!, /^这条命令请求临时联网/);
  assert.match(summary.boundary!, /可以访问网络/);
});

test('a write approval with a diff names no separate subject', () => {
  const summary = approvalSummary({
    kind: 'write',
    description: 'write_file',
    toolCall: { id: '2', name: 'write_file', arguments: { path: 'a.txt', content: 'x' } },
    change: { path: 'a.txt', kind: 'create', patch: '+x', added: 1, removed: 0, truncated: false },
  });
  assert.equal(summary.subject, undefined);
  assert.equal(summary.boundary, undefined);
});
