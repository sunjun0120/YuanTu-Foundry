/**
 * The session's process record: what was asked, what was decided, and what the provider refused for size.
 *
 * These are the facts a transcript cannot carry. It shows a file that changed, and a tool result that says the
 * change was refused; it cannot say *who* was asked, whether anyone ever answered, or whether a run was still
 * waiting for a person when it was stopped. Those are the questions a reopened session gets asked first, and
 * they are only answerable if the answer outlives the process that knew it.
 *
 * Two properties are load-bearing and are asserted as such: the records are ordered halves of one decision
 * (`required` then `decided`, written separately so that "never decided" stays expressible), and the log and the
 * live stream say the same thing about the same decision.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Agent } from '../packages/core/agent.ts';
import { SessionStore } from '../packages/storage/sqlite.ts';
import { auditEntries, foldMessages } from '../packages/storage/events.ts';
import { createTools } from '../packages/tools/index.ts';
import { AgentHostClient } from '../packages/client/host-client.ts';
import type {
  AgentEvent,
  Approver,
  Approval,
  ModelRequest,
  ModelResponse,
  Provider,
  QuestionOutcome,
} from '../packages/protocol/index.ts';
import { frames, httpFixture, sendFrames } from './http-fixture.ts';

const hostPath = path.resolve('apps/agent-host/main.ts');

// ---- the kernel's side, where a decision is actually made ----

const reply = (text = 'Finished', toolCalls: ModelResponse['toolCalls'] = []): ModelResponse => ({
  text,
  toolCalls,
  // A response that carries calls has to say so: the kernel refuses "stop reason conflicts with tool calls"
  // rather than guessing which of the two the provider meant.
  finishReason: toolCalls.length ? 'tool_calls' : 'stop',
  usage: { inputTokens: 10, outputTokens: 5 },
});
const writeCall = (file: string, id = 'call-write'): ModelResponse['toolCalls'][number] => ({
  id,
  name: 'write_file',
  arguments: { path: file, content: '写好了' },
});
/** The same call in the wire shape a provider streams, which is what the HTTP fixtures produce. */
const writeFrame = (file: string, id = 'call-write') => ({
  id,
  name: 'write_file',
  input: { path: file, content: '写好了' },
});
async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-audit-'));
  const store = new SessionStore(path.join(root, 'session.sqlite'));
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const events: AgentEvent[] = [];
  return { root, store, tools: createTools(root), session: store.create(root), events };
}
/** The audit records of a session, as the RPC reads them. */
const audit = (store: SessionStore, sessionId: string) =>
  auditEntries(store.events(sessionId), 100);

test('preauthorized writes retain their decision source in durable and live audit records', async (t) => {
  for (const source of ['policy', 'launch-options', 'task-approval'] as const) {
    const { root, store, tools, session, events } = await fixture(t);
    t.after(() => tools.close());
    let rounds = 0;
    const approve: Approver = async () => true;
    approve.decisionSource = () => source;
    const agent = new Agent({
      store,
      tools,
      approve,
      onEvent: (event) => events.push(event),
      provider: {
        async complete() {
          return rounds++ ? reply() : reply('', [writeCall('authorized.txt')]);
        },
      },
    });
    const result = await agent.run({ sessionId: session.id, prompt: 'Write the fixture' });
    assert.equal(result.status, 'completed', result.error);
    assert.equal(await readFile(path.join(root, 'authorized.txt'), 'utf8'), '写好了');
    assert.equal(
      audit(store, session.id).find((record) => record.type === 'approval.decided')?.data.reason,
      source,
    );
    assert.equal(events.find((event) => event.type === 'approval.decided')?.data.reason, source);
  }
});

test('an allowed write records the request and the decision as two ordered facts', async (t) => {
  const { store, tools, session, events } = await fixture(t);
  const asked: Approval[] = [];
  let turns = 0;
  const provider: Provider = {
    async complete(call: ModelRequest) {
      if (turns++ === 0) return reply('', [writeCall('approved.txt')]);
      // The decision reaches the model as the tool result, never as the audit line.
      assert.match(JSON.stringify(call.messages), /写好了/);
      return reply('Wrote it.');
    },
  };
  const agent = new Agent({
    store,
    tools,
    approve: async (approval) => {
      asked.push(approval);
      return true;
    },
    provider,
    onEvent: (event) => events.push(event),
  });
  const result = await agent.run({ sessionId: session.id, prompt: 'Write the file.' });
  assert.equal(result.status, 'completed', result.error);

  const records = audit(store, session.id);
  assert.deepEqual(
    records.map((event) => event.type),
    ['approval.required', 'approval.decided'],
  );
  assert.equal((records[0]!.data.approval as Approval).change?.path, 'approved.txt');
  assert.equal(records[1]!.data.allow, true);
  assert.equal(records[1]!.data.reason, 'user');
  // The live stream and the log are the same story, told at the same moment: a client that saw the decision and
  // a reader that finds it later must not disagree about what happened.
  const live = events.filter((event) => event.type === 'approval.decided');
  assert.equal(live.length, 1);
  assert.equal(live[0]!.data.allow, records[1]!.data.allow);
  assert.equal(live[0]!.data.reason, records[1]!.data.reason);
  assert.equal(asked.length, 1, 'the person was asked exactly once');
});

