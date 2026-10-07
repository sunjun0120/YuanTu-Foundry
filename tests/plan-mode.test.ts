import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Agent } from '../packages/core/agent.ts';
import { AgentHostClient } from '../packages/client/host-client.ts';
import { SCHEMA_VERSION, SessionStore } from '../packages/storage/sqlite.ts';
import { createTools } from '../packages/tools/index.ts';
import { newGoal } from '../packages/protocol/goals.ts';
import { httpFixture, frames, sendFrames, systemText } from './http-fixture.ts';
import { projectRoot, runCli } from './process-fixture.ts';
import type {
  AgentEvent,
  ModelResponse,
  Plan,
  Provider,
  Questioner,
} from '../packages/protocol/index.ts';

async function setup(t: test.TestContext, handler: Parameters<typeof httpFixture>[1]) {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-plan-'));
  const url = await httpFixture(t, handler);
  const client = new AgentHostClient({
    nodePath: process.execPath,
    hostPath: path.join(projectRoot, 'apps/agent-host/main.ts'),
    workspace: root,
    env: {
      YUANTU_MODEL: 'fixture',
      YUANTU_MAX_CONTEXT_TOKENS: '128000',
      YUANTU_SESSION_TITLES: '0',
      YUANTU_API_KEY: 'test',
      YUANTU_PROTOCOL: 'anthropic',
      YUANTU_BASE_URL: url,
    },
  });
  t.after(async () => {
    await client.stop();
    await rm(root, { recursive: true, force: true });
  });
  await client.start();
  return { root, client };
}
const exists = async (file: string) => {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
};

test('the CLI plans read-only, prints the approval witness, and gates execution on it', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-plan-cli-'));
  const url = await httpFixture(t, (_body, res) => {
    // The planning call tries to write; the execution call answers plainly.
    if (attempts++ === 0)
      return sendFrames(
        res,
        frames('', [
          { id: 'w', name: 'write_file', input: { path: 'created.txt', content: 'written' } },
        ]),
      );
    if (attempts === 2)
      return sendFrames(
        res,
        frames('', [
          {
            id: 'p',
            name: 'submit_plan',
            input: { title: 'CLI plan', summary: 'Two steps', steps: ['First', 'Second'] },
          },
        ]),
      );
    return sendFrames(res, frames('Executed by CLI'));
  });
  let attempts = 0;
  const db = path.join(root, 'sessions.sqlite');
  const env = {
    YUANTU_MODEL: 'fixture',
    YUANTU_MAX_CONTEXT_TOKENS: '128000',
    YUANTU_SESSION_TITLES: '0',
    YUANTU_API_KEY: 'test',
    YUANTU_PROTOCOL: 'anthropic',
    YUANTU_BASE_URL: url,
  };
  t.after(() => rm(root, { recursive: true, force: true }));
  const base = ['--workspace', root, '--db', db, '--json'];

  const planned = await runCli(['plan', 'Add the feature', ...base], env);
  assert.equal(planned.code, 0, planned.stderr);
  const planLine = planned.stdout
    .split('\n')
    .map((line) => {
      try {
        return JSON.parse(line) as { type?: string; plan?: Plan; approveCommand?: string };
      } catch {
        return {};
      }
    })
    .find((entry) => entry.type === 'plan');
  assert.ok(planLine?.plan, `expected a plan line, saw: ${planned.stdout}`);
  const plan = planLine!.plan!;
  assert.equal(plan.status, 'proposed');
  assert.deepEqual(
    plan.steps.map((step) => step.description),
    ['First', 'Second'],
  );
  // A planning run must not have written anything, even though the model asked to.
  assert.equal(await exists(path.join(root, 'created.txt')), false);

  // The printed command carries the reviewed hash, which is what makes the approval meaningful.
  assert.match(planLine!.approveCommand!, new RegExp(plan.hash));
  assert.ok(
    planLine!.approveCommand!.includes('--db'),
    'the approval command must preserve the database route',
  );
  assert.ok(
    planLine!.approveCommand!.includes(db),
    'the same database must contain the reviewed plan',
  );

  const shown = await runCli(
    ['plan-show', plan.sessionId, '--workspace', root, '--db', db, '--json'],
    env,
  );
  assert.equal(shown.code, 0, shown.stderr);
  const shownPlan = JSON.parse(shown.stdout.trim()) as { plan: Plan };
  assert.equal(shownPlan.plan.hash, plan.hash);

  // A hash the reviewer never saw is refused, and nothing executes.
  const wrong = await runCli(['plan-execute', plan.sessionId, plan.id, 'nothash', ...base], env);
  assert.notEqual(wrong.code, 0);
  assert.match(wrong.stderr, /does not match this plan/);
  assert.equal(await exists(path.join(root, 'created.txt')), false);

  const executed = await runCli(['plan-execute', plan.sessionId, plan.id, plan.hash, ...base], env);
  assert.equal(executed.code, 0, executed.stderr);
  assert.match(executed.stdout, /Executed by CLI/);
  const store = new SessionStore(db);
  try {
    assert.equal(store.getPlan(plan.sessionId, plan.id).status, 'approved');
  } finally {
    store.close();
  }
});

