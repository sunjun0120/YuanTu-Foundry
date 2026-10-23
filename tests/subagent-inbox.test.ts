import test from 'node:test';
import assert from 'node:assert/strict';
import { Agent } from '../packages/core/agent.ts';
import { SubAgentResidency } from '../packages/core/residency.ts';
import type { ResidentTurnResult } from '../packages/core/residency.ts';
import { createResidentMessageTool } from '../packages/core/run-residency.ts';
import type { ChildTurns } from '../packages/core/run-subagents.ts';
import { SessionStore } from '../packages/storage/sqlite.ts';
import { subagentInboxProjection } from '../packages/storage/projections.ts';
import type { PendingSubagentMessage } from '../packages/storage/projections.ts';
import type { SessionEvent } from '../packages/storage/events.ts';
import { ToolRegistry } from '../packages/tools/registry.ts';
import type { ModelRequest, ModelResponse, Provider } from '../packages/protocol/index.ts';
import { isRuntimeContext } from '../packages/protocol/context.ts';
import { storeFixture } from './temp-fixture.ts';

/**
 * *入队即回执* and the durable inbox.
 *
 * Sending a message to a sub-agent used to be one synchronous round trip: the parent waited for the child's
 * answer, and if the process died in between there was no record that anything had been asked. Two things
 * had to change, and both are behaviours rather than mechanisms:
 *
 * 1. **A hand-off is not a round trip.** `wait: false` returns a receipt as soon as the message has been given
 *    to the child, so a parent can correct a child and keep working. The answer is then read where every other
 *    background result is read (`collect_subagents`, `job_output`).
 * 2. **The acceptance is written down first.** The message is recorded in the parent's log *before* the
 *    hand-off is attempted, and the hand-off is recorded when it happens. The difference between the two
 *    records is the one failure a parent would otherwise never see: a message it believes it sent, that the
 *    child never received.
 *
 * The tests below pin the fold itself, the receipt, the durable records in order, the background turn's
 * outcome, and the reader that reports an undelivered message back to the parent.
 */

// ---- the fold ----
import { reply, toolCall } from './provider-fixture.ts';
import { until } from './wait-fixture.ts';

const event = (type: string, data: Record<string, unknown>, seq: number): SessionEvent => ({
  seq,
  sessionId: 's',
  type,
  data,
  at: new Date(0).toISOString(),
});

test('the inbox fold is queued until the child’s receipt, and a turn hand-off ends it', () => {
  let state = subagentInboxProjection.initial();
  assert.deepEqual(state, []);
  state = subagentInboxProjection.apply(
    state,
    event('subagent.message.queued', { id: 'm1', childSessionId: 'child', message: 'one' }, 1),
  );
  state = subagentInboxProjection.apply(
    state,
    event('subagent.message.queued', { id: 'm2', childSessionId: 'child', message: 'two' }, 2),
  );
  assert.deepEqual(
    state.map((entry) => entry.id),
    ['m1', 'm2'],
  );
  // A *correction*'s hand-off does not end it: the queue that accepted it is in memory, so the message stays
  // pending and only changes state — "the child may have it, look before resending" rather than "send it again".
  state = subagentInboxProjection.apply(
    state,
    event('subagent.message.handed', { id: 'm1', how: 'correction' }, 3),
  );
  assert.deepEqual(
    state.map((entry) => [entry.id, entry.handed]),
    [
      ['m1', true],
      ['m2', false],
    ],
  );
  // The child's own receipt is what ends it, and it leaves the other message alone.
  state = subagentInboxProjection.apply(
    state,
    event('subagent.message.consumed', { id: 'm1', childSessionId: 'child' }, 4),
  );
  assert.deepEqual(
    state.map((entry) => entry.id),
    ['m2'],
  );
  // A hand-off for something never queued is not an entry: the fold answers "what has not reached the child's
  // transcript", and a message that was never accepted is not one of those.
  state = subagentInboxProjection.apply(
    state,
    event('subagent.message.handed', { id: 'm9', how: 'correction' }, 5),
  );
  // A hand-off as its own turn has already reached the child (the turn *is* the transcript write), so it is not
  // pending either — and neither is a receipt for a message this log never queued.
  state = subagentInboxProjection.apply(
    state,
    event('subagent.message.handed', { id: 'm8', how: 'turn' }, 6),
  );
  state = subagentInboxProjection.apply(state, event('subagent.message.consumed', { id: 'm9' }, 7));
  assert.deepEqual(
    state.map((entry) => entry.id),
    ['m2'],
  );
  // Other events are passed over.
  state = subagentInboxProjection.apply(state, event('subagent.finished', { id: 'x' }, 8));
  assert.deepEqual(
    state.map((entry) => entry.id),
    ['m2'],
  );
});

test('a record that names no message or no child contributes nothing', () => {
  let state = subagentInboxProjection.initial();
  state = subagentInboxProjection.apply(
    state,
    event('subagent.message.queued', { message: 'no id' }, 1),
  );
  state = subagentInboxProjection.apply(
    state,
    event('subagent.message.queued', { id: 'm1', message: 'no child' }, 2),
  );
  assert.deepEqual(state, []);
});