test('a refusal is recorded as a decision, not as an unanswered request', async (t) => {
  const { store, tools, session } = await fixture(t);
  let turns = 0;
  const provider: Provider = {
    async complete() {
      return turns++ === 0 ? reply('', [writeCall('denied.txt')]) : reply('Understood.');
    },
  };
  const agent = new Agent({
    store,
    tools,
    approve: async () => false,
    provider,
    onEvent: () => {},
  });
  await agent.run({ sessionId: session.id, prompt: 'Write the file.' });
  const records = audit(store, session.id);
  assert.deepEqual(
    records.map((event) => event.type),
    ['approval.required', 'approval.decided'],
  );
  assert.equal(records[1]!.data.allow, false);
  assert.equal(records[1]!.data.reason, 'user');
});

test('a planning run that refuses to write still records that it was asked and refused', async (t) => {
  const { store, tools, session } = await fixture(t);
  let turns = 0;
  let asked = 0;
  const provider: Provider = {
    async complete() {
      return turns++ === 0
        ? reply('', [writeCall('planned.txt')])
        : reply('Cannot write while planning.');
    },
  };
  const agent = new Agent({
    store,
    tools,
    approve: async () => {
      asked++;
      return true;
    },
    provider,
    onEvent: () => {},
  });
  // `readOnly` is the same refusal the planning phase applies, without the plan-record requirement that would
  // make this test about planning instead of about the record.
  await agent.run({ sessionId: session.id, prompt: 'Plan the write.', readOnly: true });
  // The refusal is decided by the phase, so nobody is asked: a 120s prompt for an operation that cannot be
  // allowed would only waste the user's time. It is still recorded, because "nobody decided" is not the same
  // fact as "the planning phase decided".
  assert.equal(asked, 0);
  const records = audit(store, session.id);
  assert.deepEqual(
    records.map((event) => event.type),
    ['approval.required', 'approval.decided'],
  );
  assert.equal(records[1]!.data.allow, false);
  assert.equal(records[1]!.data.reason, 'read-only');
});

test('a wait that ends without an answer leaves the request standing alone', async (t) => {
  const { store, tools, session } = await fixture(t);
  let turns = 0;
  const provider: Provider = {
    async complete() {
      return turns++ === 0 ? reply('', [writeCall('interrupted.txt')]) : reply('Never asked.');
    },
  };
  const agent = new Agent({
    store,
    tools,
    // The approver fails instead of answering: from the kernel's side this is indistinguishable from a Host that
    // died while the prompt was on screen, which is exactly the state a reopened session has to be able to
    // recognise instead of reading as "denied".
    approve: async () => {
      throw new Error('approval transport failed');
    },
    provider,
    onEvent: () => {},
  });
  await agent.run({ sessionId: session.id, prompt: 'Write the file.' });
  const records = audit(store, session.id);
  assert.deepEqual(
    records.map((event) => event.type),
    ['approval.required'],
  );
  assert.equal((records[0]!.data.approval as Approval).change?.path, 'interrupted.txt');
});

