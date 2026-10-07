import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SessionStore, projectionFoldIdentity } from '../packages/storage/sqlite.ts';
import { BUILT_IN_SESSION_PROJECTIONS } from '../packages/storage/projections.ts';

/**
 * Cold-start projection checkpoints: what a *new process* reads instead of folding.
 *
 * The in-process projection cache only helps a process that is already up, which is the wrong half of the
 * problem: a restart is exactly when a long session is folded again from the beginning. The checkpoint is
 * persisted state plus the log position it was folded to, so the next process continues from there.
 *
 * These tests are about the property that makes that safe rather than fast: **a checkpoint may only skip work
 * whose answer is already written down**. So every test that exercises a checkpoint also checks the answer
 * against the fold it is standing in for, and the cases where a checkpoint must be *ignored* (a different fold
 * version, unreadable state, a log that no longer reaches that far) are treated as first-class.
 */

interface Fixture {
  root: string;
  file: string;
  store: SessionStore;
  sessionId: string;
}
async function fixture(t: test.TestContext): Promise<Fixture> {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-checkpoint-'));
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
  return { root, file, store, sessionId: session.id };
}
/** A session with enough different event kinds that several projections have something to fold. */
function seed(store: SessionStore, sessionId: string, rounds = 3): void {
  store.append(sessionId, { role: 'user', content: 'Start the work.' });
  for (let index = 0; index < rounds; index += 1) {
    store.recordEvent(sessionId, 'run.started', { runId: `run-${index}`, ownerPid: process.pid });
    // `step.*` records carry the run they belong to: the fold skips a payload without one, which is what makes
    // a log written by a different build readable rather than fatal.
    store.recordEvent(sessionId, 'step.started', { runId: `run-${index}`, step: index });
    store.recordEvent(sessionId, 'step.finished', {
      runId: `run-${index}`,
      step: index,
      reason: 'final',
    });
    store.recordEvent(sessionId, 'todo.written', {
      todos: [
        {
          id: `t${index}`,
          content: `step ${index}`,
          status: index === 0 ? 'completed' : 'pending',
        },
      ],
    });
    store.append(sessionId, { role: 'assistant', content: `Round ${index} done.`, toolCalls: [] });
    store.recordEvent(sessionId, 'run.finished', {
      runId: `run-${index}`,
      status: 'completed',
      usage: { inputTokens: 10, outputTokens: 5 },
    });
  }
}
/** The projections the store persists (everything except the transcript), as a reader would ask for them. */
function readable(store: SessionStore): string[] {
  return store.projections.names().filter((name) => store.projections.get(name).persist !== false);
}
/** Rewrites one checkpoint row directly, which is how a hostile or older build's row is staged. */
function tamper(file: string, sessionId: string, name: string, sql: string, value: unknown): void {
  const db = new DatabaseSync(file);
  try {
    db.prepare(`UPDATE projection_checkpoints SET ${sql} WHERE session_id=? AND name=?`).run(
      value as never,
      sessionId,
      name,
    );
  } finally {
    db.close();
  }
}
function checkpointRows(file: string, sessionId: string): { name: string; version: string }[] {
  const db = new DatabaseSync(file);
  try {
    return db
      .prepare('SELECT name,version FROM projection_checkpoints WHERE session_id=?')
      .all(sessionId) as unknown as { name: string; version: string }[];
  } finally {
    db.close();
  }
}

test('a restarted process continues from the checkpoint instead of folding the log again', async (t) => {
  const { file, store, sessionId } = await fixture(t);
  seed(store, sessionId);
  // The answers a full fold gives, captured while no checkpoint exists — the reference every later assertion
  // is compared against.
  const names = readable(store);
  const expected = new Map(names.map((name) => [name, store.stateOf(name, sessionId)]));
  assert.ok(expected.get('statistics'), 'the scenario has statistics to compare');
  assert.equal(store.saveProjectionCheckpoints(sessionId) >= names.length, true);
  store.close();

  // A new process: same file, empty caches, no knowledge of anything above.
  const restarted = new SessionStore(file);
  restarted.resetFoldCounters();
  for (const name of names) {
    assert.deepEqual(
      restarted.stateOf(name, sessionId),
      expected.get(name),
      `${name}: a checkpoint must give the same answer as the fold it stands in for`,
    );
  }
  const stats = restarted.foldStats();
  assert.equal(stats.events, 0, 'a checkpoint that has reached the end of the log folds nothing');
  assert.equal(
    stats.checkpointHits,
    names.length,
    'every persisted projection was read from its checkpoint',
  );
  restarted.close();
});

