import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SCHEMA_VERSION, SessionStore } from '../packages/storage/sqlite.ts';
import {
  SessionProjectionRegistry,
  UnknownSessionProjectionError,
  messagesProjection,
  statisticsProjection,
  subAgentCards,
  turnTimingProjection,
} from '../packages/storage/projections.ts';
import type { SessionProjection, SubAgentCardsState } from '../packages/storage/projections.ts';
import type { SessionEvent } from '../packages/storage/events.ts';
import { emptyStatistics, emptyRequestTiming } from '../packages/protocol/statistics.ts';
import type { SessionStatistics } from '../packages/protocol/statistics.ts';
import { Agent } from '../packages/core/agent.ts';
import { ToolRegistry } from '../packages/tools/registry.ts';
import type {
  Message,
  ModelResponse,
  RunResult,
  Usage,
  Provider,
} from '../packages/protocol/index.ts';

// ---- merged from session-projections.test.ts ----

/**
 * Session projections.
 *
 * A projection is only useful if it is *the same answer* as the thing it replaces. While both exist — the
 * fold over the log and the write-through table — these tests compare them, computing the table's answer
 * independently (the way a reviewer would) rather than by calling the code under test a second time. They
 * also pin the two behaviours a registry has to have to be worth having: an unknown projection is an error
 * rather than an empty state, and a fold that throws is not swallowed into a shorter view.
 */

const reply = (text = 'Done'): ModelResponse => ({
  text,
  toolCalls: [],
  finishReason: 'stop',
  usage: { inputTokens: 10, outputTokens: 5 },
});
const event = (type: string, seq: number, data: Record<string, unknown> = {}): SessionEvent => ({
  seq,
  sessionId: 's',
  type,
  data,
  at: new Date().toISOString(),
});
/**
 * The statistics the `runs` table implies, computed here on purpose: if the test called the code under
 * test to produce the expected value it would prove nothing.
 */
const statisticsFromRunsTable = (file: string, sessionId: string): SessionStatistics => {
  const db = new DatabaseSync(file);
  try {
    const total = emptyStatistics();
    const measuredCompactions = new Map<string, Usage>();
    const compactedByRun = new Map<string, Usage>();
    for (const row of db
      .prepare(
        'SELECT result FROM runs WHERE session_id=? AND result IS NOT NULL ORDER BY started_at,rowid',
      )
      .all(sessionId)) {
      const result = JSON.parse(String(row.result)) as RunResult;
      if (result.statistics) {
        const other = result.statistics;
        total.turns += other.turns;
        total.steps += other.steps;
        total.inputTokens += other.inputTokens;
        total.outputTokens += other.outputTokens;
        total.cachedInputTokens += other.cachedInputTokens;
        total.cacheWriteInputTokens += other.cacheWriteInputTokens ?? 0;
        total.cacheKnown = total.cacheKnown && other.cacheKnown;
        total.timingKnown = total.timingKnown && other.timingKnown;
        total.usageComplete = total.usageComplete !== false && other.usageComplete !== false;
        total.modelMs += other.modelMs;
        total.toolMs += other.toolMs;
        total.firstTokenMs += other.firstTokenMs;
        total.firstTokenCount += other.firstTokenCount;
        total.decodeMs += other.decodeMs;
        total.decodeTokens += other.decodeTokens;
        if (result.compactionUsage) {
          total.inputTokens -= result.compactionUsage.inputTokens;
          total.outputTokens -= result.compactionUsage.outputTokens;
          total.cachedInputTokens -= result.compactionUsage.cachedInputTokens ?? 0;
          total.cacheWriteInputTokens -= result.compactionUsage.cacheWriteInputTokens ?? 0;
          if (other.timingKnown) measuredCompactions.set(result.runId, result.compactionUsage);
        }
        if (other.decodeKnown !== undefined)
          total.decodeKnown = total.decodeKnown !== false && other.decodeKnown;
        if (other.requestTiming) {
          const timing = (total.requestTiming ??= emptyRequestTiming());
          for (const key of Object.keys(timing) as (keyof typeof timing)[])
            timing[key] += other.requestTiming[key];
        }
      } else {
        total.inputTokens += result.usage.inputTokens;
        total.outputTokens += result.usage.outputTokens;
        total.cachedInputTokens += result.usage.cachedInputTokens ?? 0;
        total.cacheWriteInputTokens += result.usage.cacheWriteInputTokens ?? 0;
        if (result.usage.inputTokens > 0 && result.usage.cachedInputTokens === undefined)
          total.cacheKnown = false;
        total.timingKnown = false;
      }
    }
    // Compactions are model calls too. Their cost used to live in the write-through checkpoint row as well,
    // which is how this fold could be checked against a second store; the row is gone (the compaction is a
    // log op now), so what is checked here is the same fold against the raw events, read independently.
    for (const row of db
      .prepare(
        "SELECT data FROM session_events WHERE session_id=? AND type='context.compacted' ORDER BY seq",
      )
      .all(sessionId)) {
      const data = JSON.parse(String(row.data)) as {
        usage?: Usage;
        cacheKnown?: boolean;
        runId?: string;
      };
      if (!data.usage) continue;
      const usage = data.usage;
      total.inputTokens += usage.inputTokens;
      total.outputTokens += usage.outputTokens;
      total.cachedInputTokens += usage.cachedInputTokens ?? 0;
      total.cacheWriteInputTokens += usage.cacheWriteInputTokens ?? 0;
      if (usage.inputTokens > 0 && usage.cachedInputTokens === undefined) total.cacheKnown = false;
      if (data.cacheKnown === false) total.cacheKnown = false;
      if (!data.runId) total.timingKnown = false;
      else {
        const prior = compactedByRun.get(data.runId);
        compactedByRun.set(data.runId, {
          inputTokens: (prior?.inputTokens ?? 0) + usage.inputTokens,
          outputTokens: (prior?.outputTokens ?? 0) + usage.outputTokens,
          cachedInputTokens: (prior?.cachedInputTokens ?? 0) + (usage.cachedInputTokens ?? 0),
          cacheWriteInputTokens:
            (prior?.cacheWriteInputTokens ?? 0) + (usage.cacheWriteInputTokens ?? 0),
        });
      }
    }
    for (const [runId, usage] of compactedByRun) {
      const measured = measuredCompactions.get(runId);
      if (
        !measured ||
        Object.keys(usage).some(
          (key) => usage[key as keyof Usage] !== (measured[key as keyof Usage] ?? 0),
        )
      )
        total.timingKnown = false;
    }
    return total;
  } finally {
    db.close();
  }
};

