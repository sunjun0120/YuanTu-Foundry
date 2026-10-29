/**
 * A `forbidden-path` + `unchanged` check works for every contract source, not only a task.
 *
 * The before-image used to be captured only on the task path, so an explicit request or an approved plan that said
 * "this file must not change" handed the verifier a check with nothing to compare against. The verifier reported the
 * definition as unexecutable and every run of it ended `needs_review` without the model being able to do anything
 * about it. What is pinned here is that the image is taken once the contract is resolved, before the model works.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Agent } from '../packages/core/agent.ts';
import { createTools } from '../packages/catalog/index.ts';
import type { ModelResponse, Plan, Provider } from '../packages/protocol/index.ts';
import type { CompletionSpec } from '../packages/protocol/completion.ts';
import { storeFixture } from './temp-fixture.ts';

function scripted(
  turns: { text?: string; calls?: { name: string; input: Record<string, unknown> }[] }[],
): Provider {
  let index = 0;
  return {
    async complete(): Promise<ModelResponse> {
      const turn = turns[Math.min(index, turns.length - 1)]!;
      const turnIndex = index++;
      const calls = turn.calls ?? [];
      return {
        text: turn.text ?? '',
        toolCalls: calls.map((call, position) => ({
          id: `call-${String(turnIndex)}-${String(position)}`,
          name: call.name,
          arguments: call.input,
        })),
        usage: { inputTokens: 10, outputTokens: 5 },
        finishReason: calls.length ? 'tool_calls' : 'stop',
      };
    },
  } as Provider;
}

const KEEP = [
  {
    description: 'keep.txt must not change',
    met: false,
    check: {
      id: 'keep',
      kind: 'forbidden-path' as const,
      path: 'keep.txt',
      expectation: 'unchanged' as const,
    },
  },
];

const spec: CompletionSpec = {
  version: 1,
  objective: 'Leave keep.txt alone',
  constraints: [],
  steps: [],
  acceptance: KEEP,
  inputs: [],
};

async function fixture(t: test.TestContext) {
  const { root, store } = await storeFixture(t, 'yuantu-completion-baselines-');
  await writeFile(path.join(root, 'keep.txt'), 'original\n');
  return { root, store, session: store.create(root) };
}

test('an explicit contract whose protected file is untouched is verified', async (t) => {
  const { root, store, session } = await fixture(t);
  const agent = new Agent({
    store,
    tools: createTools(root),
    approve: async () => true,
    provider: scripted([{ text: 'Done.' }]),
  });
  const result = await agent.run({ sessionId: session.id, prompt: 'Do nothing', completion: spec });
  assert.equal(result.status, 'completed', result.error);
  assert.equal(result.completion?.state, 'verified');
});

test('an explicit contract whose protected file was changed stops for review', async (t) => {
  const { root, store, session } = await fixture(t);
  const agent = new Agent({
    store,
    tools: createTools(root),
    approve: async () => true,
    provider: scripted([
      { calls: [{ name: 'read_file', input: { path: 'keep.txt' } }] },
      {
        calls: [
          {
            name: 'edit_file',
            input: { path: 'keep.txt', old_text: 'original', new_text: 'changed' },
          },
        ],
      },
      { text: 'Done.' },
    ]),
  });
  const result = await agent.run({ sessionId: session.id, prompt: 'Change it', completion: spec });
  assert.equal(result.status, 'needs_review');
  // The check ran and saw the change. Without a baseline it never ran at all: the evidence held no checks.
  const check = result.acceptance?.checks.find((item) => item.id === 'keep');
  assert.equal(check?.passed, false);
  assert.equal(check?.detail, 'Forbidden path changed');
});

test('an approved plan with an unchanged check is verified when the file is untouched', async (t) => {
  const { root, store, session } = await fixture(t);
  const plan: Plan = {
    id: 'p1',
    sessionId: session.id,
    status: 'approved',
    title: 'Leave keep.txt alone',
    summary: 'Nothing to do',
    steps: [{ description: 'look around' }],
    hash: 'a'.repeat(64),
    createdAt: '',
    updatedAt: '',
  };
  const agent = new Agent({
    store,
    tools: createTools(root),
    approve: async () => true,
    provider: scripted([
      {
        calls: [{ name: 'completion_step', input: { id: 'plan:p1:0', status: 'completed' } }],
      },
      { text: 'Done.' },
    ]),
  });
  const result = await agent.run({
    sessionId: session.id,
    prompt: 'Execute the plan',
    approvedPlan: plan,
    // No steps: an approved plan's own steps are the contract's, and the caller only adds checks.
    completion: { version: 1, objective: spec.objective, acceptance: KEEP } as CompletionSpec,
  });
  assert.equal(result.status, 'completed', result.error);
  assert.equal(result.completion?.state, 'verified');
});

/**
 * A baseline belongs to the definition, not to one attempt at it.
 *
 * A retry or a resume that re-sampled would take the failed attempt's edits as the new "before", and the protected
 * file the failed attempt changed would then pass without anyone touching it again.
 */