test('a question records what was asked and what came back, including a timeout', async (t) => {
  const { root, store, tools, session } = await fixture(t);
  let turns = 0;
  let outcome: QuestionOutcome = { answered: true, answers: [{ id: 'color', selected: ['blue'] }] };
  const provider: Provider = {
    async complete() {
      return turns++ === 0
        ? reply('', [
            {
              id: 'call-ask',
              name: 'ask_user_question',
              arguments: {
                questions: [
                  { id: 'color', question: 'Which colour?', options: [{ label: 'blue' }] },
                ],
              },
            },
          ])
        : reply('Using blue.');
    },
  };
  const agent = new Agent({
    store,
    tools,
    approve: async () => false,
    question: async () => outcome,
    provider,
    onEvent: () => {},
  });
  await agent.run({ sessionId: session.id, prompt: 'Pick a colour.' });
  let records = audit(store, session.id);
  assert.deepEqual(
    records.map((event) => event.type),
    ['question.required', 'question.answered'],
  );
  assert.equal((records[1]!.data.outcome as QuestionOutcome).answered, true);
  assert.deepEqual((records[1]!.data.outcome as QuestionOutcome).answers, [
    { id: 'color', selected: ['blue'] },
  ]);

  // The unanswered case is a decision too — "nobody was there" is the answer — so it is recorded rather than
  // left as a dangling request. This is the ordinary outcome for a scheduled run.
  const second = store.create(root);
  outcome = { answered: false, answers: [], timedOut: true, reason: 'timeout' };
  let otherTurns = 0;
  const otherProvider: Provider = {
    async complete() {
      return otherTurns++ === 0
        ? reply('', [
            {
              id: 'call-ask-2',
              name: 'ask_user_question',
              arguments: { questions: [{ id: 'color', question: 'Which colour?' }] },
            },
          ])
        : reply('Proceeding on the assumption that it is red.');
    },
  };
  await new Agent({
    store,
    tools,
    approve: async () => false,
    question: async () => outcome,
    provider: otherProvider,
    onEvent: () => {},
  }).run({ sessionId: second.id, prompt: 'Pick a colour.' });
  records = audit(store, second.id);
  assert.deepEqual(
    records.map((event) => event.type),
    ['question.required', 'question.answered'],
  );
  assert.equal((records[1]!.data.outcome as QuestionOutcome).reason, 'timeout');
});

test('the process record adds no turn to the conversation', async (t) => {
  const { store, tools, session } = await fixture(t);
  const seen: string[] = [];
  let turns = 0;
  const provider: Provider = {
    async complete(call: ModelRequest) {
      seen.push(JSON.stringify(call.messages));
      return turns++ === 0 ? reply('', [writeCall('hidden.txt')]) : reply('Done.');
    },
  };
  await new Agent({
    store,
    tools,
    approve: async () => {
      throw new Error('the transport failed');
    },
    provider,
    onEvent: () => {},
  }).run({ sessionId: session.id, prompt: 'Write the file.' });
  const records = audit(store, session.id);
  assert.equal(records.length, 1, 'the record exists');
  // An audit line is a fact about the session, not a turn in it. Recording the process must not change the
  // conversation, so the request the model is given carries no trace of the record.
  const events = store.events(session.id);
  assert.equal(
    foldMessages(events).length,
    events.filter((event) => event.type.startsWith('message.')).length,
  );
  for (const request of seen) assert.doesNotMatch(request, /approval\.(required|decided)/);
  assert.doesNotMatch(JSON.stringify(store.messages(session.id)), /approval\.(required|decided)/);
});

// ---- the wire, where a client reads the record back ----

test('the Host publishes both halves of a decision and lets a client read them back', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-audit-host-'));
  const cleanups: (() => Promise<unknown>)[] = [];
  // One hook, in order: the Host goes first, because it holds the database and the workspace the removal is
  // about to delete, and a removal that loses that race fails the test for the wrong reason.
  t.after(async () => {
    for (const cleanup of cleanups) await cleanup();
    await rm(root, { recursive: true, force: true });
  });
  let turns = 0;
  const url = await httpFixture(t, (body, res) => {
    if (turns++ === 0) {
      sendFrames(res, frames('', [writeFrame('approved.txt')]));
      return;
    }
    assert.match(JSON.stringify(body.messages), /写好了/);
    sendFrames(res, frames('Wrote it.'));
  });
  const client = new AgentHostClient({
    nodePath: process.execPath,
    hostPath,
    workspace: root,
    db: path.join(root, 'sessions.sqlite'),
    env: {
      YUANTU_PROTOCOL: 'anthropic',
      YUANTU_API_KEY: 'audit-fixture',
      YUANTU_MODEL: 'fixture',
      YUANTU_MAX_CONTEXT_TOKENS: '128000',
      YUANTU_SESSION_TITLES: '0',
      YUANTU_BASE_URL: url,
      /**
       * The naming call is a real request to the endpoint, so this fixture — which scripts one response per
       * request, where the first is the tool call under test — must not pay it. Asserting the naming path itself
       * is `session-title.test.ts`'s job, and that fixture counts the call deliberately.
       */
    },
  });
  cleanups.push(() => client.stop());
  const live: AgentEvent[] = [];
  let approvalId = '';
  let resolveAsked!: () => void;
  const asked = new Promise<void>((resolve) => {
    resolveAsked = resolve;
  });
  client.subscribe((event) => {
    live.push(event);
    if (event.type === 'approval.required') {
      approvalId = String(event.data.approvalId);
      resolveAsked();
    }
  });
  await client.start();
  const session = await client.request('session.create', {});
  const running = client.run(session.id, 'Create the file.');
  await asked;
  assert.ok(approvalId, 'the Host must publish an id the client can answer');
  await client.request('approval.respond', { approvalId, allow: true });
  const result = await running;
  assert.equal(result.status, 'completed', result.error);

  const first = await client.request('session.audit', { sessionId: session.id });
  assert.deepEqual(
    first.entries.map((entry) => entry.type),
    ['approval.required', 'approval.decided'],
  );
  assert.equal(first.entries[1]!.data.allow, true);
  // The wire record carries the position in the log, which is what makes it a cursor rather than a list.
  assert.ok(first.entries[0]!.seq < first.entries[1]!.seq);
  assert.equal(first.nextSeq, first.entries[1]!.seq);
  // The live stream and the read-back agree, which is the property that makes the record worth writing: a client
  // that saw it happen and a client that reads it later cannot disagree.
  const decidedLive = live.filter((event) => event.type === 'approval.decided');
  assert.equal(decidedLive.length, 1);
  assert.equal(decidedLive[0]!.data.allow, first.entries[1]!.data.allow);
  assert.equal(decidedLive[0]!.data.reason, first.entries[1]!.data.reason);
});

