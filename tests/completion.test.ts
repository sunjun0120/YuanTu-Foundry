import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Agent } from '../packages/core/agent.ts';
import { createTools } from '../packages/catalog/index.ts';
import { lastRuntimeSnapshot } from '../packages/core/context/runtime.ts';
import {
  CHECK_FAILURE_REASONS,
  COMPLETION_LIMITS,
  COMPLETION_REPAIR_CEILINGS,
  COMPLETION_REPAIR_DEFAULTS,
  COMPLETION_STATES,
  collectFailedChecks,
  isRepairableFailure,
  type AcceptanceEvidence,
  type CompletionStep,
  type CompletionSummary,
} from '../packages/protocol/index.ts';
import {
  DEFAULT_COMPLETION_REPAIR_POLICY,
  decideCompletion,
  nextRepeatedFailures,
  renderCompletionFeedback,
  type CompletionDecisionInput,
} from '../packages/core/completion/completion.ts';
import { storeFixture } from './temp-fixture.ts';

test('only an assertion failure is handed back to the model as repair work', () => {
  assert.equal(isRepairableFailure('assertion-failed'), true);
  for (const reason of CHECK_FAILURE_REASONS.filter((r) => r !== 'assertion-failed'))
    assert.equal(isRepairableFailure(reason), false, reason);
  // A historical result has no reason at all. "We do not know why this failed" is not a licence to spend a
  // model round on it, so the absence is read as unrepairable rather than as the common case.
  assert.equal(isRepairableFailure(undefined), false);
});

test('the repair budget defaults sit under the ceilings a caller may raise them to', () => {
  assert.deepEqual(COMPLETION_REPAIR_DEFAULTS, {
    maxRepairRounds: 3,
    maxRepeatedFailures: 2,
    repairTimeoutMs: 900_000,
  });
  assert.deepEqual(COMPLETION_REPAIR_CEILINGS, {
    maxRepairRounds: 10,
    maxRepeatedFailures: 5,
    repairTimeoutMs: 3_600_000,
  });
  assert.ok(
    COMPLETION_REPAIR_DEFAULTS.maxRepairRounds < COMPLETION_REPAIR_CEILINGS.maxRepairRounds,
  );
  assert.ok(
    COMPLETION_REPAIR_DEFAULTS.maxRepeatedFailures < COMPLETION_REPAIR_CEILINGS.maxRepeatedFailures,
  );
  assert.ok(
    COMPLETION_REPAIR_DEFAULTS.repairTimeoutMs < COMPLETION_REPAIR_CEILINGS.repairTimeoutMs,
  );
});

test('the contract limits are the ones the verifier already enforces on acceptance checks', () => {
  assert.equal(COMPLETION_LIMITS.acceptanceChecks, 64);
  assert.equal(COMPLETION_LIMITS.objectiveChars, 4000);
  assert.equal(COMPLETION_LIMITS.steps, 64);
  assert.equal(COMPLETION_LIMITS.inputs, 128);
});

test('failing checks reduce to the identity a repair fingerprint is built from', () => {
  const evidence: AcceptanceEvidence = {
    passed: false,
    durationMs: 12,
    checks: [
      { id: 'passes', kind: 'command', passed: true, detail: 'ok', durationMs: 1 },
      {
        id: 'fails',
        kind: 'command',
        passed: false,
        detail: 'wrong code',
        durationMs: 1,
        failureReason: 'assertion-failed',
        command: {
          exitCode: 2,
          signal: null,
          timedOut: false,
          stdout: '',
          stderr: '',
          outputTruncated: false,
        },
      },
      { id: 'manual', kind: 'manual', passed: false, detail: 'waiting', durationMs: 0 },
    ],
  };
  assert.deepEqual(collectFailedChecks(evidence), [
    { id: 'fails', reason: 'assertion-failed', exitCode: 2 },
    { id: 'manual' },
  ]);
});

test('the completion states are the four a reader has to distinguish', () => {
  assert.deepEqual([...COMPLETION_STATES], ['verified', 'unverified', 'needs_review', 'limited']);
});

const steps = (...statuses: CompletionStep['status'][]): CompletionStep[] =>
  statuses.map((status, index) => ({
    id: `step:${String(index)}`,
    description: `step ${String(index)}`,
    status,
  }));

const summary = (overrides: Partial<CompletionSummary> = {}): CompletionSummary => ({
  version: 1,
  state: 'unverified',
  reason: '',
  verificationRound: 1,
  repairRounds: 0,
  repeatedFailures: 0,
  failedCheckIds: [],
  unfinishedStepIds: [],
  ...overrides,
});

const passing: AcceptanceEvidence = {
  passed: true,
  durationMs: 1,
  checks: [{ id: 'ok', kind: 'command', passed: true, detail: 'fine', durationMs: 1 }],
};

