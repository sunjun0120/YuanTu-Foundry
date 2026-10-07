/**
 * `step boundaries`: a run's rounds, recorded durably with the reason each one ended.
 *
 * A run's start and end were always in the log, and so was its work — messages, tool calls, retries. What was
 * missing is the boundary between the two: nothing said which round the run was in when its process died, and
 * the only way to guess was to read the transcript and infer it. These tests pin the property that answers it —
 * one `step.started` per round, closed by exactly one `step.finished` with a named reason on *every* way out,
 * including the ways that throw — and the one shape that is deliberately left behind: a step that never ended,
 * which is what a crash looks like and what the interruption record then names.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Agent } from '../packages/core/agent.ts';
import { SessionStore } from '../packages/storage/sqlite.ts';
import { HookRegistry, ToolRegistry } from '../packages/tools/registry.ts';
import { foldSteps, inFlightStep, STEP_END_REASONS } from '../packages/protocol/steps.ts';
import type { StepEndReason, StepRecord } from '../packages/protocol/steps.ts';
import type { ModelResponse, Provider } from '../packages/protocol/index.ts';
import { connectClient, listeningHost } from './listening-host-fixture.ts';
import { httpFixture } from './http-fixture.ts';

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
/** A tool call that fails, so a round produces a result without needing real workspace state. */
const missingFile = (id: string): ModelResponse =>
  toolCall(id, 'read_file', { path: 'not-there.txt' });

async function fixture(
  t: test.TestContext,
  provider: Provider,
  options: { hooks?: HookRegistry } = {},
) {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-step-'));
  const store = new SessionStore(path.join(root, 'sessions.sqlite'));
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const session = store.create(root);
  const agent = new Agent({
    store,
    provider,
    tools: new ToolRegistry(options.hooks ?? new HookRegistry()),
    approve: async () => true,
  });
  return { root, store, session, agent };
}
const steps = (store: SessionStore, sessionId: string): readonly StepRecord[] =>
  store.stateOf<readonly StepRecord[]>('steps', sessionId);
const reasons = (store: SessionStore, sessionId: string): (StepEndReason | null)[] =>
  steps(store, sessionId).map((record) => record.reason);

test('every step is opened and closed in the log, and the reason says what the step did', async (t) => {
  let turn = 0;
  const { agent, store, session } = await fixture(t, {
    async complete() {
      return turn++ === 0 ? missingFile('read-1') : reply('finished');
    },
  });
  const result = await agent.run({ sessionId: session.id, prompt: 'Do the work' });
  assert.equal(result.status, 'completed', result.error);

  const records = steps(store, session.id);
  assert.deepEqual(
    records.map((record) => ({ step: record.step, reason: record.reason })),
    [
      { step: 0, reason: 'tool-calls' },
      { step: 1, reason: 'final' },
    ],
  );
  for (const record of records) {
    assert.equal(record.runId, result.runId);
    assert.ok(record.startedAt, 'a boundary has a time');
    assert.ok(record.endedAt, 'every step in a finished run was closed');
    assert.ok(STEP_END_REASONS.includes(record.reason as StepEndReason));
    assert.equal(inFlightStep([record]), null);
  }
  // Durable, not just folded: the four rows are in the session's own log, in order, and the run's end follows
  // them — which is what makes "the last step ended this way" readable after the process is gone.
  const boundary = store
    .events(session.id)
    .filter((event) => event.type === 'step.started' || event.type === 'step.finished');
  assert.deepEqual(
    boundary.map((event) => event.type),
    ['step.started', 'step.finished', 'step.started', 'step.finished'],
  );
  assert.deepEqual(
    boundary.map((event) => event.data.step),
    [0, 0, 1, 1],
  );
  assert.deepEqual(
    boundary.map((event) => event.data.runId),
    [result.runId, result.runId, result.runId, result.runId],
  );
  assert.equal(
    store.events(session.id).at(-1)!.type,
    'run.finished',
    'the run ends after the step it was in',
  );
});