test('the inbox is a store projection, so it survives the process that wrote it', async (t) => {
  const { root, store } = await fixture(t);
  const session = store.create(root);
  store.recordEvent(session.id, 'subagent.message.queued', {
    id: 'm1',
    childId: 'task-0',
    childSessionId: 'child-1',
    message: 'check the config',
  });
  const read = () => store.stateOf<readonly PendingSubagentMessage[]>('subagentInbox', session.id);
  assert.deepEqual(read(), [
    {
      id: 'm1',
      childId: 'task-0',
      childSessionId: 'child-1',
      message: 'check the config',
      handed: false,
    },
  ]);
  store.recordEvent(session.id, 'subagent.message.handed', { id: 'm1', how: 'turn' });
  assert.deepEqual(
    read(),
    [],
    'a message handed over as its own turn is the child’s run, not a pending queue item',
  );
  // The transcript is untouched by any of these records: this is the parent's bookkeeping, not its conversation.
  assert.deepEqual(store.messages(session.id), []);
});

// ---- the hand-off ----

test('deliver(wait: false) returns as soon as the message is in the running turn’s queue', async () => {
  const residency = new SubAgentResidency();
  let release: (() => void) | null = null;
  let steered: string[] = [];
  const activation = residency.open({
    id: 'child',
    childSessionId: 'child-session',
    parentSessionId: 'parent',
    objective: 'work',
    depth: 1,
    turn: async (_prompt, _signal, _reportRequired, hooks) => {
      assert.ok(hooks, 'a turn runner is handed the way to receive a correction');
      hooks.attach((message) => {
        steered.push(message);
        return true;
      });
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return turnResult('the answer after the correction');
    },
  });
  const running = activation.run('start', false);
  await until(() => steered.length === 0 && release !== null);

  const delivery = await activation.deliver('a correction', { wait: false });
  assert.equal(delivery.delivered, true);
  assert.deepEqual(steered, ['a correction']);
  assert.equal(delivery.result, undefined, 'not waiting means not having the answer yet');
  assert.ok(
    delivery.done,
    'the running turn’s promise is handed back so its outcome can be recorded',
  );

  let settled = false;
  void delivery.done!.then(() => {
    settled = true;
  });
  assert.equal(settled, false, 'the turn is still running, and the caller was not held by it');
  release!();
  assert.equal((await running).text, 'the answer after the correction');
  assert.equal(settled, true);
  await residency.disposeAll();
});

test('send_message(wait: false) hands the message over, records it, and returns a receipt', async (t) => {
  const { root, store } = await fixture(t);
  const residency = new SubAgentResidency();
  t.after(() => residency.disposeAll());
  const session = store.create(root);
  let childSessionId = '';
  let parentRound = 0;
  const provider: Provider = {
    async complete(request) {
      /**
       * A child answers in prose for a turn it was not offered the report tool in.
       *
       * A resident child's *follow-up* turn has no `submit_report` on purpose (that is what makes a follow-up a
       * message rather than a task). A fixture that keeps asking for it anyway gets `Unknown tool` back, asks
       * again, and — now that a run has no round cap — never reaches the step boundary this test waits for.
       * The same guard is used by the inline-answer test below; a real model does not call a tool it was not
       * given.
       */
      if (isChild(request))
        return request.tools.some((tool) => tool.name === 'submit_report')
          ? report(`sweep ${childSessionId || 'first'}`)
          : reply('the follow-up answer');
      parentRound++;
      if (parentRound === 1)
        return toolCall('delegate-1', 'delegate_task', { tasks: [{ objective: 'Sweep it' }] });
      if (parentRound === 2) return reply('Done');
      if (parentRound === 3)
        return toolCall('send-1', 'send_message', {
          childSessionId,
          message: 'also check the config',
          wait: false,
        });
      return reply('Done');
    },
  };
  const run = () =>
    new Agent({
      store,
      provider,
      tools: new ToolRegistry(),
      approve: async () => true,
      subagents: { enabled: true },
      subagentResidency: residency,
      childTools: () => new ToolRegistry(),
    }).run({ sessionId: session.id, prompt: 'Delegate a sweep' });

  assert.equal((await run()).status, 'completed');
  childSessionId = residency.list()[0]!.childSessionId;
  assert.equal(residency.list()[0]!.status, 'idle', 'the delegation turn finished');

  assert.equal((await run()).status, 'completed');
  const receipt = toolResults(store, session.id).find((content) => content.includes('handed to'));
  assert.ok(receipt, 'the parent got a receipt for the hand-off');
  assert.match(receipt!, /as a new turn/);
  assert.match(receipt!, /read it with collect_subagents \(or job_output on the child session\)/);
  assert.ok(
    !receipt!.includes('Done'),
    `the receipt is not the answer and does not pretend to be one: ${receipt}`,
  );

  /**
   * The two records, in order, with the acceptance first.
   *
   * The order is the assertion: `queued` before any hand-off attempt is what makes the inbox fold mean "the
   * process died in between" rather than "the message was never asked for".
   */
  const records = store
    .events(session.id)
    .filter(
      (entry) =>
        entry.type === 'subagent.message.queued' || entry.type === 'subagent.message.handed',
    );
  assert.deepEqual(
    records.map((entry) => entry.type),
    ['subagent.message.queued', 'subagent.message.handed'],
  );
  assert.equal(records[0]!.data.id, records[1]!.data.id, 'the hand-off names the accepted message');
  assert.equal(records[0]!.data.childSessionId, childSessionId);
  assert.equal(records[1]!.data.how, 'turn');
  assert.equal(
    store.stateOf<readonly PendingSubagentMessage[]>('subagentInbox', session.id).length,
    0,
    'a handed-over message is not pending',
  );

  // The turn really ran, without the parent waiting for it, and its outcome was recorded when it landed.
  await until(() => residency.list()[0]!.status === 'idle');
  assert.ok(
    store
      .messages(childSessionId)
      .some((message) => message.content.includes('also check the config')),
    'the message became a turn on the child',
  );
  assert.equal(
    store.events(session.id).filter((entry) => entry.type === 'subagent.finished').length,
    2,
    'the background turn is recorded as its own outcome, like any other child turn',
  );
});