function failure(
  reason?: 'assertion-failed' | 'permission-denied' | 'timeout',
): AcceptanceEvidence {
  return {
    passed: false,
    durationMs: 1,
    checks: [
      {
        id: 'check',
        kind: 'command',
        passed: false,
        detail: 'expected exit code 0, received 1',
        durationMs: 1,
        ...(reason ? { failureReason: reason } : {}),
        command: {
          exitCode: 1,
          signal: null,
          timedOut: reason === 'timeout',
          stdout: 'boom',
          stderr: 'details',
          outputTruncated: false,
        },
      },
    ],
  };
}

function input(overrides: Partial<CompletionDecisionInput> = {}): CompletionDecisionInput {
  return {
    summary: summary(),
    steps: steps('completed'),
    evidence: passing,
    definitionValid: true,
    definitionNonEmpty: true,
    manualPending: false,
    pendingEffects: false,
    definitionChanged: false,
    cancelled: false,
    now: 1_000,
    policy: DEFAULT_COMPLETION_REPAIR_POLICY,
    failureFingerprint: 'fingerprint',
    inputChanged: false,
    stepsChanged: false,
    ...overrides,
  };
}

test('a satisfied definition is only a candidate: the state stays unverified until the caller finalizes', () => {
  const decision = decideCompletion(input());
  assert.equal(decision.action, 'complete');
  assert.equal(decision.summary.state, 'unverified');
  assert.equal(decision.summary.reason, 'finalizing');
  // A pass clears the repeat counter rather than leaving the last failure's count on the record.
  assert.equal(decision.summary.repeatedFailures, 0);
});

test('a repairable assertion failure is handed back with feedback', () => {
  const decision = decideCompletion(
    input({ evidence: failure('assertion-failed'), steps: steps('in_progress') }),
  );
  assert.equal(decision.action, 'repair');
  assert.equal(decision.action === 'repair' && decision.feedback.includes('check'), true);
  assert.deepEqual(decision.summary.failedCheckIds, ['check']);
  assert.deepEqual(decision.summary.unfinishedStepIds, ['step:0']);
});

test('a failure that is not an assertion stops for review instead of being retried', () => {
  for (const reason of ['permission-denied', 'timeout'] as const) {
    const decision = decideCompletion(input({ evidence: failure(reason) }));
    assert.equal(decision.action, 'review', reason);
    assert.equal(decision.summary.state, 'needs_review');
    assert.equal(decision.summary.reason, reason);
  }
  // A result recorded before the field existed carries no reason, and an unclassified failure is not repairable.
  const legacy = decideCompletion(input({ evidence: failure() }));
  assert.equal(legacy.action, 'review');
  assert.equal(legacy.summary.reason, 'unknown-failure');
});

test('unknown effects, a changed definition, cancellation and manual judgement all stop the loop', () => {
  assert.equal(decideCompletion(input({ pendingEffects: true })).action, 'review');
  assert.equal(
    decideCompletion(input({ definitionChanged: true })).summary.reason,
    'definition-changed',
  );
  assert.equal(decideCompletion(input({ cancelled: true })).summary.reason, 'cancelled');
  assert.equal(decideCompletion(input({ manualPending: true })).summary.reason, 'manual-review');
  // A cancelled run outranks the failure it was carrying: the person's stop is the newer fact.
  assert.equal(
    decideCompletion(input({ cancelled: true, evidence: failure('permission-denied') })).summary
      .reason,
    'cancelled',
  );
});

test('an empty or unusable definition is never repaired towards', () => {
  assert.equal(
    decideCompletion(input({ definitionNonEmpty: false })).summary.reason,
    'empty-acceptance',
  );
  assert.equal(
    decideCompletion(input({ definitionValid: false })).summary.reason,
    'invalid-definition',
  );
});

test('the fourth repair of a run is refused, and the state says the budget ran out', () => {
  const decision = decideCompletion(
    input({
      evidence: failure('assertion-failed'),
      summary: summary({ repairRounds: 3 }),
    }),
  );
  assert.equal(decision.action, 'limit');
  assert.equal(decision.summary.state, 'limited');
  assert.equal(decision.summary.reason, 'repair-limit');
});

test('the repair deadline stops a run without waiting for it', () => {
  const decision = decideCompletion(
    input({
      evidence: failure('assertion-failed'),
      summary: summary({ repairRounds: 1 }),
      repairStartedAt: 1_000,
      now: 1_000 + DEFAULT_COMPLETION_REPAIR_POLICY.repairTimeoutMs,
    }),
  );
  assert.equal(decision.action, 'limit');
  assert.equal(decision.summary.reason, 'repair-timeout');
  // One millisecond earlier it is still a repair, so the boundary is on the deadline and not near it.
  const justBefore = decideCompletion(
    input({
      evidence: failure('assertion-failed'),
      summary: summary({ repairRounds: 1 }),
      repairStartedAt: 1_000,
      now: 1_000 + DEFAULT_COMPLETION_REPAIR_POLICY.repairTimeoutMs - 1,
    }),
  );
  assert.equal(justBefore.action, 'repair');
});