test('the turn timing fold measures the runs a session worked, and only its own', () => {
  /**
   * The one figure this fold exists for, checked against arithmetic a reviewer can do by hand: two runs of
   * ten and five seconds are fifteen, a boundary that names another run closes nothing, and an end with no
   * start is a record about a run this session never opened here.
   */
  const at = (seconds: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, seconds)).toISOString();
  const boundary = (type: string, seq: number, runId: string, seconds: number): SessionEvent => ({
    seq,
    sessionId: 's',
    type,
    data: { runId },
    at: at(seconds),
  });
  const events: SessionEvent[] = [
    boundary('run.started', 1, 'r1', 0),
    boundary('run.finished', 2, 'r1', 10),
    // A run this fold is not holding: the open span must survive it rather than being charged for its end.
    boundary('run.finished', 3, 'other', 40),
    boundary('run.started', 4, 'r2', 50),
    boundary('run.finished', 5, 'r2', 55),
  ];
  let state = turnTimingProjection.initial();
  assert.deepEqual(state, { settledMs: 0, runningSince: null, runningRunId: null });
  for (const entry of events) state = turnTimingProjection.apply(state, entry);
  assert.deepEqual(state, { settledMs: 15_000, runningSince: null, runningRunId: null });

  // A run still in flight is a start with nothing after it: the caller adds the elapsed part, which is what
  // lets a working child's number tick without a frame a second.
  const open = turnTimingProjection.apply(
    turnTimingProjection.initial(),
    boundary('run.started', 1, 'r1', 3),
  );
  assert.deepEqual(open, {
    settledMs: 0,
    runningSince: Date.parse(at(3)),
    runningRunId: 'r1',
  });
  // An interruption closes the span exactly like a finish: the process died, but the work happened.
  assert.equal(
    turnTimingProjection.apply(open, boundary('run.interrupted', 2, 'r1', 9)).settledMs,
    6_000,
  );
  // A run with no window of its own contributes nothing to a figure about work.
  assert.deepEqual(
    turnTimingProjection.apply(turnTimingProjection.initial(), boundary('run.started', 1, '', 0)),
    turnTimingProjection.initial(),
  );
});