test("a step that had nothing left to do but queued input says 'queued-input'", async (t) => {
  const ref: { agent?: Agent } = {};
  let sessionId = '';
  let turn = 0;
  const { agent, store, session } = await fixture(t, {
    async complete() {
      // A follow-up arrives while the first round is answering: the round ends with nothing to do, and the
      // loop goes on anyway. That is a different ending from "the run is finished", and the log says which.
      if (turn++ === 0)
        ref.agent!.enqueue(sessionId, { prompt: 'and then the tests' }, 'follow-up');
      return reply(`answer ${turn}`);
    },
  });
  ref.agent = agent;
  sessionId = session.id;
  const result = await agent.run({ sessionId: session.id, prompt: 'Do the work' });
  assert.equal(result.status, 'completed', result.error);
  assert.deepEqual(reasons(store, session.id), ['queued-input', 'final']);
});

test('a round a policy refuses ends as blocked, and the run still fails', async (t) => {
  const hooks = new HookRegistry();
  hooks.register({
    preStep: (context) => (context.round === 1 ? { block: 'budget freeze' } : undefined),
  });
  let turn = 0;
  const { agent, store, session } = await fixture(
    t,
    {
      async complete() {
        return turn++ === 0 ? missingFile('read-1') : reply();
      },
    },
    { hooks },
  );
  const result = await agent.run({ sessionId: session.id, prompt: 'Do the work' });
  // The refusal still fails the run — the task did not happen — while the *step* is recorded as blocked, which
  // is the difference between "policy said no" and "something broke" that a reader needs.
  assert.equal(result.status, 'failed');
  assert.match(result.error ?? '', /Run refused by extension pre-step hook: budget freeze/);
  assert.deepEqual(reasons(store, session.id), ['tool-calls', 'blocked']);
});

test('a cancelled run closes the step it was in, and one cancelled before its first step opens none', async (t) => {
  const controller = new AbortController();
  const { agent, store, session, root } = await fixture(t, {
    async complete({ signal }) {
      controller.abort();
      return new Promise((_, reject) => {
        const abort = () => reject(signal.reason);
        if (signal.aborted) abort();
        else signal.addEventListener('abort', abort, { once: true });
      });
    },
  });
  const result = await agent.run({
    sessionId: session.id,
    prompt: 'Wait',
    signal: controller.signal,
  });
  assert.equal(result.status, 'cancelled');
  assert.deepEqual(reasons(store, session.id), ['cancelled']);

  // The other half of the same property: a run stopped before any work began leaves no open step, so a reader
  // never sees a crash signature where there was none.
  const early = new AbortController();
  early.abort();
  const earlySession = store.create(root);
  const earlyAgent = new Agent({
    store,
    provider: {
      async complete() {
        throw new Error('must not be called');
      },
    },
    tools: new ToolRegistry(new HookRegistry()),
    approve: async () => true,
  });
  const stopped = await earlyAgent.run({
    sessionId: earlySession.id,
    prompt: 'never starts',
    signal: early.signal,
  });
  assert.equal(stopped.status, 'cancelled');
  assert.deepEqual(steps(store, earlySession.id), []);
});

test('a step the run was limited in ends as limited', async (t) => {
  const { agent, store, session } = await fixture(t, {
    async complete() {
      // Truncated at the output limit: the run is limited, and the tool call the turn carried is not executed.
      return { ...missingFile('read-1'), finishReason: 'length' };
    },
  });
  const result = await agent.run({ sessionId: session.id, prompt: 'Do the work' });
  assert.equal(result.status, 'limited');
  assert.equal(result.code, 'output-limit');
  // The step's reason is the limit, because that is why the run has no next step to hand the work to.
  assert.deepEqual(reasons(store, session.id), ['limited']);
  assert.equal(store.messages(session.id).filter((message) => message.role === 'tool').length, 0);
});