test('events appended after a checkpoint are folded on top of it', async (t) => {
  const { file, store, sessionId } = await fixture(t);
  seed(store, sessionId);
  store.saveProjectionCheckpoints(sessionId);
  store.close();

  const restarted = new SessionStore(file);
  // One new fact, of a kind two projections care about (statistics folds run.finished, steps folds step.*).
  restarted.recordEvent(sessionId, 'step.started', { runId: 'run-99', step: 99 });
  restarted.resetFoldCounters();
  const steps = restarted.stateOf<readonly { step: number; endedAt: string | null }[]>(
    'steps',
    sessionId,
  );
  assert.equal(steps.at(-1)?.step, 99, 'the new event is in the view');
  assert.equal(steps.at(-1)?.endedAt, null, 'and it is the step that is still open');
  assert.equal(
    restarted.foldStats().events,
    1,
    'exactly the events after the checkpoint were folded',
  );
  assert.equal(restarted.foldStats().checkpointHits, 1);
  restarted.close();
});

test('a checkpoint written by a different fold of the same projection is ignored, not continued', async (t) => {
  const { file, store, sessionId } = await fixture(t);
  seed(store, sessionId);
  const todos = store.stateOf<unknown[]>('todos', sessionId);
  store.saveProjectionCheckpoints(sessionId);
  store.close();
  // Any identity but this projection's own: what a changed fold produces, and what an older build's global
  // integer now looks like. Both mean the same thing to the reader — fold from the log.
  tamper(file, sessionId, 'todos', 'version=?', 'a-different-fold');

  const restarted = new SessionStore(file);
  restarted.resetFoldCounters();
  assert.deepEqual(restarted.stateOf('todos', sessionId), todos);
  assert.equal(
    restarted.foldStats().checkpointHits,
    0,
    'state from another fold is not a starting point',
  );
  assert.ok(restarted.foldStats().events > 0, 'so the log was folded from the beginning');
  restarted.close();
});
test('one projection checkpoint per fold identity, and the rest still hit', async (t) => {
  /**
   * The reason the identity is per projection rather than one number for the build.
   *
   * Tampering with exactly one projection's row is what a changed fold looks like from the outside: that
   * projection re-folds and its neighbours carry on from their checkpoints. With the single global integer this
   * replaced, changing one fold's shape discarded every checkpoint in the database.
   *
   * Each read is measured on its own — `resetFoldCounters` then one `stateOf` — because a projection that starts
   * from a checkpoint folds nothing at all, which is the difference being asserted.
   */
  const { file, store, sessionId } = await fixture(t);
  seed(store, sessionId);
  const todos = store.stateOf<unknown[]>('todos', sessionId);
  const steps = store.stateOf<unknown[]>('steps', sessionId);
  store.saveProjectionCheckpoints(sessionId);
  store.close();
  tamper(file, sessionId, 'todos', 'version=?', 'stale');

  const restarted = new SessionStore(file);
  const foldedEvents = (name: string) => {
    restarted.resetFoldCounters();
    return { state: restarted.stateOf(name, sessionId), events: restarted.foldStats().events };
  };
  const fresh = foldedEvents('todos');
  const neighbour = foldedEvents('steps');
  assert.deepEqual(fresh.state, todos);
  assert.deepEqual(neighbour.state, steps);
  assert.ok(fresh.events > 0, 'the projection whose fold changed re-folded from the log');
  assert.equal(neighbour.events, 0, 'its neighbour still started from its own checkpoint');
  restarted.close();
});

test('unreadable state, or a checkpoint from beyond the log, falls back to folding', async (t) => {
  const { file, store, sessionId } = await fixture(t);
  seed(store, sessionId);
  const todos = store.stateOf<unknown[]>('todos', sessionId);
  store.saveProjectionCheckpoints(sessionId);
  store.close();

  for (const [what, column, value] of [
    ['state that is not JSON', 'state=?', '{not json'],
    ['a position past the end of the log', 'seq=?', 9_999],
    ['a negative position', 'seq=?', -1],
  ] as const) {
    tamper(file, sessionId, 'todos', column, value);
    const opened = new SessionStore(file);
    try {
      opened.resetFoldCounters();
      assert.deepEqual(opened.stateOf('todos', sessionId), todos, what);
      assert.equal(opened.foldStats().checkpointHits, 0, what);
    } finally {
      opened.close();
    }
  }
});

