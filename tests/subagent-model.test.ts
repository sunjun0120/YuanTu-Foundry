import test from 'node:test';
import assert from 'node:assert/strict';
import type { SubAgentView } from '../packages/client/session-controller.ts';
import {
  subagentDotState,
  subagentFindings,
  subagentRunning,
  subagentStatusLabel,
  subagentTokenText,
  subagentWorkDuration,
  subagentWorkMs,
} from '../apps/desktop/ui/conversation/subagent-model.ts';
import { translate } from '../apps/desktop/i18n.ts';

/**
 * The numbers the sub-agent catalog and detail cards share. One pair of formatters keeps "12.3K tok" and "2m 05s"
 * from reading differently in the two places a person looks at the same child.
 */
function view(overrides: Partial<SubAgentView> = {}): SubAgentView {
  return {
    id: 'child',
    childSessionId: 'child-session',
    index: 0,
    total: 1,
    role: 'general',
    objective: 'fixture',
    status: 'running',
    rounds: 1,
    toolCalls: 0,
    text: '',
    ...overrides,
  } as SubAgentView;
}

test('a running child adds the open turn to its settled work time', () => {
  assert.equal(subagentRunning(view({ runningSince: 1_000 })), true);
  assert.equal(subagentRunning(view({ runningSince: null as never })), false);
  assert.equal(subagentWorkMs(view({ durationMs: 5_000 }), 99_999), 5_000);
  assert.equal(subagentWorkMs(view({ durationMs: 5_000, runningSince: 10_000 }), 12_500), 7_500);
  assert.equal(
    subagentWorkMs(view({ durationMs: 5_000, runningSince: 20_000 }), 12_500),
    5_000,
    'a clock that went backwards does not subtract work',
  );
});

test('work time chooses seconds, minutes, hours or days', () => {
  assert.equal(subagentWorkDuration(view({ durationMs: 9_000 }), 0, 'zh-CN'), '9秒');
  assert.equal(subagentWorkDuration(view({ durationMs: 125_000 }), 0, 'en-US'), '2m 05s');
  assert.equal(subagentWorkDuration(view({ durationMs: 3_725_000 }), 0, 'en-US'), '1h 02m 05s');
  assert.equal(subagentWorkDuration(view({ durationMs: 90_000_000 }), 0, 'en-US'), '1d 1h');
});

test('the status label falls back to the raw status when no key exists', () => {
  assert.equal(
    subagentStatusLabel(view({ status: 'completed' }), 'zh-CN'),
    translate('subagent.status.completed', 'zh-CN'),
  );
  assert.equal(subagentStatusLabel(view({ status: 'future' as never }), 'zh-CN'), 'future');
  assert.equal(subagentDotState(view({ status: 'running' })), 'ongoing');
  assert.equal(subagentDotState(view({ status: 'completed' })), 'done');
  assert.equal(subagentDotState(view({ status: 'failed' })), 'idle');
});

test('spent tokens are prompt plus output, and absent until reported', () => {
  assert.equal(subagentTokenText(view(), 'zh-CN'), '');
  assert.equal(
    subagentTokenText(view({ usage: { inputTokens: 1_000, outputTokens: 234 } as never }), 'en-US'),
    '1.2K tok',
  );
});

test('findings pair every statement with its evidence and keep the unverified note', () => {
  const reading = subagentFindings(
    {
      summary: 'done',
      findings: [
        { statement: 'found it', evidence: 'read the file', paths: ['a.md', 'b.md'] },
        { statement: 'plain', evidence: 'seen' },
      ],
      unverified: ['the build'],
      blockers: ['the signing key'],
    } as never,
    'zh-CN',
  );
  assert.equal(reading.summary, 'done');
  assert.equal(reading.heading, translate('subagent.findings', 'zh-CN'));
  assert.equal(reading.findings[0]?.evidence, '依据: read the file [a.md, b.md]');
  assert.equal(reading.findings[1]?.evidence, '依据: seen');
  assert.match(reading.unverified ?? '', /^未核实: the build$/);
  assert.match(reading.blockers ?? '', /^阻塞: the signing key$/);
});