test('the registry lists, describes, refuses unknown names and hands back removals', () => {
  const registry = new SessionProjectionRegistry();
  const counters: SessionProjection<number> = {
    name: 'count',
    description: 'Counts events.',
    initial: () => 0,
    apply: (state) => state + 1,
  };
  const dispose = registry.register(counters);
  assert.deepEqual(registry.names(), ['count']);
  assert.deepEqual(registry.describe(), [{ name: 'count', description: 'Counts events.' }]);
  assert.throws(() => registry.register(counters), /Duplicate session projection: count/);
  assert.equal(registry.stateOf('count', [event('a', 1), event('b', 2)]), 2);
  assert.throws(() => registry.stateOf('missing', []), UnknownSessionProjectionError);
  assert.throws(() => registry.get('missing'), /registered projections: count/);
  dispose();
  assert.deepEqual(registry.names(), []);
});

test('a projection only folds the events it cares about, and one pass covers them all', () => {
  const registry = new SessionProjectionRegistry();
  registry.register({
    name: 'users',
    initial: () => 0,
    apply: (state, current) => (current.type === 'message.user' ? state + 1 : state),
  });
  registry.register({
    name: 'runs',
    initial: () => [] as string[],
    apply: (state, current) =>
      current.type === 'run.finished' ? [...state, String(current.data.runId)] : state,
  });
  const events = [
    event('run.started', 1, { runId: 'r1' }),
    event('message.user', 2, { message: { role: 'user', content: 'x' } }),
    event('run.finished', 3, { runId: 'r1' }),
  ];
  assert.deepEqual(registry.snapshot(events), { users: 1, runs: ['r1'] });
  assert.equal(registry.stateOf('users', events), 1);
  assert.deepEqual(registry.stateOf<string[]>('runs', events), ['r1']);
});

test('a fold that throws is not swallowed into a shorter view', () => {
  const registry = new SessionProjectionRegistry();
  registry.register({
    name: 'strict',
    initial: () => 0,
    apply: () => {
      throw new Error('this event cannot be folded');
    },
  });
  assert.throws(() => registry.stateOf('strict', [event('anything', 1)]), /cannot be folded/);
  assert.throws(() => registry.snapshot([event('anything', 1)]), /cannot be folded/);
});

test('the messages projection is the transcript a session read returns', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-projection-messages-'));
  const store = new SessionStore(path.join(root, 'sessions.sqlite'));
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const session = store.create(root);
  store.append(session.id, { role: 'user', content: 'hello' });
  store.append(session.id, { role: 'assistant', content: 'hi', toolCalls: [] });
  const messages: Message[] = store.stateOf<Message[]>('messages', session.id);
  assert.deepEqual(messages, store.messages(session.id));
  assert.deepEqual(messages, messagesProjection.initial().concat(messages));
  assert.deepEqual(
    (store.snapshot(session.id) as { messages: Message[] }).messages,
    store.messages(session.id),
  );
});

test('the statistics projection equals what the runs table implies', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-projection-stats-'));
  const file = path.join(root, 'sessions.sqlite');
  const store = new SessionStore(file);
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const session = store.create(root);
  let turn = 0;
  const agent = new Agent({
    store,
    provider: {
      async complete() {
        turn++;
        return reply(`answer ${turn}`);
      },
    },
    tools: new ToolRegistry(),
    approve: async () => true,
  });
  // Two runs in one session: the fold has to accumulate, like the table does.
  assert.equal((await agent.run({ sessionId: session.id, prompt: 'one' })).status, 'completed');
  assert.equal((await agent.run({ sessionId: session.id, prompt: 'two' })).status, 'completed');

  const fromLog = store.statistics(session.id);
  const fromTable = statisticsFromRunsTable(file, session.id);
  assert.deepEqual(fromLog, fromTable, 'the projection and the table agree run for run');
  assert.ok(fromLog.inputTokens > 0, 'the scenario really produced usage');
  assert.equal(fromLog.timingKnown, fromTable.timingKnown);
  assert.deepEqual(statisticsProjection.initial().statistics, emptyStatistics());
  assert.deepEqual(
    (store.snapshot(session.id) as { statistics: SessionStatistics }).statistics,
    fromLog,
  );
});

