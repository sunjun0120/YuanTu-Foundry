/**
 * What a crash costs, and what it must not.
 *
 * The Host owns the run, the store and the workspace lock, so when its process disappears there is nothing to
 * continue: the run in flight is over and its outcome is whatever the workspace now shows. The failure this
 * covers is that a crash used to cost *more* than the run  it left the session pointing at a run nobody owned,
 * which blocked deleting or renaming it, and it left the client with an untyped error and no way back except
 * restarting the whole application.
 *
 * Two properties are load-bearing here. First, the interruption is *recorded*: the session's own log gets a
 * `run.interrupted` line, and every unresolved call gets an "outcome unknown" result, because a call that may
 * already have had effects must never be silently replayed. Second, recovery is *by the log*: a new Host
 * rebuilds the session from what was written down, not from what the dead process remembered.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { AgentHostClient, HostDisconnectedError } from '../packages/client/host-client.ts';
import { CarrierService } from '../packages/carrier/index.ts';
import { SCHEMA_VERSION, SessionStore } from '../packages/storage/sqlite.ts';
import { auditEntries, foldMessages } from '../packages/storage/events.ts';
import type { Message } from '../packages/protocol/index.ts';
import { isRuntimeContext } from '../packages/protocol/context.ts';
import { frames, httpFixture, sendFrames } from './http-fixture.ts';
import { storeFixture } from './temp-fixture.ts';

const hostPath = path.resolve('apps/agent-host/main.ts');
/** An owner pid that cannot exist, which is how a test says "the process that started this run is gone". */
const DEAD_PID = 2_147_483_647;

async function store_(t: test.TestContext) {
  const { root, db: file, store } = await storeFixture(t, 'yuantu-reconnect-');
  return { root, file, store, session: store.create(root) };
}
/** Forge a dead owner for a run, which is the only way to write the state a crash leaves behind. */
const orphan = (file: string, runId: string) => {
  const db = new DatabaseSync(file);
  db.prepare('UPDATE runs SET owner_pid=? WHERE id=?').run(DEAD_PID, runId);
  db.close();
};

// ---- the store's side: an abandoned run is converged and recorded ----

test('a run left by a dead Host is settled, recorded and made usable at startup', async (t) => {
  const { root, file, store, session } = await store_(t);
  const runId = store.beginRun(session.id);
  store.append(session.id, {
    role: 'assistant',
    content: 'writing',
    toolCalls: [{ id: 'call-1', name: 'write_file', arguments: { path: 'a.txt', content: 'x' } }],
  });
  orphan(file, runId);

  // The dead end this fixes, asserted before it is fixed: a session whose run has no owner cannot be deleted,
  // so a crash used to leave a conversation the user could not get rid of.
  assert.throws(() => store.delete(session.id), /running or interrupted/);

  assert.equal(store.reconcileInterruptedRuns(root), 1);
  assert.equal(store.get(session.id).activeRun, null);
  const events = store.events(session.id);
  assert.deepEqual(
    events.map((event) => event.type),
    ['run.started', 'message.assistant', 'message.tool', 'run.interrupted'],
  );
  const settled = events[2]!;
  assert.equal((settled.data.message as Message).role, 'tool');
  assert.match(String((settled.data.message as Message).content), /outcome is unknown/i);
  assert.deepEqual(events[3]!.data, {
    runId,
    pendingCalls: 1,
    reason:
      'Previous run was interrupted. Execution outcome is unknown; inspect current state before retrying.',
  });
  // It is a reader-facing fact, not bookkeeping: the process record is where a person looks after a crash.
  assert.deepEqual(
    auditEntries(events, 100).map((entry) => entry.type),
    ['run.interrupted'],
  );
  // The fold still agrees with the table, which is the property every writer of messages has to keep.
  assert.deepEqual(foldMessages(events), store.messages(session.id));
  // Converging twice is a no-op: the record must not be written again by the next startup.
  assert.equal(store.reconcileInterruptedRuns(root), 0);
  store.delete(session.id);
});

