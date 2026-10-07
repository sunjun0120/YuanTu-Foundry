import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionController, type SubAgentDelta } from '../packages/client/session-controller.ts';
import type { AgentHostClient } from '../packages/client/host-client.ts';
import type { AgentEvent, RunResult, SubAgentSummary } from '../packages/protocol/index.ts';

const usage = { inputTokens: 10, outputTokens: 5 };
const summary = (overrides: Partial<SubAgentSummary> = {}): SubAgentSummary => ({
  id: 'sub-1',
  role: 'explore',
  objective: 'Investigate alpha',
  sessionId: 'child-1',
  status: 'completed',
  rounds: 3,
  toolCalls: 2,
  usage,
  ...overrides,
});
/**
 * A hand-driven host client. The real one spawns a Host process, which no unit test should need in
 * order to check how progress events become panel state.
 */
class FakeClient {
  status = 'ready';
  readonly events = new Set<(event: AgentEvent) => void>();
  readonly statuses = new Set<(status: string) => void>();
  readonly requests: string[] = [];
  history: unknown[] = [];
  listed: SubAgentSummary[] = [];
  settle!: (result: RunResult) => void;
  private pending = new Promise<RunResult>((resolve) => {
    this.settle = resolve;
  });
  subscribe(listener: (event: AgentEvent) => void): () => void {
    this.events.add(listener);
    return () => this.events.delete(listener);
  }
  subscribeStatus(listener: (status: string) => void): () => void {
    this.statuses.add(listener);
    return () => this.statuses.delete(listener);
  }
  run(): Promise<RunResult> {
    return this.pending;
  }
  async request(method: string): Promise<unknown> {
    this.requests.push(method);
    if (method === 'session.get')
      return {
        session: { id: 's1', workspace: '.', createdAt: '', activeRun: null },
        messages: this.history,
      };
    if (method === 'plan.get') return null;
    if (method === 'subagents.list') return this.listed;
    return {};
  }
  /**
   * A frame as a Host sends it. The cursor is stamped here rather than at every call site: these fixtures are
   * about how progress becomes panel state, and the one thing every real frame shares is that it carries a log
   * position (`AgentEvent.seq`).
   */
  emit(event: Omit<AgentEvent, 'seq'>): void {
    for (const listener of this.events) listener({ ...event, seq: 0 });
  }
}
function controller(): { client: FakeClient; session: SessionController } {
  const client = new FakeClient();
  return { client, session: new SessionController(client as unknown as AgentHostClient) };
}

