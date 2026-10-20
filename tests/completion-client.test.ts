/**
 * The completion contract as a client sees it.
 *
 * Two things are being pinned, and both are about *not* losing information a person is reading. First, the fold:
 * every record the runtime writes carries a whole `summary`, so the newest wins — but the *definition* is only on
 * the record that created the contract, so a later round's record must not erase the objective and the criteria
 * the panel is showing. Second, a host that has never heard of the contract answers nothing, and the session still
 * loads: "no contract" and "a contract that verified" are different statements and only one of them may be shown.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionController } from '../packages/client/session-controller.ts';
import type { AgentHostClient } from '../packages/client/host-client.ts';
import type { CompletionRecord } from '../packages/protocol/completion.ts';
import type { AgentEvent } from '../packages/protocol/index.ts';
import { foldCompletion } from '../packages/client/session-event-fold.ts';

test('live automatic verification preserves real check evidence without leaking it to a later contract', () => {
  const previous = record();
  const evidence = {
    passed: true,
    durationMs: 5,
    checks: [
      {
        id: 'auto-1',
        kind: 'command' as const,
        passed: true,
        durationMs: 5,
        detail: 'Passed',
        command: {
          exitCode: 0,
          signal: null,
          timedOut: false,
          stdout: '1 test passed',
          stderr: '',
          outputTruncated: false,
        },
      },
    ],
  };
  const folded = foldCompletion(
    previous,
    {
      type: 'completion.updated',
      sessionId: 's1',
      runId: 'r1',
      seq: 1,
      data: {
        contractId: previous.contractId,
        source: 'automatic',
        summary: previous.summary,
        evidence,
      },
    },
    's1',
  );
  assert.equal(folded?.source, 'automatic');
  assert.equal(folded?.evidence?.checks[0]?.command?.stdout, '1 test passed');
  const later = foldCompletion(
    folded ?? null,
    {
      type: 'completion.updated',
      sessionId: 's1',
      runId: 'r2',
      seq: 2,
      data: { contractId: 'different-contract', source: 'automatic', summary: previous.summary },
    },
    's1',
  );
  assert.equal(later?.evidence, undefined);
});

class FakeClient {
  status = 'ready';
  readonly events = new Set<(event: AgentEvent) => void>();
  readonly statuses = new Set<(status: string) => void>();
  readonly requests: string[] = [];
  /** `null` means a Host that predates the capability, which is what the load path must tolerate. */
  completion: CompletionRecord | null | undefined = null;
  subscribe(listener: (event: AgentEvent) => void): () => void {
    this.events.add(listener);
    return () => this.events.delete(listener);
  }
  subscribeStatus(listener: (status: string) => void): () => void {
    this.statuses.add(listener);
    return () => this.statuses.delete(listener);
  }
  run(): Promise<never> {
    return new Promise(() => {});
  }
  async request(method: string): Promise<unknown> {
    this.requests.push(method);
    if (method === 'session.get')
      return {
        session: { id: 's1', workspace: '.', createdAt: '', activeRun: null },
        messages: [],
      };
    if (method === 'plan.get') return null;
    if (method === 'completion.current') {
      if (this.completion === undefined) throw new Error('Unknown method completion.current');
      return this.completion;
    }
    return {};
  }
  emit(event: Omit<AgentEvent, 'seq'>): void {
    for (const listener of this.events) listener({ ...event, seq: 1 });
  }
}

function controller(): { client: FakeClient; session: SessionController } {
  const client = new FakeClient();
  return { client, session: new SessionController(client as unknown as AgentHostClient) };
}

const record = (over: Partial<CompletionRecord> = {}): CompletionRecord => ({
  version: 1,
  contractId: 'task:t1',
  sessionId: 's1',
  originRunId: 'r1',
  latestRunId: 'r1',
  source: 'task',
  definition: {
    version: 1,
    objective: 'Rename the helper',
    constraints: [],
    steps: [{ id: 'task:t1:0', description: 'rename', status: 'pending' }],
    acceptance: [{ description: 'no callers left', met: false }],
    inputs: [],
  },
  definitionHash: 'deadbeef',
  summary: {
    version: 1,
    state: 'unverified',
    reason: 'contract-created',
    contractId: 'task:t1',
    verificationRound: 0,
    repairRounds: 0,
    repeatedFailures: 0,
    failedCheckIds: [],
    unfinishedStepIds: ['task:t1:0'],
  },
  steps: [{ id: 'task:t1:0', description: 'rename', status: 'pending' }],
  affectedPaths: [],
  policy: { maxRepairRounds: 3, maxRepeatedFailures: 2, repairTimeoutMs: 900_000 },
  ...over,
});

