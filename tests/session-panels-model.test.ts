import test from 'node:test';
import assert from 'node:assert/strict';
import type { CarrierSnapshot } from '../packages/carrier/contract.ts';
import {
  todosView,
  goalView,
  deliverablesView,
} from '../apps/desktop/ui/panels/session-panels-model.ts';

/**
 * The three session panels as readings: what the checklist shows, what the goal banner says, and which presented
 * files exist. The panels are hidden rather than emptied when there is nothing to show.
 */
function snapshot(
  messages: { role: 'user' | 'assistant'; content: string; toolCalls?: { name: string }[] }[],
): CarrierSnapshot {
  return { session: { sessionId: 's', messages } } as unknown as CarrierSnapshot;
}

test('the checklist belongs to the question being answered', () => {
  const todos = [
    { content: 'one', status: 'completed' },
    { content: 'two', status: 'in_progress' },
    { content: 'three', status: 'pending' },
  ] as never;
  const afterPlan = todosView(
    snapshot([
      { role: 'user', content: 'ask' },
      { role: 'assistant', content: '', toolCalls: [{ name: 'todo_write' }] },
    ]),
    todos,
    'zh-CN',
  );
  assert.equal(afterPlan.visible, true);
  assert.equal(afterPlan.summary, '1 已完成 · 1 进行中 · 1 待处理');
  assert.equal(afterPlan.rows[0]?.mark, '✓');
  assert.equal(afterPlan.rows[1]?.className, 'todo todo-in-progress');
  assert.match(afterPlan.countText, /^3 项：1 已完成，1 进行中，1 待办$/);

  const askedAgain = todosView(
    snapshot([
      { role: 'assistant', content: '', toolCalls: [{ name: 'todo_write' }] },
      { role: 'user', content: 'next question' },
    ]),
    todos,
    'zh-CN',
  );
  assert.equal(askedAgain.visible, false, 'a list from the previous question is not shown');
  assert.equal(todosView(snapshot([]), [], 'zh-CN').visible, false);
});

test('a runtime context message is not a new question', () => {
  const view = todosView(
    snapshot([
      { role: 'user', content: 'ask' },
      { role: 'assistant', content: '', toolCalls: [{ name: 'todo_write' }] },
      { role: 'user', content: '<runtime-context source="fixture">state</runtime-context>' },
    ]),
    [{ content: 'one', status: 'pending' }] as never,
    'zh-CN',
  );
  assert.equal(view.visible, true);
});

test('the goal banner carries rounds, a blocked reason, and a stand-down notice', () => {
  const active = goalView(
    {
      objective: 'Ship it',
      status: 'active',
      roundsStarted: 5,
      maxGoalRounds: 3,
      standDown: { reason: 'no-progress', continuations: 2 },
    } as never,
    'zh-CN',
  );
  assert.equal(active.visible, true);
  assert.equal(active.statusText, '进行中');
  assert.match(active.meta, /已用 3\/3 轮/);
  assert.match(active.meta, /2/);
  const blocked = goalView(
    {
      objective: 'x',
      status: 'blocked',
      roundsStarted: 0,
      maxGoalRounds: 2,
      blockedReason: 'no key',
    } as never,
    'en-US',
  );
  assert.match(blocked.meta, /no key/);
  assert.equal(goalView(null, 'zh-CN').visible, false);
});

test('presented files keep their path, description and revision title', () => {
  const view = deliverablesView([
    {
      path: 'out/report.md',
      description: 'the report',
      bytes: 12,
      sha256: 'a'.repeat(64),
      at: '2026-10-26T00:00:00.000Z',
    },
  ] as never);
  assert.equal(view.visible, true);
  assert.equal(view.rows[0]?.path, 'out/report.md');
  assert.equal(view.rows[0]?.description, 'the report');
  assert.match(view.rows[0]?.title ?? '', /^12 B · sha256 aaaaaaaaaaaa…/);
  assert.equal(deliverablesView([]).visible, false);
});