test('a compaction contributes the tokens it cost, and the table agrees', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-projection-compact-'));
  const file = path.join(root, 'sessions.sqlite');
  const store = new SessionStore(file);
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const session = store.create(root);
  store.append(session.id, { role: 'user', content: 'first' });
  store.append(session.id, { role: 'assistant', content: 'answer', toolCalls: [] });
  const usage: Usage = { inputTokens: 900, outputTokens: 100 };
  store.applyCompaction(session.id, { coveredMessages: 2, summary: 'summary', usage });
  const statistics = store.statistics(session.id);
  assert.equal(statistics.inputTokens, 900);
  assert.equal(statistics.outputTokens, 100);
  assert.equal(statistics.timingKnown, false, 'a summary request reports tokens, not timing');
  assert.deepEqual(
    statistics,
    statisticsFromRunsTable(file, session.id),
    'the table carries the same cost, so the two views stay reconcilable',
  );
  // A checkpoint recorded without usage (an older writer, or a caller that does not report it) changes
  // nothing: the totals must not invent a cost.
  store.append(session.id, { role: 'user', content: 'second' });
  store.append(session.id, { role: 'assistant', content: 'answer again', toolCalls: [] });
  store.applyCompaction(session.id, { coveredMessages: 4, summary: 'summary again' });
  assert.equal(store.statistics(session.id).inputTokens, 900);
});

test('pending summary timing survives a checkpoint and only its matching run confirms it', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-summary-timing-'));
  const file = path.join(root, 'sessions.sqlite');
  let store = new SessionStore(file);
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const session = store.create(root);
  const usage = { inputTokens: 100, outputTokens: 20, cachedInputTokens: 0 };
  const stats = { ...emptyStatistics(), ...usage, modelMs: 50 };
  store.recordEvent(session.id, 'context.compacted', { runId: 'one', usage });
  assert.equal(store.statistics(session.id).timingKnown, false);
  store.close();
  store = new SessionStore(file);
  assert.equal(store.statistics(session.id).timingKnown, false);
  store.recordEvent(session.id, 'context.compacted', { runId: 'two', usage });
  store.recordEvent(session.id, 'run.finished', {
    runId: 'one',
    statistics: stats,
    compactionUsage: usage,
  });
  assert.equal(store.statistics(session.id).timingKnown, false, 'run two remains unconfirmed');
  store.close();
  store = new SessionStore(file);
  store.recordEvent(session.id, 'run.finished', {
    runId: 'two',
    statistics: stats,
    compactionUsage: usage,
  });
  assert.equal(store.statistics(session.id).timingKnown, true);
  assert.equal(store.statistics(session.id).inputTokens, 200);
  assert.equal(store.statistics(session.id).modelMs, 100);
  assert.deepEqual(
    (store.snapshot(session.id) as { statistics: SessionStatistics }).statistics,
    store.statistics(session.id),
    'the snapshot exposes public statistics without fold metadata',
  );
  store.recordEvent(session.id, 'context.compacted', { runId: 'crashed', usage });
  store.recordEvent(session.id, 'run.interrupted', { runId: 'crashed' });
  store.recordEvent(session.id, 'run.finished', { runId: 'later', statistics: stats });
  assert.equal(
    store.statistics(session.id).timingKnown,
    false,
    'a later run cannot erase crash uncertainty',
  );
});

for (const source of ['standalone', 'title', 'legacy-run', 'mismatched'] as const) {
  test(`known summary timing cannot erase an unknown ${source} source`, () => {
    const usage = { inputTokens: 100, outputTokens: 20, cachedInputTokens: 0 };
    const stats = { ...emptyStatistics(), ...usage, modelMs: 50 };
    let state = statisticsProjection.initial();
    const apply = (type: string, data: Record<string, unknown>) => {
      state = statisticsProjection.apply(state, event(type, 1, data));
    };
    if (source === 'standalone') apply('context.compacted', { usage });
    if (source === 'title') apply('session.title.generated', { usage });
    if (source === 'legacy-run') apply('run.finished', { runId: 'old', usage });
    if (source === 'mismatched') {
      apply('context.compacted', { runId: 'old', usage });
      apply('run.finished', {
        runId: 'old',
        statistics: stats,
        compactionUsage: { ...usage, outputTokens: 19 },
      });
    }
    apply('context.compacted', { runId: 'known', usage });
    apply('run.finished', { runId: 'known', statistics: stats, compactionUsage: usage });
    assert.equal(state.statistics.timingKnown, false);
    assert.deepEqual(state.pendingCompactions, {});
  });
}

