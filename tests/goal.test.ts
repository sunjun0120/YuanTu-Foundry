/**
 * The session goal.
 *
 * A goal is the one thing in a session that outlives the run that declared it, so what these tests pin is what
 * makes it survive honestly: that creating it is recorded before the run ends and read by the next one, that a
 * run admitted to an existing goal costs it one round and says so in the log, that the status rules live in one
 * place and refuse rather than repair, and that a run which does not own the session's work — a planning run, a
 * read-only run, a delegated child — cannot see the tools at all.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Agent } from '../packages/core/agent.ts';
import { SessionStore } from '../packages/storage/sqlite.ts';
import { createTools } from '../packages/tools/index.ts';
import { goalTools } from '../packages/tools/goal.ts';
import { goalProjection } from '../packages/storage/projections.ts';
import {
  admitGoalRound,
  changeGoal,
  exhaustedGoalVerdict,
  goalExhausted,
  GOAL_CEILINGS,
  newGoal,
} from '../packages/protocol/goals.ts';
import type { Goal } from '../packages/protocol/goals.ts';
import { RUN_SCOPED_TOOLS } from '../packages/tools/registry.ts';
import type {
  AgentEvent,
  ModelResponse,
  Provider,
  Tool,
  ToolContext,
} from '../packages/protocol/index.ts';

const AT = '2026-01-01T00:00:00.000Z';
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
const goal = (over: Partial<Goal> = {}): Goal => ({
  ...newGoal({ objective: 'Ship the loader' }, AT),
  ...over,
});

test('goal notices follow every result in the assistant tool batch', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-goal-batch-'));
  const store = new SessionStore(path.join(root, 'sessions.db'));
  const tools = createTools(root);
  t.after(async () => {
    await tools.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const session = store.create(root);
  let rounds = 0;
  const agent = new Agent({
    store,
    tools,
    approve: async () => true,
    provider: {
      async complete(request) {
        if (++rounds === 1)
          return {
            ...reply(),
            finishReason: 'tool_calls',
            toolCalls: [
              { id: 'create', name: 'create_goal', arguments: { objective: 'Verify the batch' } },
              { id: 'read', name: 'get_goal', arguments: {} },
            ],
          };
        const index = request.messages.findIndex(
          (message) => message.role === 'assistant' && message.toolCalls.length === 2,
        );
        const tail = request.messages.slice(index + 1);
        assert.deepEqual(
          tail.slice(0, 2).map((message) => message.role),
          ['tool', 'tool'],
        );
        assert.deepEqual(
          tail.slice(0, 2).map((message) => message.role === 'tool' && message.toolCallId),
          ['create', 'read'],
        );
        assert.equal(tail[2]?.role, 'user');
        assert.match(tail[2]?.content ?? '', /Verify the batch/);
        return reply();
      },
    },
  });
  const result = await agent.run({ sessionId: session.id, prompt: 'Verify the tool batch' });
  assert.equal(result.status, 'completed', result.error);
  assert.equal(rounds, 2);
});

test('the goal transitions keep their rules in one place', () => {
  const start = goal();
  assert.equal(start.roundsStarted, 1, 'the run that declares a goal is its first round');
  assert.equal(start.status, 'active');
  assert.equal(admitGoalRound(start, AT).roundsStarted, 2);
  // Clamped, not thrown: spending the budget changes what the model is told, not what it may do.
  const spent = goal({ roundsStarted: 12, maxGoalRounds: 12 });
  assert.equal(admitGoalRound(spent, AT), spent);
  assert.equal(goalExhausted(spent), true);
  // A paused or completed goal does not spend rounds.
  assert.equal(admitGoalRound(goal({ status: 'paused' }), AT).roundsStarted, 1);
  assert.equal(admitGoalRound(goal({ status: 'completed' }), AT).roundsStarted, 1);
  // The blocked floor: a verdict that costs something has to have been worked for.
  assert.throws(
    () => changeGoal(goal({ roundsStarted: 2 }), 'blocked', { blockedReason: 'no access' }, AT),
    /after 3 rounds of work/,
  );
  // The floor is on the *verdict*, not on the goal: a goal that has been worked for three rounds may be
  // recorded as blocked.
  const worked = goal({ roundsStarted: 3 });
  const blocked = changeGoal(worked, 'blocked', { blockedReason: 'the API key is missing' }, AT);
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.blockedReason, 'the API key is missing');
  // Blocked needs a reason at all, and only an active goal can be paused.
  assert.throws(() => changeGoal(worked, 'blocked', {}, AT), /needs a blocked_reason/);
  assert.throws(() => changeGoal(blocked, 'pause', {}, AT), /Only an active goal can be paused/);
  assert.throws(() => changeGoal(start, 'resume', {}, AT), /Only a paused goal can be resumed/);
  assert.throws(() => changeGoal(start, 'edit', {}, AT), /needs an objective or a max_goal_rounds/);
  // A goal that can never be achieved has a ceiling, not an unbounded budget.
  assert.throws(
    () => changeGoal(start, 'edit', { maxGoalRounds: 4_097 }, AT),
    /must be an integer from 1 to 4096/,
  );
  // Changing the objective reopens a verdict that was reached against the old one.
  const reopened = changeGoal(blocked, 'edit', { objective: 'Ship the scheduler' }, AT);
  assert.equal(reopened.status, 'active');
  assert.equal(reopened.blockedReason, undefined);
  assert.equal(reopened.objective, 'Ship the scheduler');
  // But a completed goal is only reopened by an edit; complete is idempotent-refusing, not silent.
  assert.throws(
    () => changeGoal(goal({ status: 'completed' }), 'complete', {}, AT),
    /already completed/,
  );
  assert.throws(
    () => changeGoal(goal({ status: 'completed' }), 'blocked', { blockedReason: 'x' }, AT),
    /completed goal cannot become blocked/,
  );
});
test('the runtime records the verdict a spent budget implies, even before the blocked floor', () => {
  const spent = exhaustedGoalVerdict(goal({ roundsStarted: 3, maxGoalRounds: 3 }), AT)!;
  assert.equal(spent.status, 'blocked');
  assert.match(spent.blockedReason!, /3\/3/);
  assert.match(spent.blockedReason!, /will not start another one on its own/);
  // Nothing to say about a goal that is still running, or one that already ended.
  assert.equal(exhaustedGoalVerdict(goal({ roundsStarted: 1, maxGoalRounds: 3 }), AT), undefined);
  assert.equal(
    exhaustedGoalVerdict(goal({ status: 'completed', roundsStarted: 3, maxGoalRounds: 3 }), AT),
    undefined,
  );
  /**
   * The floor is deliberately not applied to this verdict, and the difference is asserted here rather than
   * described: the same goal cannot be recorded blocked by the model (`changeGoal` throws) and is recorded
   * blocked by the runtime. The floor exists so a *model* cannot take the early exit on its first round; the
   * runtime is not making a claim about effort, it is stating that its loop has stopped.
   */
  const tiny = goal({ roundsStarted: 1, maxGoalRounds: 1 });
  assert.throws(
    () => changeGoal(tiny, 'blocked', { blockedReason: 'x' }, AT),
    /after 3 rounds of work/,
  );
  assert.equal(exhaustedGoalVerdict(tiny, AT)!.status, 'blocked');
});

