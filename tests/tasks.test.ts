import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeTaskDraft,
  initialTaskDraft,
  validateAcceptance,
} from '../packages/core/task-spec.ts';
import { mkdtemp, rm, mkdir, writeFile, readFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AgentHostClient } from '../packages/client/host-client.ts';
import { SessionStore } from '../packages/storage/sqlite.ts';
import { DatabaseSync } from 'node:sqlite';
import { TaskScheduler } from '../apps/agent-host/scheduler.ts';
import { recordTaskDelivery } from '../packages/core/task-deliveries.ts';
import { httpFixture, frames, sendFrames } from './http-fixture.ts';
import { projectRoot } from './process-fixture.ts';
import type { TaskTrigger, Task } from '../packages/protocol/index.ts';
import {
  dueTasks,
  matchesEvent,
  nextDailyRun,
  nextRunAt,
  normalizeTaskTrigger,
  triggerSource,
  latestScheduledAt,
} from '../packages/core/task-trigger.ts';
import { capturePathSnapshot, verifyAcceptance, MAX_CHECKS } from '../packages/core/acceptance.ts';
import { nextCalendarRun, latestCalendarRun } from '../packages/core/calendar.ts';

/** Han characters, for the cases that assert which language a generated string is in. */
const HAN = /\p{Script=Han}/u;
import type { AcceptanceSpec } from '../packages/core/acceptance.ts';

// ---- merged from task-spec.test.ts ----

test('the stored form of a task cannot promise more than the verifier can run', () => {
  /**
   * `validateAcceptance` is the list the *write* paths use, and it allowed 100 entries while `verifyAcceptance`
   * refuses more than 64. A task could therefore be created, stored, and then never verified: every run of it
   * ended as a failed attempt with a message about the work, when the definition was what could not run. The two
   * numbers are one number now, and it is the verifier's.
   */
  const build = (count: number) =>
    Array.from({ length: count }, (_, index) => ({
      description: `check ${index}`,
      met: false,
      check: { id: `c${index}`, kind: 'file-contains', path: 'out.txt', expected: 'ok' },
    }));
  assert.equal(
    validateAcceptance(build(MAX_CHECKS)).length,
    MAX_CHECKS,
    'the limit itself has to be storable',
  );
  assert.throws(
    () => validateAcceptance(build(MAX_CHECKS + 1)),
    new RegExp(`at most ${MAX_CHECKS}`),
    'one over the limit is refused where the task is written, not where it is run',
  );
});

test('a daily rule fires at the wall time it names, even on the day the clocks skip it', (t) => {
  /**
   * `setHours` cannot represent 02:30 on a spring-forward day, so it lands on 03:30 — a wall time the operator
   * never chose, for a rule that still claims to fire at 02:30. The explicit-zone path has always skipped such a
   * day (`calendar.ts`'s `wallClockInstant` answers nothing for it and `nextCalendarRun` moves on), so one rule
   * behaved two ways depending on whether a timezone was filled in — and `daily` is exactly the rule the desktop
   * leaves the timezone off for.
   *
   * The two spellings are asserted against each other, because that agreement is the property; a pair of
   * hard-coded instants would pin today's arithmetic rather than the rule.
   */
  const previous = process.env.TZ;
  process.env.TZ = 'America/New_York';
  t.after(() => {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  });
  // 2026-03-08 is the US spring-forward day: local 02:00 jumps to 03:00, so 02:30 does not exist on it.
  const after = new Date('2026-03-08T00:00:00-05:00');
  const host = nextDailyRun(150, after);
  assert.deepEqual(
    [host.getHours(), host.getMinutes()],
    [2, 30],
    `the rule fires at the time it names, not the one the gap pushed it to: ${host.toString()}`,
  );
  assert.equal(
    host.toISOString(),
    nextCalendarRun(150, 'America/New_York', after).toISOString(),
    'and the host-local path agrees with the zone-aware one',
  );
  // An ordinary day is untouched by the change.
  const ordinary = nextDailyRun(150, new Date('2026-03-10T00:00:00-04:00'));
  assert.deepEqual([ordinary.getHours(), ordinary.getMinutes()], [2, 30]);
});

test('a catch-up label never names a wall time the clocks skipped', (t) => {
  /**
   * The mirror of the case above, on the path that decides *which occurrence a late run is standing in for*.
   *
   * `latestScheduledAt` answers with the occurrence a catch-up run is recorded against, and the host-local branch
   * asked `setHours` for today's wall time — which on a spring-forward day is 03:30 for a rule that says 02:30.
   * That number is persisted as `scheduledAt`, so the rule ends up naming a time it never fires at. The
   * zone-aware path has always walked back to the previous day instead, so the property asserted here is the
   * agreement between the two spellings rather than a hard-coded instant.
   */
  const previous = process.env.TZ;
  process.env.TZ = 'America/New_York';
  t.after(() => {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  });
  // Noon on the US spring-forward day, so today's 02:30 is already in the past — and does not exist.
  const now = new Date('2026-03-08T12:00:00-04:00');
  const dueAt = '2026-03-07T02:30:00-05:00';
  const trigger: TaskTrigger = { kind: 'daily', enabled: true, atMinutes: 150, misfire: 'latest' };
  const label = latestScheduledAt(trigger, dueAt, now);
  assert.equal(
    label,
    latestCalendarRun(150, 'America/New_York', now).toISOString(),
    'the host-local path agrees with the zone-aware one',
  );
  assert.equal(
    label,
    new Date('2026-03-07T02:30:00-05:00').toISOString(),
    'the occurrence is the previous day, because the skipped day has no 02:30',
  );
  // An ordinary day still labels the same day's occurrence, so this is a skip rather than a shift.
  const ordinary = latestScheduledAt(
    trigger,
    '2026-03-09T02:30:00-04:00',
    new Date('2026-03-10T12:00:00-04:00'),
  );
  assert.equal(ordinary, new Date('2026-03-10T02:30:00-04:00').toISOString());
});