test('a session that stopped mid-plan resumes as a planning run, not as an ordinary one', async (t) => {
  /**
   * Plan mode is a promise that this run cannot change anything, and it lived only in the request that started it:
   * `plan` created the row and passed `planPhase`, `resume` passed neither — so a session whose planning run ended
   * without submitting (the user's Stop, a lost terminal, a crash) came back with the full tool set, and a write it
   * made would have been refused a moment earlier.
   *
   * The row is the state, and this is the whole of it: a plan still `planning` means nobody has decided anything
   * yet, so continuing means continuing to plan. The second run below both asserts the read-only promise (a write
   * is refused and nothing is created) and ends the way a planning run does, by submitting the plan the first run
   * never got to.
   */
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-plan-resume-'));
  let calls = 0;
  const url = await httpFixture(t, (_body, res) => {
    calls++;
    // The first run: a write the planning phase refuses, then an answer that decides nothing — the row stays
    // `planning`, which is the state a Stop or a lost terminal leaves behind.
    if (calls === 1)
      return sendFrames(
        res,
        frames('', [
          { id: 'w', name: 'write_file', input: { path: 'created.txt', content: 'written' } },
        ]),
      );
    if (calls === 2) return sendFrames(res, frames('Still looking around'));
    // The resumed run submits the plan, and that is only possible if it is a planning run: `submit_plan` is
    // registered for the planning phase alone, so an ordinary run would answer "Unknown tool" and the row would
    // stay `planning`.
    if (calls === 3)
      return sendFrames(
        res,
        frames('', [
          {
            id: 'p',
            name: 'submit_plan',
            input: { title: 'Resumed plan', summary: 'Still planning', steps: ['First'] },
          },
        ]),
      );
    return sendFrames(res, frames('Plan recorded, nothing executed'));
  });
  const db = path.join(root, 'sessions.sqlite');
  const env = {
    YUANTU_MODEL: 'fixture',
    YUANTU_MAX_CONTEXT_TOKENS: '128000',
    YUANTU_SESSION_TITLES: '0',
    YUANTU_API_KEY: 'test',
    YUANTU_PROTOCOL: 'anthropic',
    YUANTU_BASE_URL: url,
  };
  t.after(() => rm(root, { recursive: true, force: true }));
  const base = ['--workspace', root, '--db', db, '--json'];

  // A planning run that stops without submitting — the interrupted case, which leaves the row at `planning`.
  const planned = await runCli(['plan', 'Add the feature', ...base], env);
  assert.equal(planned.code, 0, planned.stderr);
  const store = new SessionStore(db);
  let sessionId = '';
  let planId = '';
  try {
    sessionId = store.list('', root)[0]!.id;
    const plan = store.latestPlan(sessionId);
    assert.ok(plan, 'the planning run created its row');
    planId = plan.id;
    assert.equal(plan.status, 'planning', 'it never reached a decision');
  } finally {
    store.close();
  }
  assert.equal(await exists(path.join(root, 'created.txt')), false);

  const resumed = await runCli(['resume', sessionId, 'continue planning', ...base], env);
  assert.equal(resumed.code, 0, resumed.stderr);
  const reopened = new SessionStore(db);
  try {
    assert.equal(
      reopened.getPlan(sessionId, planId).status,
      'proposed',
      'the resumed run finished the planning it was in the middle of',
    );
  } finally {
    reopened.close();
  }
  // The read-only promise held across the restart: the write the model asked for in the resumed run is not there.
  assert.equal(
    await exists(path.join(root, 'created.txt')),
    false,
    'a resumed planning run is still read-only',
  );
});