test('a turn the runtime started may report on the goal but not re-aim it', async () => {
  /**
   * The abuse this closes: a continuation round is an ordinary run, so the goal tools are in it — and with no
   * check on who was asking, the model could `edit max_goal_rounds` up to the ceiling from inside a round the
   * runtime had started for it, or `resume` a goal a person had just paused. Reporting is still the model's
   * job: `complete` and `blocked` are how a goal ends, and gating those would leave every goal active forever.
   */
  let state: Goal | null = goal();
  const written: string[] = [];
  const context: ToolContext = {
    signal: new AbortController().signal,
    approve: async () => true,
    goals: {
      read: () => state,
      human: false,
      write: (action, next) => {
        written.push(action);
        state = next;
      },
    },
  };
  const [, , update] = goalTools(() => AT) as [Tool, Tool, Tool];
  const first = goal({ roundsStarted: 2 });
  state = first;
  const edited = await update.execute!(
    { action: 'edit', max_goal_rounds: GOAL_CEILINGS.maxGoalRounds },
    context,
  );
  assert.equal(edited.isError, true);
  assert.match(edited.content, /who is in charge of this goal/);
  assert.equal(state!.maxGoalRounds, first.maxGoalRounds, 'the budget is exactly where it was');
  assert.equal(
    (await update.execute!({ action: 'pause' }, context)).isError,
    true,
    'a round started by the runtime may not stop work the user is waiting for',
  );
  // The one that matters most: a pause a person set stands.
  state = { ...first, status: 'paused' };
  const resumed = await update.execute!({ action: 'resume' }, context);
  assert.equal(resumed.isError, true);
  assert.match(resumed.content, /who is in charge of this goal/);
  assert.equal(state!.status, 'paused');
  assert.deepEqual(written, [], 'a refused action writes nothing at all');
  // And the two the model needs are still its to take.
  assert.equal((await update.execute!({ action: 'complete' }, context)).isError, false);
  assert.equal(state!.status, 'completed');
});