test('a failed recovery write rolls that session back instead of committing a partial state', async (t) => {
  const { root, file, store, session } = await store_(t);
  const runId = store.beginRun(session.id);
  store.append(session.id, {
    role: 'assistant',
    content: 'writing',
    toolCalls: [{ id: 'call-1', name: 'write_file', arguments: { path: 'a.txt', content: 'x' } }],
  });
  orphan(file, runId);
  const raw = new DatabaseSync(file);
  raw.exec(`CREATE TRIGGER test_fail_interrupted BEFORE INSERT ON session_events
    WHEN NEW.type = 'run.interrupted'
    BEGIN SELECT RAISE(ABORT, 'injected recovery failure'); END;`);
  raw.close();

  const reported: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => void reported.push(args.join(' '));
  let recovered: number;
  try {
    recovered = store.reconcileInterruptedRuns(root);
  } finally {
    console.error = original;
  }
  assert.equal(recovered, 0, 'the failed session is not counted as converged');
  assert.match(reported.join('\n'), /injected recovery failure/);
  // The failure happened at the last write of settleAbandonedRun. Every earlier write — the unknown-tool
  // answer, the run row, the active pointer, the lease — belongs to the same object and must be rolled back.
  assert.equal(store.get(session.id).activeRun, runId, 'the active run pointer is unchanged');
  assert.deepEqual(
    store.messages(session.id).filter((message) => message.role === 'tool'),
    [],
    'the unresolved call was not answered by a rolled-back recovery',
  );
  assert.deepEqual(
    store.events(session.id).map((event) => event.type),
    ['run.started', 'message.assistant'],
    'no interruption record survived a failed convergence',
  );
  const check = new DatabaseSync(file, { readOnly: true });
  assert.equal(check.prepare('SELECT status FROM runs WHERE id=?').get(runId)?.status, 'running');
  check.close();
});

test('task recovery settles a dead run through the run-recovery path, and leaves one it cannot settle holding its session', async (t) => {
  const { root, file, store, session } = await store_(t);
  const task = store.createTask(session.id, { title: 'Interrupted task' });
  const runId = store.beginRun(session.id);
  store.startTaskAttempt(session.id, task.id, { kind: 'run', runId });
  orphan(file, runId);
  const raw = new DatabaseSync(file);
  raw.exec(`CREATE TRIGGER test_fail_interrupted BEFORE INSERT ON session_events
    WHEN NEW.type = 'run.interrupted'
    BEGIN SELECT RAISE(ABORT, 'injected recovery failure'); END;`);
  raw.close();
  const original = console.error;
  console.error = () => {};
  try {
    // The run pass fails for this session; the task pass used to release the run anyway, without its record.
    assert.equal(store.reconcileInterruptedRuns(root), 0);
    store.recoverInterruptedTasks(root);
  } finally {
    console.error = original;
  }
  assert.equal(store.get(session.id).activeRun, runId, 'an unsettled run keeps its session');
  assert.deepEqual(
    store.events(session.id).filter((event) => event.type === 'run.interrupted'),
    [],
  );
  const check = new DatabaseSync(file);
  assert.equal(check.prepare('SELECT status FROM runs WHERE id=?').get(runId)?.status, 'running');
  check.exec('DROP TRIGGER test_fail_interrupted');
  check.close();
  // The task was released for review; the run itself is retried by the next start's run pass, intact.
  assert.equal(store.reconcileInterruptedRuns(root), 1);
  assert.equal(store.get(session.id).activeRun, null);
  assert.equal(
    store.events(session.id).filter((event) => event.type === 'run.interrupted').length,
    1,
  );
  assert.equal(store.getTask(session.id, task.id).status, 'needs_review');
});

