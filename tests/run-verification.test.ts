/**
 * A desktop request that asks to be verified carries its contract all the way to `run.start`.
 *
 * The kernel already judges a run against a stated contract; what is pinned here is the path to it. A plain send stays
 * a chat turn, a send with a contract (or a contract to resume) reaches the host with it, and an approved plan's
 * execution restates the approved steps beside the checks a person added — never a different list.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionController } from '../packages/client/session-controller.ts';
import type { AgentHostClient } from '../packages/client/host-client.ts';
import { parseCarrierCommand } from '../packages/carrier/contract.ts';
import type { Plan } from '../packages/protocol/index.ts';
import type { CompletionSpec } from '../packages/protocol/completion.ts';

const plan: Plan = {
  id: 'p1',
  sessionId: 's1',
  status: 'approved',
  title: 'Rename the helper',
  summary: 'Rename and update callers',
  steps: [{ description: 'rename the export' }, { description: 'update callers' }],
  hash: 'a'.repeat(64),
  createdAt: '',
  updatedAt: '',
};

const spec: CompletionSpec = {
  version: 1,
  objective: 'Fix the parser',
  constraints: [],
  steps: [],
  acceptance: [
    {
      description: 'tests pass',
      met: false,
      check: { id: 'tests', kind: 'command', command: 'npm', args: ['test'] },
    },
  ],
  inputs: ['src/parser.ts'],
};

class FakeClient {
  status = 'ready';
  readonly runs: Array<{ prompt: string; options: Record<string, unknown> }> = [];
  subscribe(): () => void {
    return () => {};
  }
  subscribeStatus(): () => void {
    return () => {};
  }
  async run(_sessionId: string, prompt: string, options: Record<string, unknown>) {
    this.runs.push({ prompt, options });
    return { runId: `r${String(this.runs.length)}`, status: 'completed' };
  }
  async request(method: string): Promise<unknown> {
    if (method === 'session.get')
      return {
        session: { id: 's1', workspace: '.', createdAt: '', activeRun: null },
        messages: [],
      };
    if (method === 'plan.get') return plan;
    if (method === 'completion.current') return null;
    return {};
  }
}

async function loaded() {
  const client = new FakeClient();
  const session = new SessionController(client as unknown as AgentHostClient);
  await session.load('s1');
  return { client, session };
}

function contractOf(options: Record<string, unknown>) {
  const { completion, resumeCompletionId, completionRepairPolicy } = options;
  return { completion, resumeCompletionId, completionRepairPolicy };
}

test('a plain send stays a chat turn with no contract', async () => {
  const { client, session } = await loaded();
  await session.send('hello');
  assert.deepEqual(contractOf(client.runs[0]!.options), {
    completion: undefined,
    resumeCompletionId: undefined,
    completionRepairPolicy: undefined,
  });
});

test('a send with a contract or a resume carries it to run.start', async () => {
  const { client, session } = await loaded();
  await session.send('fix it', undefined, undefined, {
    completion: spec,
    repairPolicy: { maxRepairRounds: 2 } as never,
  });
  assert.deepEqual(client.runs[0]!.options.completion, spec);
  assert.deepEqual(client.runs[0]!.options.completionRepairPolicy, { maxRepairRounds: 2 });
  const resumed = await loaded();
  await resumed.session.send('continue', undefined, undefined, { resumeCompletionId: 'c1' });
  assert.equal(resumed.client.runs[0]!.options.resumeCompletionId, 'c1');
  assert.equal(resumed.client.runs[0]!.options.completion, undefined);
  const task = await loaded();
  await assert.rejects(
    task.session.send('task', undefined, 't1', { resumeCompletionId: 'c1' }),
    /task already carries/,
  );
});

test('an approved plan executes with its own steps and the added checks', async () => {
  const { client, session } = await loaded();
  await session.executePlan('p1', { acceptance: spec.acceptance, inputs: ['src'] });
  const options = client.runs[0]!.options;
  assert.equal(options.planId, 'p1');
  const completion = options.completion as CompletionSpec;
  assert.deepEqual(
    completion.steps.map((step) => [step.id, step.description]),
    [
      ['plan:p1:0', 'rename the export'],
      ['plan:p1:1', 'update callers'],
    ],
  );
  assert.deepEqual(completion.inputs, ['src']);
  assert.equal(completion.acceptance.length, 1);
  await assert.rejects(
    session.executePlan('other', { acceptance: spec.acceptance }),
    /not the one this session shows/,
  );
});

test('an approved plan without verification keeps the unverified execution', async () => {
  const { client, session } = await loaded();
  await session.executePlan('p1');
  assert.equal(client.runs[0]!.options.completion, undefined);
});

test('the carrier accepts a verification envelope and refuses malformed ones', () => {
  const send = { type: 'send', prompt: 'fix', verification: { completion: spec } };
  assert.deepEqual(parseCarrierCommand(send), send);
  const resume = { type: 'send', prompt: 'go', verification: { resumeCompletionId: 'c1' } };
  assert.deepEqual(parseCarrierCommand(resume), resume);
  const execute = {
    type: 'planExecute',
    planId: 'p1',
    verification: { acceptance: spec.acceptance, inputs: ['src'] },
  };
  assert.deepEqual(parseCarrierCommand(execute), execute);
  for (const verification of [
    { completion: spec, resumeCompletionId: 'c1' },
    { completion: { ...spec, acceptance: [] } },
    { resumeCompletionId: '' },
    { completion: spec, repairPolicy: { maxRepairRounds: -1 } },
    { completion: spec, extra: true },
  ])
    assert.throws(() => parseCarrierCommand({ type: 'send', prompt: 'x', verification }));
  for (const verification of [
    { acceptance: [] },
    { acceptance: spec.acceptance, steps: [] },
    { acceptance: spec.acceptance, inputs: [1] },
  ])
    assert.throws(() => parseCarrierCommand({ type: 'planExecute', planId: 'p1', verification }));
});
