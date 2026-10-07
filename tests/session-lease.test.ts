import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SessionStore } from '../packages/storage/sqlite.ts';
import { Agent } from '../packages/core/agent.ts';
import { ToolRegistry } from '../packages/tools/registry.ts';
import type { ModelResponse } from '../packages/protocol/index.ts';
import { isSummaryRequest } from './summary-request.ts';

/**
 * The session write lease, and the compaction lock that consumes it.
 *
 * The lease is **presence**, not history: who is writing a session right now, and when they last proved it.
 * Two rules carry this file, and they are deliberately about different things:
 *
 * 1. **Mutual exclusion is decided by the pid, never by age.** A lease that has not been renewed for an hour
 *    still belongs to its run while that process lives, because the main request has no total duration and its
 *    only watchdog resets on every byte. The test that pins this is the one that forges an ancient renewal and
 *    watches `beginRun` refuse anyway — it is the regression guard for the failure mode the design record named:
 *    expire a healthy run by time and `settleAbandonedRun` writes it down as interrupted and hands the session
 *    to a second writer.
 * 2. **A compaction may only be recorded by the run that holds the session.** The lock is taken before the
 *    summary request (`claimCompaction`) and re-checked at the write (`applyCompaction`), so a run does not pay
 *    for a summary it would be refused, and the log never gets a surface op from a bystanding writer.
 */

const DEAD_PID = 2_147_483_647;
interface Fixture {
  root: string;
  file: string;
  store: SessionStore;
  sessionId: string;
  db: () => DatabaseSync;
}
async function fixture(t: test.TestContext): Promise<Fixture> {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-lease-'));
  const file = path.join(root, 'sessions.sqlite');
  const store = new SessionStore(file);
  t.after(async () => {
    try {
      store.close();
    } catch {
      /* already closed by the test */
    }
    await rm(root, { recursive: true, force: true });
  });
  const session = store.create(root);
  return {
    root,
    file,
    store,
    sessionId: session.id,
    // A second handle on the same file, for forging the states a crash leaves behind — the same technique
    // `host-reconnect` uses to make a run's owner look dead.
    db: () => new DatabaseSync(file),
  };
}
/** A finished run, as `finishRun` needs it. */
function result(sessionId: string, runId: string) {
  return {
    runId,
    sessionId,
    status: 'completed' as const,
    text: 'done',
    usage: { inputTokens: 1, outputTokens: 1 },
  };
}
/** A conversation with an old turn to compress and a recent one to keep. */
function seedConversation(store: SessionStore, sessionId: string): void {
  store.append(sessionId, { role: 'user', content: 'First question about the parser.' });
  store.append(sessionId, { role: 'assistant', content: 'First answer.', toolCalls: [] });
  store.append(sessionId, { role: 'user', content: 'Second question about the lexer.' });
  store.append(sessionId, { role: 'assistant', content: 'Second answer.', toolCalls: [] });
}

test('beginRun records the lease, and the run is the owner it names', async (t) => {
  const { store, sessionId } = await fixture(t);
  assert.equal(store.leaseOf(sessionId), null, 'a session nobody runs has no lease');

  const runId = store.beginRun(sessionId);
  const lease = store.leaseOf(sessionId);
  assert.equal(lease?.runId, runId);
  assert.equal(lease?.ownerPid, process.pid);
  assert.equal(lease?.renewals, 0, 'a lease starts with nothing renewed');
  assert.equal(lease?.compactingRunId, undefined);
});

test('renewal is the owner’s, and a foreign run cannot renew or release it', async (t) => {
  const { store, sessionId } = await fixture(t);
  const runId = store.beginRun(sessionId);

  assert.equal(store.renewLease(sessionId, runId), true);
  assert.equal(store.renewLease(sessionId, runId), true);
  assert.equal(store.leaseOf(sessionId)?.renewals, 2, 'each renewal is counted');

  assert.equal(store.renewLease(sessionId, 'somebody-else'), false);
  assert.equal(store.releaseLease(sessionId, 'somebody-else'), false);
  assert.equal(
    store.leaseOf(sessionId)?.runId,
    runId,
    'a run that does not hold the lease cannot touch it',
  );

  assert.equal(store.releaseLease(sessionId, runId), true);
  assert.equal(store.leaseOf(sessionId), null, 'the owner can give it up');
});