test('send_message(wait: true) still answers inline, and is not left pending', async (t) => {
  const { root, store } = await fixture(t);
  const residency = new SubAgentResidency();
  t.after(() => residency.disposeAll());
  const session = store.create(root);
  let childSessionId = '';
  let parentRound = 0;
  /** What each child turn was offered, so "a follow-up is not a report turn" is checked, not assumed. */
  const childOffers: string[][] = [];
  const provider: Provider = {
    async complete(request) {
      if (isChild(request)) {
        childOffers.push(request.tools.map((tool) => tool.name));
        return request.tools.some((tool) => tool.name === 'submit_report')
          ? report('first sweep done')
          : reply('the follow-up answer');
      }
      parentRound++;
      if (parentRound === 1)
        return toolCall('delegate-1', 'delegate_task', { tasks: [{ objective: 'Sweep it' }] });
      if (parentRound === 2) return reply('Done');
      if (parentRound === 3)
        return toolCall('send-1', 'send_message', {
          childSessionId,
          message: 'what did you find?',
        });
      return reply('Done');
    },
  };
  const run = () =>
    new Agent({
      store,
      provider,
      tools: new ToolRegistry(),
      approve: async () => true,
      subagents: { enabled: true },
      subagentResidency: residency,
      childTools: () => new ToolRegistry(),
    }).run({ sessionId: session.id, prompt: 'Delegate a sweep' });
  assert.equal((await run()).status, 'completed');
  childSessionId = residency.list()[0]!.childSessionId;
  assert.equal((await run()).status, 'completed');

  const answer = toolResults(store, session.id).find((content) =>
    content.includes('the follow-up answer'),
  );
  assert.ok(
    answer,
    `waiting still returns the answer in the tool result: ${JSON.stringify(toolResults(store, session.id))}`,
  );
  /**
   * The follow-up is an ordinary turn, and the tool set has to say so.
   *
   * The delegation turn installs `submit_report` on the registry the resident child keeps, so before this was
   * pinned the follow-up turn still offered it — and the child, obeying "calling this completes the run",
   * answered the question with a report form until it hit its round limit. This assertion is what would have
   * caught that.
   */
  assert.equal(
    childOffers.length,
    2,
    'one child turn for the delegation and one for the follow-up',
  );
  assert.ok(childOffers[0]!.includes('submit_report'), 'a delegation turn ends with a report');
  assert.ok(
    !childOffers[1]!.includes('submit_report'),
    `a follow-up turn is asked a question, so it is not offered the report tool: ${childOffers[1]!.join(', ')}`,
  );
  const handed = store
    .events(session.id)
    .filter((entry) => entry.type === 'subagent.message.handed');
  assert.equal(handed.length, 1);
  assert.equal(handed[0]!.data.how, 'turn', 'the child was idle, so the message became a turn');
  assert.equal(
    store.stateOf<readonly PendingSubagentMessage[]>('subagentInbox', session.id).length,
    0,
  );
  assert.ok(
    store.events(session.id).some((entry) => entry.type === 'subagent.collected'),
    'an answer read from the tool result is recorded as delivered, so it is not announced twice',
  );
});

test('a message for a child this session never delegated to is refused before anything is written', async (t) => {
  const { root, store } = await fixture(t);
  const session = store.create(root);
  let asked = false;
  const agent = new Agent({
    store,
    provider: {
      async complete() {
        if (asked) return reply('Done');
        asked = true;
        return toolCall('send-1', 'send_message', {
          childSessionId: 'not-mine',
          message: 'do something',
        });
      },
    },
    tools: new ToolRegistry(),
    approve: async () => true,
    subagents: { enabled: true },
    subagentResidency: new SubAgentResidency(),
    childTools: () => new ToolRegistry(),
  });
  assert.equal((await agent.run({ sessionId: session.id, prompt: 'Send' })).status, 'completed');
  assert.match(toolResults(store, session.id).join('\n'), /No sub-agent of this session/);
  assert.deepEqual(
    store.events(session.id).filter((entry) => entry.type.startsWith('subagent.message')),
    [],
    'a refused call leaves no inbox entry behind: nothing was accepted',
  );
});

// ---- the reader ----