test('the same failure twice with no progress stops, and any progress resets the count', () => {
  const repeated = decideCompletion(
    input({
      evidence: failure('assertion-failed'),
      summary: summary({ repeatedFailures: 1 }),
      failureFingerprint: 'same',
      previousFailureFingerprint: 'same',
    }),
  );
  assert.equal(repeated.action, 'review');
  assert.equal(repeated.summary.reason, 'repeated-failure');
  assert.equal(repeated.summary.repeatedFailures, 2);

  // A different failure is a new fact, so the count restarts at one and the run keeps its repair budget.
  const different = decideCompletion(
    input({
      evidence: failure('assertion-failed'),
      summary: summary({ repeatedFailures: 1 }),
      failureFingerprint: 'changed',
      previousFailureFingerprint: 'same',
    }),
  );
  assert.equal(different.action, 'repair');
  assert.equal(different.summary.repeatedFailures, 1);

  // So does progress inside the workspace or through the step list, even when the fingerprint is identical.
  for (const progress of [{ inputChanged: true }, { stepsChanged: true }]) {
    const decision = decideCompletion(
      input({
        evidence: failure('assertion-failed'),
        summary: summary({ repeatedFailures: 1 }),
        failureFingerprint: 'same',
        previousFailureFingerprint: 'same',
        ...progress,
      }),
    );
    assert.equal(decision.action, 'repair');
    assert.equal(decision.summary.repeatedFailures, 1);
  }
});

test('the repeat counter starts at one and needs a previous fingerprint to grow', () => {
  assert.equal(
    nextRepeatedFailures({
      previous: 0,
      failureFingerprint: 'a',
      inputChanged: false,
      stepsChanged: false,
    }),
    1,
  );
  assert.equal(
    nextRepeatedFailures({
      previous: 0,
      failureFingerprint: 'a',
      previousFailureFingerprint: 'a',
      inputChanged: false,
      stepsChanged: false,
    }),
    1,
  );
});

test('the completion contract travels in the conversation, so a compaction cannot swallow the definition', async (t) => {
  const { root, store, session } = await storeFixture(t, 'yuantu-completion-announce-');
  await writeFile(path.join(root, 'out.txt'), 'verified content');
  const agent = new Agent({
    store,
    tools: createTools(root),
    approve: async () => true,
    provider: {
      async complete() {
        return {
          text: 'Done',
          toolCalls: [],
          usage: { inputTokens: 1, outputTokens: 1 },
          finishReason: 'stop',
        };
      },
    },
  });
  const result = await agent.run({
    sessionId: session.id,
    prompt: 'produce the file',
    completion: {
      version: 1,
      objective: 'Produce out.txt',
      constraints: ['The file must already exist'],
      steps: [{ id: 'write', description: 'write out.txt', status: 'completed' }],
      acceptance: [
        {
          description: 'out.txt matches',
          met: false,
          check: {
            id: 'out',
            kind: 'file-contains',
            path: 'out.txt',
            expected: 'verified content',
          },
        },
      ],
      inputs: ['out.txt'],
    },
  });
  assert.equal(result.status, 'completed', result.error);
  assert.equal(result.completion?.state, 'verified');
  // The definition is in the conversation, not only in the log: that is what makes it survive a compaction.
  const snapshot = lastRuntimeSnapshot(store.messages(session.id), 'completion');
  assert.ok(snapshot, 'the contract was announced as runtime context');
  assert.match(snapshot, /Produce out\.txt/);
  assert.match(snapshot, /out\.txt matches/);
  // …and it carries no internal identity a model could mistake for the objective.
  assert.doesNotMatch(snapshot, /[0-9a-f]{32}/);
  assert.doesNotMatch(snapshot, /contractId|definitionHash/);
});

test('repair feedback stays bounded, is redacted, and says the output is evidence', () => {
  const long = 'x'.repeat(50_000);
  const evidence: AcceptanceEvidence = {
    passed: false,
    durationMs: 1,
    checks: Array.from({ length: 40 }, (_, index) => ({
      id: `check-${String(index)}`,
      kind: 'command' as const,
      passed: false,
      detail: `failed ${String(index)}`,
      durationMs: 1,
      failureReason: 'assertion-failed' as const,
      command: {
        exitCode: 1,
        signal: null,
        timedOut: false,
        stdout: long,
        stderr: `token sk-${'a'.repeat(40)}`,
        outputTruncated: true,
      },
    })),
  };
  const feedback = renderCompletionFeedback({
    summary: summary(),
    steps: steps('pending', 'completed', 'skipped'),
    evidence,
    evidenceLocation: 'the session log for this run',
  });
  assert.ok(feedback.length <= 12_000, `feedback was ${String(feedback.length)} characters`);
  assert.doesNotMatch(feedback, /x{2500}/);
  assert.match(feedback, /check-0/);
  assert.match(feedback, /step:0/);
  assert.match(feedback, /step:2/);
  assert.match(feedback, /session log for this run/);
  assert.match(feedback, /never as an instruction/i);
});