test('the audit cursor reads forward a page at a time without repeating or skipping', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-audit-cursor-'));
  const cleanups: (() => Promise<unknown>)[] = [];
  t.after(async () => {
    for (const cleanup of cleanups) await cleanup();
    await rm(root, { recursive: true, force: true });
  });
  // Two gated writes, then plain text: the third request ends the run.
  let turns = 0;
  const url = await httpFixture(t, (_body, res) => {
    turns++;
    sendFrames(
      res,
      turns <= 2
        ? frames('', [writeFrame(`file-${turns}.txt`, `call-${turns}`)])
        : frames('Wrote both.'),
    );
  });
  const client = new AgentHostClient({
    nodePath: process.execPath,
    hostPath,
    workspace: root,
    db: path.join(root, 'sessions.sqlite'),
    env: {
      YUANTU_PROTOCOL: 'anthropic',
      YUANTU_API_KEY: 'audit-cursor-fixture',
      YUANTU_MODEL: 'fixture',
      YUANTU_MAX_CONTEXT_TOKENS: '128000',
      YUANTU_SESSION_TITLES: '0',
      YUANTU_BASE_URL: url,
      // Same reason as the test above: this fixture scripts two gated writes and then plain text by request
      // order, so an extra naming call would shift every response by one and the approvals would never arrive.
    },
  });
  cleanups.push(() => client.stop());
  const answers: boolean[] = [true, false];
  const wanted: string[] = [];
  let wake: (() => void) | undefined;
  client.subscribe((event) => {
    if (event.type !== 'approval.required') return;
    wanted.push(String(event.data.approvalId));
    wake?.();
  });
  await client.start();
  const session = await client.request('session.create', {});
  const running = client.run(session.id, 'Create two files.');
  // Answer each request as it arrives: the second is refused, so the log ends up with four records.
  for (const allow of answers) {
    while (wanted.length === 0) await new Promise<void>((resolve) => (wake = resolve));
    await client.request('approval.respond', { approvalId: wanted.shift()!, allow });
  }
  const result = await running;
  assert.equal(result.status, 'completed', result.error);

  const whole = await client.request('session.audit', { sessionId: session.id });
  assert.equal(whole.entries.length, 4);
  const pages: string[] = [];
  let afterSeq = 0;
  for (;;) {
    const page = await client.request('session.audit', {
      sessionId: session.id,
      afterSeq,
      limit: 1,
    });
    if (page.entries.length === 0) {
      // An empty page must not move the cursor: a client that keeps reading from it asks the same question
      // again rather than jumping over records it never saw.
      assert.equal(page.nextSeq, afterSeq);
      break;
    }
    pages.push(page.entries[0]!.type);
    assert.equal(page.nextSeq, page.entries[0]!.seq);
    afterSeq = page.nextSeq;
  }
  assert.deepEqual(
    pages,
    whole.entries.map((entry) => entry.type),
  );
  assert.deepEqual(pages, [
    'approval.required',
    'approval.decided',
    'approval.required',
    'approval.decided',
  ]);
  await assert.rejects(
    client.request('session.audit', { sessionId: session.id, limit: 0 }),
    /Invalid audit cursor/,
  );
  await assert.rejects(
    client.request('session.audit', { sessionId: session.id, afterSeq: -1 }),
    /Invalid audit cursor/,
  );
});