test('sub-agent progress becomes panel state without a snapshot per token', async (t) => {
  const { client, session } = controller();
  t.after(() => session.dispose());
  await session.load('s1');
  const deltas: SubAgentDelta[] = [];
  session.subscribeSubAgentDelta((delta) => deltas.push(delta));
  let publishes = 0;
  session.subscribe(() => publishes++);

  const sending = session.send('Investigate both');
  client.emit({ type: 'run.started', sessionId: 's1', runId: 'r1', data: {} });
  client.emit({
    type: 'subagent.started',
    sessionId: 's1',
    runId: 'r1',
    data: {
      id: 'sub-1',
      index: 0,
      total: 2,
      role: 'explore',
      objective: 'Investigate alpha',
      childSessionId: 'child-1',
    },
  });
  client.emit({
    type: 'subagent.started',
    sessionId: 's1',
    runId: 'r1',
    data: {
      id: 'sub-2',
      index: 1,
      total: 2,
      role: 'general',
      objective: 'Fix beta',
      childSessionId: 'child-2',
    },
  });
  assert.deepEqual(
    session.snapshot.subagents.map((view) => [
      view.id,
      view.index,
      view.total,
      view.role,
      view.status,
    ]),
    [
      ['sub-1', 0, 2, 'explore', 'running'],
      ['sub-2', 1, 2, 'general', 'running'],
    ],
  );
  assert.equal(session.snapshot.subagents[0]!.childSessionId, 'child-1');

  // Two deltas must not publish: a child streams for as long as it runs.
  const before = publishes;
  client.emit({
    type: 'subagent.delta',
    sessionId: 's1',
    runId: 'r1',
    data: { id: 'sub-1', text: 'looking ' },
  });
  client.emit({
    type: 'subagent.delta',
    sessionId: 's1',
    runId: 'r1',
    data: { id: 'sub-1', text: 'at files' },
  });
  assert.equal(publishes, before, 'streamed child text must not republish the snapshot');
  assert.deepEqual(deltas, [
    { id: 'sub-1', text: 'looking ' },
    { id: 'sub-1', text: 'at files' },
  ]);
  assert.equal(session.snapshot.subagents[0]!.text, 'looking at files');

  client.emit({
    type: 'subagent.tool',
    sessionId: 's1',
    runId: 'r1',
    data: { id: 'sub-1', name: 'read_file', phase: 'started' },
  });
  assert.equal(session.snapshot.subagents[0]!.tool, 'read_file');
  client.emit({
    type: 'subagent.tool',
    sessionId: 's1',
    runId: 'r1',
    data: { id: 'sub-1', name: 'read_file', phase: 'finished', isError: false },
  });
  assert.equal(session.snapshot.subagents[0]!.tool, undefined);
  assert.equal(session.snapshot.subagents[0]!.toolCalls, 1);

  client.emit({
    type: 'subagent.finished',
    sessionId: 's1',
    runId: 'r1',
    data: { ...summary(), index: 0, total: 2, text: 'alpha report' },
  });
  client.emit({
    type: 'subagent.finished',
    sessionId: 's1',
    runId: 'r1',
    data: {
      ...summary({ id: 'sub-2', role: 'general', status: 'failed', error: 'timed out' }),
      index: 1,
      total: 2,
    },
  });
  const views = session.snapshot.subagents;
  assert.equal(views[0]!.status, 'completed');
  assert.equal(views[0]!.rounds, 3);
  assert.equal(views[0]!.text, 'alpha report');
  assert.equal(views[1]!.status, 'failed');
  assert.equal(views[1]!.error, 'timed out');

  // An event for a run that is not the one on screen is ignored, which is what keeps a stale Host
  // stream from writing into a newly opened session.
  client.emit({
    type: 'subagent.started',
    sessionId: 's1',
    runId: 'other-run',
    data: {
      id: 'sub-3',
      index: 0,
      total: 1,
      role: 'explore',
      objective: 'Late',
      childSessionId: 'child-3',
    },
  });
  assert.equal(session.snapshot.subagents.length, 2);

  client.emit({
    type: 'run.finished',
    sessionId: 's1',
    runId: 'r1',
    data: { result: { runId: 'r1', sessionId: 's1', status: 'completed', text: 'done', usage } },
  });
  client.settle({ runId: 'r1', sessionId: 's1', status: 'completed', text: 'done', usage });
  await sending;
  // The cards survive the end of the run: they are the only record of what the children did.
  assert.equal(session.snapshot.subagents.length, 2);
});

test('reopening a session rebuilds the sub-agent cards from the stored run', async (t) => {
  const { client, session } = controller();
  t.after(() => session.dispose());
  const stored = summary();
  stored.report = {
    summary: 'The loader lives in packages/core.',
    findings: [
      { statement: 'Entry point', evidence: 'read_file', paths: ['packages/core/agent.ts'] },
    ],
  };
  client.listed = [
    stored,
    summary({ id: 'sub-2', role: 'general', status: 'failed', error: 'boom' }),
  ];
  await session.load('s1');
  // The list is the whole of what a reopen asks for: one call per thing the session view shows. It grew when
  // the deliveries and goal views were added to that view, which is why it is asserted in full rather than
  // checked for membership.
  assert.deepEqual(client.requests, [
    'session.get',
    'plan.get',
    'subagents.list',
    'todos.get',
    'deliverables.get',
    'goal.get',
  ]);
  assert.deepEqual(
    session.snapshot.subagents.map((view) => [
      view.id,
      view.index,
      view.total,
      view.status,
      view.error,
    ]),
    [
      ['sub-1', 0, 2, 'completed', undefined],
      ['sub-2', 1, 2, 'failed', 'boom'],
    ],
  );
  // Findings have to survive a reload, otherwise a restored card can only say that a child ran.
  assert.equal(session.snapshot.subagents[0]!.report?.findings[0]?.statement, 'Entry point');
  assert.equal(session.snapshot.subagents[1]!.report, undefined);
  // So does what the child cost: a restored card that lost the tokens would hide the expensive ones.
  assert.equal(session.snapshot.subagents[0]!.usage?.inputTokens, 10);
  assert.equal(session.snapshot.subagents[0]!.usage?.outputTokens, 5);
  // A Host that predates the capability answers with an error; the session still opens.
  const older = controller();
  t.after(() => older.session.dispose());
  const original = older.client.request.bind(older.client);
  older.client.request = async (method: string) => {
    if (method === 'subagents.list') throw new Error('Unknown method: subagents.list');
    return original(method);
  };
  await older.session.load('s1');
  assert.deepEqual(older.session.snapshot.subagents, []);
});