test('collect_subagents reports a message that was accepted and never delivered', async (t) => {
  const { root, store } = await fixture(t);
  const session = store.create(root);
  /**
   * The crash, staged where it is observable.
   *
   * A real crash between the two records cannot be scheduled from a test — that is the point of the window
   * being small — so the state it leaves behind is written directly: an acceptance with no hand-off. The
   * reader is what has to be right about it.
   */
  store.recordEvent(session.id, 'subagent.message.queued', {
    id: 'msg-task-0-x-1',
    childId: 'task-0',
    childSessionId: 'child-lost',
    message: 'also check\nthe   config',
  });
  let round = 0;
  const agent = new Agent({
    store,
    provider: {
      async complete(request) {
        round++;
        if (round === 1) return toolCall('collect-1', 'collect_subagents', { waitMs: 0 });
        if (request.messages.some((message) => message.content.includes('never delivered')))
          return reply('I will send it again');
        return reply('Done');
      },
    },
    tools: new ToolRegistry(),
    approve: async () => true,
    subagents: { enabled: true },
    childTools: () => new ToolRegistry(),
  });
  assert.equal(
    (await agent.run({ sessionId: session.id, prompt: 'Anything?' })).status,
    'completed',
  );
  const notice = toolResults(store, session.id).find((content) =>
    content.includes('never delivered'),
  );
  assert.ok(notice, 'the parent is told, instead of the message disappearing');
  assert.match(notice!, /Accepted for a sub-agent and never delivered \(1\)/);
  assert.match(notice!, /msg-task-0-x-1 → child-lost: also check the config/, 'quoted, one line');
  assert.match(notice!, /Send it again with send_message/);
  /**
   * Reading it does not resolve it.
   *
   * Unlike a report, an undelivered message is not delivered by being looked at, and a notice that stopped
   * after one read would report the failure exactly once — to a parent that may not have been listening.
   */
  const second = await agent.run({ sessionId: session.id, prompt: 'Anything else?' });
  assert.equal(second.status, 'completed');
  assert.equal(
    toolResults(store, session.id).filter((content) => content.includes('never delivered')).length,
    1,
    'the second run does not call collect again, so this counted the one notice',
  );
  assert.equal(
    store.stateOf<readonly PendingSubagentMessage[]>('subagentInbox', session.id).length,
    1,
    'and the entry is still pending after being reported',
  );
});

test('an explicit ids list narrows the inbox to the children it names', async (t) => {
  const { root, store } = await fixture(t);
  const session = store.create(root);
  store.recordEvent(session.id, 'subagent.message.queued', {
    id: 'm-mine',
    childId: 'task-0',
    childSessionId: 'child-mine',
    message: 'mine',
  });
  store.recordEvent(session.id, 'subagent.message.queued', {
    id: 'm-other',
    childId: 'task-1',
    childSessionId: 'child-other',
    message: 'other',
  });
  let round = 0;
  const agent = new Agent({
    store,
    provider: {
      async complete() {
        round++;
        if (round === 1)
          return toolCall('collect-1', 'collect_subagents', {
            ids: ['child-mine'],
            waitMs: 0,
          });
        return reply('Done');
      },
    },
    tools: new ToolRegistry(),
    approve: async () => true,
    subagents: { enabled: true },
    childTools: () => new ToolRegistry(),
  });
  assert.equal(
    (await agent.run({ sessionId: session.id, prompt: 'Anything?' })).status,
    'completed',
  );
  const notice = toolResults(store, session.id).find((content) =>
    content.includes('never delivered'),
  );
  assert.ok(notice);
  assert.match(notice!, /m-mine/);
  assert.ok(!notice!.includes('m-other'), 'the message for the other child is not named');
});

// ---- helpers ----

const isChild = (request: ModelRequest) =>
  request.system.includes('You are a sub-agent delegated by a parent agent');
const report = (summary: string): ModelResponse => ({
  text: '',
  finishReason: 'tool_calls',
  toolCalls: [
    {
      id: `report-${summary}`,
      name: 'submit_report',
      arguments: { summary, findings: [{ statement: summary, evidence: 'seen' }] },
    },
  ],
  usage: { inputTokens: 10, outputTokens: 5 },
});
const turnResult = (text: string): ResidentTurnResult => ({
  usage: { inputTokens: 1, outputTokens: 1 },
  text,
  status: 'completed',
  rounds: 1,
  toolCalls: 0,
});
const toolResults = (store: SessionStore, sessionId: string): string[] =>
  store
    .messages(sessionId)
    .filter((message) => message.role === 'tool')
    .map((message) => String(message.content));
async function fixture(t: test.TestContext) {
  const { root, store } = await storeFixture(t, 'yuantu-inbox-');
  return { root, store };
}

// ---- the receipt that closes the window `handed` left open ----

/**
 * A correction handed to a *running* child is the window this receipt exists for.
 *
 * `handed` says a turn's queue took the message, and that queue lives in memory: a process that stops before the
 * child's next step boundary loses the correction while the parent's log says it was delivered, so the parent
 * believes a child was corrected that never heard it. The child now writes `subagent.message.consumed` at the
 * moment the correction becomes a user message in its own transcript, and the fold keeps the message pending —
 * with `handed: true`, which is a different prescription from "send it again" — until the receipt arrives.
 */