test('summary timing keeps prototype-named run ids as pending sources across serialization', () => {
  const usage = { inputTokens: 100, outputTokens: 20, cachedInputTokens: 0 };
  const stats = { ...emptyStatistics(), ...usage, modelMs: 50 };
  for (const runId of ['__proto__', 'constructor', 'toString']) {
    let state = statisticsProjection.apply(
      statisticsProjection.initial(),
      event('context.compacted', 1, { runId, usage }),
    );
    assert.equal(state.statistics.timingKnown, false, runId);
    assert.equal(Object.hasOwn(state.pendingCompactions, runId), true);
    state = JSON.parse(JSON.stringify(state)) as typeof state;
    state = statisticsProjection.apply(
      state,
      event('run.finished', 2, { runId, statistics: stats, compactionUsage: usage }),
    );
    assert.equal(state.statistics.timingKnown, true, runId);
    assert.deepEqual(state.pendingCompactions, {});
  }
});

test('a database written before the log existed gets its run and compaction facts backfilled', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-projection-backfill-'));
  const file = path.join(root, 'sessions.sqlite');
  const now = new Date().toISOString();
  const legacyResult = (runId: string, usage: Usage, statistics?: SessionStatistics): RunResult =>
    ({
      runId,
      sessionId: 'old',
      status: 'completed',
      text: 'done',
      usage,
      ...(statistics ? { statistics } : {}),
      statistics: undefined,
    }) as unknown as RunResult;
  const legacy = new DatabaseSync(file);
  legacy.exec(`
    CREATE TABLE sessions(id TEXT PRIMARY KEY, workspace TEXT NOT NULL, created_at TEXT NOT NULL, active_run TEXT);
    CREATE TABLE messages(seq INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, body TEXT NOT NULL, search_text TEXT NOT NULL DEFAULT '');
    CREATE TABLE runs(id TEXT PRIMARY KEY, session_id TEXT NOT NULL, owner_pid INTEGER NOT NULL, status TEXT NOT NULL, started_at TEXT NOT NULL, result TEXT);
    CREATE TABLE context_checkpoints(session_id TEXT PRIMARY KEY, covered_messages INTEGER NOT NULL, summary TEXT NOT NULL);
    PRAGMA user_version=13;
  `);
  legacy
    .prepare('INSERT INTO sessions(id,workspace,created_at) VALUES(?,?,?)')
    .run('old', root, now);
  legacy
    .prepare('INSERT INTO messages(session_id,body,search_text) VALUES(?,?,?)')
    .run('old', JSON.stringify({ role: 'user', content: 'legacy question' }), '');
  // One run with statistics, one older run with usage only: the fold has to handle both.
  legacy
    .prepare(
      "INSERT INTO runs(id,session_id,owner_pid,status,started_at,result) VALUES(?,?,?,'completed',?,?)",
    )
    .run(
      'run-a',
      'old',
      process.pid,
      now,
      JSON.stringify({
        ...legacyResult('run-a', { inputTokens: 100, outputTokens: 40 }),
        statistics: { ...emptyStatistics(), inputTokens: 100, outputTokens: 40, modelMs: 500 },
      }),
    );
  legacy
    .prepare(
      "INSERT INTO runs(id,session_id,owner_pid,status,started_at,result) VALUES(?,?,?,'completed',?,?)",
    )
    .run(
      'run-b',
      'old',
      process.pid,
      now,
      JSON.stringify(legacyResult('run-b', { inputTokens: 7, outputTokens: 3 })),
    );
  legacy
    .prepare(
      "INSERT INTO runs(id,session_id,owner_pid,status,started_at) VALUES(?,?,?,'interrupted',?)",
    )
    .run('run-c', 'old', process.pid, now);
  legacy
    .prepare('INSERT INTO context_checkpoints(session_id,covered_messages,summary) VALUES(?,?,?)')
    .run('old', 1, 'earlier history, summarised');
  legacy.close();

  const store = new SessionStore(file);
  const opened: SessionStore[] = [store];
  t.after(async () => {
    for (const handle of opened) handle.close();
    await rm(root, { recursive: true, force: true });
  });

  const types = store.events('old').map((current) => current.type);
  assert.deepEqual(types, [
    'message.user',
    'run.started',
    'run.finished',
    'run.started',
    'run.finished',
    'run.started',
    'context.compacted',
  ]);
  assert.deepEqual(store.messages('old'), [{ role: 'user', content: 'legacy question' }]);
  const statistics = store.statistics('old');
  assert.deepEqual(statistics, statisticsFromRunsTable(file, 'old'));
  assert.equal(statistics.inputTokens, 107);
  assert.equal(statistics.modelMs, 500, 'the run that reported timing keeps it');
  assert.equal(statistics.timingKnown, false, 'the run that only had usage marks timing unknown');
  const compacted = store.events('old').find((current) => current.type === 'context.compacted');
  assert.deepEqual(compacted?.data, {
    coveredMessages: 1,
    summary: 'earlier history, summarised',
  });
  const again = new SessionStore(file);
  opened.push(again);
  assert.equal(again.events('old').length, types.length, 'the backfill does not run twice');
  // Schema v18: the checkpoint row is gone and the surface is derived from that same event. This database
  // was written before the table's own column set was settled, so it is also the case the migration has to
  // carry: a row with no usage, whose summary still has to reach a reader that only folds the log.
  assert.deepEqual(again.contextSurface('old'), {
    generation: 1,
    coveredMessages: 1,
    summary: 'earlier history, summarised',
  });
  const schema = new DatabaseSync(file);
  try {
    assert.equal(
      schema
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='context_checkpoints'")
        .get(),
      undefined,
      'the compaction surface is a log op, not a table',
    );
    assert.equal(
      (schema.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
      SCHEMA_VERSION,
    );
  } finally {
    schema.close();
  }
});