test('a planning run started by resume does not spend the goal rounds', async (t) => {
  /**
   * `resume` is also one of the two front doors the goal loop continues through, and a planning run may not
   * touch the goal at all: the goal tools are not registered in that phase, so a round started for it would be
   * spent on work the run cannot do. On the resume path it would be worse than idle — a continuation is an
   * ordinary run, which is the escape that resuming mid-plan exists to close.
   *
   * The seeded goal has exactly one round left, so a continuation the loop should not have started is a round
   * the loop takes: the second fixture call and the moved `roundsStarted` are both the failure.
   */
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-plan-goal-'));
  let calls = 0;
  const url = await httpFixture(t, (_body, res) => {
    calls++;
    // The planning run submits its plan, which ends it: submitting is the last act of the phase. Every call
    // after that one is a goal round this invocation should never have started.
    if (calls === 1)
      return sendFrames(
        res,
        frames('', [
          {
            id: 'p',
            name: 'submit_plan',
            input: { title: 'Resumed plan', summary: 'Still planning', steps: ['First'] },
          },
        ]),
      );
    return sendFrames(res, frames('Carrying the goal forward'));
  });
  const db = path.join(root, 'sessions.sqlite');
  const env = {
    YUANTU_MODEL: 'fixture',
    YUANTU_MAX_CONTEXT_TOKENS: '128000',
    YUANTU_SESSION_TITLES: '0',
    YUANTU_API_KEY: 'test',
    YUANTU_PROTOCOL: 'anthropic',
    YUANTU_BASE_URL: url,
  };
  t.after(() => rm(root, { recursive: true, force: true }));
  // A session that stopped mid-plan *and* is carrying a goal: the plan was never decided, the objective is
  // still open, and one round of its budget is left.
  const seeded = new SessionStore(db);
  let sessionId = '';
  try {
    sessionId = seeded.create(root).id;
    seeded.recordEvent(sessionId, 'goal.changed', {
      action: 'create',
      goal: {
        ...newGoal({ objective: 'Ship the loader', maxGoalRounds: 3 }, new Date().toISOString()),
        roundsStarted: 2,
      },
    });
    seeded.createPlan(sessionId);
    assert.equal(seeded.goal(sessionId)?.roundsStarted, 2);
  } finally {
    seeded.close();
  }

  const resumed = await runCli(
    ['resume', sessionId, 'continue planning', '--db', db, '--json'],
    env,
  );
  assert.equal(resumed.code, 0, resumed.stderr);
  const after = new SessionStore(db);
  try {
    assert.equal(after.goal(sessionId)?.roundsStarted, 2, 'a planning run admits no goal round');
    assert.equal(
      after.latestPlan(sessionId)?.status,
      'proposed',
      'it was still the planning phase',
    );
  } finally {
    after.close();
  }
  assert.equal(calls, 1, 'the plan was submitted, and no continuation round was started');
});

test('a session whose plan is still planning continues planning, not writing', async (t) => {
  /**
   * Plan mode is a promise that the run cannot change anything, and the durable plan row is what carries it
   * between runs — the *request* that started the planning is long gone. The CLI already continues planning when
   * `resume` finds a `planning` row; the Host decided the phase from the request alone, so the same session
   * reached from a client that does not send `phase` came back as an ordinary run with the full tool set: the
   * write it then made would have been refused a moment earlier.
   *
   * The row is seeded directly because that is the point — it is durable state, and it does not matter which
   * process wrote it. What the run is *told* decides whether this is plan mode, so the request is what is
   * asserted: the read-only catalogue, and the planning instruction.
   */
  let offered: string[] = [];
  let system = '';
  const { root, client } = await setup(t, (body, res) => {
    offered = ((body as { tools?: { name: string }[] }).tools ?? []).map((tool) => tool.name);
    system = systemText((body as { system?: unknown }).system);
    return sendFrames(res, frames('Still looking around.'));
  });
  await client.start();
  const session = (await client.request('session.create', {})) as { id: string };
  const store = new SessionStore(path.join(root, '.yuantu', 'sessions.sqlite'));
  let plan: Plan;
  try {
    plan = store.createPlan(session.id);
    assert.equal(plan.status, 'planning');
  } finally {
    store.close();
  }

  const result = (await client.request('run.start', {
    sessionId: session.id,
    prompt: '继续',
  })) as { status: string };
  assert.equal(result.status, 'completed', JSON.stringify(result));
  assert.ok(offered.includes('read_file'), `read-only tools stay available: ${offered.join(',')}`);
  assert.equal(
    offered.includes('write_file'),
    false,
    `a planning session must not be offered the tools that write: ${offered.join(',')}`,
  );
  assert.match(system, /Planning mode: you have read-only tools/);
  // And it is still *this* plan that is being filled, rather than a second row appearing beside it.
  const reopened = new SessionStore(path.join(root, '.yuantu', 'sessions.sqlite'));
  try {
    assert.equal(reopened.latestPlan(session.id)?.id, plan.id);
    assert.equal(reopened.latestPlan(session.id)?.status, 'planning');
  } finally {
    reopened.close();
  }
});