test('a correction stays pending until the child’s own turn records reading it', async (t) => {
  const { root, store } = await fixture(t);
  const residency = new SubAgentResidency();
  let childSessionId = '';
  let parentRound = 0;
  let gated = false;
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  /**
   * One cleanup, in one order: let the parked child go *before* disposing it.
   *
   * The child's first round is parked on `gate`, and `disposeAll` waits for the turn it aborts. Two separate
   * hooks would run dispose first and wait forever for a promise this test owns — so the release is not
   * optional cleanup, it is the first half of it.
   */
  t.after(async () => {
    release();
    await residency.disposeAll();
  });
  const session = store.create(root);
  const inbox = () => store.stateOf<readonly PendingSubagentMessage[]>('subagentInbox', session.id);
  const eventsOfType = (type: string) =>
    store.events(session.id).filter((entry) => entry.type === type);
  const provider: Provider = {
    async complete(request) {
      if (isChild(request)) {
        // The child's first round waits here, so the correction is handed over *while it works*; the failing
        // tool call is what then brings its loop to a step boundary, which is where a queued correction is taken.
        if (!gated) {
          gated = true;
          await gate;
          return toolCall('bad-1', 'no_such_tool', {});
        }
        return report('swept after the correction');
      }
      parentRound++;
      if (parentRound === 1)
        return toolCall('delegate-1', 'delegate_task', {
          tasks: [{ objective: 'Sweep it' }],
          wait: false,
        });
      if (parentRound === 2) {
        // The child session id arrives with the delegation's receipt, and the parent is the one reading it.
        await until(() => Boolean(childSessionId));
        return toolCall('send-1', 'send_message', {
          childSessionId,
          message: 'also check the config',
          wait: false,
        });
      }
      if (parentRound === 3) return toolCall('collect-1', 'collect_subagents', {});
      return reply('Done');
    },
  };
  const running = new Agent({
    store,
    provider,
    tools: new ToolRegistry(),
    approve: async () => true,
    subagents: { enabled: true, collectWaitMs: 5_000 },
    subagentResidency: residency,
    childTools: () => new ToolRegistry(),
  }).run({ sessionId: session.id, prompt: 'Delegate a sweep' });

  await until(() => residency.list().length === 1);
  childSessionId = residency.list()[0]!.childSessionId;
  // Handed over, not yet read — and the parent can see exactly that, before any step boundary has passed.
  await until(() => inbox().length === 1);
  assert.equal(
    inbox()[0]!.handed,
    true,
    'the queue took it, so the prescription is "look before resending"',
  );
  assert.equal(
    eventsOfType('subagent.message.consumed').length,
    0,
    'nothing has recorded the child reading it',
  );

  release();
  assert.equal((await running).status, 'completed');
  await until(() => inbox().length === 0);
  const receipts = eventsOfType('subagent.message.consumed');
  const handed = eventsOfType('subagent.message.handed');
  assert.equal(receipts.length, 1, 'the child wrote exactly one receipt');
  assert.equal(
    receipts[0]!.data.id,
    handed[0]!.data.id,
    'and it names the message the parent queued',
  );
  assert.equal(
    receipts[0]!.data.childSessionId,
    childSessionId,
    'for the child the parent sent it to',
  );
  assert.ok(
    store
      .messages(childSessionId)
      .some((message) => message.content.includes('also check the config')),
    'the correction really is in the child’s transcript, which is what the receipt claims',
  );
});

/**
 * A full queue is a refusal, not a hand-off.
 *
 * The queue holds sixteen inputs, and `add` threw a plain `Error` that the child's attach callback swallowed as
 * "there is no live turn to fold into". That answer made the caller start a *second* turn on a child that was
 * already running — which the store's run lock refuses — and then record the message as handed over, because
 * the synchronous test for that was "the child is running", which it was. The record then said a correction had
 * been delivered that had never entered the queue.
 */
test('a full child queue is refused loudly instead of being recorded as handed over', async (t) => {
  const { root, store } = await fixture(t);
  const residency = new SubAgentResidency();
  const session = store.create(root);
  const inbox = () => store.stateOf<readonly PendingSubagentMessage[]>('subagentInbox', session.id);
  const eventsOfType = (type: string) =>
    store.events(session.id).filter((entry) => entry.type === type);
  /** One more than the queue holds, so the last correction is the one that cannot be taken. */
  const SENT = 17;
  let childSessionId = '';
  let parentRound = 0;
  let gated = false;
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  // Same reason as above: let the parked child go *before* disposing it, or the disposal waits for a promise
  // this test owns.
  t.after(async () => {
    release();
    await residency.disposeAll();
  });
  const provider: Provider = {
    async complete(request) {
      if (isChild(request)) {
        // Gated for the whole test: a child that reached a step boundary would drain the queue and the
        // seventeenth message would fit.
        if (!gated) {
          gated = true;
          await gate;
          return toolCall('bad-1', 'no_such_tool', {});
        }
        return report('done');
      }
      parentRound++;
      if (parentRound === 1)
        return toolCall('delegate-1', 'delegate_task', {
          tasks: [{ objective: 'Sweep it' }],
          wait: false,
        });
      if (parentRound === 2) await until(() => Boolean(childSessionId));
      if (parentRound >= 2 && parentRound <= SENT + 1)
        return toolCall(`send-${parentRound}`, 'send_message', {
          childSessionId,
          message: `correction ${parentRound - 1}`,
          wait: false,
        });
      return reply('Done');
    },
  };
  const running = new Agent({
    store,
    provider,
    tools: new ToolRegistry(),
    approve: async () => true,
    subagents: { enabled: true },
    subagentResidency: residency,
    childTools: () => new ToolRegistry(),
  }).run({ sessionId: session.id, prompt: 'Delegate a sweep' });
  await until(() => residency.list().length === 1);
  childSessionId = residency.list()[0]!.childSessionId;
  /**
   * The parent's run is *not* awaited yet, and that ordering is the test.
   *
   * A run that ends while a child is still working stops it, which means the run's own promise does not settle
   * until the child does — and this child is parked behind the gate until the assertions below have been made.
   * Waiting for the run here would be waiting for the release that comes after it.
   */
  await until(
    () => toolResults(store, session.id).some((content) => content.includes('Run queue is full')),
    10_000,
  );

  const results = toolResults(store, session.id);
  assert.ok(
    results.some((content) => content.includes('Run queue is full')),
    `the correction that could not be queued is refused where the parent can see it: ${JSON.stringify(results.slice(-2))}`,
  );
  const queued = eventsOfType('subagent.message.queued');
  const handed = eventsOfType('subagent.message.handed');
  assert.equal(
    queued.length,
    SENT,
    'every message was written down before the hand-off was attempted',
  );
  assert.equal(
    handed.length,
    SENT - 1,
    'the one that never entered the queue has no hand-off record',
  );
  const refusedId = String(queued.at(-1)!.data.id);
  assert.ok(
    !handed.some((entry) => entry.data.id === refusedId),
    'and the missing record is exactly the refused message, not some other one',
  );
  assert.deepEqual(
    inbox().map((entry) => entry.handed),
    [...Array(SENT - 1).fill(true), false],
    'sixteen say "look before resending"; the refused one says "send it again"',
  );
  // Let the child go, then the run can finish stopping it. Whether it reaches its next step boundary first is a
  // race with the run's own end, so what is asserted is the part that cannot be raced: no receipt ever names the
  // refused message, and the record never claims more than the receipts do.
  release();
  assert.equal((await running).status, 'completed');
  const consumed = eventsOfType('subagent.message.consumed').map((entry) => String(entry.data.id));
  assert.ok(
    !consumed.includes(refusedId),
    'a message that was never queued is never consumed either',
  );
  assert.ok(
    inbox().some((entry) => entry.id === refusedId && !entry.handed),
    'the refused message is still pending as "send it again" — nothing upgraded its state behind the refusal',
  );
});