// ---- merged from subagent-cards.test.ts ----

/**
 * Sub-agent cards as a projection.
 *
 * The cards used to be derived at read time from the parent's latest stored run result plus a
 * `subagent_assignments` table that existed only so a child whose parent crashed could still be shown.
 * That is two sources for one view, and the interesting question — "do they agree?" — had no answer. They
 * are durable facts about the parent's session, so they belong in the parent's log, and the cards become a
 * fold.
 *
 * These tests check the three places that can go wrong: the writer (a real delegated run must record both
 * the assignment and the outcome), the selector (which cards a reader sees is presentation, and the rule is
 * "the latest finished run, plus children left interrupted"), and the migration (an older database must not
 * lose its cards, or gain stale "running" ones, when it upgrades).
 */

const reply2 = (text = 'Done'): ModelResponse => ({
  text,
  toolCalls: [],
  finishReason: 'stop',
  usage: { inputTokens: 10, outputTokens: 5 },
});
const toolCall = (id: string, name: string, args: Record<string, unknown>): ModelResponse => ({
  text: '',
  finishReason: 'tool_calls',
  toolCalls: [{ id, name, arguments: args }],
  usage: { inputTokens: 10, outputTokens: 5 },
});

test('a delegated run records the child identity and outcome in the parent log', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-cards-run-'));
  const store = new SessionStore(path.join(root, 'sessions.sqlite'));
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const session = store.create(root);
  const provider: Provider = {
    async complete(request) {
      if (request.system.includes('You are a sub-agent delegated by a parent agent'))
        return reply2('child report');
      if (request.messages.some((message) => message.role === 'tool')) return reply2('Done');
      return toolCall('delegate-1', 'delegate_task', { tasks: [{ objective: 'Investigate' }] });
    },
  };
  const agent = new Agent({
    store,
    provider,
    tools: new ToolRegistry(),
    approve: async () => true,
    subagents: { enabled: true },
  });
  const result = await agent.run({ sessionId: session.id, prompt: 'Do the work' });
  assert.equal(result.status, 'completed', result.error);
  assert.equal(result.subagents?.length, 1, 'the run reported one child');

  const types = store.events(session.id).map((event) => event.type);
  assert.ok(types.includes('subagent.assigned'), 'the assignment is durable');
  assert.ok(types.includes('subagent.finished'), 'the outcome is durable');
  const assigned = store.events(session.id).find((event) => event.type === 'subagent.assigned');
  const child = store.childSessions(session.id)[0]!;
  assert.equal(assigned?.data.childSessionId, child.id);
  assert.equal(assigned?.data.id, result.subagents?.[0]?.id);
  assert.equal(typeof assigned?.data.runId, 'string', 'the card knows which run started it');

  // The projection has to agree with the run result, which is where these cards came from before.
  const cards = store.subagents(session.id);
  assert.equal(cards.length, 1);
  assert.equal(cards[0]?.id, result.subagents?.[0]?.id);
  assert.equal(cards[0]?.status, result.subagents?.[0]?.status);
  assert.equal(cards[0]?.objective, result.subagents?.[0]?.objective);
  assert.equal(cards[0]?.sessionId, result.subagents?.[0]?.sessionId);
  assert.deepEqual(cards[0]?.usage, result.subagents?.[0]?.usage);
  assert.equal(cards[0]?.rounds, result.subagents?.[0]?.rounds);
});