test('the plan mode a session is in is read from its newest plan row', async (t) => {
  /**
   * The rule both hosts ask, pinned where it lives now: only a plan nobody has decided anything about is plan
   * mode. Every other status is a recorded decision — submitted, approved, rejected, or the abandonment a dead run
   * leaves behind — and continuing to plan after one of those would ignore what was already decided.
   */
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-plan-mode-'));
  const store = new SessionStore(path.join(root, 'sessions.sqlite'));
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const session = store.create(root);
  assert.equal(store.planMode(session.id), null, 'a session with no plan is not planning');
  const plan = store.createPlan(session.id);
  assert.deepEqual(store.planMode(session.id), { planId: plan.id });
  store.submitPlan(session.id, plan.id, { title: 'T', summary: 'why', steps: ['one'] });
  assert.equal(
    store.planMode(session.id),
    null,
    'a submitted plan awaits a human, not another planning run',
  );
  store.approvePlan(session.id, plan.id, store.getPlan(session.id, plan.id).hash);
  assert.equal(store.planMode(session.id), null);
  // A second, newer row is what "the newest plan" means — including when the older one is still planning.
  const next = store.createPlan(session.id);
  assert.deepEqual(store.planMode(session.id), { planId: next.id });
  /**
   * And a row a person rejected is a decision too. The `abandoned` status — what the sweep that settles a dead
   * run's plan writes — is reached the same way in `tests/host-reconnect.test.ts`, through a real restart, which
   * is the only honest way to produce it: the sweep only settles runs whose owner process is gone.
   */
  store.rejectPlan(session.id, next.id, 'not this');
  assert.equal(store.planMode(session.id), null, 'a rejected plan is not a plan mode to continue');
});

test('discarding a plan nobody submitted is how a session leaves plan mode', async (t) => {
  /**
   * The escape hatch the derived phase needs. A session with a `planning` row continues planning, so if that row
   * could not be discarded a person who changed their mind would be pinned to a read-only session. The panel
   * offers the action; this is the same rule where the decision is actually made — rejecting a row that never
   * carried a body is allowed, and it is what puts the session back in write mode.
   */
  let offered: string[] = [];
  const { root, client } = await setup(t, (body, res) => {
    offered = ((body as { tools?: { name: string }[] }).tools ?? []).map((tool) => tool.name);
    return sendFrames(res, frames('Done'));
  });
  await client.start();
  const session = (await client.request('session.create', {})) as { id: string };
  const store = new SessionStore(path.join(root, '.yuantu', 'sessions.sqlite'));
  let plan: Plan;
  try {
    plan = store.createPlan(session.id);
  } finally {
    store.close();
  }
  const discarded = (await client.request('plan.reject', {
    sessionId: session.id,
    planId: plan.id,
    reason: 'changed my mind',
  })) as Plan;
  assert.equal(discarded.status, 'rejected');
  assert.equal(discarded.reason, 'changed my mind');

  await client.request('run.start', { sessionId: session.id, prompt: '就按刚才说的改' });
  assert.ok(
    offered.includes('write_file'),
    `a session out of plan mode gets the tools that write: ${offered.join(',')}`,
  );
});