test('one unreadable session does not stop the rest from being converged, or the Host from starting', async (t) => {
  /**
   * `settleAbandonedRun` hydrates the transcript and reads the log, so a session this build cannot fold throws
   * from inside the startup convergence. It used to throw out of one looping transaction, which did two things
   * at once: it rolled back the convergence already performed for the *other* sessions, and it propagated to the
   * caller — Host startup — so a single damaged conversation left every session in the workspace unusable and
   * stopped the Host from opening at all.
   */
  const { root, file, store } = await store_(t);
  const healthy = store.create(root);
  const damaged = store.create(root);
  const healthyRun = store.beginRun(healthy.id);
  const damagedRun = store.beginRun(damaged.id);
  for (const id of [healthy.id, damaged.id]) store.append(id, { role: 'user', content: 'start' });
  orphan(file, healthyRun);
  orphan(file, damagedRun);
  // A log entry that no longer parses is the cheapest stand-in for "this build cannot read this session": the
  // same throw arrives from a missing attachment blob or an event type a newer build wrote. It has to be the
  // event data rather than a `messages` row, because the transcript is folded from the log — the write-through
  // table is not what the convergence reads.
  const raw = new DatabaseSync(file);
  raw.prepare('UPDATE session_events SET data=? WHERE session_id=?').run('{"message":', damaged.id);
  raw.close();
  assert.throws(
    () => store.messages(damaged.id),
    'the damage has to be real for this test to mean anything',
  );

  const reported: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => void reported.push(args.join(' '));
  try {
    assert.equal(
      store.reconcileInterruptedRuns(root),
      1,
      'the readable session is still converged',
    );
  } finally {
    console.error = original;
  }
  assert.equal(
    store.get(healthy.id).activeRun,
    null,
    'and it is usable: the other session no longer rolls its convergence back',
  );
  assert.match(
    reported.join('\n'),
    new RegExp(damaged.id),
    'the session that could not be converged is named rather than swallowed',
  );
  assert.throws(
    () => store.delete(damaged.id),
    /running or interrupted/,
    'the unreadable session is left exactly as it was, not half-settled',
  );
});

test('a plan its interrupted run never finished is abandoned rather than left planning', async (t) => {
  /**
   * The durable row exists so a crash leaves a record rather than nothing — but a record that keeps saying
   * `planning` is a promise about a run that no longer exists, which is the one reading a person cannot act on:
   * there is no plan to wait for and nothing to stop. The convergence that settles the run drops the promise while
   * keeping the record, and only for rows that were still `planning`: a plan that already reached a human is a
   * different thing entirely.
   */
  const { root, file, store, session } = await store_(t);
  const runId = store.beginRun(session.id);
  const plan = store.createPlan(session.id);
  store.linkPlanRun(session.id, plan.id, runId);
  const decided = store.createPlan(session.id);
  store.linkPlanRun(session.id, decided.id, runId);
  store.submitPlan(session.id, decided.id, {
    title: 'Decided',
    summary: 'Already at a human',
    steps: [{ description: 'one' }],
  });
  orphan(file, runId);

  assert.equal(store.reconcileInterruptedRuns(root), 1);
  assert.equal(store.getPlan(session.id, plan.id).status, 'abandoned');
  assert.equal(
    store.getPlan(session.id, decided.id).status,
    'proposed',
    'a plan waiting for a person is not a promise about the dead run',
  );
  const interrupted = store
    .events(session.id)
    .filter((event) => event.type === 'run.interrupted')
    .at(-1)!;
  assert.equal((interrupted.data as { abandonedPlans?: number }).abandonedPlans, 1);
  // The row is still there, with its run: the record of "a planning run died here" is what the status change keeps.
  assert.equal(store.getPlan(session.id, plan.id).runId, runId);
});

test('a run whose owner is still alive is left exactly as it is', async (t) => {
  const { root, store, session } = await store_(t);
  // This process is the live owner; another Host on the same workspace looks the same from here.
  const runId = store.beginRun(session.id);
  assert.equal(store.reconcileInterruptedRuns(root), 0);
  assert.equal(store.get(session.id).activeRun, runId);
  assert.deepEqual(
    store.events(session.id).map((event) => event.type),
    ['run.started'],
  );
});