test('the tools write through the seam, and the fold reads back what they wrote', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-goal-tools-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let state: Goal | null = null;
  const written: string[] = [];
  const context: ToolContext = {
    signal: new AbortController().signal,
    approve: async () => true,
    goals: {
      read: () => state,
      // The user's own turn: the tests below that need the other answer build their own seam.
      human: true,
      write: (action, next) => {
        written.push(`${action}:${next.status}`);
        state = next;
      },
    },
  };
  // The three tools in the order `goalTools` documents them; destructured as a tuple so each one is a `Tool`
  // rather than `Tool | undefined`.
  const [create, get, update] = goalTools(() => AT) as [Tool, Tool, Tool];
  const call = (tool: Tool, args: Record<string, unknown>) => tool.execute!(args, context);
  assert.equal((await call(get!, {})).content.includes('no goal'), true);
  const created = await call(create, { objective: 'Ship the loader', max_goal_rounds: 3 });
  assert.equal(created.isError, false, created.content);
  assert.equal(state!.objective, 'Ship the loader');
  assert.equal(state!.maxGoalRounds, 3);
  assert.match(created.content, /\[active\] Ship the loader \(1\/3 round\(s\)\)/);
  // A second active goal is refused rather than silently replacing the first.
  const second = await call(create, { objective: 'Something else' });
  assert.equal(second.isError, true);
  assert.match(second.content, /already has an active goal/);
  const paused = await call(update, { action: 'pause' });
  assert.match(paused.content, /Goal pause/);
  assert.equal(state!.status, 'paused');
  assert.equal((await call(update, { action: 'pause' })).isError, true, 'pausing twice is refused');
  assert.equal((await call(update, { action: 'resume' })).isError, false);
  assert.equal((await call(update, { action: 'nonsense' })).isError, true);
  // The budget is stated, and a goal that has spent it says so where the model will read it.
  state = { ...state!, roundsStarted: 3 };
  const spent = await call(get, {});
  assert.match(spent.content, /spent its 3 rounds/);
  const completed = await call(update, { action: 'complete' });
  assert.match(completed.content, /Goal complete/);
  assert.equal(state!.status, 'completed');
  // A completed goal can be replaced — the user moved on — and the replacement says what it replaced.
  const replaced = await call(create, { objective: 'Ship the scheduler' });
  assert.equal(replaced.isError, false, replaced.content);
  assert.match(replaced.content, /replacing the previous one \(completed\)/);
  assert.deepEqual(written, [
    'create:active',
    'pause:paused',
    'resume:active',
    'complete:completed',
    'create:active',
  ]);
  // Every tool answers with the state it recorded, and no tool is a no-op when the seam is missing.
  const bare: ToolContext = { signal: new AbortController().signal, approve: async () => true };
  for (const tool of goalTools()) {
    const result = await tool.execute!({ objective: 'x', action: 'complete' }, bare);
    assert.equal(result.isError, true, tool.name);
    assert.match(result.content, /no goal store/);
  }
});
test('a run declares a goal, the next run is told about it and costs it one round', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-goal-run-'));
  const store = new SessionStore(path.join(root, 'sessions.db'));
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const session = store.create(root);
  const events: AgentEvent[] = [];
  /**
   * What each round was *told*, as the model received it.
   *
   * The goal is a conversation message rather than a system section now (§3-4: the section made the cacheable
   * prefix differ on every round of a goal), so what is asserted is the request the model was sent — messages
   * included — and not one field of it.
   */
  const told: string[] = [];
  let round = 0;
  const provider: Provider = {
    async complete(request) {
      told.push(JSON.stringify({ system: request.system, messages: request.messages }));
      round++;
      if (round === 1)
        return toolCall('c1', 'create_goal', { objective: 'Ship the loader', max_goal_rounds: 5 });
      return reply();
    },
  };
  const agent = new Agent({
    store,
    provider,
    tools: createTools(root),
    approve: async () => true,
    onEvent: (event) => events.push(event),
  });
  await agent.run({ sessionId: session.id, prompt: 'Start the loader work' });
  assert.equal(store.goal(session.id)?.objective, 'Ship the loader');
  assert.equal(events.filter((event) => event.type === 'goal.changed').length, 1);
  // The round after the write is told the goal, because the write appends the notice to the conversation.
  assert.match(told.at(-1)!, /Session goal .*\\n\[active\] Ship the loader \(1\/5 round/);

  // A second run in the same session: admitted to the goal, which is what the budget counts.
  const second = new Agent({
    store,
    provider: {
      async complete(request) {
        told.push(JSON.stringify({ system: request.system, messages: request.messages }));
        return reply('Continuing');
      },
    },
    tools: createTools(root),
    approve: async () => true,
    onEvent: (event) => events.push(event),
  });
  await second.run({ sessionId: session.id, prompt: 'Keep going' });
  assert.equal(store.goal(session.id)?.roundsStarted, 2);
  assert.match(told.at(-1)!, /\[active\] Ship the loader \(2\/5 round/);
  const admitted = events.filter((event) => event.type === 'goal.changed');
  assert.equal(admitted.length, 2, 'the creation and the admission are both recorded');
  assert.deepEqual(
    store
      .events(session.id, 0, 500)
      .filter((event) => event.type === 'goal.changed')
      .map((event) => event.data.action),
    ['create', 'round'],
  );
  // The fold and the store's reader are the same fact.
  assert.deepEqual(
    store.stateOf<Goal | null>('goal', session.id),
    store.events(session.id, 0, 500).reduce<Goal | null>(
      (state, event) =>
        goalProjection.apply(state, {
          seq: event.seq,
          sessionId: session.id,
          type: event.type,
          at: '',
          data: event.data,
        }),
      null,
    ),
  );
  // A completed goal is not work: the next run is told, and does not spend a round on it.
  store.recordEvent(session.id, 'goal.changed', {
    action: 'complete',
    goal: { ...store.goal(session.id)!, status: 'completed' },
  });
  const third = new Agent({
    store,
    provider: {
      async complete(request) {
        told.push(JSON.stringify({ system: request.system, messages: request.messages }));
        return reply('Noted');
      },
    },
    tools: createTools(root),
    approve: async () => true,
    onEvent: (event) => events.push(event),
  });
  await third.run({ sessionId: session.id, prompt: 'What now?' });
  assert.match(told.at(-1)!, /\[completed\] Ship the loader/);
  assert.equal(store.goal(session.id)?.roundsStarted, 2, 'a closed goal is not admitted to again');
});
test('the goal tools are run-scoped, and only a run that owns the session gets them', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-goal-scope-'));
  const store = new SessionStore(path.join(root, 'sessions.db'));
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const session = store.create(root);
  const names = new Set<string>();
  const offered: string[][] = [];
  let round = 0;
  const provider: Provider = {
    async complete(request) {
      offered.push(request.tools.map((spec) => spec.name));
      round++;
      // The model tries the goal tool in every run; whether it exists is the thing under test.
      if (round % 2 === 1) return toolCall(`c${round}`, 'create_goal', { objective: 'X' });
      return reply();
    },
  };
  for (const input of [
    { name: 'root', run: { sessionId: session.id, prompt: 'go' } },
    { name: 'read-only', run: { sessionId: session.id, prompt: 'go', readOnly: true } },
    {
      name: 'planning',
      run: {
        sessionId: session.id,
        prompt: 'go',
        planPhase: true,
        planId: store.createPlan(session.id).id,
      },
    },
  ]) {
    const events: AgentEvent[] = [];
    const agent = new Agent({
      store,
      provider,
      tools: createTools(root),
      approve: async () => true,
      onEvent: (event) => events.push(event),
    });
    await agent.run(input.run as Parameters<typeof agent.run>[0]);
    const seen = offered.at(-1)!;
    for (const tool of ['create_goal', 'get_goal', 'update_goal'])
      if (seen.includes(tool)) names.add(`${input.name}:${tool}`);
  }
  assert.deepEqual(
    [...names].sort(),
    ['root:create_goal', 'root:get_goal', 'root:update_goal'],
    'only the root writable run is offered the goal tools',
  );
  for (const tool of ['create_goal', 'get_goal', 'update_goal'])
    assert.ok(RUN_SCOPED_TOOLS.includes(tool as (typeof RUN_SCOPED_TOOLS)[number]));
  // And the run-scoped list is what a delegated child's registry copy is filtered by, so the tools are gone
  // there even before the child's own run decides what to offer.
  const parent = createTools(root);
  t.after(() => parent.close());
  for (const tool of goalTools()) parent.register(tool);
  const inherited = parent.forRun();
  assert.equal(
    inherited.specs().some((spec) => spec.name === 'create_goal'),
    false,
  );
});
