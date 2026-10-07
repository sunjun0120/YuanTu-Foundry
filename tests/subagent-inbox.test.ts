import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Agent } from '../packages/core/agent.ts';
import { SubAgentResidency } from '../packages/core/residency.ts';
import type { ResidentTurnResult } from '../packages/core/residency.ts';
import { SessionStore } from '../packages/storage/sqlite.ts';
import { subagentInboxProjection } from '../packages/storage/projections.ts';
import type { PendingSubagentMessage } from '../packages/storage/projections.ts';
import type { SessionEvent } from '../packages/storage/events.ts';
import { ToolRegistry } from '../packages/tools/registry.ts';
import type { ModelRequest, ModelResponse, Provider } from '../packages/protocol/index.ts';

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

const reply = (text = 'Done'): ModelResponse => ({
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
/** Polls until a condition holds, so a background turn is observed however fast the fake provider is. */
async function until(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for a condition');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-inbox-'));
  const store = new SessionStore(path.join(root, 'sessions.sqlite'));
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
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