test('the planning phase is read-only and ends with a proposed plan', async (t) => {
  let call = 0;
  let offered: string[] = [];
  const { root, client } = await setup(t, (body, res) => {
    call++;
    // Captured from every request: the planning run ends on `submit_plan`, so there is no later call.
    offered = ((body as { tools?: { name: string }[] }).tools ?? []).map((tool) => tool.name);
    if (call === 1)
      return sendFrames(
        res,
        frames('Looking around.', [
          { id: 'w', name: 'write_file', input: { path: 'created.txt', content: 'written' } },
        ]),
      );
    if (call === 2)
      return sendFrames(
        res,
        frames('', [
          {
            id: 'p',
            name: 'submit_plan',
            input: {
              title: 'Add the feature',
              summary: 'Do it in two steps',
              steps: ['Read', 'Change'],
            },
          },
        ]),
      );
    offered = ((body as { tools?: { name: string }[] }).tools ?? []).map((tool) => tool.name);
    return sendFrames(res, frames('Executed'));
  });
  const info = await client.start();
  assert.ok(
    info.capabilities.includes('plan-approval'),
    'the host must advertise plan approval so a client can negotiate it',
  );
  const session = (await client.request('session.create', {})) as { id: string };
  const events: string[] = [];
  client.subscribe((event) => events.push(event.type));
  const result = (await client.request('run.start', {
    sessionId: session.id,
    prompt: 'plan the feature',
    phase: 'plan',
  })) as { status: string };
  assert.equal(result.status, 'completed');
  assert.ok(events.includes('plan.proposed'), `expected plan.proposed, saw ${events.join(',')}`);
  /**
   * The two assertions that actually pin the read-only guarantee.
   *
   * It must not rest on the host's 120s approval timeout: that path would prompt the user for an
   * operation that can never be allowed, and would stall the planning run for two minutes first.
   */
  assert.equal(
    events.includes('approval.required'),
    false,
    'a planning run must never prompt for a mutating operation',
  );
  assert.equal(
    offered.includes('write_file'),
    false,
    'permission-requiring tools must not even be offered to the planner',
  );
  assert.ok(offered.includes('read_file'), 'read-only tools stay available to the planner');

  // The read-only guarantee: a scripted write attempt in the planning phase must have no effect.
  assert.equal(
    await exists(path.join(root, 'created.txt')),
    false,
    'planning must not be able to write files',
  );
  const plan = (await client.request('plan.get', { sessionId: session.id })) as Plan | null;
  assert.ok(plan);
  assert.equal(plan!.status, 'proposed');
  assert.equal(plan!.title, 'Add the feature');
  assert.deepEqual(
    plan!.steps.map((step) => step.description),
    ['Read', 'Change'],
  );
  assert.ok(plan!.hash.length === 64, 'the plan carries a body digest');
  assert.ok(plan!.runId, 'the plan records the run that produced it');
});

test('execution needs an approval whose hash still matches the plan', async (t) => {
  let call = 0;
  let system = '';
  const { client } = await setup(t, (body, res) => {
    call++;
    if (call === 1)
      return sendFrames(
        res,
        frames('', [
          {
            id: 'p',
            name: 'submit_plan',
            input: { title: 'Ship it', summary: 'Two steps', steps: ['One', 'Two'] },
          },
        ]),
      );
    system = systemText((body as { system?: unknown }).system);
    return sendFrames(res, frames('Executed'));
  });
  await client.start();
  const session = (await client.request('session.create', {})) as { id: string };
  await client.request('run.start', { sessionId: session.id, prompt: 'plan', phase: 'plan' });
  const plan = (await client.request('plan.get', { sessionId: session.id })) as Plan;

  // An unapproved plan cannot be executed: this is the gate the desktop /plan flow never had.
  await assert.rejects(
    client.request('run.start', { sessionId: session.id, prompt: 'go', planId: plan.id }),
    /has not been approved yet/,
  );

  // Approving text the reviewer never saw is refused.
  await assert.rejects(
    client.request('plan.approve', { sessionId: session.id, planId: plan.id, hash: 'deadbeef' }),
    /changed since it was reviewed/,
  );

  const approved = (await client.request('plan.approve', {
    sessionId: session.id,
    planId: plan.id,
    hash: plan.hash,
  })) as Plan;
  assert.equal(approved.status, 'approved');
  assert.ok(approved.approvedAt);

  // Now the same plan executes, and the approved text reaches the model.
  const executed = (await client.request('run.start', {
    sessionId: session.id,
    prompt: 'go',
    planId: plan.id,
  })) as { status: string };
  assert.equal(executed.status, 'completed');
  assert.match(system, /Approved plan/);
  assert.match(system, /Ship it/);
});

test('editing an approved plan invalidates the approval', async (t) => {
  let call = 0;
  const { root, client } = await setup(t, (_body, res) => {
    call++;
    if (call === 1)
      return sendFrames(
        res,
        frames('', [
          {
            id: 'p',
            name: 'submit_plan',
            input: { title: 'Original plan', summary: 's', steps: ['Only step'] },
          },
        ]),
      );
    return sendFrames(res, frames('Executed'));
  });
  await client.start();
  const session = (await client.request('session.create', {})) as { id: string };
  await client.request('run.start', { sessionId: session.id, prompt: 'plan', phase: 'plan' });
  const plan = (await client.request('plan.get', { sessionId: session.id })) as Plan;
  await client.request('plan.approve', { sessionId: session.id, planId: plan.id, hash: plan.hash });

  // Simulate an edit that happened after the approval: the body no longer matches the approved hash.
  const db = new DatabaseSync(path.join(root, '.yuantu', 'sessions.sqlite'));
  db.prepare('UPDATE plans SET title=? WHERE id=?').run('Swapped after approval', plan.id);
  db.close();

  await assert.rejects(
    client.request('run.start', { sessionId: session.id, prompt: 'go', planId: plan.id }),
    /changed after approval; review and approve it again/,
  );
});