// ---- whose cancellation is whose ----

const idle = (text = 'done'): ResidentTurnResult => ({
  usage: { inputTokens: 1, outputTokens: 1 },
  text,
  status: 'completed',
  rounds: 1,
  toolCalls: 0,
});
/** A `send_message` tool over a residency the test drives directly, so the child is whatever it says it is. */
async function residentTool(t: test.TestContext) {
  const { root, store, session } = await storeFixture(t, 'yuantu-inbox-signal-');
  const residency = new SubAgentResidency();
  t.after(() => residency.disposeAll());
  const tool = createResidentMessageTool({
    store,
    parentSessionId: session.id,
    depth: 0,
    residency,
    // Every child in these tests is already loaded, so the cold-resume path is never reached; a thrower says so
    // rather than quietly building a child from a log that has none.
    childTurns: (() => {
      throw new Error('this fixture only drives already-loaded children');
    }) as unknown as ChildTurns,
    emit: () => {},
    statistics: store.statistics(session.id),
    usage: { inputTokens: 0, outputTokens: 0 },
    nextMessageId: () => 1,
  });
  return { root, store, session, residency, tool };
}
/** The result of a call, or a statement that it had not returned by the deadline. */
async function within<T>(
  value: Promise<T>,
  ms = 1_500,
): Promise<{ ok: true; value: T } | { ok: false }> {
  return Promise.race([
    value.then((settled) => ({ ok: true as const, value: settled })),
    new Promise<{ ok: false }>((resolve) => setTimeout(() => resolve({ ok: false }), ms)),
  ]);
}
const approve = async () => true;

test('a call that starts a resident turn cancels that turn when the call is cancelled', async (t) => {
  /**
   * A waiting call owns the turn it asked for. Without this the call is cut off (a budget, a cancelled request)
   * and the child keeps working on a question nobody is waiting for the answer to — the caller sees a failure
   * while the child keeps spending.
   */
  const { residency, session, tool } = await residentTool(t);
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let turns = 0;
  let turnAborted = false;
  const child = residency.open({
    id: 'watch',
    childSessionId: 'child-watch',
    parentSessionId: session.id,
    objective: 'Watch the tree',
    depth: 1,
    turn: async (_prompt, signal) => {
      turns++;
      await new Promise<void>((resolve) => {
        signal.addEventListener(
          'abort',
          () => {
            turnAborted = true;
            resolve();
          },
          { once: true },
        );
        void gate.then(resolve);
      });
      return { ...idle('stopped'), status: signal.aborted ? 'cancelled' : 'completed' };
    },
  });
  t.after(() => {
    release();
    return child.dispose();
  });
  const controller = new AbortController();
  const reason = new Error('the send_message call was cancelled');
  const pending = tool.execute(
    { childSessionId: 'child-watch', message: 'check the config' },
    { signal: controller.signal, approve },
  );
  await until(() => turns === 1);
  controller.abort(reason);
  const settled = await within(pending);
  assert.ok(settled.ok, 'the call never returned after it was cancelled');
  assert.equal(turnAborted, true, 'the turn this call started observed the call’s cancellation');
  assert.equal(settled.value.isError, true);
  assert.match(settled.value.content, /the send_message call was cancelled/);
  assert.equal(
    child.status,
    'idle',
    'and the activation is still usable afterwards: only that turn was cancelled',
  );
});