test('starting a run on a session a dead Host left behind records the interruption too', async (t) => {
  const { file, store, session } = await store_(t);
  const runId = store.beginRun(session.id);
  store.append(session.id, { role: 'user', content: 'do it' });
  orphan(file, runId);
  // No startup pass ran (this is the lazy path): beginning the next run has to converge the old one, and it has
  // to say so in the log rather than only in the runs table.
  const next = store.beginRun(session.id);
  assert.notEqual(next, runId);
  assert.deepEqual(
    store.events(session.id).map((event) => event.type),
    ['run.started', 'message.user', 'run.interrupted', 'run.started'],
  );
  assert.equal(store.get(session.id).activeRun, next);
});

// ---- the wire: a client crashes, comes back, and finds the session it had ----

test('a client whose Host is killed mid-approval can restart and rebuild the session', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-reconnect-host-'));
  const cleanups: (() => Promise<unknown>)[] = [];
  // One hook, in order: the Host releases the database before the directory holding it is removed.
  t.after(async () => {
    for (const cleanup of cleanups) await cleanup();
    await rm(root, { recursive: true, force: true });
  });
  let turns = 0;
  const url = await httpFixture(t, (body, res) => {
    if (turns++ === 0) {
      sendFrames(
        res,
        frames('', [
          { id: 'call-write', name: 'write_file', input: { path: 'crashed.txt', content: 'x' } },
        ]),
      );
      return;
    }
    assert.match(JSON.stringify(body.messages), /outcome is unknown/i);
    sendFrames(res, frames('Recovered.'));
  });
  const client = new AgentHostClient({
    nodePath: process.execPath,
    hostPath,
    workspace: root,
    db: path.join(root, 'sessions.sqlite'),
    env: {
      YUANTU_PROTOCOL: 'anthropic',
      YUANTU_API_KEY: 'reconnect-fixture',
      YUANTU_MODEL: 'fixture',
      YUANTU_MAX_CONTEXT_TOKENS: '128000',
      YUANTU_SESSION_TITLES: '0',
      YUANTU_BASE_URL: url,
    },
  });
  cleanups.push(() => client.stop());
  let asked = false;
  client.subscribe((event) => {
    if (event.type === 'approval.required') asked = true;
  });
  await client.start();
  const session = await client.request('session.create', {});
  const running = client.run(session.id, 'Write the file.');
  // The run is parked on the approval prompt, which is the state the crash has to be survivable from: a person
  // had been asked and never answered.
  for (let i = 0; i < 400 && !asked; i++) await new Promise((resolve) => setTimeout(resolve, 25));
  assert.ok(asked, 'the run must reach the approval prompt');
  const pid = client.pid;
  assert.ok(pid, 'the client must be able to name the Host process');
  process.kill(pid, 'SIGKILL');
  const failure = await running.then(
    () => null,
    (error: unknown) => error,
  );
  assert.ok(
    failure instanceof HostDisconnectedError,
    `expected a disconnect, got ${String(failure)}`,
  );
  assert.equal(failure.pid, pid);
  assert.equal(client.status, 'failed');
  assert.equal(client.recoverable, true);

  // Recovery: a new Host, which converges the abandoned run as it starts.
  await client.start();
  assert.equal(client.status, 'ready');
  const page = await client.request('session.get', { sessionId: session.id });
  assert.equal(page.session.activeRun, null);
  const roles = page.messages
    .filter((message: Message) => !isRuntimeContext(message.content))
    .map((message: Message) => message.role);
  assert.deepEqual(roles, ['user', 'assistant', 'tool']);
  const unresolved = page.messages.filter(
    (message: Message) => !isRuntimeContext(message.content),
  )[2] as Message & { role: 'tool' };
  assert.equal(unresolved.isError, true);
  assert.match(String(unresolved.content), /outcome is unknown/i);
  // Asked, never decided  and now with the reason it was never decided.
  const audit = await client.request('session.audit', { sessionId: session.id });
  assert.deepEqual(
    audit.entries.map((entry: { type: string }) => entry.type),
    ['approval.required', 'run.interrupted'],
  );
  assert.equal(audit.entries[1]!.data.pendingCalls, 1);

  // The session is usable again, not merely readable: a new run completes and needs no convergence first.
  const second = await client.run(session.id, 'Try again.');
  assert.equal(second.status, 'completed', second.error);
  assert.equal(
    (await client.request('session.get', { sessionId: session.id })).messages.at(-1)?.content,
    'Recovered.',
  );
  // And it can be deleted, which a stale active run used to refuse.
  assert.deepEqual(await client.request('session.delete', { sessionId: session.id }), {
    deleted: true,
  });
});

