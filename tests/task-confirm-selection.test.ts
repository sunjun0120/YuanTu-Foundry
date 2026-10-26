/**
 * The ticks a person leaves in the task list, and whether they outlive the render that drew them.
 *
 * Manual acceptance is the one place where the interface, not the Host, remembers something between two frames: a run
 * can only be confirmed once the person has said which criteria they checked. Those ticks live in
 * `TaskConfirmDrafts`, keyed by session, run and acceptance definition, so a rebuild of the list — a step checkpoint,
 * an attempt, a language switch — cannot silently clear them.
 *
 * The DOM half (checkbox rendering, confirm-button disabling, the command sent) is covered by
 * `tests/workflows.smoke.mjs`; this file tests the draft rules directly.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { Acceptance, Task } from '../packages/protocol/index.ts';
import { acceptanceDefinitionKey, TaskConfirmDrafts } from '../apps/desktop/task-confirm-drafts.ts';
function manualAcceptance(): Acceptance[] {
  return [
    { description: 'first manual criterion', met: false },
    {
      description: 'exact file contents',
      met: false,
      check: { id: 'check-1', kind: 'file-exact', path: 'a.txt', expected: 'x' },
    },
    { description: 'second manual criterion', met: false },
  ];
}
function taskFixture(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    sessionId: 'session-1',
    title: 'Ship it',
    description: 'do the thing',
    status: 'needs_review',
    acceptance: manualAcceptance(),
    verification: {
      passed: false,
      durationMs: 1,
      checks: [
        { id: 'verify-1', kind: 'manual', passed: false, detail: 'not confirmed', durationMs: 1 },
      ],
    },
    steps: [{ description: 'step one', status: 'completed' }],
    attemptCount: 1,
    latestRunId: 'run-1',
    createdAt: '2026-10-10T00:00:00.000Z',
    updatedAt: '2026-10-10T00:00:00.000Z',
    ...overrides,
  };
}

test('the acceptance identity follows the criteria but not their confirmed state', () => {
  const acceptance = manualAcceptance();
  const before = acceptanceDefinitionKey(acceptance);
  acceptance[0]!.met = true;
  assert.equal(acceptanceDefinitionKey(acceptance), before, 'confirming must not reset the draft');
  acceptance[0]!.description = 'edited';
  assert.notEqual(acceptanceDefinitionKey(acceptance), before);
  assert.notEqual(
    acceptanceDefinitionKey(acceptance),
    acceptanceDefinitionKey([{ description: 'edited', met: false }]),
  );
});

test('the draft is reused only for the same session, run and definition', () => {
  const drafts = new TaskConfirmDrafts();
  const task = taskFixture();
  drafts.selection('session-1', task).add(0);
  assert.deepEqual([...drafts.selection('session-1', task)], [0]);
  assert.deepEqual([...drafts.selection('session-1', taskFixture({ latestRunId: 'run-2' }))], []);
  assert.deepEqual(
    [...drafts.selection('session-2', task)],
    [],
    'another session is another draft',
  );
});

test('the draft drops an index whose criterion became met', () => {
  const drafts = new TaskConfirmDrafts();
  drafts.selection('session-1', taskFixture()).add(2);
  const met = taskFixture();
  met.acceptance[2]!.met = true;
  assert.deepEqual([...drafts.selection('session-1', met)], []);
});

test('retain keeps only the current session live tasks', () => {
  const drafts = new TaskConfirmDrafts();
  drafts.selection('session-1', taskFixture()).add(0);
  drafts.selection('session-1', taskFixture({ id: 'task-2' })).add(1);
  drafts.selection('session-2', taskFixture()).add(2);
  drafts.retain('session-1', ['task-2']);
  assert.deepEqual([...drafts.selection('session-1', taskFixture())], [], 'a deleted task is gone');
  assert.deepEqual([...drafts.selection('session-1', taskFixture({ id: 'task-2' }))], [1]);
  assert.deepEqual(
    [...drafts.selection('session-2', taskFixture())],
    [],
    'another session is gone',
  );
});

test('a draft survives a rebuild that only changed the steps', () => {
  const drafts = new TaskConfirmDrafts();
  const before = taskFixture();
  drafts.selection('session-1', before).add(0);
  const after = taskFixture({
    steps: [
      { description: 'step one', status: 'completed' },
      { description: 'step two', status: 'in_progress' },
    ],
  });
  assert.deepEqual([...drafts.selection('session-1', after)], [0]);
});