test('a finished run leaves no lease behind', async (t) => {
  const { store, sessionId } = await fixture(t);
  const runId = store.beginRun(sessionId);
  store.renewLease(sessionId, runId);
  store.finishRun(result(sessionId, runId));
  assert.equal(store.leaseOf(sessionId), null);
  // The point of releasing: the next run starts from a clean slate rather than reasoning around a leftover.
  assert.ok(store.beginRun(sessionId));
});

test('a live owner is refused, and the refusal says who holds it and when it last moved', async (t) => {
  const { store, sessionId } = await fixture(t);
  const runId = store.beginRun(sessionId);
  store.renewLease(sessionId, runId);

  assert.throws(
    () => store.beginRun(sessionId),
    (error: Error) =>
      /already running/i.test(error.message) &&
      error.message.includes(runId) &&
      /1 renewal/.test(error.message),
    'the refusal names the owning run, not only "somebody"',
  );
});

test('age is not death: an ancient renewal under a live pid still refuses takeover', async (t) => {
  const { store, sessionId, db } = await fixture(t);
  const runId = store.beginRun(sessionId);
  // The state a long model call leaves behind: the owner is alive and working, and nothing has been renewed
  // for an hour. A lease expired by age would hand this session to a second writer and let recovery write a
  // healthy run down as interrupted; the pid is the only thing allowed to decide.
  const handle = db();
  handle
    .prepare('UPDATE session_leases SET renewed_at=? WHERE session_id=?')
    .run(new Date(Date.now() - 3_600_000).toISOString(), sessionId);
  handle.close();

  const lease = store.leaseOf(sessionId);
  assert.equal(lease?.runId, runId);
  assert.throws(() => store.beginRun(sessionId), /already running/i);
  assert.equal(store.renewLease(sessionId, runId), true, 'and it can still renew');
});

test('a dead owner is taken over, and the abandoned run’s lease goes with it', async (t) => {
  const { store, sessionId, db } = await fixture(t);
  const stale = store.beginRun(sessionId);
  store.renewLease(sessionId, stale);
  const handle = db();
  handle.prepare('UPDATE runs SET owner_pid=? WHERE id=?').run(DEAD_PID, stale);
  handle.close();

  const next = store.beginRun(sessionId);
  assert.notEqual(next, stale);
  const lease = store.leaseOf(sessionId);
  assert.equal(lease?.runId, next, 'the lease moved to the run that took over');
  assert.equal(lease?.renewals, 0, 'a new run starts its own count');
  const events = store.events(sessionId).map((event) => event.type);
  assert.ok(
    events.includes('run.interrupted'),
    'the crash is written down, not silently forgotten',
  );
});

test('the compaction lock excludes a second writer, and releases for the next one', async (t) => {
  const { store, sessionId } = await fixture(t);
  const runId = store.beginRun(sessionId);

  store.claimCompaction(sessionId, runId);
  assert.equal(store.leaseOf(sessionId)?.compactingRunId, runId, 'the claim is visible');
  assert.throws(
    () => store.claimCompaction(sessionId, 'another-run'),
    /Another run is writing this session/,
  );
  assert.throws(
    () => store.claimCompaction(sessionId, undefined),
    /Another run is writing this session/,
    'a caller that names no run is not the holder, so it is refused too',
  );

  store.releaseCompaction(sessionId, runId);
  assert.equal(store.leaseOf(sessionId)?.compactingRunId, undefined);
  assert.doesNotThrow(() => store.claimCompaction(sessionId, runId));
  store.releaseCompaction(sessionId, runId);
});

test('a session with no lease has nothing to exclude, which is the store-level caller', async (t) => {
  const { store, sessionId } = await fixture(t);
  seedConversation(store, sessionId);
  assert.doesNotThrow(() => store.claimCompaction(sessionId, undefined));
  store.applyCompaction(sessionId, { coveredMessages: 2, summary: 'Compressed.' });
  assert.equal(store.contextSurface(sessionId)?.coveredMessages, 2);
});

test('applyCompaction refuses a write from a run that does not hold the session', async (t) => {
  const { store, sessionId } = await fixture(t);
  seedConversation(store, sessionId);
  const runId = store.beginRun(sessionId);

  assert.throws(
    () => store.applyCompaction(sessionId, { coveredMessages: 2, summary: 'Not mine.' }),
    /Another run is writing this session/,
  );
  assert.throws(
    () =>
      store.applyCompaction(sessionId, {
        coveredMessages: 2,
        summary: 'Not mine.',
        runId: 'another-run',
      }),
    /the compaction was not recorded/,
  );
  assert.equal(store.contextSurface(sessionId), null, 'nothing was written by the bystander');

  store.applyCompaction(sessionId, { coveredMessages: 2, summary: 'Mine.', runId });
  assert.equal(store.contextSurface(sessionId)?.summary, 'Mine.');
});