test('a checkpoint whose state has the wrong structure is not a starting point', async (t) => {
  /**
   * The corruption a fold does not necessarily notice.
   *
   * `todos` folds to an array and this row holds a parseable object instead. Several folds walk their state with
   * `Array.isArray` guards or spread it, so an object in place of an array can produce a *quietly wrong* answer
   * rather than an error — which is why the shape is checked against the projection's own empty state before the
   * state is used, rather than relying on the fold to complain.
   */
  const { file, store, sessionId } = await fixture(t);
  seed(store, sessionId);
  const todos = store.stateOf<unknown[]>('todos', sessionId);
  const steps = store.stateOf<unknown[]>('steps', sessionId);
  store.saveProjectionCheckpoints(sessionId);
  store.close();
  tamper(file, sessionId, 'todos', 'state=?', '{"not":"an array"}');

  const restarted = new SessionStore(file);
  restarted.resetFoldCounters();
  assert.deepEqual(
    restarted.stateOf('todos', sessionId),
    todos,
    'the log answered, not the bad row',
  );
  assert.equal(restarted.foldStats().checkpointHits, 0, 'and the row was not used at all');
  // The neighbouring projection is unaffected: one bad row is one projection's problem.
  restarted.resetFoldCounters();
  assert.deepEqual(restarted.stateOf('steps', sessionId), steps);
  assert.equal(restarted.foldStats().events, 0, 'its checkpoint still stood');
  restarted.close();
});

test('a state this fold cannot continue is refused, even when nothing would be folded on top of it', async (t) => {
  /**
   * The case that makes validating a checkpoint worth its cost, and the one a "the next event will fix it"
   * argument misses entirely.
   *
   * This checkpoint is at the end of the log, so the fold loop applies *no* events to it: whatever the row holds
   * is handed back as the answer. Its structure is plausible — a number where a number belongs — so the shape
   * check passes, and only replaying one real event can tell that the state is nonsense.
   *
   * The fixture is a projection that insists on its own state, because no built-in projection throws on a
   * plausible-looking state — and a test that cannot make a fold reject a state cannot test what happens when it
   * does.
   */
  const { file, store, sessionId } = await fixture(t);
  seed(store, sessionId);
  const counting = {
    name: 'counting',
    initial: () => ({ count: 0 }),
    apply: (state: { count: number }, event: { type: string }) => {
      if (typeof state.count !== 'number')
        throw new Error(`counting: state.count is ${typeof state.count}`);
      return event.type === 'todo.written' ? { count: state.count + 1 } : state;
    },
  };
  store.projections.register(counting);
  const expected = store.stateOf<{ count: number }>('counting', sessionId);
  assert.deepEqual(expected, { count: 3 }, 'three todo.written events in the fixture');
  store.saveProjectionCheckpoints(sessionId);
  store.close();
  // Right shape, wrong value, and at the end of the log: nothing folds over it, so nothing else would notice.
  tamper(file, sessionId, 'counting', 'state=?', '{"count":"lots"}');

  const restarted = new SessionStore(file);
  restarted.projections.register(counting);
  restarted.resetFoldCounters();
  assert.deepEqual(
    restarted.stateOf('counting', sessionId),
    expected,
    'the log answered, not the rotten state',
  );
  assert.equal(restarted.foldStats().checkpointHits, 0, 'the row was refused');
  assert.ok(restarted.foldStats().events > 0, 'so the events were folded from the beginning');
  restarted.close();
});

test('a fold that throws with no checkpoint in play still fails, loudly and once', async (t) => {
  // The other side of the validation: a projection whose fold is simply broken must fail. Re-folding would
  // double the work to reach the same throw, and would suggest the checkpoint was to blame.
  const { store, sessionId } = await fixture(t);
  seed(store, sessionId);
  store.projections.register({
    name: 'always-throws',
    initial: () => ({}),
    apply: () => {
      throw new Error('always-throws: the fold is broken');
    },
  });
  assert.throws(() => store.stateOf('always-throws', sessionId), /the fold is broken/);
});