const CHANGE_KEEP = [
  { calls: [{ name: 'read_file', input: { path: 'keep.txt' } }] },
  {
    calls: [
      { name: 'edit_file', input: { path: 'keep.txt', old_text: 'original', new_text: 'changed' } },
    ],
  },
  { text: 'Done.' },
];

function agentWith(
  root: string,
  store: Awaited<ReturnType<typeof fixture>>['store'],
  turns: Parameters<typeof scripted>[0],
) {
  return new Agent({
    store,
    tools: createTools(root),
    approve: async () => true,
    provider: scripted(turns),
  });
}

test('a task retry still compares against the first attempt’s baseline', async (t) => {
  const { root, store, session } = await fixture(t);
  const task = store.createTask(session.id, { title: 'Leave keep.txt alone', acceptance: KEEP });
  const first = await agentWith(root, store, CHANGE_KEEP).run({
    sessionId: session.id,
    taskId: task.id,
    prompt: 'Change it',
  });
  assert.equal(first.status, 'needs_review');
  const retry = await agentWith(root, store, [{ text: 'Nothing to do.' }]).run({
    sessionId: session.id,
    taskId: task.id,
    prompt: 'Change it',
  });
  assert.equal(retry.status, 'needs_review');
  const check = retry.acceptance?.checks.find((item) => item.id === 'keep');
  assert.equal(check?.passed, false);
  assert.equal(check?.detail, 'Forbidden path changed');
});

test('a resumed contract still compares against the baseline its first run recorded', async (t) => {
  const { root, store, session } = await fixture(t);
  const first = await agentWith(root, store, CHANGE_KEEP).run({
    sessionId: session.id,
    prompt: 'Change it',
    completion: spec,
  });
  assert.equal(first.status, 'needs_review');
  const contractId = store.completionCurrent(session.id)?.contractId;
  assert.ok(contractId);
  assert.ok(store.completionCurrent(session.id)?.baselines?.keep);
  const resumed = await agentWith(root, store, [{ text: 'Nothing to do.' }]).run({
    sessionId: session.id,
    prompt: 'Continue',
    resumeCompletionId: contractId,
  });
  assert.equal(resumed.status, 'needs_review');
  assert.notEqual(resumed.completion?.state, 'verified');
});

test('a resumed contract keeps counting the failure it stopped on as a repeat', async (t) => {
  /**
   * The repeat detector compares against the last failure's fingerprint, and a resume restores the count without
   * it used to: the first failure after a resume read as new, so resuming bought another round of the same broken
   * state. With the fingerprint restored, the same failure with nothing changed stops at once.
   */
  const { root, store, session } = await fixture(t);
  const marker: CompletionSpec = {
    ...spec,
    objective: 'Write the marker',
    acceptance: [
      {
        description: 'marker.txt says ok',
        met: false,
        check: { id: 'marker', kind: 'file-contains', path: 'marker.txt', expected: 'ok' },
      },
    ],
  };
  const first = await agentWith(root, store, [{ text: 'Not yet.' }]).run({
    sessionId: session.id,
    prompt: 'Write it',
    completion: marker,
  });
  assert.equal(first.completion?.reason, 'repeated-failure');
  const contractId = store.completionCurrent(session.id)?.contractId;
  assert.ok(contractId);
  let requests = 0;
  const counting = scripted([{ text: 'Still not.' }]);
  const resumed = await new Agent({
    store,
    tools: createTools(root),
    approve: async () => true,
    provider: {
      ...counting,
      complete: (request) => {
        requests++;
        return counting.complete(request);
      },
    },
  }).run({ sessionId: session.id, prompt: 'Continue', resumeCompletionId: contractId });
  assert.equal(resumed.status, 'needs_review');
  assert.equal(resumed.completion?.reason, 'repeated-failure');
  assert.equal(requests, 1, 'no repair round was spent on a failure already seen twice');
  assert.equal(resumed.completion?.repeatedFailures, 3);
});