test('the cards a reader sees are the latest finished run, plus children left interrupted', () => {
  const state: SubAgentCardsState = {
    latestRunId: 'run-2',
    children: {
      old: {
        id: 'old',
        runId: 'run-1',
        sessionId: 'child-old',
        role: 'explore',
        objective: 'older work',
        status: 'completed',
        rounds: 1,
        toolCalls: 0,
        usage: { inputTokens: 1, outputTokens: 1 },
      },
      current: {
        id: 'current',
        runId: 'run-2',
        sessionId: 'child-current',
        role: 'general',
        objective: 'current work',
        status: 'completed',
        rounds: 2,
        toolCalls: 1,
        usage: { inputTokens: 2, outputTokens: 1 },
      },
      stuck: {
        id: 'stuck',
        runId: 'run-1',
        sessionId: 'child-stuck',
        role: 'explore',
        objective: 'never reported',
        status: 'interrupted',
        rounds: 0,
        toolCalls: 0,
        usage: { inputTokens: 0, outputTokens: 0 },
        error: 'Interrupted',
      },
    },
  };
  const cards = subAgentCards(state);
  assert.deepEqual(
    cards.map((card) => card.id),
    ['current', 'stuck'],
    'an older finished child is history; an interrupted one is still work to review',
  );
  assert.ok(
    cards.every((card) => !('runId' in card)),
    'the selector returns summaries, not the bookkeeping field',
  );
  assert.deepEqual(subAgentCards({ children: {} }), []);
});

test('a fresh database never creates the assignment table', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-cards-fresh-'));
  const file = path.join(root, 'sessions.sqlite');
  const store = new SessionStore(file);
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const reader = new DatabaseSync(file);
  const tables = reader
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='subagent_assignments'")
    .all();
  reader.close();
  assert.deepEqual(tables, [], 'the retired table is not part of the schema any more');
});

test('upgrading past the retired table drops it and keeps the cards', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-cards-drop-'));
  const file = path.join(root, 'sessions.sqlite');
  const store = new SessionStore(file);
  const session = store.create(root);
  const child = store.create(root, session.id);
  store.recordEvent(session.id, 'subagent.assigned', {
    id: 'task-1',
    role: 'general',
    objective: 'finish the sweep',
    childSessionId: child.id,
    runId: 'run-1',
  });
  store.recordEvent(session.id, 'run.finished', { runId: 'run-1', status: 'completed' });
  store.recordEvent(session.id, 'subagent.finished', {
    runId: 'run-1',
    id: 'task-1',
    sessionId: child.id,
    role: 'general',
    objective: 'finish the sweep',
    status: 'completed',
    rounds: 3,
    toolCalls: 2,
    usage: { inputTokens: 30, outputTokens: 8 },
  });
  store.close();

  // A v15 database: the log already carries the cards, and the table that used to carry them is still there.
  const legacy = new DatabaseSync(file);
  legacy.exec(
    'CREATE TABLE subagent_assignments(child_session_id TEXT PRIMARY KEY, id TEXT NOT NULL, role TEXT NOT NULL, objective TEXT NOT NULL)',
  );
  legacy
    .prepare('INSERT INTO subagent_assignments(child_session_id,id,role,objective) VALUES(?,?,?,?)')
    .run(child.id, 'task-1', 'general', 'finish the sweep');
  legacy.exec('PRAGMA user_version=15');
  legacy.close();

  const upgraded = new SessionStore(file);
  t.after(async () => {
    upgraded.close();
    await rm(root, { recursive: true, force: true });
  });
  const reader = new DatabaseSync(file);
  const tables = reader
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='subagent_assignments'")
    .all();
  reader.close();
  assert.deepEqual(tables, [], 'the retired table is dropped on upgrade');
  assert.deepEqual(
    upgraded.subagents(session.id).map((card) => [card.id, card.status, card.rounds]),
    [['task-1', 'completed', 3]],
    'and the cards survive, because the log carried them',
  );
});