test('a session with no contract says so, and one that verified says that', async (t) => {
  const { session } = controller();
  t.after(() => session.dispose());
  await session.load('s1');
  assert.equal(
    session.snapshot.completion,
    null,
    'no contract is not the same as an unverified one',
  );

  const { client, session: verified } = controller();
  t.after(() => verified.dispose());
  client.completion = record({
    summary: { ...record().summary, state: 'verified', reason: 'verified', repairRounds: 0 },
  });
  await verified.load('s1');
  assert.equal(verified.snapshot.completion?.summary.state, 'verified');
  assert.equal(verified.snapshot.completion?.definition.objective, 'Rename the helper');
});

test('a host that predates the capability leaves the session loadable', async (t) => {
  const { client, session } = controller();
  t.after(() => session.dispose());
  client.completion = undefined;
  await session.load('s1');
  assert.equal(session.snapshot.completion, null);
  assert.equal(session.snapshot.sessionId, 's1', 'the rest of the session still loaded');
});

test('a round record folds into the state without erasing the definition', async (t) => {
  const { client, session } = controller();
  t.after(() => session.dispose());
  client.completion = record();
  await session.load('s1');
  const objective = session.snapshot.completion?.definition.objective;
  assert.equal(objective, 'Rename the helper');

  /**
   * The frame arrives while a run owns the session.
   *
   * A client applies a run's frames only for the run it adopted — that is what keeps one session's events from
   * being folded into another's view — so the fixture starts a run and announces it, exactly as the carrier does.
   */
  const sending = session.send('Carry the work forward');
  client.emit({ type: 'run.started', sessionId: 's1', runId: 'r1', data: {} });
  // A later round carries the evidence and no definition, which is what the runtime writes per round.
  client.emit({
    type: 'completion.updated',
    sessionId: 's1',
    runId: 'r1',
    data: {
      runId: 'r1',
      contractId: 'task:t1',
      verificationRound: 1,
      steps: [{ id: 'task:t1:0', description: 'rename', status: 'completed' }],
      affectedPaths: ['src'],
      summary: {
        version: 1,
        state: 'unverified',
        reason: 'checks-failed',
        contractId: 'task:t1',
        definitionHash: 'deadbeef',
        verificationRound: 1,
        repairRounds: 1,
        repeatedFailures: 1,
        failedCheckIds: ['callers'],
        unfinishedStepIds: [],
      },
    },
  });
  const folded = session.snapshot.completion!;
  assert.equal(folded.summary.reason, 'checks-failed');
  assert.equal(folded.summary.repairRounds, 1);
  assert.deepEqual(folded.summary.failedCheckIds, ['callers']);
  assert.equal(
    folded.steps[0]!.status,
    'completed',
    'the newest round’s progress is what the panel shows',
  );
  assert.deepEqual(folded.affectedPaths, ['src']);
  // The definition survives, because the record that carried it is the only one that ever will.
  assert.equal(folded.definition.objective, 'Rename the helper');
  assert.equal(folded.definition.acceptance[0]!.description, 'no callers left');
  // The policy survives for the same reason: it is written when the contract is created.
  assert.equal(folded.policy.maxRepairRounds, 3);
  sending.catch(() => {});
});

test('a repeated frame at the same cursor does not change the answer', async (t) => {
  const { client, session } = controller();
  t.after(() => session.dispose());
  client.completion = record();
  await session.load('s1');
  const sending = session.send('Carry the work forward');
  client.emit({ type: 'run.started', sessionId: 's1', runId: 'r1', data: {} });
  const event = {
    type: 'completion.updated' as const,
    sessionId: 's1',
    runId: 'r1',
    data: {
      runId: 'r1',
      contractId: 'task:t1',
      summary: { ...record().summary, state: 'limited', reason: 'repair-limit', repairRounds: 3 },
    },
  };
  client.emit(event);
  const first = JSON.stringify(session.snapshot.completion);
  client.emit(event);
  assert.equal(JSON.stringify(session.snapshot.completion), first);
  assert.equal(session.snapshot.completion?.summary.state, 'limited');
  sending.catch(() => {});
});