test('a rejected plan cannot be executed and the phase cannot be smuggled', async (t) => {
  let call = 0;
  const { client } = await setup(t, (_body, res) => {
    call++;
    if (call === 1)
      return sendFrames(
        res,
        frames('', [{ id: 'p', name: 'submit_plan', input: { title: 'T', steps: ['S'] } }]),
      );
    return sendFrames(res, frames('Executed'));
  });
  await client.start();
  const session = (await client.request('session.create', {})) as { id: string };
  await client.request('run.start', { sessionId: session.id, prompt: 'plan', phase: 'plan' });
  const plan = (await client.request('plan.get', { sessionId: session.id })) as Plan;
  const rejected = (await client.request('plan.reject', {
    sessionId: session.id,
    planId: plan.id,
    reason: 'too vague',
  })) as Plan;
  assert.equal(rejected.status, 'rejected');
  assert.equal(rejected.reason, 'too vague');
  await assert.rejects(
    client.request('run.start', { sessionId: session.id, prompt: 'go', planId: plan.id }),
    /cannot be executed/,
  );
  // An unknown phase, and a planning run that also asks to execute a plan, are both refused rather
  // than silently treated as a normal run. The cast is deliberate: the transport type only admits
  // 'plan', so this covers a value that slips past a non-TypeScript client.
  await assert.rejects(
    client.request('run.start', {
      sessionId: session.id,
      prompt: 'x',
      phase: 'execute' as 'plan',
    }),
    /Invalid run phase/,
  );
  await assert.rejects(
    client.request('run.start', {
      sessionId: session.id,
      prompt: 'x',
      phase: 'plan',
      planId: plan.id,
    }),
    /cannot execute a task or an approved plan/,
  );
});

/**
 * `exit_plan_mode`: the in-run approval, as opposed to the two-run `submit_plan` flow above.
 *
 * The two share the store's `submitPlan`/`approvePlan`, so the hash the user reviews is the hash that is
 * approved whichever path is taken. What is new here is that the approval takes effect *inside* the run, and
 * these tests pin the three things that makes dangerous: that nothing is recorded before the answer, that the
 * lift happens at a step boundary rather than inside the asking round, and that a declined or missing answer
 * leaves the run exactly as read-only as it was.
 */
const reply = (text = 'Done'): ModelResponse => ({
  text,
  finishReason: 'stop',
  toolCalls: [],
  usage: { inputTokens: 10, outputTokens: 5 },
});
const toolCall = (id: string, name: string, args: Record<string, unknown>): ModelResponse => ({
  text: '',
  finishReason: 'tool_calls',
  toolCalls: [{ id, name, arguments: args }],
  usage: { inputTokens: 10, outputTokens: 5 },
});
const PLAN_ARGS = { title: 'Add the loader', summary: 'Two steps', steps: ['Write it', 'Test it'] };
async function planRun(
  t: test.TestContext,
  script: ModelResponse[],
  options: { question?: Questioner; approve?: () => Promise<boolean> } = {},
) {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-exit-plan-'));
  const store = new SessionStore(path.join(root, 'sessions.sqlite'));
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const session = store.create(root);
  const plan = store.createPlan(session.id);
  const events: AgentEvent[] = [];
  const requests: string[] = [];
  let round = 0;
  const provider: Provider = {
    async complete(request) {
      requests.push(systemText(request.system));
      const response = script[Math.min(round, script.length - 1)]!;
      round++;
      return response;
    },
  };
  const agent = new Agent({
    store,
    provider,
    tools: createTools(root),
    approve: options.approve ?? (async () => true),
    ...(options.question ? { question: options.question } : {}),
    onEvent: (event) => events.push(event),
  });
  const result = await agent.run({
    sessionId: session.id,
    prompt: 'Plan the loader',
    planPhase: true,
    planId: plan.id,
  });
  return {
    root,
    store,
    session,
    plan,
    events,
    result,
    /** The system prompt each round was sent, in order: what the model was actually told. */
    requests,
    /** What the model read back from each tool call, in order. */
    toolResults: () =>
      store
        .messages(session.id)
        .filter((message) => message.role === 'tool')
        .map((message) => ({
          isError: message.isError,
          content: String(message.content),
        })),
  };
}
const approveAnswer: Questioner = async () => ({
  answered: true,
  answers: [{ id: 'plan', selected: ['Approve and execute'] }],
});