test('a check byte limit survives being stored', () => {
  /**
   * The `file-exact`/`file-contains` branch rebuilt a literal with only id/kind/path/expected, so an author's
   * `maxBytes` was dropped on the way in — and the consumer's forward of that field could never be anything but
   * undefined. The check silently compared against the 1 MB default, which is how a check written to fail an
   * oversized file passed instead.
   */
  const [stored] = validateAcceptance([
    {
      description: 'the file stays small',
      met: false,
      check: { id: 'a', kind: 'file-exact', path: 'out.txt', expected: 'ok', maxBytes: 4096 },
    },
  ]);
  assert.equal(stored!.check?.maxBytes, 4096);
  assert.throws(
    () =>
      validateAcceptance([
        {
          description: 'a limit that is not one',
          met: false,
          check: { id: 'a', kind: 'file-exact', path: 'out.txt', expected: 'ok', maxBytes: 0 },
        },
      ]),
    /maximum bytes/,
  );
});

test('task drafts have explicit pending steps and manual acceptance', () => {
  const draft = initialTaskDraft('plan', 'Implement a settings toggle');
  assert.ok(draft.steps.length > 0);
  assert.ok(draft.acceptance.length > 0);
  assert.ok(draft.acceptance.every((x) => !x.met && !x.check));
});

test('a draft is written in the language its caller names, and Chinese is still the default', () => {
  /**
   * The draft's steps and acceptance line are *generated* text, not copy the dictionary can translate: they land
   * in the fields a person then edits (`renderer-tasks.ts` writes them into `input.value`, which the DOM walker
   * does not visit), so the language has to be chosen where they are written. It used to be Chinese
   * unconditionally, which is what an English interface showed in its draft.
   *
   * The caller is the carrier command, which knows the interface language; a caller that says nothing keeps the
   * wording it has always produced, because that is what an older client sends.
   */
  const english = initialTaskDraft('plan', 'Implement a settings toggle', 'en-US');
  for (const step of english.steps) assert.doesNotMatch(step.description, HAN, step.description);
  assert.doesNotMatch(english.acceptance[0]!.description, HAN);
  assert.match(english.description, /Implement a settings toggle/, 'the request itself is content');

  const chinese = initialTaskDraft('plan', 'Implement a settings toggle', 'zh-CN');
  assert.match(chinese.steps[0]!.description, HAN);
  assert.match(chinese.acceptance[0]!.description, HAN);
  assert.deepEqual(
    initialTaskDraft('plan', 'x').steps,
    chinese.steps,
    'a caller that names no language keeps the wording it always got',
  );
});

test('draft editing cannot grant completion and validates executable checks', () => {
  const draft = normalizeTaskDraft({
    title: 'Task',
    description: 'Do work',
    steps: [{ description: 'Inspect', status: 'completed' }],
    acceptance: [
      {
        description: 'File exists',
        met: true,
        check: { id: 'a', kind: 'file-contains', path: 'a.txt', expected: 'ok' },
      },
    ],
  });
  assert.equal(draft.steps[0]!.status, 'pending');
  assert.equal(draft.acceptance[0]!.met, false);
  assert.throws(() =>
    normalizeTaskDraft({
      ...draft,
      acceptance: [{ description: 'Run', met: false, check: { id: 'a', kind: 'command' } }],
    }),
  );
  assert.throws(() => normalizeTaskDraft({ ...draft, acceptance: [] }));
  assert.throws(() =>
    normalizeTaskDraft({ ...draft, acceptance: [draft.acceptance[0], draft.acceptance[0]] }),
  );
});

test('preserves whitespace in exact content and command arguments', () => {
  const draft = initialTaskDraft('plan', 'work');
  const normalized = normalizeTaskDraft({
    ...draft,
    acceptance: [
      {
        description: 'Exact',
        check: { id: 'a', kind: 'file-exact', path: 'out.txt', expected: '  value\n' },
      },
      {
        description: 'Args',
        check: { id: 'b', kind: 'command', command: 'node', args: ['  value  ', ''] },
      },
    ],
  });
  assert.equal(normalized.acceptance[0]!.check!.expected, '  value\n');
  assert.deepEqual(normalized.acceptance[1]!.check!.args, ['  value  ', '']);
});

// ---- merged from task-schedule.test.ts ----

/**
 * Seed a workspace exactly as a previous Host process would have left it: a scheduled task that
 * was interrupted after banking one completed step. The Host opens `<workspace>/.yuantu/
 * sessions.sqlite`, so the fixture must write to the same file.
 */