test('a summary in flight blocks a second claim on the same session', async (t) => {
  const { store, sessionId } = await fixture(t);
  const runId = store.beginRun(sessionId);
  store.claimCompaction(sessionId, runId);
  assert.throws(() => store.claimCompaction(sessionId, runId), /already in flight/);
});

/**
 * The run loop, not the store, is what renews a lease — and this is the test that says so.
 *
 * A lease that only the store could renew would be a row nothing keeps current, and "last active" would be a
 * lie for every run that ever took more than one step. So the check is made from inside the provider: by the
 * time a request is being answered, the step boundary that preceded it must already have renewed.
 */
test('a real run renews its lease at each step boundary and releases it at the end', async (t) => {
  const { store, sessionId } = await fixture(t);
  const renewals: number[] = [];
  const replies: ModelResponse[] = [
    {
      text: '',
      toolCalls: [{ id: 'call-1', name: 'noop', arguments: {} }],
      finishReason: 'tool_calls',
      usage: { inputTokens: 5, outputTokens: 3 },
    },
    {
      text: 'Done.',
      toolCalls: [],
      finishReason: 'stop',
      usage: { inputTokens: 5, outputTokens: 3 },
    },
  ];
  const tools = new ToolRegistry();
  tools.register({
    name: 'noop',
    description: 'Does nothing',
    inputSchema: { type: 'object', properties: {} },
    async execute() {
      return { isError: false, content: 'ok' };
    },
  });
  const agent = new Agent({
    store,
    tools,
    approve: async () => false,
    provider: {
      async complete(request) {
        if (!isSummaryRequest(request)) renewals.push(store.leaseOf(sessionId)?.renewals ?? -1);
        return replies.shift()!;
      },
    },
  });
  const result = await agent.run({ sessionId, prompt: 'Do one thing.' });
  assert.equal(result.status, 'completed', result.error);
  assert.deepEqual(
    renewals,
    [1, 2],
    'one renewal per step boundary, before the request it precedes',
  );
  assert.equal(store.leaseOf(sessionId), null, 'a finished run is not a writer any more');
});

/**
 * The compaction lock, end to end: while the summary request is in flight, the session is claimed *by the run
 * that is paying for it*. The claim is what was taken before the request, which is the whole point — a run must
 * not spend a summary it would be refused at the write.
 */
test('a compaction holds the session while its summary request is in flight', async (t) => {
  const { store, sessionId } = await fixture(t);
  for (let index = 0; index < 3; index++) {
    store.append(sessionId, { role: 'user', content: 'history '.repeat(900) });
    store.append(sessionId, { role: 'assistant', content: 'Recorded.', toolCalls: [] });
  }
  const held: { compactingRunId?: string; runId: string }[] = [];
  let summaries = 0;
  const agent = new Agent({
    store,
    tools: new ToolRegistry(),
    approve: async () => false,
    maxContextChars: 100_000,
    maxContextTokens: 10_000,
    autoCompactTokens: 6_000,
    maxOutputTokens: 128,
    provider: {
      async complete(request) {
        if (isSummaryRequest(request)) {
          summaries++;
          const lease = store.leaseOf(sessionId);
          if (lease)
            held.push({
              runId: lease.runId,
              ...(lease.compactingRunId ? { compactingRunId: lease.compactingRunId } : {}),
            });
        }
        return {
          text: 'Summary of the work so far.',
          toolCalls: [],
          finishReason: 'stop',
          usage: { inputTokens: 5, outputTokens: 3 },
        };
      },
    },
  });
  const result = await agent.run({ sessionId, prompt: 'Continue.' });
  assert.equal(result.status, 'completed', result.error);
  assert.ok(summaries > 0, 'the fixture really did compact');
  assert.ok(held.length > 0, 'the session was held while the summary was in flight');
  assert.equal(
    held[0]!.compactingRunId,
    held[0]!.runId,
    'the lock belongs to the run that is paying for the summary',
  );
  assert.ok(store.contextSurface(sessionId), 'and the compaction was recorded by the holder');
  assert.equal(store.leaseOf(sessionId), null, 'the lock and the lease both end with the run');
});
