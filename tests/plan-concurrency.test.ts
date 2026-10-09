import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SqlitePlanStore } from '../packages/storage/plans.ts';

const body = { title: 'First proposal', summary: 'Reviewed work', steps: ['First step'] };
const competingBody = { title: 'Competing proposal', summary: 'Other work', steps: ['Other step'] };

function connectedPlans(t: test.TestContext) {
  const scratch = resolve('.scratch');
  mkdirSync(scratch, { recursive: true });
  const directory = mkdtempSync(join(scratch, 'plan-concurrency-'));
  const firstDb = new DatabaseSync(join(directory, 'plans.sqlite'));
  firstDb.exec(`CREATE TABLE plans (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL, run_id TEXT, status TEXT NOT NULL,
    title TEXT NOT NULL, summary TEXT NOT NULL, steps TEXT NOT NULL, hash TEXT NOT NULL,
    reason TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, approved_at TEXT
  )`);
  const secondDb = new DatabaseSync(join(directory, 'plans.sqlite'));
  t.after(() => {
    secondDb.close();
    firstDb.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    first: new SqlitePlanStore(firstDb, () => {}),
    second: new SqlitePlanStore(secondDb, () => {}),
    secondDb,
  };
}

// Preserve the real read, then let the other connection win before the first write.
function afterNextRead(store: SqlitePlanStore, action: () => void) {
  const getPlan = store.getPlan.bind(store);
  store.getPlan = (sessionId, planId) => {
    store.getPlan = getPlan;
    const plan = getPlan(sessionId, planId);
    action();
    return plan;
  };
}

test('stale approval cannot overwrite rejection on another SQLite connection', (t) => {
  const { first, second } = connectedPlans(t);
  const plan = first.createPlan('session');
  const proposed = first.submitPlan('session', plan.id, body);
  afterNextRead(first, () => second.rejectPlan('session', plan.id, 'Declined'));
  assert.throws(() => first.approvePlan('session', plan.id, proposed.hash), /changed|conflict/i);
  const remaining = second.getPlan('session', plan.id);
  assert.equal(remaining.status, 'rejected');
  assert.equal(remaining.reason, 'Declined');
  assert.equal(remaining.approvedAt, undefined);
});

test('approval refuses a hash witness changed after validation', (t) => {
  const { first, second, secondDb } = connectedPlans(t);
  const plan = first.createPlan('session');
  const proposed = first.submitPlan('session', plan.id, body);
  afterNextRead(first, () => {
    secondDb
      .prepare('UPDATE plans SET title=?, hash=? WHERE id=?')
      .run('Changed work', 'changed', plan.id);
  });
  assert.throws(() => first.approvePlan('session', plan.id, proposed.hash), /changed|conflict/i);
  const remaining = second.getPlan('session', plan.id);
  assert.equal(remaining.status, 'proposed');
  assert.equal(remaining.title, 'Changed work');
  assert.equal(remaining.hash, 'changed');
  assert.equal(remaining.approvedAt, undefined);
});

test('stale submission cannot overwrite a competing rejection', (t) => {
  const { first, second } = connectedPlans(t);
  const plan = first.createPlan('session');
  afterNextRead(first, () => second.rejectPlan('session', plan.id, 'Stopped planning'));
  assert.throws(() => first.submitPlan('session', plan.id, body), /changed|conflict/i);
  const remaining = second.getPlan('session', plan.id);
  assert.equal(remaining.status, 'rejected');
  assert.equal(remaining.title, '');
  assert.equal(remaining.reason, 'Stopped planning');
});

test('stale submission cannot overwrite a competing proposal', (t) => {
  const { first, second } = connectedPlans(t);
  const plan = first.createPlan('session');
  afterNextRead(first, () => second.submitPlan('session', plan.id, competingBody));
  assert.throws(() => first.submitPlan('session', plan.id, body), /changed|conflict/i);
  const remaining = second.getPlan('session', plan.id);
  assert.equal(remaining.status, 'proposed');
  assert.equal(remaining.title, 'Competing proposal');
});

test('stale rejection cannot discard a competing proposal', (t) => {
  const { first, second } = connectedPlans(t);
  const plan = first.createPlan('session');
  afterNextRead(first, () => second.submitPlan('session', plan.id, competingBody));
  assert.throws(() => first.rejectPlan('session', plan.id, 'Stale decision'), /changed|conflict/i);
  const remaining = second.getPlan('session', plan.id);
  assert.equal(remaining.status, 'proposed');
  assert.equal(remaining.title, 'Competing proposal');
  assert.equal(remaining.reason, undefined);
});

test('stale rejection cannot overwrite a competing approval', (t) => {
  const { first, second } = connectedPlans(t);
  const plan = first.createPlan('session');
  const proposed = first.submitPlan('session', plan.id, body);
  afterNextRead(first, () => second.approvePlan('session', plan.id, proposed.hash));
  assert.throws(() => first.rejectPlan('session', plan.id, 'Stale decision'), /changed|conflict/i);
  const remaining = second.getPlan('session', plan.id);
  assert.equal(remaining.status, 'approved');
  assert.equal(remaining.reason, undefined);
  assert.ok(remaining.approvedAt);
});

test('rejection refuses a plan whose hash changed without a status transition', (t) => {
  const { first, second, secondDb } = connectedPlans(t);
  const plan = first.createPlan('session');
  first.submitPlan('session', plan.id, body);
  afterNextRead(first, () => {
    secondDb.prepare('UPDATE plans SET hash=? WHERE id=?').run('changed', plan.id);
  });
  assert.throws(() => first.rejectPlan('session', plan.id), /changed|conflict/i);
  assert.equal(second.getPlan('session', plan.id).status, 'proposed');
});

test('submission refuses a planning row whose hash changed after validation', (t) => {
  const { first, second, secondDb } = connectedPlans(t);
  const plan = first.createPlan('session');
  afterNextRead(first, () => {
    secondDb.prepare('UPDATE plans SET hash=? WHERE id=?').run('changed', plan.id);
  });
  assert.throws(() => first.submitPlan('session', plan.id, body), /changed|conflict/i);
  const remaining = second.getPlan('session', plan.id);
  assert.equal(remaining.status, 'planning');
  assert.equal(remaining.hash, 'changed');
});

test('run linking reports a missing plan or a plan in another session', (t) => {
  const { first, second } = connectedPlans(t);
  const plan = first.createPlan('session');
  assert.throws(() => first.linkPlanRun('session', 'missing', 'run'), /Plan not found/);
  assert.throws(() => first.linkPlanRun('other', plan.id, 'run'), /Plan not found/);
  assert.equal(second.getPlan('session', plan.id).runId, undefined);
});

test('accepted submission returns current run metadata changed after its validation read', (t) => {
  const { first, second } = connectedPlans(t);
  const plan = first.createPlan('session', 'initial-run');
  afterNextRead(first, () => second.linkPlanRun('session', plan.id, 'active-run'));
  const proposed = first.submitPlan('session', plan.id, body);
  assert.equal(proposed.status, 'proposed');
  assert.equal(proposed.runId, 'active-run');
});

test('accepted submission returns its own decision rather than a subsequent rejection', (t) => {
  const { first, second } = connectedPlans(t);
  const plan = first.createPlan('session');
  const getPlan = first.getPlan.bind(first);
  let reads = 0;
  first.getPlan = (sessionId, planId) => {
    if (++reads === 2) second.rejectPlan(sessionId, planId, 'Later rejection');
    return getPlan(sessionId, planId);
  };
  assert.equal(first.submitPlan('session', plan.id, body).status, 'proposed');
});