test('cancelling a wait does not stop the resident turn another caller started', async (t) => {
  /**
   * The other half of the same rule: a `send_message` folded into a turn that is already running did not start
   * that turn, so cancelling this call may end this call's patience and nothing else. The parent that started
   * the turn is still entitled to its answer, and a wait that killed it would be a correction turning into an
   * interruption — the exact confusion the residency's `deliver`/`interrupt` split exists to prevent.
   */
  const { residency, session, tool } = await residentTool(t);
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let turnSignal: AbortSignal | undefined;
  const child = residency.open({
    id: 'busy',
    childSessionId: 'child-busy',
    parentSessionId: session.id,
    objective: 'Sweep the tree',
    depth: 1,
    turn: async (_prompt, signal, _reportRequired, handle) => {
      turnSignal = signal;
      handle?.attach(() => true);
      await gate;
      return idle('swept');
    },
  });
  t.after(() => {
    release();
    return child.dispose();
  });
  const running = child.run('work', false);
  const controller = new AbortController();
  const pending = tool.execute(
    { childSessionId: 'child-busy', message: 'also check the config' },
    { signal: controller.signal, approve },
  );
  await until(() => Boolean(turnSignal));
  controller.abort(new Error('this waiting call was cancelled'));
  const settled = await within(pending);
  assert.ok(settled.ok, 'the cancelled wait did not end');
  assert.equal(settled.value.isError, true);
  assert.equal(
    turnSignal!.aborted,
    false,
    'the child’s turn belongs to the caller that started it, not to this wait',
  );
  release();
  assert.equal((await running).status, 'completed', 'and that caller still gets its answer');
});

// ---- the child this process never started ----

/**
 * A child resumed in another process comes back as *that* child.
 *
 * A residency lives in memory, so after a restart every child is "gone" — while its session, its transcript and
 * the delegation that named it are all on disk. `subagent.assigned` is that record, and it is the authority for
 * what the resumed turn is: the model the delegation chose and the role it was given. Nothing the *message*
 * says can change either, and that is the point of reading them from the log rather than from the call — a
 * follow-up is a question addressed to a child, not a new delegation of one.
 *
 * Two failures this pins, and they are separate: a child that lost its model answers on its parent's (the turn
 * still runs, the transcript still looks right, and only the bill says otherwise), and a child whose finished
 * event says `general` hands its parent a role it was never given.
 */
test('cold resident continuation keeps the model and role its delegation assigned', async (t) => {
  const { root, store } = await fixture(t);
  const session = store.create(root);
  let childSessionId = '';
  let phase: 'delegate' | 'continue' = 'delegate';
  let round = 0;
  /** What each child turn was offered, in order: the delegation's turn, then the resumed one's. */
  const childOffers: string[][] = [];
  /** A child turn that reached the *parent's* provider, which is what a lost model would send there. */
  const strayed: string[] = [];
  const childProvider: Provider = {
    async complete(request) {
      childOffers.push(request.tools.map((tool) => tool.name));
      return request.tools.some((tool) => tool.name === 'submit_report')
        ? report('swept the tree')
        : reply('the follow-up answer');
    },
  };
  const parentProvider: Provider = {
    async complete(request) {
      if (isChild(request)) {
        strayed.push(String(request.messages.at(-1)?.content ?? ''));
        return reply('answered by the wrong provider');
      }
      round++;
      if (phase === 'delegate')
        return round === 1
          ? toolCall('delegate-1', 'delegate_task', {
              tasks: [{ objective: 'Sweep the tree', role: 'explore', model: 'child-model' }],
            })
          : reply('Delegated');
      return round === 1
        ? toolCall('send-1', 'send_message', { childSessionId, message: 'what did you find?' })
        : reply('Done');
    },
  };
  /**
   * One tool the role keeps and one it does not, so "still read-only" is a claim with two outcomes rather than
   * an assertion that an empty registry is still empty. `readOnly` is what hides a tool that declares a
   * permission, and the role — read from the durable assignment — is what decides it.
   */
  const childTools = () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 'read_file',
      description: 'read fixture',
      inputSchema: { type: 'object' },
      execute: async () => ({ isError: false, content: 'read' }),
    });
    registry.register({
      name: 'write_file',
      description: 'write fixture',
      permission: 'write',
      inputSchema: { type: 'object' },
      execute: async () => ({ isError: false, content: 'written' }),
    });
    return registry;
  };
  const runParent = (residency: SubAgentResidency) =>
    new Agent({
      store,
      provider: parentProvider,
      tools: new ToolRegistry(),
      approve: async () => true,
      // The parent's own model, which is what a child that lost its assignment would answer on.
      modelInfo: { model: 'parent-model', protocol: 'openai' },
      subagents: { enabled: true },
      subagentResidency: residency,
      // This host can serve the child's model and says so, which is what makes "the request went to the
      // child's provider" an observation rather than an assumption.
      subagentProviderFor: (model) => (model === 'child-model' ? childProvider : undefined),
      childTools,
    }).run({ sessionId: session.id, prompt: 'Delegate a sweep' });

  // ---- the process that delegated ----
  const first = new SubAgentResidency();
  assert.equal((await runParent(first)).status, 'completed');
  childSessionId = first.list()[0]!.childSessionId;
  assert.equal(
    store.events(session.id).find((event) => event.type === 'subagent.assigned')!.data.model,
    'child-model',
    'the delegation is recorded with the model it named',
  );
  await first.disposeAll();

  // ---- the process that never saw it ----
  phase = 'continue';
  round = 0;
  const second = new SubAgentResidency();
  t.after(() => second.disposeAll());
  assert.deepEqual(second.list(), [], 'the continuation starts with no loaded children');
  assert.equal((await runParent(second)).status, 'completed');

  assert.equal(childOffers.length, 2, 'the delegation and the follow-up each ran one child turn');
  assert.deepEqual(
    strayed,
    [],
    'both turns ran on the provider the child’s model resolved to, not on the parent’s',
  );
  const followUp = childOffers[1]!;
  /**
   * What the kernel held as the turn's model, read where it is written down.
   *
   * Not the `llm.request` rows: those record a *transition*, so a child whose model never changed from the
   * configured one has none at all, and an empty list would have looked like agreement. Every user turn is
   * stamped with the identity it was run under in the child's own transcript, which is both the durable record
   * and the thing a reader of that session sees.
   *
   * *Both* turns, not only the resumed one: the delegation's own turn is the same child, and a child whose
   * identity changes part-way through its own transcript is harder to explain than one that never had it.
   */
  const models = store
    .messages(childSessionId)
    .filter((message) => message.role === 'user' && !isRuntimeContext(message.content))
    .map((message) => (message.role === 'user' ? message.modelInfo?.model : undefined));
  t.diagnostic(`models the child's turns ran under: ${JSON.stringify(models)}`);
  assert.deepEqual(
    models,
    ['child-model', 'child-model'],
    'the delegation’s own turn and the resumed one both ran under the model the delegation named',
  );
  const finished = store.events(session.id).filter((event) => event.type === 'subagent.finished');
  t.diagnostic(
    `roles the finished records carry: ${JSON.stringify(finished.map((event) => event.data.role))}`,
  );
  assert.equal(finished.length, 2, 'both turns are recorded as outcomes');
  assert.equal(
    finished.at(-1)!.data.role,
    'explore',
    'and the assignment’s role is what the resumed turn finishes as',
  );
  // The role is a *permission* as well as a name: an `explore` child that came back writable would be a
  // follow-up question turned into a grant.
  assert.ok(
    followUp.includes('read_file'),
    `the resumed turn keeps the tools its role allows: ${followUp.join(', ')}`,
  );
  assert.ok(
    !followUp.includes('write_file'),
    `and is not offered the ones it does not: ${followUp.join(', ')}`,
  );
});

