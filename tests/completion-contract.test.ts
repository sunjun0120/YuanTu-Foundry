/**
 * The completion contract: what a caller may state as "done", and what it may not.
 *
 * Two properties are load-bearing and are what these tests pin. First, the *definition hash* has to describe the
 * definition and nothing else — step statuses and timestamps move constantly during a run, and a hash that
 * included them would report "the definition changed" every time the run did work. Second, a contract is refused
 * rather than repaired: an unknown field, a conflicting source, a step list that does not match the approved plan
 * and a path that leaves the workspace are all errors before a model request, because a contract that was silently
 * adjusted is a contract nobody approved.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalJson,
  completionDefinitionHash,
  normalizeCompletionPath,
  normalizeCompletionRepairPolicy,
  normalizeCompletionSpec,
  planCompletionSpec,
  taskCompletionSpec,
  taskCompletionStepId,
} from '../packages/core/completion-contract.ts';
import { COMPLETION_REPAIR_CEILINGS, type Plan, type Task } from '../packages/protocol/index.ts';

const minimal = {
  objective: 'Rename the helper',
  constraints: ['Keep the public export'],
  steps: [{ id: 's1', description: 'rename the declaration' }],
  acceptance: [
    {
      description: 'no callers remain',
      met: false,
      check: {
        id: 'c1',
        kind: 'command',
        command: 'node',
        args: ['-e', 'process.exit(0)'],
      },
    },
  ],
  inputs: ['src'],
};

test('a well-formed contract normalizes to its declared defaults', () => {
  const spec = normalizeCompletionSpec(minimal);
  assert.equal(spec.version, 1);
  assert.equal(spec.objective, 'Rename the helper');
  assert.deepEqual(spec.constraints, ['Keep the public export']);
  assert.equal(spec.steps[0]!.status, 'pending');
  assert.equal(spec.steps[0]!.id, 's1');
  assert.deepEqual(spec.inputs, ['src']);
  // A contract with no steps is legal — "no steps and a valid definition may pass" is the rule the verifier keeps.
  const noSteps = normalizeCompletionSpec({ objective: 'Ship it', acceptance: [] });
  assert.deepEqual(noSteps.steps, []);
  assert.deepEqual(noSteps.constraints, []);
});

test('a contract that is malformed is refused, never adjusted', () => {
  for (const bad of [
    { objective: '' },
    { objective: 'x', constraints: Array.from({ length: 33 }, () => 'c') },
    { objective: 'x', constraints: ['c'.repeat(501)] },
    {
      objective: 'x',
      steps: Array.from({ length: 65 }, (_, i) => ({ id: `s${i}`, description: 'd' })),
    },
    {
      objective: 'x',
      steps: [
        { id: 's', description: 'd' },
        { id: 's', description: 'e' },
      ],
    },
    { objective: 'x', steps: [{ id: '', description: 'd' }] },
    { objective: 'x', steps: [{ id: 's', description: 'x'.repeat(501) }] },
    { objective: 'x', steps: [{ id: 's', description: 'd', status: 'nonsense' }] },
    { objective: 'x', acceptance: [{ description: 'd', met: 'yes' }] },
    { objective: 'x', acceptance: [{ description: 'd', met: false, check: { id: 'c' } }] },
    { objective: 'x', inputs: ['.'] },
    { objective: 'x', inputs: ['a.ts', 'a.ts'] },
    { objective: 'x', inputs: Array.from({ length: 129 }, (_, i) => `f${i}.ts`) },
    { objective: 'x', version: 2 },
  ])
    assert.throws(() => normalizeCompletionSpec(bad));
});

test('a contract path is relative to the execution root and cannot leave it', () => {
  assert.equal(normalizeCompletionPath('src/a.ts'), 'src/a.ts');
  assert.equal(normalizeCompletionPath('./src//a.ts'), 'src/a.ts');
  assert.equal(normalizeCompletionPath('src\\a.ts'), 'src/a.ts');
  for (const bad of [
    '/etc/passwd',
    'C:\\Windows',
    'https://example.test/x',
    '../outside',
    'a/../../b',
    '',
  ])
    assert.throws(() => normalizeCompletionPath(bad));
});

test('the definition hash ignores progress and time, and follows the definition', () => {
  const spec = normalizeCompletionSpec(minimal);
  const base = completionDefinitionHash(spec);
  const progressed = {
    ...spec,
    steps: spec.steps.map((step) => ({ ...step, status: 'completed' as const })),
  };
  assert.equal(
    completionDefinitionHash(progressed),
    base,
    'a step that completed is progress, not an edit to what done means',
  );
  const unmet = { ...spec, acceptance: spec.acceptance.map((item) => ({ ...item, met: true })) };
  assert.equal(
    completionDefinitionHash(unmet),
    base,
    'a criterion being met is not part of the definition',
  );
  const reworded = { ...spec, objective: 'Rename the helper everywhere' };
  assert.notEqual(completionDefinitionHash(reworded), base);
  const addedInput = { ...spec, inputs: ['src', 'docs'] };
  assert.notEqual(completionDefinitionHash(addedInput), base);
  // Deterministic serialization: two equal objects hash equally however they were built.
  assert.equal(
    completionDefinitionHash(spec),
    completionDefinitionHash(normalizeCompletionSpec(minimal)),
  );
  assert.equal(canonicalJson({ b: 1, a: [{ d: 2, c: 3 }] }), '{"a":[{"c":3,"d":2}],"b":1}');
});

test('a task’s contract is derived from the definition the operator approved', () => {
  const task: Task = {
    id: 't1',
    sessionId: 's',
    title: 'Ship the migration',
    description: 'Move every caller',
    status: 'in_progress',
    acceptance: [{ description: 'no callers left', met: false }],
    steps: [
      { description: 'rename', status: 'completed' },
      { description: 'update callers', status: 'pending' },
    ],
    attemptCount: 1,
    createdAt: '2026-10-13T00:00:00.000Z',
    updatedAt: '2026-10-13T00:00:00.000Z',
  };
  const spec = taskCompletionSpec(task, ['src']);
  assert.equal(spec.objective, 'Ship the migration');
  assert.deepEqual(spec.constraints, ['Move every caller']);
  assert.deepEqual(
    spec.steps.map((step) => step.id),
    [taskCompletionStepId('t1', 0), taskCompletionStepId('t1', 1)],
  );
  assert.deepEqual(spec.inputs, ['src']);
  // The definition hash does not move when the task row is written again for progress.
  const later = taskCompletionSpec(
    { ...task, steps: task.steps.map((step) => ({ ...step, status: 'completed' as const })) },
    ['src'],
  );
  assert.equal(completionDefinitionHash(later), completionDefinitionHash(spec));
});

test('an approved plan’s steps are the ones that were approved', () => {
  const plan: Plan = {
    id: 'p1',
    sessionId: 's',
    status: 'approved',
    title: 'Migrate',
    summary: 'Move the helper and its callers',
    steps: [{ description: 'rename' }, { description: 'update callers' }],
    hash: 'abc',
    createdAt: '2026-10-13T00:00:00.000Z',
    updatedAt: '2026-10-13T00:00:00.000Z',
  };
  const spec = planCompletionSpec(plan, { acceptance: [], inputs: ['src'] });
  assert.equal(spec.objective, 'Migrate');
  assert.deepEqual(spec.constraints, ['Move the helper and its callers']);
  assert.deepEqual(
    spec.steps.map((step) => step.description),
    ['rename', 'update callers'],
  );
  // A caller may add constraints and checks, and may not reword or reorder the approved steps.
  const extended = planCompletionSpec(plan, {
    constraints: ['Do not change the export'],
    acceptance: [],
    inputs: ['src'],
  });
  assert.deepEqual(extended.constraints, [
    'Move the helper and its callers',
    'Do not change the export',
  ]);
  assert.throws(
    () =>
      planCompletionSpec(plan, {
        steps: [
          { id: 'x', description: 'update callers' },
          { id: 'y', description: 'rename' },
        ],
      }),
    /must match the approved plan/,
  );
});

test('a repair policy may be lowered, raised to the ceiling, and never past it', () => {
  assert.deepEqual(normalizeCompletionRepairPolicy(undefined), {
    maxRepairRounds: 3,
    maxRepeatedFailures: 2,
    repairTimeoutMs: 900_000,
  });
  assert.deepEqual(
    normalizeCompletionRepairPolicy({
      maxRepairRounds: 0,
      maxRepeatedFailures: 0,
      repairTimeoutMs: 0,
    }),
    { maxRepairRounds: 0, maxRepeatedFailures: 0, repairTimeoutMs: 0 },
  );
  assert.deepEqual(
    normalizeCompletionRepairPolicy({
      maxRepairRounds: COMPLETION_REPAIR_CEILINGS.maxRepairRounds,
      maxRepeatedFailures: COMPLETION_REPAIR_CEILINGS.maxRepeatedFailures,
      repairTimeoutMs: COMPLETION_REPAIR_CEILINGS.repairTimeoutMs,
    }),
    {
      maxRepairRounds: COMPLETION_REPAIR_CEILINGS.maxRepairRounds,
      maxRepeatedFailures: COMPLETION_REPAIR_CEILINGS.maxRepeatedFailures,
      repairTimeoutMs: COMPLETION_REPAIR_CEILINGS.repairTimeoutMs,
    },
  );
  for (const beyond of [
    { maxRepairRounds: COMPLETION_REPAIR_CEILINGS.maxRepairRounds + 1 },
    { maxRepeatedFailures: COMPLETION_REPAIR_CEILINGS.maxRepeatedFailures + 1 },
    { repairTimeoutMs: COMPLETION_REPAIR_CEILINGS.repairTimeoutMs + 1 },
    { maxRepairRounds: -1 },
    { maxRepairRounds: 1.5 },
  ])
    assert.throws(() => normalizeCompletionRepairPolicy(beyond));
});