test('an approved plan lifts read-only mode in the same run, and only from the next round', async (t) => {
  const asked: string[] = [];
  const run = await planRun(
    t,
    [
      toolCall('c1', 'exit_plan_mode', PLAN_ARGS),
      // The very next round writes. It must succeed, because the lift happens at the boundary between the two.
      toolCall('c2', 'write_file', { path: 'created.txt', content: 'written' }),
      reply(),
    ],
    {
      question: async (request) => {
        asked.push(request.questions[0]!.question);
        return approveAnswer(request, new AbortController().signal);
      },
    },
  );
  assert.equal(run.result.status, 'completed');
  assert.equal(await exists(path.join(run.root, 'created.txt')), true);
  // The question carried the plan itself, so the person approved text they could read.
  assert.match(asked[0]!, /Add the loader/);
  assert.match(asked[0]!, /1\. Write it/);
  assert.match(asked[0]!, /2\. Test it/);
  assert.match(asked[0]!, /Plan digest: [a-f0-9]{12}/);
  // The durable record is the plan row, approved through the same store call the panel uses.
  const stored = run.store.getPlan(run.session.id, run.plan.id);
  assert.equal(stored.status, 'approved');
  assert.ok(stored.approvedAt);
  assert.ok(
    run.events.some((event) => event.type === 'plan.approved'),
    'the client is told the plan was approved inside this run',
  );
  const results = run.toolResults();
  assert.equal(results[0]?.isError, false, results[0]?.content);
  assert.match(results[0]!.content, /approved this plan/);
  assert.equal(results[1]?.isError, false, results[1]?.content);
  // And the system prompt for the round that wrote said so, rather than still claiming read-only.
  const prompt = run.requests.at(-1)!;
  assert.match(prompt, /Read-only mode is over for this run/);
  assert.ok(!prompt.includes('Planning mode: you have read-only tools'));
  // The round that asked was still told it was read-only: the lift is a step boundary, not a mid-round switch.
  assert.match(run.requests[0]!, /Planning mode: you have read-only tools/);
});
test('declining the plan keeps this run read-only and records nothing', async (t) => {
  const run = await planRun(
    t,
    [
      toolCall('c1', 'exit_plan_mode', PLAN_ARGS),
      toolCall('c2', 'write_file', { path: 'created.txt', content: 'written' }),
      reply(),
    ],
    {
      question: async () => ({
        answered: true,
        answers: [{ id: 'plan', selected: ['Keep planning'], freeText: 'Use the existing loader' }],
      }),
    },
  );
  await assert.rejects(access(path.join(run.root, 'created.txt')));
  assert.equal(run.store.getPlan(run.session.id, run.plan.id).status, 'planning');
  assert.ok(!run.events.some((event) => event.type === 'plan.approved'));
  const results = run.toolResults();
  assert.match(results[0]!.content, /Use the existing loader/);
  assert.match(results[0]!.content, /still in planning mode/);
  assert.equal(results[1]?.isError, true, 'the write it attempted was refused');
});
test('an unanswered question records no plan and says to use submit_plan', async (t) => {
  const run = await planRun(t, [toolCall('c1', 'exit_plan_mode', PLAN_ARGS), reply()], {
    question: async () => ({ answered: false, answers: [], reason: 'timeout', timedOut: true }),
  });
  assert.equal(run.store.getPlan(run.session.id, run.plan.id).status, 'planning');
  const [first] = run.toolResults();
  assert.equal(first?.isError, true);
  assert.match(first!.content, /could not be asked \(timeout\)/);
  assert.match(first!.content, /Call submit_plan/);
});
test('a plan too long to put in one question is refused instead of approved unseen', async (t) => {
  let asked = 0;
  const run = await planRun(
    t,
    [
      toolCall('c1', 'exit_plan_mode', {
        title: 'Long plan',
        // Every step inside the schema's 500 characters, and the plan as a whole far past a question's budget:
        // the schema cannot express "too long to read", so the tool is the only place that can refuse it.
        steps: Array.from({ length: 40 }, (_, index) => `${index}. ${'x'.repeat(486)}`),
      }),
      reply(),
    ],
    {
      question: async () => {
        asked++;
        return { answered: true, answers: [{ id: 'plan', selected: ['Approve and execute'] }] };
      },
    },
  );
  assert.equal(
    asked,
    0,
    'the user is never asked to approve a plan they cannot read in the question',
  );
  assert.equal(run.store.getPlan(run.session.id, run.plan.id).status, 'planning');
  const [first] = run.toolResults();
  assert.equal(first?.isError, true);
  assert.match(first!.content, /too long to put in a question/);
  assert.match(first!.content, /submit_plan/);
});
test('without a questioner the planning run is offered submit_plan and not exit_plan_mode', async (t) => {
  const run = await planRun(t, [
    toolCall('c1', 'exit_plan_mode', PLAN_ARGS),
    toolCall('c2', 'submit_plan', PLAN_ARGS),
    reply(),
  ]);
  const [refused, submitted] = run.toolResults();
  assert.equal(refused?.isError, true);
  assert.match(refused!.content, /Unknown tool/);
  assert.equal(submitted?.isError, false, submitted?.content);
  assert.equal(run.store.getPlan(run.session.id, run.plan.id).status, 'proposed');
});
test('the plan-phase system prompt names the tool that can actually settle the plan', async (t) => {
  const withQuestion = await planRun(t, [toolCall('c1', 'submit_plan', PLAN_ARGS), reply()], {
    question: approveAnswer,
  });
  assert.match(withQuestion.requests[0]!, /exit_plan_mode/);
  const without = await planRun(t, [toolCall('c1', 'submit_plan', PLAN_ARGS), reply()]);
  const prompt = without.requests[0]!;
  assert.match(prompt, /call submit_plan exactly once/);
  assert.ok(!prompt.includes('exit_plan_mode'));
});

