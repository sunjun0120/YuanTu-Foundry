import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { normalizePlanBody, planHash, type PlanApprovalStore } from '../packages/protocol/plans.ts';
import {
  normalizePlanBody as legacyNormalize,
  planHash as legacyHash,
  LEASE_RENEW_INTERVAL_MS as legacyInterval,
} from '../packages/storage/sqlite.ts';
import { LEASE_RENEW_INTERVAL_MS } from '../packages/protocol/session-lease.ts';
import { SqlitePlanStore } from '../packages/storage/plans.ts';
import { createPlanningTools } from '../packages/core/plan-tools.ts';
import type { Plan, Questioner, ToolContext } from '../packages/protocol/index.ts';

const body = { title: '  Plan  ', summary: '  Summary  ', steps: ['  First  '] };
function memoryPlans(t: test.TestContext): { db: DatabaseSync; store: SqlitePlanStore } {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE plans (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL, run_id TEXT, status TEXT NOT NULL,
    title TEXT NOT NULL, summary TEXT NOT NULL, steps TEXT NOT NULL, hash TEXT NOT NULL,
    reason TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, approved_at TEXT
  )`);
  t.after(() => db.close());
  const store = new SqlitePlanStore(db, (sessionId) => {
    if (!['one', 'two'].includes(sessionId)) throw new Error('Session not found');
  });
  return { db, store };
}
test('plan contract preserves normalization and the existing approval digest', () => {
  assert.equal(normalizePlanBody, legacyNormalize);
  assert.equal(planHash, legacyHash);
  assert.equal(LEASE_RENEW_INTERVAL_MS, legacyInterval);
  const normalized = normalizePlanBody(body);
  assert.deepEqual(normalized, {
    title: 'Plan',
    summary: 'Summary',
    steps: [{ description: 'First' }],
  });
  const previousDigest = createHash('sha256')
    .update(JSON.stringify(['Plan', 'Summary', ['First']]))
    .digest('hex');
  assert.equal(planHash(normalized), previousDigest);
  assert.throws(() => normalizePlanBody({ ...body, steps: [] }), /at least one step/);
});
test('independent plan storage enforces session identity and approval witnesses', (t) => {
  const { db, store } = memoryPlans(t);
  assert.throws(() => store.createPlan('missing'), /Session not found/);
  const plan = store.createPlan('one');
  assert.deepEqual(store.planMode('one'), { planId: plan.id });
  assert.throws(() => store.getPlan('two', plan.id), /Plan not found/);
  assert.throws(() => store.submitPlan('two', plan.id, body), /Plan not found/);
  const proposed = store.submitPlan('one', plan.id, body);
  assert.equal(proposed.status, 'proposed');
  assert.throws(() => store.executablePlan('one', plan.id), /not been approved/);
  assert.throws(() => store.approvePlan('one', plan.id, 'wrong'), /changed since/);
  assert.equal(store.approvePlan('one', plan.id, proposed.hash).status, 'approved');
  assert.equal(store.executablePlan('one', plan.id).hash, proposed.hash);
  assert.throws(() => store.submitPlan('one', plan.id, body), /already approved/);
  db.prepare('UPDATE plans SET title=? WHERE id=?').run('tampered', plan.id);
  assert.throws(() => store.executablePlan('one', plan.id), /changed after approval/);
});
test('plan repository retains newest-plan mode and does not own the database connection', (t) => {
  const { db, store } = memoryPlans(t);
  const previous = store.createPlan('one');
  store.submitPlan('one', previous.id, body);
  const newest = store.createPlan('one', 'run');
  assert.equal(store.latestPlan('one')?.id, newest.id);
  store.linkPlanRun('one', newest.id, 'linked');
  assert.equal(store.getPlan('one', newest.id).runId, 'linked');
  store.rejectPlan('one', newest.id, 'discarded');
  assert.equal(store.planMode('one'), null);
  assert.throws(() => store.executablePlan('one', newest.id), /rejected/);
  db.exec('CREATE TABLE still_owned_by_caller (id TEXT)');
});

function planning(ask?: Questioner) {
  const writes: string[] = [];
  const plan: Plan = {
    id: 'plan',
    sessionId: 'one',
    status: 'planning',
    title: '',
    summary: '',
    steps: [],
    hash: '',
    createdAt: 'now',
    updatedAt: 'now',
  };
  const store: PlanApprovalStore = {
    submitPlan(sessionId, id, value) {
      assert.equal(sessionId, 'one');
      assert.equal(id, 'plan');
      writes.push('submit');
      const normalized = normalizePlanBody(value);
      Object.assign(plan, normalized, { status: 'proposed', hash: planHash(normalized) });
      return { ...plan };
    },
    approvePlan(sessionId, id, hash) {
      assert.equal(sessionId, 'one');
      assert.equal(id, 'plan');
      assert.equal(hash, plan.hash);
      writes.push('approve');
      plan.status = 'approved';
      return { ...plan };
    },
  };
  const run = createPlanningTools({
    store,
    sessionId: 'one',
    planId: 'plan',
    ask,
    onProposed: () => writes.push('proposed'),
    onApproved: () => writes.push('approved'),
  });
  const execute = (name: string, value = body, signal = new AbortController().signal) => {
    const tool = run.tools.find((tool) => tool.name === name);
    assert.ok(tool);
    return tool.execute(value, { signal } as ToolContext);
  };
  return { writes, run, execute };
}
test('plan tools require only the minimal storage contract and submit without a questioner', async () => {
  const { writes, run, execute } = planning();
  assert.deepEqual(
    run.tools.map((tool) => tool.name),
    ['submit_plan'],
  );
  assert.equal((await execute('submit_plan')).isError, false);
  assert.equal(run.submitted, true);
  assert.deepEqual(writes, ['submit', 'proposed']);
  assert.equal(run.takeApproval(), undefined);
});
test('approval is consumed once at the next round and repeated questions cannot approve twice', async () => {
  const { writes, run, execute } = planning(async () => ({
    answered: true,
    answers: [{ id: 'plan', selected: ['Approve and execute'] }],
  }));
  assert.equal((await execute('exit_plan_mode')).isError, false);
  assert.equal(run.submitted, false);
  assert.deepEqual(writes, ['submit', 'approve', 'approved']);
  assert.equal((await execute('exit_plan_mode')).isError, true);
  assert.deepEqual(writes, ['submit', 'approve', 'approved']);
  assert.equal(run.takeApproval()?.status, 'approved');
  assert.equal(run.takeApproval(), undefined);
});
test('declined and unanswered plans never write to storage', async () => {
  for (const outcome of [
    {
      answered: true as const,
      answers: [{ id: 'plan', selected: ['Keep planning'], freeText: 'revise' }],
    },
    { answered: false as const, answers: [], reason: 'unavailable' as const },
  ]) {
    const { writes, run, execute } = planning(async () => outcome);
    await execute('exit_plan_mode');
    assert.deepEqual(writes, []);
    assert.equal(run.takeApproval(), undefined);
  }
});
test('oversized plans do not ask the user or write to storage', async () => {
  let questions = 0;
  const { writes, execute } = planning(async () => {
    questions++;
    return { answered: false, answers: [], reason: 'unavailable' };
  });
  const result = await execute('exit_plan_mode', {
    title: 'long',
    summary: 'summary',
    steps: Array(40).fill('x'.repeat(500)),
  });
  assert.equal(result.isError, true);
  assert.match(result.content, /submit_plan/);
  assert.equal(questions, 0);
  assert.deepEqual(writes, []);
});
test('cancelled questions cannot approve a plan even if the questioner resolves late', async () => {
  const controller = new AbortController();
  const { writes, execute, run } = planning(async () => {
    controller.abort(new Error('cancelled'));
    return { answered: true, answers: [{ id: 'plan', selected: ['Approve and execute'] }] };
  });
  const result = await execute('exit_plan_mode', body, controller.signal);
  assert.equal(result.isError, true);
  assert.deepEqual(writes, []);
  assert.equal(run.takeApproval(), undefined);
});