test('the transcript is never checkpointed', async (t) => {
  const { file, store, sessionId } = await fixture(t);
  seed(store, sessionId);
  store.saveProjectionCheckpoints(sessionId);
  const names = checkpointRows(file, sessionId).map((row) => row.name);
  assert.ok(names.length >= 5, `several small projections were written: ${names.join(', ')}`);
  assert.ok(
    !names.includes('messages'),
    'persisting the transcript would be copying the session to avoid folding it',
  );
});

test('every checkpoint records the identity of its own fold, and only that fold continues it', async (t) => {
  const { file, store, sessionId } = await fixture(t);
  seed(store, sessionId);
  store.saveProjectionCheckpoints(sessionId);
  const rows = checkpointRows(file, sessionId);
  assert.ok(rows.length >= 5, `several projections were written: ${rows.length}`);
  for (const row of rows) {
    const projection = BUILT_IN_SESSION_PROJECTIONS.find((entry) => entry.name === row.name);
    assert.ok(projection, `${row.name} is a registered projection`);
    // Two claims in one: the row carries its fold's identity, and that identity is not shared with another
    // projection. The second is what a global version could never express.
    assert.equal(row.version, projectionFoldIdentity(projection), row.name);
  }
  assert.equal(new Set(rows.map((row) => row.version)).size, rows.length, 'one identity per fold');
  // The digest moves when the fold does: that is the whole mechanism, so it is asserted rather than assumed.
  const todos = BUILT_IN_SESSION_PROJECTIONS.find((entry) => entry.name === 'todos')!;
  const changed = { ...todos, apply: (state: unknown) => state };
  assert.notEqual(projectionFoldIdentity(changed), projectionFoldIdentity(todos));
});

test('a session with no checkpoint still reads exactly as before', async (t) => {
  const { store, sessionId } = await fixture(t);
  seed(store, sessionId);
  // Nothing is saved here: this is the path every existing reader takes.
  const todos = store.stateOf<unknown[]>('todos', sessionId);
  assert.ok(todos.length, 'the projection folded its events');
  assert.equal(store.foldStats().checkpointHits, 0);
  assert.ok(store.foldStats().events > 0);
  // And the whole-session snapshot agrees with the per-projection reads it replaces.
  const snapshot = store.snapshot(sessionId);
  for (const name of store.projections.names())
    assert.deepEqual(snapshot[name], store.stateOf(name, sessionId), name);
});

test('the snapshot path uses checkpoints too, and agrees with the folds', async (t) => {
  const { file, store, sessionId } = await fixture(t);
  seed(store, sessionId);
  const before = store.snapshot(sessionId);
  store.saveProjectionCheckpoints(sessionId);
  store.close();

  const restarted = new SessionStore(file);
  restarted.resetFoldCounters();
  const after = restarted.snapshot(sessionId);
  assert.deepEqual(after, before, 'a resumed snapshot is the same session');
  /**
   * The snapshot includes the transcript, which is deliberately never checkpointed, so this read still folds
   * the message events — that is the honest expectation. What the checkpoints buy here is the *other*
   * projections: they start from persisted state instead of re-folding the whole log.
   */
  assert.equal(
    restarted.foldStats().checkpointHits,
    readable(restarted).length,
    'every persisted projection in the snapshot started from its checkpoint',
  );
  assert.equal(
    restarted.stateOf<unknown[]>('messages', sessionId).length,
    4,
    'and the transcript is folded from the log as it always was',
  );
  restarted.close();
});

test('closing a store checkpoints the sessions it actually read', async (t) => {
  const { file, store, sessionId } = await fixture(t);
  seed(store, sessionId);
  // A session nobody read in this process: closing must not pay for folding it.
  const untouched = store.create(path.dirname(file));
  store.stateOf('todos', sessionId);
  store.close();
  const written = checkpointRows(file, sessionId).map((row) => row.name);
  assert.ok(written.length > 0, 'the session that was read is checkpointed on close');
  assert.deepEqual(checkpointRows(file, untouched.id), [], 'the one that was not is left alone');
});

test('a checkpoint write failure never reaches the caller', async (t) => {
  const { store, sessionId } = await fixture(t);
  seed(store, sessionId);
  store.close();
  // A closed store cannot write; saving must report nothing rather than throw, because this is derived data
  // and the alternative is a host that cannot shut down.
  assert.equal(store.saveProjectionCheckpoints(sessionId), 0);
});