async function seedInterrupted(root: string, trigger?: TaskTrigger) {
  const store = new SessionStore(path.join(root, '.yuantu', 'sessions.sqlite'));
  const session = store.create(root);
  const task = store.createTask(session.id, {
    title: 'Scheduled workflow',
    description: 'run the scheduled workflow',
    steps: [
      { description: 'gather inputs', status: 'pending' },
      { description: 'produce output', status: 'pending' },
    ],
    trigger: trigger ?? { kind: 'interval', enabled: true, everyMinutes: 60 },
  });
  const attempt = store.startTaskAttempt(session.id, task.id, { kind: 'run', trigger: 'interval' });
  store.checkpointTaskStep(session.id, task.id, {
    attemptId: attempt.id,
    index: 0,
    status: 'completed',
    note: 'inputs gathered',
  });
  store.finishTaskAttempt(session.id, task.id, attempt.id, {
    status: 'blocked',
    error: 'Host stopped before this task attempt finished.',
  });
  // The obligation came due while nothing was running, so the next Host start must pick it up.
  store.scheduleImmediateRun(session.id, task.id);
  store.close();
  return { sessionId: session.id, taskId: task.id };
}

test('a restarted Host resumes a missed scheduled task from its completed step', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-task-schedule-'));
  const seeded = await seedInterrupted(root);
  const bodies: string[] = [];
  const url = await httpFixture(t, (body, res) => {
    bodies.push(JSON.stringify(body));
    sendFrames(res, frames('RESUMED'));
  });
  const client = new AgentHostClient({
    nodePath: process.execPath,
    hostPath: path.join(projectRoot, 'apps/agent-host/main.ts'),
    workspace: root,
    env: {
      YUANTU_BASE_URL: url,
      YUANTU_MODEL: 'fixture',
      YUANTU_MAX_CONTEXT_TOKENS: '128000',
      YUANTU_SESSION_TITLES: '0',
      YUANTU_API_KEY: 'test',
      YUANTU_PROTOCOL: 'anthropic',
      YUANTU_WORKFLOW_INTERVAL_MS: '1000',
    },
  });
  t.after(async () => {
    await client.stop();
    await rm(root, { recursive: true, force: true });
  });
  await client.start();

  // Nothing in this test starts a run: the Host must do it on its own.
  const deadline = Date.now() + 20_000;
  while (!bodies.length && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 100));
  assert.ok(bodies.length, 'the Host never started the scheduled task');

  const first = bodies[0]!;
  assert.match(first, /already completed/);
  assert.match(first, /continue from step 1/);
  /**
   * The resume must not hand the model the original all-pending list — and it now travels in the conversation
   * rather than the system prompt (§3-4: the step list changes whenever a step is checkpointed, and a prompt
   * that changes throws the provider's cached prefix away).
   */
  const body = JSON.parse(first) as {
    system: { text: string }[];
    messages: { role: string; content: unknown }[];
  };
  const systemText = body.system.map((part) => part.text).join('\n');
  const conversation = body.messages
    .map((message) => {
      if (typeof message.content === 'string') return message.content;
      if (!Array.isArray(message.content)) return '';
      return message.content
        .map((part) =>
          part && typeof part === 'object' && 'text' in part
            ? String((part as { text: unknown }).text)
            : '',
        )
        .join('\n');
    })
    .join('\n');
  assert.match(conversation, /"status":"completed"/);
  assert.match(conversation, /"status":"in_progress"/);
  assert.match(conversation, /<runtime-context source="task">/);
  assert.ok(!systemText.includes('Approved task definition'), 'and not through the prompt');

  const opened = new SessionStore(path.join(root, '.yuantu', 'sessions.sqlite'));
  try {
    const attempts = opened.listTaskAttempts(seeded.sessionId, seeded.taskId);
    const resumed = attempts.at(-1)!;
    assert.equal(resumed.trigger, 'interval');
    assert.equal(resumed.resume, true);
    // The model request arrives before the run settles, so wait for the durable bookkeeping that
    // only the scheduler's completion path writes.
    const settle = Date.now() + 20_000;
    while (!opened.getTask(seeded.sessionId, seeded.taskId).lastRunAt && Date.now() < settle)
      await new Promise((resolve) => setTimeout(resolve, 100));
    const task = opened.getTask(seeded.sessionId, seeded.taskId);
    assert.ok(task.lastRunAt, 'the trigger clock was never re-armed');
    assert.ok(Date.parse(task.nextRunAt!) > Date.now(), 'the next occurrence is not in the future');
    assert.equal(task.attemptCount, 2);
    // The step completed before the restart is still recorded against the original attempt.
    const journal = opened.taskStepCheckpoints(seeded.sessionId, seeded.taskId);
    assert.equal(journal.length, 1);
    assert.equal(journal[0]!.attemptId, attempts[0]!.id);
  } finally {
    opened.close();
  }
});