/**
 * A delegation that named no model resumes on the host's own, rather than being refused for it.
 *
 * `model` is optional on a task and absent entirely from a `subagent.assigned` record written before the field
 * existed, so a resumed turn that *required* one would refuse children that were delegated perfectly legally —
 * the failure mode a fallback exists to prevent. The role is a separate statement and survives on its own:
 * nothing about a missing model makes an `explore` child a general one.
 */
test('a delegation that recorded no model resumes without one, and keeps its role', async (t) => {
  const { root, store } = await fixture(t);
  const session = store.create(root);
  let childSessionId = '';
  let phase: 'delegate' | 'continue' = 'delegate';
  let round = 0;
  /** A model resolution is what this path must *not* need: asking for one would fail the child. */
  const resolved: string[] = [];
  /** The child's answer, served by the parent's own provider because that is what it inherits. */
  const served = (request: ModelRequest): ModelResponse =>
    request.tools.some((tool) => tool.name === 'submit_report')
      ? report('swept the tree')
      : reply('the follow-up answer');
  const provider: Provider = {
    async complete(request) {
      if (isChild(request)) return served(request);
      round++;
      if (phase === 'delegate')
        return round === 1
          ? toolCall('delegate-1', 'delegate_task', {
              tasks: [{ objective: 'Sweep the tree', role: 'explore' }],
            })
          : reply('Delegated');
      return round === 1
        ? toolCall('send-1', 'send_message', { childSessionId, message: 'what did you find?' })
        : reply('Done');
    },
  };
  const runParent = (residency: SubAgentResidency) =>
    new Agent({
      store,
      provider,
      tools: new ToolRegistry(),
      approve: async () => true,
      modelInfo: { model: 'parent-model', protocol: 'openai' },
      subagents: { enabled: true },
      subagentResidency: residency,
      subagentProviderFor: (model) => {
        resolved.push(model);
        return undefined;
      },
      childTools: () => new ToolRegistry(),
    }).run({ sessionId: session.id, prompt: 'Delegate a sweep' });

  const first = new SubAgentResidency();
  assert.equal((await runParent(first)).status, 'completed');
  childSessionId = first.list()[0]!.childSessionId;
  assert.deepEqual(
    store.events(session.id).find((event) => event.type === 'subagent.assigned')!.data.model,
    undefined,
    'the assignment really carries no model, which is the case under test',
  );
  await first.disposeAll();

  phase = 'continue';
  round = 0;
  const second = new SubAgentResidency();
  t.after(() => second.disposeAll());
  const result = await runParent(second);
  assert.equal(result.status, 'completed', result.error);
  assert.deepEqual(
    resolved,
    [],
    'nothing was resolved because there was nothing to resolve, and nothing was refused either',
  );
  assert.ok(
    store
      .messages(childSessionId)
      .some((message) => message.role === 'assistant' && message.content.includes('follow-up')),
    'the resumed turn ran on the host’s own model',
  );
  assert.equal(
    store
      .events(session.id)
      .filter((event) => event.type === 'subagent.finished')
      .at(-1)!.data.role,
    'explore',
    'a role is not carried by a model, so it is still the one the delegation gave',
  );
});
