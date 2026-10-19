import test from 'node:test';
import assert from 'node:assert/strict';
import type { CarrierSnapshot } from '../packages/carrier/contract.ts';
import { RunWatch } from '../apps/desktop/run-notifications.ts';

interface Shape {
  workspace?: string;
  current?: string | null;
  running?: boolean;
  loading?: boolean;
  error?: string | null;
  approvals?: string[];
  questions?: string[];
  others?: { sessionId: string; approvals?: string[]; questions?: string[] }[];
  active?: string[];
}

function snapshot(shape: Shape = {}): CarrierSnapshot {
  return {
    ready: true,
    workspace: shape.workspace ?? '/w',
    sessions: ['a', 'b', 'c'].map((id) => ({
      id,
      title: `会话 ${id}`,
      activeRun: shape.active?.includes(id) ? `run-${id}` : null,
    })),
    session: {
      sessionId: shape.current === undefined ? 'a' : shape.current,
      running: shape.running ?? false,
      loading: shape.loading ?? false,
      error: shape.error ?? null,
      approvals: (shape.approvals ?? []).map((id) => ({ id })),
      questions: (shape.questions ?? []).map((id) => ({ id })),
      otherRuns: (shape.others ?? []).map((run) => ({
        sessionId: run.sessionId,
        runId: `run-${run.sessionId}`,
        approvals: (run.approvals ?? []).map((id) => ({ id })),
        questions: (run.questions ?? []).map((id) => ({ id })),
      })),
    },
  } as unknown as CarrierSnapshot;
}

test('the first snapshot reports nothing, even a run already waiting', () => {
  const watch = new RunWatch();
  assert.deepEqual(watch.update(snapshot({ running: true, approvals: ['x'] })), []);
});

test('a run on screen that ends is reported as finished, or failed with its error', () => {
  const watch = new RunWatch();
  watch.update(snapshot({ running: true }));
  assert.deepEqual(watch.update(snapshot()), [{ kind: 'done', sessionId: 'a', title: '会话 a' }]);
  watch.update(snapshot({ running: true }));
  assert.deepEqual(watch.update(snapshot({ error: 'boom' })), [
    { kind: 'failed', sessionId: 'a', title: '会话 a', error: 'boom' },
  ]);
});

test('a run the user stopped is not news', () => {
  const watch = new RunWatch();
  watch.update(snapshot({ running: true }));
  assert.deepEqual(watch.update(snapshot({ error: 'Run cancelled' })), []);
});

test('a background run that ends, and one the list alone knows about, are both reported', () => {
  const watch = new RunWatch();
  watch.update(snapshot({ others: [{ sessionId: 'b' }], active: ['c'] }));
  assert.deepEqual(
    watch
      .update(snapshot())
      .map((notice) => [notice.kind, notice.sessionId])
      .sort(),
    [
      ['done', 'b'],
      ['done', 'c'],
    ],
  );
});

test('a new approval or question is reported once, a question taking the name when both arrive', () => {
  const watch = new RunWatch();
  watch.update(snapshot({ running: true }));
  assert.deepEqual(watch.update(snapshot({ running: true, approvals: ['p1'] })), [
    { kind: 'approval', sessionId: 'a', title: '会话 a', count: 1 },
  ]);
  assert.deepEqual(watch.update(snapshot({ running: true, approvals: ['p1'] })), []);
  assert.deepEqual(
    watch.update(
      snapshot({
        running: true,
        others: [{ sessionId: 'b', approvals: ['p2'], questions: ['q1'] }],
      }),
    ),
    [{ kind: 'question', sessionId: 'b', title: '会话 b', count: 2 }],
  );
});

test('switching to a running session moves it without reporting anything', () => {
  const watch = new RunWatch();
  watch.update(snapshot({ running: true, approvals: ['p1'] }));
  watch.update(snapshot({ running: true, approvals: ['p1'], loading: true }));
  assert.deepEqual(
    watch.update(snapshot({ current: 'b', others: [{ sessionId: 'a', approvals: ['p1'] }] })),
    [],
  );
});

test('another workspace starts a new comparison', () => {
  const watch = new RunWatch();
  watch.update(snapshot({ running: true }));
  assert.deepEqual(watch.update(snapshot({ workspace: '/other' })), []);
});