test('task.trigger round-trips through the Host and gates unattended runs on enabled', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-task-trigger-rpc-'));
  const bodies: string[] = [];
  const url = await httpFixture(t, (body, res) => {
    bodies.push(JSON.stringify(body));
    sendFrames(res, frames('OK'));
  });
  const client = new AgentHostClient({
    nodePath: process.execPath,
    hostPath: path.join(projectRoot, 'apps/agent-host/main.ts'),
    workspace: root,
    env: {
      YUANTU_BASE_URL: url,
      YUANTU_MODEL: 'fixture',
      YUANTU_MAX_CONTEXT_TOKENS: '128000',
      YUANTU_SESSION_TITLES: '0',
      YUANTU_API_KEY: 'test',
      YUANTU_PROTOCOL: 'anthropic',
      YUANTU_WORKFLOW_INTERVAL_MS: '1000',
    },
  });
  t.after(async () => {
    await client.stop();
    await rm(root, { recursive: true, force: true });
  });
  await client.start();
  const session = await client.request('session.create', {});
  const task = await client.request('task.create', {
    sessionId: session.id,
    title: 'Guarded',
    steps: [{ description: 'one', status: 'pending' }],
  });
  assert.equal(task.trigger, undefined);

  const armed = await client.request('task.trigger', {
    sessionId: session.id,
    taskId: task.id,
    trigger: { kind: 'daily', enabled: false, atMinutes: 9 * 60 },
  });
  assert.deepEqual(armed.trigger, { kind: 'daily', enabled: false, atMinutes: 9 * 60 });
  assert.equal(armed.nextRunAt, undefined);
  // A disabled trigger must never start work, even after a full tick.
  await new Promise((resolve) => setTimeout(resolve, 2_500));
  assert.equal(bodies.length, 0);

  const enabled = await client.request('task.trigger', {
    sessionId: session.id,
    taskId: task.id,
    trigger: { kind: 'interval', enabled: true, everyMinutes: 60 },
  });
  assert.ok(enabled.nextRunAt);
  assert.deepEqual(
    await client.request('task.steps', { sessionId: session.id, taskId: task.id }),
    [],
  );
  // An interval trigger armed in the future must not fire immediately.
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  assert.equal(bodies.length, 0);

  const cleared = await client.request('task.trigger', {
    sessionId: session.id,
    taskId: task.id,
    trigger: null,
  });
  assert.equal(cleared.trigger, undefined);
  assert.equal(cleared.nextRunAt, undefined);
  await assert.rejects(
    client.request('task.trigger', {
      sessionId: session.id,
      taskId: task.id,
      trigger: { kind: 'interval', enabled: true, everyMinutes: 0 },
    }),
    /Invalid task trigger interval/,
  );
});

test('a task the busy Host could not start says so, until the run happens', async (t) => {
  /**
   * The surface for the record `packages/core/task-deliveries.ts` writes: a due moment the Host was too busy to
   * start is visible on the task a client reads, with the reason and the moment it was owed from, and it goes away
   * when the run that settles it happens. Without this the record would be durable and unread, and a person would
   * see only a task that ran late.
   */
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-task-waiting-'));
  const url = await httpFixture(t, (_body, res) => sendFrames(res, frames('OK')));
  const client = new AgentHostClient({
    nodePath: process.execPath,
    hostPath: path.join(projectRoot, 'apps/agent-host/main.ts'),
    workspace: root,
    env: {
      YUANTU_BASE_URL: url,
      YUANTU_MODEL: 'fixture',
      YUANTU_MAX_CONTEXT_TOKENS: '128000',
      YUANTU_SESSION_TITLES: '0',
      YUANTU_API_KEY: 'test',
      YUANTU_PROTOCOL: 'anthropic',
    },
  });
  t.after(async () => {
    await client.stop();
    await rm(root, { recursive: true, force: true });
  });
  await client.start();
  const session = await client.request('session.create', {});
  const task = await client.request('task.create', {
    sessionId: session.id,
    title: 'Nightly',
    description: 'the work',
    steps: [{ description: 'one', status: 'pending' }],
  });
  // A trigger is armed by its own call; the row it produces carries `nextRunAt`, which is the moment a delivery
  // is about.
  const armed = (await client.request('task.trigger', {
    sessionId: session.id,
    taskId: task.id,
    trigger: { kind: 'interval', enabled: true, everyMinutes: 30 },
  })) as Task;
  assert.ok(armed.nextRunAt, 'an armed trigger names the next moment');
  // Nothing is owed yet, so there is nothing to say.
  const quiet = (await client.request('task.list', { sessionId: session.id })) as Task[];
  assert.equal(quiet[0]!.waiting, undefined);

  // The record a busy scheduler writes, written here by the same function it uses.
  const store = new SessionStore(path.join(root, '.yuantu', 'sessions.sqlite'));
  try {
    recordTaskDelivery(store, session.id, {
      dueAt: armed.nextRunAt!,
      reason: 'busy',
      tasks: [{ id: task.id, title: task.title }],
      recordedAt: new Date().toISOString(),
    });
  } finally {
    store.close();
  }
  const waiting = (await client.request('task.list', { sessionId: session.id })) as Task[];
  assert.deepEqual(waiting[0]!.waiting, { since: armed.nextRunAt, reason: 'busy' });
  const single = (await client.request('task.get', {
    sessionId: session.id,
    taskId: task.id,
  })) as Task;
  assert.deepEqual(single.waiting, { since: armed.nextRunAt, reason: 'busy' });

  // The run happened: it is no longer owed, and the field is gone rather than stale.
  const settled = new SessionStore(path.join(root, '.yuantu', 'sessions.sqlite'));
  try {
    settled.recordTaskRun(session.id, task.id, {
      at: new Date(Date.parse(armed.nextRunAt!) + 1_000).toISOString(),
    });
  } finally {
    settled.close();
  }
  const done = (await client.request('task.list', { sessionId: session.id })) as Task[];
  assert.equal(done[0]!.waiting, undefined);
});