// ---- the startup failure a newer workspace database produces ----

test('a database written by a newer build is refused with the version named', async (t) => {
  // The shape of the failure a person actually hit: a workspace opened once by a newer build, then opened by
  // this one. The store refuses the version rather than reading a shape it cannot know, so the Host exits —
  // and without the diagnosis below, the only thing on screen is "Agent Host exited … requests were not
  // replayed", which says nothing about the database at all.
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-newer-db-'));
  const db = path.join(root, 'sessions.sqlite');
  const store = new SessionStore(db);
  store.close();
  const newer = SCHEMA_VERSION + 1;
  const stamp = new DatabaseSync(db);
  stamp.exec(`PRAGMA user_version=${newer}`);
  stamp.close();
  t.after(() => rm(root, { recursive: true, force: true }));

  const client = new AgentHostClient({
    nodePath: process.execPath,
    hostPath,
    workspace: root,
    db,
    env: {
      YUANTU_PROTOCOL: 'anthropic',
      YUANTU_API_KEY: 'newer-db-fixture',
      YUANTU_MODEL: 'fixture',
      YUANTU_MAX_CONTEXT_TOKENS: '128000',
      YUANTU_SESSION_TITLES: '0',
    },
  });
  t.after(() => client.stop());

  const failure: unknown = await client.start().then(
    () => null,
    (error: unknown) => error,
  );
  assert.ok(failure instanceof Error, String(failure));
  assert.match(
    String(failure),
    /DATABASE_VERSION/,
    'the reason must be named, not just "the Host died"',
  );
  assert.match(String(failure), new RegExp(`is v${newer}, written by a newer build`));
  assert.match(String(failure), /back up \.yuantu\/sessions\.sqlite/);
  assert.equal(client.status, 'failed');
});

test('a carrier whose first Host cannot open the database reports it once and closes quietly', async (t) => {
  // The window that refused a newer database used to keep restarting the Host behind the error, three doomed
  // tries, and quitting during one of them failed the shutdown with "exited abnormally": an "exited unexpectedly"
  // dialog after a refusal the person had already been shown. Recovery is for a Host that was running.
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-newer-db-carrier-'));
  const db = path.join(root, 'sessions.sqlite');
  new SessionStore(db).close();
  const stamp = new DatabaseSync(db);
  stamp.exec(`PRAGMA user_version=${SCHEMA_VERSION + 1}`);
  stamp.close();
  t.after(() => rm(root, { recursive: true, force: true }));
  const carrier = new CarrierService({
    nodePath: process.execPath,
    hostPath,
    workspace: root,
    db,
    env: {
      YUANTU_PROTOCOL: 'anthropic',
      YUANTU_API_KEY: 'newer-db-fixture',
      YUANTU_MODEL: 'fixture',
      YUANTU_MAX_CONTEXT_TOKENS: '128000',
      YUANTU_SESSION_TITLES: '0',
    },
  });
  const failure = await carrier.start().then(
    () => assert.fail('the start must fail'),
    (error: unknown) => error,
  );
  assert.match(String(failure), /DATABASE_VERSION/);
  const refused = carrier['client'].lastPid;
  // Longer than the recovery pause: a restart would have spawned another Host by now.
  await new Promise((resolve) => setTimeout(resolve, 1500));
  assert.equal(
    carrier['client'].lastPid,
    refused,
    'no Host is restarted after a failed first start',
  );
  assert.equal(carrier.snapshot.startupStage, 'failed');
  await carrier.stop();
});

