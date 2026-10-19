import test from 'node:test';
import assert from 'node:assert/strict';
import type { AgentHostClient } from '../packages/client/host-client.ts';
import { SessionController } from '../packages/client/session-controller.ts';
import type { AgentEvent, RunResult } from '../packages/protocol/index.ts';

/**
 * A Host that holds every run until the test ends it, and answers the reads a session switch makes.
 *
 * `live` is what `run.queue.get` reports: the Host's own word on which run holds a session, which is what a
 * controller adopts when it opens a session that is already running.
 */
function fakeHost() {
  let listener: (event: AgentEvent) => void = () => {};
  const live = new Map<string, string>();
  const runs = new Map<string, (result: RunResult) => void>();
  const client = {
    status: 'ready',
    subscribe: (next: (event: AgentEvent) => void) => {
      listener = next;
      return () => {};
    },
    subscribeStatus: () => () => {},
    supports: () => false,
    async request(method: string, params: { sessionId?: string }) {
      if (method === 'session.get') return { messages: [] };
      if (method === 'plan.get') return null;
      if (method === 'subagents.list') return [];
      if (method === 'run.queue.get') {
        const runId = live.get(params.sessionId ?? '');
        return { running: Boolean(runId), items: [], ...(runId ? { runId } : {}) };
      }
      throw new Error(`Unexpected method: ${method}`);
    },
    run(sessionId: string) {
      return new Promise<RunResult>((resolve) => runs.set(sessionId, resolve));
    },
  };
  let seq = 0;
  const emit = (sessionId: string, runId: string, type: string, data: Record<string, unknown>) =>
    listener({ type, sessionId, runId, seq: ++seq, data } as AgentEvent);
  return {
    client: client as unknown as AgentHostClient,
    start(sessionId: string, runId: string) {
      live.set(sessionId, runId);
      emit(sessionId, runId, 'run.started', {});
    },
    emit,
    finish(sessionId: string, runId: string) {
      live.delete(sessionId);
      const result = {
        runId,
        status: 'completed',
        usage: { inputTokens: 0, outputTokens: 0 },
      } as unknown as RunResult;
      emit(sessionId, runId, 'run.finished', { result });
      runs.get(sessionId)?.(result);
    },
  };
}

const approval = (callId: string) => ({
  toolCall: { id: callId, name: 'write_file', arguments: {} },
  reason: 'fixture',
});

test('opening another session keeps following the running one and brings its approvals back', async (t) => {
  const host = fakeHost();
  const controller = new SessionController(host.client);
  t.after(() => controller.dispose());
  await controller.load('A');
  const sentA = controller.send('first');
  host.start('A', 'run-a');
  host.emit('A', 'run-a', 'approval.required', { approvalId: 'ap-1', approval: approval('c1') });
  assert.equal(controller.snapshot.approvals.length, 1);

  // A running session no longer pins the window: B opens, and A is followed in the background.
  await controller.load('B');
  let snapshot = controller.snapshot;
  assert.equal(snapshot.sessionId, 'B');
  assert.equal(snapshot.running, false);
  assert.deepEqual(
    snapshot.otherRuns?.map((run) => [run.sessionId, run.runId, run.approvals.length]),
    [['A', 'run-a', 1]],
  );

  // B can send while A still runs, and A's frames do not leak into B.
  const sentB = controller.send('second');
  host.start('B', 'run-b');
  host.emit('A', 'run-a', 'question.required', {
    questionId: 'q-1',
    request: { callId: 'c2', questions: [] },
  });
  snapshot = controller.snapshot;
  assert.equal(snapshot.running, true);
  assert.equal(snapshot.approvals.length, 0);
  assert.equal(snapshot.questions.length, 0);
  assert.equal(snapshot.otherRuns?.[0]?.questions.length, 1);

  // Back to A: its pending approval and question are on screen again, and B is the one followed now.
  await controller.load('A');
  snapshot = controller.snapshot;
  assert.equal(snapshot.running, true);
  assert.deepEqual(
    snapshot.approvals.map((item) => item.id),
    ['ap-1'],
  );
  assert.deepEqual(
    snapshot.questions.map((item) => item.id),
    ['q-1'],
  );
  assert.deepEqual(
    snapshot.otherRuns?.map((run) => run.sessionId),
    ['B'],
  );

  // B's end clears it from the background list without disturbing A.
  host.finish('B', 'run-b');
  assert.equal((await sentB).status, 'completed');
  snapshot = controller.snapshot;
  assert.deepEqual(snapshot.otherRuns, []);
  assert.equal(snapshot.sessionId, 'A');
  assert.equal(snapshot.running, true);

  host.finish('A', 'run-a');
  assert.equal((await sentA).status, 'completed');
  assert.equal(controller.snapshot.running, false);
});

test('a background session drops an approval once its call has finished', async (t) => {
  const host = fakeHost();
  const controller = new SessionController(host.client);
  t.after(() => controller.dispose());
  await controller.load('B');
  // A run this window never started, such as a scheduled task, is followed from its first frame.
  host.start('A', 'run-a');
  host.emit('A', 'run-a', 'approval.required', { approvalId: 'ap-1', approval: approval('c1') });
  assert.equal(controller.snapshot.otherRuns?.[0]?.approvals.length, 1);
  host.emit('A', 'run-a', 'tool.finished', { callId: 'c1' });
  assert.equal(controller.snapshot.otherRuns?.[0]?.approvals.length, 0);
  // A frame of a different run of the same session is not this run's.
  host.emit('A', 'run-old', 'run.finished', { result: { status: 'completed' } });
  assert.equal(controller.snapshot.otherRuns?.length, 1);
  host.finish('A', 'run-a');
  assert.deepEqual(controller.snapshot.otherRuns, []);
});