test('event triggers run a dependent task when its source completes', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-task-event-'));
  const bodies: string[] = [];
  const url = await httpFixture(t, (body, res) => {
    bodies.push(JSON.stringify(body));
    /**
     * The source task's own round records progress before it answers.
     *
     * A completed task now requires its declared steps to be completed and its acceptance to be satisfiable, so a
     * fixture that only ever answers in prose can no longer produce the `task.completed` this test chains on.
     */
    if (bodies.length === 1)
      sendFrames(
        res,
        frames('OK', [
          { id: 'step-1', name: 'task_step', input: { index: 0, status: 'completed' } },
        ]),
      );
    else sendFrames(res, frames('OK'));
  });
  const client = new AgentHostClient({
    nodePath: process.execPath,
    hostPath: path.join(projectRoot, 'apps/agent-host/main.ts'),
    workspace: root,
    env: {
      YUANTU_BASE_URL: url,
      YUANTU_MODEL: 'fixture',
      YUANTU_MAX_CONTEXT_TOKENS: '128000',
      YUANTU_SESSION_TITLES: '0',
      YUANTU_API_KEY: 'test',
      YUANTU_PROTOCOL: 'anthropic',
      YUANTU_WORKFLOW_INTERVAL_MS: '1000',
    },
  });
  t.after(async () => {
    await client.stop();
    await rm(root, { recursive: true, force: true });
  });
  await client.start();
  const session = await client.request('session.create', {});
  // The source task's criterion is a file that is already there, so a clean finish can satisfy it.
  await writeFile(path.join(root, 'marker.txt'), 'ok');
  const source = await client.request('task.create', {
    sessionId: session.id,
    title: 'Source task',
    description: 'source work',
    steps: [{ description: 'one', status: 'pending' }],
    acceptance: [
      {
        description: 'marker file matches',
        met: false,
        check: { id: 'marker', kind: 'file-contains', path: 'marker.txt', expected: 'ok' },
      },
    ],
  });
  const dependent = await client.request('task.create', {
    sessionId: session.id,
    title: 'Dependent task',
    description: 'dependent work',
    steps: [{ description: 'one', status: 'pending' }],
  });
  await client.request('task.trigger', {
    sessionId: session.id,
    taskId: dependent.id,
    trigger: { kind: 'event', enabled: true, on: 'task.completed', taskId: source.id },
  });

  // Running the source to completion must chain into the dependent task without a second request.
  await client.request('run.start', {
    sessionId: session.id,
    taskId: source.id,
    prompt: 'do source',
  });
  const deadline = Date.now() + 20_000;
  // Waited for by *content* rather than by request count: the source's own round needs a second request to close
  // (the checkpoint is a tool call, and a run does not end on one), so counting requests would race the chain.
  while (!bodies.some((body) => /dependent work/.test(body)) && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 100));
  assert.ok(
    bodies.some((body) => /dependent work/.test(body)),
    'the dependent task did not run after the source completed',
  );
});

// ---- merged from task-trigger.test.ts ----