test('a database whose plans table predates the abandoned status is rebuilt on open', async (t) => {
  /**
   * The status vocabulary is a `CHECK`, and SQLite cannot widen one in place, so admitting `abandoned` is a table
   * rebuild — which means the migration is the kind that can lose data if it is wrong. This forges the old shape
   * (same rows, old constraint, old version) and asserts what a reopened database has: the row that was there, the
   * constraint that now admits the new status, and a stamped version.
   */
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-plan-migrate-'));
  const file = path.join(root, 'sessions.sqlite');
  const store = new SessionStore(file);
  /** Every handle this test opens, including the one it closes itself to forge the old shape. */
  const opened = [store];
  t.after(async () => {
    for (const handle of opened) {
      try {
        handle.close();
      } catch {
        /* The test closed this one on purpose: the file had to be free before it could be rewritten. */
      }
    }
    await rm(root, { recursive: true, force: true });
  });
  const session = store.create(root);
  const plan = store.createPlan(session.id);
  store.close();

  const legacy = new DatabaseSync(file);
  legacy.exec(`
    ALTER TABLE plans RENAME TO plans_v21;
    CREATE TABLE plans (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      run_id TEXT,
      status TEXT NOT NULL CHECK(status IN ('planning','proposed','approved','rejected')),
      title TEXT NOT NULL DEFAULT '',
      summary TEXT NOT NULL DEFAULT '',
      steps TEXT NOT NULL DEFAULT '[]',
      hash TEXT NOT NULL DEFAULT '',
      reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      approved_at TEXT
    );
    INSERT INTO plans SELECT * FROM plans_v21;
    DROP TABLE plans_v21;
    PRAGMA user_version=21;
  `);
  legacy.close();

  const reopened = new SessionStore(file);
  opened.push(reopened);
  const migrated = reopened.getPlan(session.id, plan.id);
  assert.equal(migrated.status, 'planning', 'the row is the row it was');
  assert.equal(migrated.sessionId, session.id);
  const shape = new DatabaseSync(file);
  try {
    assert.equal(shape.prepare('PRAGMA user_version').get()?.user_version, SCHEMA_VERSION);
    const sql = String(
      (shape.prepare("SELECT sql FROM sqlite_master WHERE name='plans'").get() as { sql?: string })
        ?.sql ?? '',
    );
    assert.match(sql, /'abandoned'/, 'the constraint the migration exists for');
    // The index went with the old table, so the migration has to put it back: it is what lists a session's plans.
    assert.ok(
      shape
        .prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='plans_session'")
        .get(),
      'plans_session survived the rebuild',
    );
  } finally {
    shape.close();
  }
});