test('an upgraded database keeps its cards and does not show old children as running', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-cards-migrate-'));
  const file = path.join(root, 'sessions.sqlite');
  const now = new Date().toISOString();
  // A v13 database as it was written then: messages, runs whose result carried the child summaries, and the
  // assignments table that existed so a crashed parent's card could still be shown.
  const legacy = new DatabaseSync(file);
  legacy.exec(`
    CREATE TABLE sessions(id TEXT PRIMARY KEY, workspace TEXT NOT NULL, created_at TEXT NOT NULL, active_run TEXT, parent_session_id TEXT, fork_message_count INTEGER);
    CREATE TABLE messages(seq INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, body TEXT NOT NULL, search_text TEXT NOT NULL DEFAULT '');
    CREATE TABLE runs(id TEXT PRIMARY KEY, session_id TEXT NOT NULL, owner_pid INTEGER NOT NULL, status TEXT NOT NULL, started_at TEXT NOT NULL, result TEXT);
    CREATE TABLE context_checkpoints(session_id TEXT PRIMARY KEY, covered_messages INTEGER NOT NULL, summary TEXT NOT NULL);
    CREATE TABLE subagent_assignments(child_session_id TEXT PRIMARY KEY, id TEXT NOT NULL, role TEXT NOT NULL, objective TEXT NOT NULL);
    PRAGMA user_version=13;
  `);
  const addSession = legacy.prepare(
    'INSERT INTO sessions(id,workspace,created_at,parent_session_id) VALUES(?,?,?,?)',
  );
  addSession.run('parent', root, now, null);
  addSession.run('child-done', root, now, 'parent');
  addSession.run('child-stuck', root, now, 'parent');
  legacy
    .prepare('INSERT INTO subagent_assignments(child_session_id,id,role,objective) VALUES(?,?,?,?)')
    .run('child-done', 'task-done', 'general', 'finish the sweep');
  legacy
    .prepare('INSERT INTO subagent_assignments(child_session_id,id,role,objective) VALUES(?,?,?,?)')
    .run('child-stuck', 'task-stuck', 'explore', 'read the config');
  legacy
    .prepare(
      "INSERT INTO runs(id,session_id,owner_pid,status,started_at,result) VALUES(?,?,?,'completed',?,?)",
    )
    .run(
      'run-1',
      'parent',
      process.pid,
      now,
      JSON.stringify({
        runId: 'run-1',
        sessionId: 'parent',
        status: 'completed',
        text: 'done',
        usage: { inputTokens: 100, outputTokens: 20 },
        subagents: [
          {
            id: 'task-done',
            sessionId: 'child-done',
            role: 'general',
            objective: 'finish the sweep',
            status: 'completed',
            rounds: 2,
            toolCalls: 3,
            usage: { inputTokens: 40, outputTokens: 9 },
          },
        ],
      }),
    );
  legacy
    .prepare(
      "INSERT INTO runs(id,session_id,owner_pid,status,started_at) VALUES(?,?,?,'interrupted',?)",
    )
    .run('run-child', 'child-stuck', process.pid, now);
  legacy
    .prepare(
      "INSERT INTO runs(id,session_id,owner_pid,status,started_at) VALUES(?,?,?,'completed',?)",
    )
    .run('run-child-done', 'child-done', process.pid, now);
  legacy.close();

  const store = new SessionStore(file);
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const types = store.events('parent').map((event) => event.type);
  assert.ok(types.includes('subagent.assigned'), 'assignments were backfilled');
  assert.ok(types.includes('subagent.finished'), 'outcomes were backfilled');
  assert.ok(types.includes('subagent.interrupted'), 'the interrupted child was backfilled');
  const cards = store.subagents('parent');
  assert.deepEqual(
    cards.map((card) => [card.id, card.status]),
    [
      ['task-done', 'completed'],
      ['task-stuck', 'interrupted'],
    ],
    'the finished child keeps its real outcome, and the stuck one is still reviewable',
  );
  assert.equal(cards[0]?.rounds, 2, 'the recorded outcome is the real one, not a default');
  assert.deepEqual(cards[0]?.usage, { inputTokens: 40, outputTokens: 9 });
  assert.match(String(cards[1]?.error), /Interrupted/);
});