test('a client that missed the approval frame gets it from the queue answer and can still answer it', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-reconnect-pending-'));
  const cleanups: (() => Promise<unknown>)[] = [];
  t.after(async () => {
    for (const cleanup of cleanups) await cleanup();
    await rm(root, { recursive: true, force: true });
  });
  let turns = 0;
  const url = await httpFixture(t, (_body, res) => {
    if (turns++ === 0) {
      sendFrames(
        res,
        frames('', [
          { id: 'call-write', name: 'write_file', input: { path: 'later.txt', content: 'x' } },
        ]),
      );
      return;
    }
    sendFrames(res, frames('Written.'));
  });
  const client = new AgentHostClient({
    nodePath: process.execPath,
    hostPath,
    workspace: root,
    db: path.join(root, 'sessions.sqlite'),
    env: {
      YUANTU_PROTOCOL: 'anthropic',
      YUANTU_API_KEY: 'reconnect-fixture',
      YUANTU_MODEL: 'fixture',
      YUANTU_MAX_CONTEXT_TOKENS: '128000',
      YUANTU_SESSION_TITLES: '0',
      YUANTU_BASE_URL: url,
    },
  });
  cleanups.push(() => client.stop());
  let asked: string | undefined;
  client.subscribe((event) => {
    if (event.type === 'approval.required') asked = String(event.data.approvalId);
  });
  await client.start();
  const session = await client.request('session.create', {});
  const running = client.run(session.id, 'Write the file.');
  for (let i = 0; i < 400 && !asked; i++) await new Promise((resolve) => setTimeout(resolve, 25));
  assert.ok(asked, 'the run must reach the approval prompt');

  // What a second window, or a client after a reconnect, asks when it opens the session.
  const inbox = await client.request('run.queue.get', { sessionId: session.id });
  assert.equal(inbox.running, true);
  assert.deepEqual(
    inbox.pending?.approvals.map((item) => [item.id, item.approval.toolCall.id]),
    [[asked, 'call-write']],
  );
  assert.deepEqual(inbox.pending?.questions, []);

  await client.request('approval.respond', {
    approvalId: inbox.pending!.approvals[0]!.id,
    allow: true,
  });
  await running;
  const after = await client.request('run.queue.get', { sessionId: session.id });
  assert.equal(after.running, false);
  assert.equal(after.pending, undefined);
});

test('an aborted request stops being waited for, and the Host answers the next one normally', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-request-abort-'));
  const cleanups: (() => Promise<unknown>)[] = [];
  t.after(async () => {
    for (const cleanup of cleanups) await cleanup();
    await rm(root, { recursive: true, force: true });
  });
  const url = await httpFixture(t, (_body, res) => sendFrames(res, frames('Unused.')));
  const client = new AgentHostClient({
    nodePath: process.execPath,
    hostPath,
    workspace: root,
    db: path.join(root, 'sessions.sqlite'),
    env: {
      YUANTU_PROTOCOL: 'anthropic',
      YUANTU_API_KEY: 'abort-fixture',
      YUANTU_MODEL: 'fixture',
      YUANTU_MAX_CONTEXT_TOKENS: '128000',
      YUANTU_SESSION_TITLES: '0',
      YUANTU_BASE_URL: url,
    },
  });
  cleanups.push(() => client.stop());
  await client.start();
  const session = await client.request('session.create', {});

  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(
    client.request('session.get', { sessionId: session.id }, { signal: aborted.signal }),
    { name: 'AbortError' },
  );
  // Abandoned after it was sent: its answer arrives later and must not settle anything else.
  const midway = new AbortController();
  const abandoned = client.request(
    'session.get',
    { sessionId: session.id },
    { signal: midway.signal },
  );
  midway.abort();
  await assert.rejects(abandoned, { name: 'AbortError' });

  const inbox = await client.request('run.queue.get', { sessionId: session.id });
  assert.equal(inbox.running, false);
  // The cursor an opening read needs, in the same answer, so it does not have to ask `session.events` for it.
  const events = await client.request('session.events', { sessionId: session.id, limit: 1 });
  assert.equal(inbox.latestSeq, events.latestSeq);
});