test('the fold keeps the newest boundaries and skips what it cannot read', () => {
  const at = (n: number) => new Date(Date.UTC(2026, 9, 1, 0, 0, n)).toISOString();
  const opened = (runId: string, step: number, second: number) => ({
    type: 'step.started',
    data: { runId, step },
    at: at(second),
  });
  const closed = (runId: string, step: number, reason: unknown, second: number) => ({
    type: 'step.finished',
    data: { runId, step, reason },
    at: at(second),
  });
  // Three payloads a different build could have written: a start with no run, a reason outside the vocabulary,
  // and an end for a step nobody opened. Each is skipped rather than closes something that was never opened.
  const junk = [
    { type: 'step.started', data: { step: 0 }, at: at(0) },
    closed('r', 0, 'because', 1),
    closed('r', 5, 'final', 2),
  ];
  assert.deepEqual(foldSteps(junk), []);

  const pair = [opened('r', 0, 0), closed('r', 0, 'tool-calls', 30)];
  assert.deepEqual(foldSteps(pair), [
    { runId: 'r', step: 0, startedAt: at(0), endedAt: at(30), reason: 'tool-calls' },
  ]);
  assert.equal(inFlightStep(foldSteps(pair)), null);
  assert.deepEqual(foldSteps(pair, { runId: 'other' }), []);

  // The cap drops the oldest, and an open step survives it because the newest record is the one that is open.
  const many = Array.from({ length: 60 }, (_, index) => opened('long', index, index));
  const kept = foldSteps([...many, opened('open-run', 0, 100)]);
  assert.equal(kept.length, 50);
  assert.equal(kept[0]!.step, 11);
  assert.equal(inFlightStep(kept)?.runId, 'open-run');
});

test('a run whose process died leaves one open step, and the interruption names it', async (t) => {
  // The endpoint accepts the request and then stops talking, so the run is inside its first step's request when
  // the Host is killed. That is the state the boundaries exist to describe, and the only way to produce it is to
  // really kill a process: a step that never ends is a record nobody writes.
  const url = await httpFixture(t, (_, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(
      'event: message_start\r\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","content":[],"model":"fixture","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":5,"output_tokens":0}}}\r\n\r\n',
    );
    res.write(
      'event: content_block_start\r\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\r\n\r\n',
    );
    res.write(
      'event: content_block_delta\r\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"thinking"}}\r\n\r\n',
    );
    // Deliberately never ends: the run stays in this step until the process is gone.
  });
  const host = await listeningHost(t, { YUANTU_BASE_URL: url });
  const { client } = await connectClient(host.port);
  t.after(() => client.stop().catch(() => {}));
  await client.start();
  const session = await client.request('session.create', {});
  let streamed = false;
  const off = client.subscribe((event) => {
    if (event.type === 'message.delta') streamed = true;
  });
  t.after(off);
  const pending = client.run(session.id, 'Think about it slowly').catch(() => {});
  const deadline = Date.now() + 20_000;
  while (!streamed && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(streamed, `the run never reached its first step. stderr: ${host.stderr()}`);
  const exited = new Promise<void>((resolve) => host.child.once('exit', () => resolve()));
  host.child.kill('SIGKILL');
  await exited;
  await pending;

  // A new process opens the same workspace, which is what a carrier does after a crash.
  const store = new SessionStore(host.dbPath);
  try {
    assert.equal(store.reconcileInterruptedRuns(host.root), 1);
    const events = store.events(session.id);
    const boundary = events.filter(
      (event) => event.type === 'step.started' || event.type === 'step.finished',
    );
    assert.deepEqual(
      boundary.map((event) => event.type),
      ['step.started'],
      'the step was opened, and the process died before anything closed it',
    );
    const interrupted = events.find((event) => event.type === 'run.interrupted');
    assert.ok(interrupted, 'the interruption is recorded');
    assert.equal(interrupted.data.runId, boundary[0]!.data.runId);
    assert.equal(interrupted.data.step, 0, 'and it names the step the run was in');
    const records = store.stateOf<readonly StepRecord[]>('steps', session.id);
    assert.equal(records.length, 1);
    assert.equal(records[0]!.step, 0);
    assert.equal(records[0]!.endedAt, null, 'an unended step is how a cut-off run is recognised');
    assert.equal(records[0]!.reason, null);
    assert.equal(inFlightStep(records)?.step, 0);
    assert.equal(
      store.inFlightStep(session.id, String(interrupted.data.runId))?.step,
      0,
      'the store names it from the log, not from a column',
    );
    assert.equal(store.get(session.id).activeRun, null);
  } finally {
    store.close();
  }
});