function task(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    sessionId: 's',
    title: id,
    description: '',
    status: 'pending',
    acceptance: [],
    steps: [{ description: 'step', status: 'pending' }],
    attemptCount: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

test('task triggers accept only well-formed schedules and reject lookalike fields', () => {
  assert.deepEqual(normalizeTaskTrigger(undefined), undefined);
  assert.deepEqual(normalizeTaskTrigger({ kind: 'interval', enabled: true, everyMinutes: 30 }), {
    kind: 'interval',
    enabled: true,
    everyMinutes: 30,
  });
  assert.deepEqual(normalizeTaskTrigger({ kind: 'daily', enabled: false, atMinutes: 540 }), {
    kind: 'daily',
    enabled: false,
    atMinutes: 540,
  });
  assert.deepEqual(normalizeTaskTrigger({ kind: 'event', enabled: true, on: 'run.finished' }), {
    kind: 'event',
    enabled: true,
    on: 'run.finished',
  });
  assert.deepEqual(
    normalizeTaskTrigger({ kind: 'event', enabled: true, on: 'task.completed', taskId: 'a' }),
    { kind: 'event', enabled: true, on: 'task.completed', taskId: 'a' },
  );
  // A near-miss field name must not be silently ignored, or a typo would schedule nothing.
  assert.throws(
    () => normalizeTaskTrigger({ kind: 'interval', enabled: true, everyMinute: 5 }),
    /Unknown task trigger field/,
  );
  assert.throws(
    () => normalizeTaskTrigger({ kind: 'interval', enabled: true, everyMinutes: 0 }),
    /Invalid task trigger interval/,
  );
  assert.throws(
    () => normalizeTaskTrigger({ kind: 'interval', enabled: true, everyMinutes: 8 * 24 * 60 }),
    /Invalid task trigger interval/,
  );
  assert.throws(
    () => normalizeTaskTrigger({ kind: 'daily', enabled: true, atMinutes: 1440 }),
    /Invalid task trigger time of day/,
  );
  assert.throws(
    () => normalizeTaskTrigger({ kind: 'event', enabled: true, on: 'run.started' }),
    /Invalid task trigger event/,
  );
  // Only a completion names a source task; anywhere else the filter would never be applied.
  assert.throws(
    () => normalizeTaskTrigger({ kind: 'event', enabled: true, on: 'run.finished', taskId: 'a' }),
    /Invalid task trigger event filter/,
  );
  assert.throws(
    () => normalizeTaskTrigger({ kind: 'unsupported', enabled: true }),
    /Unsupported task trigger kind/,
  );
  assert.throws(() => normalizeTaskTrigger({ kind: 'interval', everyMinutes: 5 }), /enabled flag/);
});

test('interval and daily triggers compute their next local occurrence', () => {
  const base = new Date('2026-03-01T08:00:00.000Z');
  const interval = nextRunAt({ kind: 'interval', enabled: true, everyMinutes: 90 }, base);
  assert.equal(interval, new Date(base.getTime() + 90 * 60_000).toISOString());

  const at = new Date(2026, 2, 1, 7, 30, 0, 0);
  const sameDay = nextDailyRun(9 * 60, at);
  assert.equal(sameDay.getHours(), 9);
  assert.equal(sameDay.getMinutes(), 0);
  assert.equal(sameDay.getDate(), at.getDate());
  // Exactly at the scheduled minute counts as already passed, so the next occurrence is tomorrow.
  const nextDay = nextDailyRun(7 * 60 + 30, at);
  assert.equal(nextDay.getDate(), at.getDate() + 1);
  assert.equal(nextDay.getHours(), 7);
  assert.equal(nextDay.getMinutes(), 30);
  assert.equal(nextRunAt({ kind: 'event', enabled: true, on: 'run.finished' }, base), undefined);
  assert.equal(triggerSource({ kind: 'daily', enabled: true, atMinutes: 0 }), 'daily');
});

/**
 * Forge a task's next moment.
 *
 * "Due at a particular time" is what the scheduler's clock is about, and no API takes one: the store computes
 * `next_run_at` from the trigger, and every trigger it supports is at least a minute away — which is a fine
 * schedule and a useless test fixture. Written through the same file the store holds, like the other forged states
 * in this suite.
 */
function setNextRun(file: string, taskId: string, at: Date): void {
  const db = new DatabaseSync(file);
  try {
    db.prepare('UPDATE tasks SET next_run_at=? WHERE id=?').run(at.toISOString(), taskId);
  } finally {
    db.close();
  }
}

test('the scheduler aims at the next due moment instead of polling on a fixed interval', async (t) => {
  /**
   * Characterisation of the clock, and the reason the item gives for it: a fixed interval meant a task due at
   * 09:00:01 started at 09:00:30 at the earliest, and the process woke 2,880 times a day to find nothing. The
   * policy is asserted directly because it is the whole change — three answers, in the order they are asked.
   */
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-scheduler-clock-'));
  const file = path.join(root, 'sessions.sqlite');
  const store = new SessionStore(file);
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const session = store.create(root);
  const task = store.createTask(session.id, {
    title: 'Scheduled workflow',
    steps: [{ description: 'step', status: 'pending' }],
    trigger: { kind: 'interval', enabled: true, everyMinutes: 60 },
  });
  const runs: string[] = [];
  const scheduler = new TaskScheduler({
    store,
    workspace: root,
    canRun: () => true,
    intervalMs: 45_000,
    run: async (scheduled) => {
      runs.push(scheduled.task.id);
      return { status: 'completed' };
    },
  });
  t.after(() => scheduler.stop());
  /** The moment the scheduler is asked to look from, so the arithmetic is assertable rather than timed. */
  const now = new Date();

  // Nothing scheduled: the configured interval is what a task created in the meantime has to wait.
  const other = store.createTask(session.id, {
    title: 'Manual',
    steps: [{ description: 'step', status: 'pending' }],
  });
  assert.equal(scheduler.nextDelayMs(now), 45_000);
  assert.ok(other.id);

  // Due in eight seconds: look then, not at the ceiling. The trigger's own interval is an hour, which the ceiling
  // would otherwise round to 45 seconds — so this number can only come from the task's own moment.
  setNextRun(file, task.id, new Date(now.getTime() + 8_000));
  assert.equal(scheduler.nextDelayMs(now), 8_000);

  // Further away than the ceiling: the ceiling wins, so a task edited by another process is still noticed.
  setNextRun(file, task.id, new Date(now.getTime() + 10 * 60_000));
  assert.equal(scheduler.nextDelayMs(now), 45_000);

  // Already due: that task is waiting for the *Host*, not for the clock, and asking every second would not change
  // it — so the ordinary interval is the re-check.
  setNextRun(file, task.id, new Date(now.getTime() - 60_000));
  assert.equal(scheduler.nextDelayMs(now), 45_000);

  // And the wiring, not just the arithmetic: a task due in a moment runs without waiting for the ceiling, which is
  // what a fixed interval could not do at any setting.
  const soon = store.createTask(session.id, {
    title: 'Soon',
    steps: [{ description: 'step', status: 'pending' }],
    trigger: { kind: 'interval', enabled: true, everyMinutes: 60 },
  });
  setNextRun(file, task.id, new Date(Date.now() + 10 * 60_000));
  setNextRun(file, soon.id, new Date(Date.now() + 300));
  scheduler.start();
  const deadline = Date.now() + 5_000;
  while (!runs.length && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(
    runs.length >= 1,
    true,
    'a task due in 300ms started without waiting out a 45s interval',
  );
});

test('scheduled tasks become due once, oldest first, and event triggers never poll', () => {
  const now = new Date('2026-03-01T12:00:00.000Z');
  const list = [
    task('later', {
      trigger: { kind: 'interval', enabled: true, everyMinutes: 60 },
      nextRunAt: new Date(now.getTime() + 60_000).toISOString(),
    }),
    task('due-newer', {
      trigger: { kind: 'interval', enabled: true, everyMinutes: 60 },
      nextRunAt: new Date(now.getTime() - 10_000).toISOString(),
    }),
    task('due-older', {
      trigger: { kind: 'daily', enabled: true, atMinutes: 0 },
      nextRunAt: new Date(now.getTime() - 3 * 60 * 60_000).toISOString(),
    }),
    task('disabled', {
      trigger: { kind: 'interval', enabled: false, everyMinutes: 60 },
      nextRunAt: new Date(now.getTime() - 60_000).toISOString(),
    }),
    task('event', { trigger: { kind: 'event', enabled: true, on: 'run.finished' } }),
    task('running', {
      status: 'in_progress',
      trigger: { kind: 'interval', enabled: true, everyMinutes: 60 },
      nextRunAt: new Date(now.getTime() - 60_000).toISOString(),
    }),
    task('cancelled', {
      status: 'cancelled',
      trigger: { kind: 'interval', enabled: true, everyMinutes: 60 },
      nextRunAt: new Date(now.getTime() - 60_000).toISOString(),
    }),
    task('manual'),
  ];
  // Without catch-up, a stale obligation is still due: the clock passed while nothing observed it.
  assert.deepEqual(
    dueTasks(list, now).map((entry) => entry.task.id),
    ['due-older', 'due-newer'],
  );
  // Catch-up marks the stale one as missed exactly once rather than replaying a backlog.
  const caught = dueTasks(list, now, { catchUp: true });
  assert.equal(caught.length, 2);
  assert.equal(caught.find((entry) => entry.task.id === 'due-older')?.missed, true);
  assert.equal(caught.find((entry) => entry.task.id === 'due-newer')?.missed, false);
  assert.deepEqual(
    caught.map((entry) => entry.source),
    ['daily', 'interval'],
  );
});

test('event triggers match by name and optionally by source task', () => {
  const anyCompletion = { kind: 'event', enabled: true, on: 'task.completed' } as const;
  const oneCompletion = {
    kind: 'event',
    enabled: true,
    on: 'task.completed',
    taskId: 'build',
  } as const;
  const disabled = { kind: 'event', enabled: false, on: 'task.completed' } as const;
  assert.equal(matchesEvent(anyCompletion, { name: 'task.completed', taskId: 'x' }), true);
  assert.equal(matchesEvent(oneCompletion, { name: 'task.completed', taskId: 'build' }), true);
  assert.equal(matchesEvent(oneCompletion, { name: 'task.completed', taskId: 'other' }), false);
  assert.equal(matchesEvent(disabled, { name: 'task.completed', taskId: 'build' }), false);
  assert.equal(matchesEvent(anyCompletion, { name: 'run.finished' }), false);
  assert.equal(
    matchesEvent({ kind: 'interval', enabled: true, everyMinutes: 5 }, { name: 'run.finished' }),
    false,
  );
});

// ---- merged from acceptance.test.ts ----

async function workspace(t: test.TestContext): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-acceptance-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function nodeCommand(script: string, options: Partial<AcceptanceSpec> = {}): AcceptanceSpec {
  return {
    id: 'command',
    kind: 'command',
    command: process.execPath,
    args: ['-e', script],
    ...options,
  } as AcceptanceSpec;
}

test('verifies command and file content checks', async (t) => {
  const root = await workspace(t);
  await writeFile(path.join(root, 'result.txt'), 'alpha\nbeta\n');
  const result = await verifyAcceptance(root, [
    nodeCommand("process.stdout.write('ok')"),
    { id: 'exact', kind: 'file-exact', path: 'result.txt', expected: 'alpha\nbeta\n' },
    { id: 'contains', kind: 'file-contains', path: 'result.txt', expected: 'beta' },
  ]);
  assert.equal(result.passed, true);
  assert.deepEqual(
    result.checks.map((check) => check.passed),
    [true, true, true],
  );
  assert.equal(result.checks[0]!.command?.stdout, 'ok');
});

test('reports deterministic mismatches without throwing', async (t) => {
  const root = await workspace(t);
  await writeFile(path.join(root, 'result.txt'), 'actual');
  const result = await verifyAcceptance(root, [
    nodeCommand('process.exit(3)'),
    { id: 'exact', kind: 'file-exact', path: 'result.txt', expected: 'expected' },
    { id: 'missing', kind: 'file-contains', path: 'missing.txt', expected: 'text' },
  ]);
  assert.equal(result.passed, false);
  assert.equal(result.checks[0]!.command?.exitCode, 3);
  assert.match(result.checks[1]!.detail, /did not match/);
  assert.match(result.checks[2]!.detail, /does not exist/);
});

test('checks forbidden paths for absence and bounded content changes', async (t) => {
  const root = await workspace(t);
  await mkdir(path.join(root, 'protected'));
  await writeFile(path.join(root, 'protected', 'value.txt'), 'before');
  const baseline = await capturePathSnapshot(root, 'protected');
  let result = await verifyAcceptance(root, [
    {
      id: 'unchanged',
      kind: 'forbidden-path',
      path: 'protected',
      expectation: 'unchanged',
      baseline,
    },
    { id: 'absent', kind: 'forbidden-path', path: 'forbidden.tmp', expectation: 'absent' },
  ]);
  assert.equal(result.passed, true);
  await writeFile(path.join(root, 'protected', 'value.txt'), 'after');
  await writeFile(path.join(root, 'forbidden.tmp'), 'created');
  result = await verifyAcceptance(root, [
    {
      id: 'unchanged',
      kind: 'forbidden-path',
      path: 'protected',
      expectation: 'unchanged',
      baseline,
    },
    { id: 'absent', kind: 'forbidden-path', path: 'forbidden.tmp', expectation: 'absent' },
  ]);
  assert.equal(result.passed, false);
  assert.equal(result.checks[0]!.detail, 'Forbidden path changed');
  assert.equal(result.checks[1]!.detail, 'Forbidden path exists');
});

test('times out commands and bounds combined output', async (t) => {
  const root = await workspace(t);
  const result = await verifyAcceptance(
    root,
    [
      nodeCommand("process.stdout.write('x'.repeat(10000)); setInterval(() => {}, 1000)", {
        timeoutMs: 100,
      }),
    ],
    { maxOutputBytes: 128 },
  );
  assert.equal(result.passed, false);
  assert.equal(result.checks[0]!.command?.timedOut, true);
  assert.equal(result.checks[0]!.command?.outputTruncated, true);
  assert.equal(result.checks[0]!.command?.stdout.length, 128);
});

test('cancellation terminates a running command and rejects with the abort reason', async (t) => {
  const root = await workspace(t);
  const controller = new AbortController();
  const reason = new Error('stop acceptance');
  const running = verifyAcceptance(
    root,
    [nodeCommand('setInterval(() => {}, 1000)', { timeoutMs: 10_000 })],
    { signal: controller.signal },
  );
  setTimeout(() => controller.abort(reason), 50);
  await assert.rejects(running, reason);
});

test('rejects paths outside the workspace', async (t) => {
  const root = await workspace(t);
  const result = await verifyAcceptance(root, [
    { id: 'escape', kind: 'file-exact', path: '../outside.txt', expected: '' },
  ]);
  assert.equal(result.passed, false);
  assert.match(result.checks[0]!.detail, /outside workspace/);
});

test('command acceptance is refused when the approver denies it and has no side effects', async (t) => {
  const root = await workspace(t);
  const outside = path.join(tmpdir(), `yuantu-acceptance-pwn-${Date.now()}-${Math.random()}`);
  const result = await verifyAcceptance(
    root,
    [nodeCommand(`require('node:fs').writeFileSync(${JSON.stringify(outside)}, 'pwn')`)],
    { approve: async () => false },
  );
  assert.equal(result.passed, false);
  assert.match(result.checks[0]!.detail, /not authorized/);
  await assert.rejects(access(outside));
});

test('command acceptance executes when the approver allows it', async (t) => {
  const root = await workspace(t);
  const marker = path.join(root, 'marker.txt');
  const result = await verifyAcceptance(
    root,
    [nodeCommand(`require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ok')`)],
    { approve: async () => true },
  );
  assert.equal(result.passed, true);
  assert.equal(await readFile(marker, 'utf8'), 'ok');
});

test('file delivery check verifies a real nonempty artifact and rejects missing, empty and corrupt outputs', async (t) => {
  const root = await workspace(t);
  await writeFile(path.join(root, 'report.txt'), 'release evidence 947');
  await writeFile(path.join(root, 'empty.txt'), '');
  await writeFile(path.join(root, 'broken.pdf'), 'not a PDF');
  const results = await verifyAcceptance(root, [
    { id: 'text', kind: 'file-delivery', path: 'report.txt', format: 'text', minBytes: 5 },
    { id: 'empty', kind: 'file-delivery', path: 'empty.txt' },
    { id: 'pdf', kind: 'file-delivery', path: 'broken.pdf', format: 'pdf' },
    { id: 'missing', kind: 'file-delivery', path: 'missing.docx' },
  ]);
  assert.deepEqual(
    results.checks.map((item) => item.passed),
    [true, false, false, false],
  );
  assert.match(results.checks[0]!.detail, /sha256/i);
});

test('delivery evidence rejects paths outside workspace and a wrong expected hash', async (t) => {
  const root = await workspace(t);
  await writeFile(path.join(root, 'output.txt'), 'actual artifact');
  const result = await verifyAcceptance(root, [
    { id: 'outside', kind: 'file-delivery', path: '../outside.txt' },
    { id: 'wrong-hash', kind: 'file-delivery', path: 'output.txt', sha256: '0'.repeat(64) },
  ]);
  assert.deepEqual(
    result.checks.map((check) => check.passed),
    [false, false],
  );
  assert.match(result.checks[0]!.detail, /outside workspace/i);
  assert.match(result.checks[1]!.detail, /SHA-256 does not match/i);
});
