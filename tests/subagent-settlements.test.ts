/**
 * A delegated child that settled after its parent stopped looking.
 *
 * `wait: false` is the only place where work escapes the turn that started it, and the run that started it is
 * the only thing that knew about it: the coordinator lives inside the run, so a parent whose run has ended has
 * nothing left to collect *from*. What survives is the parent's log, and these tests hold the two promises
 * that make it usable — the parent is told (in its next request, from the log), and the parent can still act
 * on it (collect the report, or resume the same child).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Agent } from '../packages/core/agent.ts';
import { SubAgentResidency } from '../packages/core/residency.ts';
import { settlementNotices, settlementNoticeText } from '../packages/core/settlements.ts';
import { SessionStore } from '../packages/storage/sqlite.ts';
import { ToolRegistry } from '../packages/tools/registry.ts';
import type { ModelRequest, ModelResponse, Provider } from '../packages/protocol/index.ts';

const SUBAGENT_MARK = 'You are a sub-agent delegated by a parent agent';
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const reply = (text: string): ModelResponse => ({
  text,
  toolCalls: [],
  finishReason: 'stop',
  usage: { inputTokens: 10, outputTokens: 5 },
});
const call = (id: string, name: string, args: Record<string, unknown>): ModelResponse => ({
  text: '',
  finishReason: 'tool_calls',
  toolCalls: [{ id, name, arguments: args }],
  usage: { inputTokens: 10, outputTokens: 5 },
});
const report = (summary: string): ModelResponse =>
  call('report-1', 'submit_report', {
    summary,
    findings: [{ statement: `${summary} finding`, evidence: 'src/index.ts:12' }],
  });
const isChild = (request: ModelRequest) => request.system.includes(SUBAGENT_MARK);

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-settlement-'));
  const store = new SessionStore(path.join(root, 'sessions.sqlite'));
  const residency = new SubAgentResidency();
  t.after(async () => {
    residency.disposeAll();
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const session = store.create(root);
  return { root, store, residency, session };
}
/** The system prompt of the run's first request, which is where a settlement notice is delivered. */
const noticeIn = (requests: ModelRequest[]): string =>
  requests.map((request) => request.system).find((system) => system.includes('have settled')) ?? '';
function parentAgent(store: SessionStore, residency: SubAgentResidency, provider: Provider): Agent {
  return new Agent({
    store,
    provider,
    tools: new ToolRegistry(),
    approve: async () => true,
    subagents: { enabled: true },
    subagentResidency: residency,
    childTools: () => new ToolRegistry(),
  });
}

test('a child that finished after its run is announced to the parent and can be collected', async (t) => {
  const { store, residency, session } = await fixture(t);
  // The child finishes on its own, just after the parent's last turn: the work is done, and nobody heard.
  const first: Provider = {
    async complete(request) {
      if (isChild(request)) {
        await sleep(30);
        return report('Sweep complete');
      }
      if (request.messages.some((message) => message.role === 'tool'))
        return reply('I delegated the sweep.');
      return call('d1', 'delegate_task', { wait: false, tasks: [{ objective: 'Sweep' }] });
    },
  };
  const started = await parentAgent(store, residency, first).run({
    sessionId: session.id,
    prompt: 'Delegate a sweep',
  });
  assert.equal(started.status, 'completed', started.error);
  // The parent answered before the child was done, so the run cancelled the turn in flight — the child is
  // nevertheless recorded, not lost.
  const settled = settlementNotices(store, session.id);
  assert.equal(settled.length, 1, JSON.stringify(settled));
  assert.equal(settled[0]!.status, 'cancelled');
  assert.match(settled[0]!.reason ?? '', /ended without collecting/);
  // The reason has to survive in the log: a card or a notice that says "cancelled" with no reason is the
  // silence this whole path exists to remove.
  assert.match(
    JSON.stringify(store.events(session.id).filter((event) => event.type === 'subagent.finished')),
    /ended without collecting/,
  );

  // The next run of the same session is told, in its own system prompt, and told which id each tool wants.
  const requests: ModelRequest[] = [];
  const second: Provider = {
    async complete(request) {
      requests.push(request);
      return reply('Understood.');
    },
  };
  await parentAgent(store, residency, second).run({
    sessionId: session.id,
    prompt: 'Anything new?',
  });
  const notice = noticeIn(requests);
  assert.match(notice, /Sweep/);
  assert.match(notice, /cancelled/);
  assert.match(notice, /collect_subagents id: [0-9a-f-]{36}/);
  assert.match(notice, /job_output\/send_message childSessionId: [0-9a-f-]{36}/);
  // The notice goes into the system prompt, so the child's own prose must not travel with it: an explore child
  // reads files it did not write, and its report has to reach the parent as data (a tool result) rather than as
  // instruction-shaped text next to the parent's rules.
  assert.doesNotMatch(notice, /Sweep complete/);
  // A notice is context, not a turn: the transcript must not grow a message the user never sent.
  assert.equal(
    requests[0]!.messages.filter((message) => message.role === 'user').length,
    2,
    JSON.stringify(requests[0]!.messages.map((message) => message.role)),
  );
});

test('the notice repeats until the outcome is collected, then stops', async (t) => {
  const { store, residency, session } = await fixture(t);
  const first: Provider = {
    async complete(request) {
      if (isChild(request)) return report('Sweep complete');
      if (request.messages.some((message) => message.role === 'tool')) return reply('Delegated.');
      return call('d1', 'delegate_task', { wait: false, tasks: [{ objective: 'Sweep' }] });
    },
  };
  await parentAgent(store, residency, first).run({
    sessionId: session.id,
    prompt: 'Delegate a sweep',
  });
  assert.equal(settlementNotices(store, session.id).length, 1);

  // A run that is told but ignores it must be told again: a single announcement that is missed leaves the
  // work unread, which is the state the notice exists to prevent.
  const ignored: ModelRequest[] = [];
  await parentAgent(store, residency, {
    async complete(request) {
      ignored.push(request);
      return reply('Ignored.');
    },
  }).run({ sessionId: session.id, prompt: 'Ignore it' });
  assert.match(noticeIn(ignored), /Sweep/);
  assert.equal(settlementNotices(store, session.id).length, 1);

  // Collecting is what ends it — and `collect_subagents` has to work here, one run later, or the notice
  // would be pointing at a tool that answers "no outstanding sub-agents".
  const collecting: ModelRequest[] = [];
  const collected = await parentAgent(store, residency, {
    async complete(request) {
      collecting.push(request);
      if (request.messages.at(-1)?.role === 'tool') return reply('Got it.');
      return call('c1', 'collect_subagents', { waitMs: 0 });
    },
  }).run({ sessionId: session.id, prompt: 'Collect' });
  assert.equal(collected.status, 'completed', collected.error);
  const result = store
    .messages(session.id)
    .filter((message) => message.role === 'tool')
    .map((message) => String(message.content))
    .join('\n');
  assert.match(result, /Sweep complete/);
  assert.match(result, /cancelled/);
  assert.deepEqual(settlementNotices(store, session.id), []);

  const after: ModelRequest[] = [];
  await parentAgent(store, residency, {
    async complete(request) {
      after.push(request);
      return reply('Done.');
    },
  }).run({ sessionId: session.id, prompt: 'Again?' });
  assert.equal(noticeIn(after), '');
});

test('a cancelled child is named and can be resumed instead of the work being done twice', async (t) => {
  const { store, residency, session } = await fixture(t);
  let childTurns = 0;
  const provider: Provider = {
    async complete(request) {
      if (isChild(request)) {
        childTurns++;
        if (childTurns > 1) return reply('carried on and finished the sweep');
        // Never finishes: the parent's run end has to stop it.
        return new Promise<ModelResponse>((_resolve, reject) => {
          request.signal.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          });
        });
      }
      if (request.messages.some((message) => message.role === 'tool')) return reply('Delegated.');
      return call('d1', 'delegate_task', { wait: false, tasks: [{ objective: 'Slow sweep' }] });
    },
  };
  await parentAgent(store, residency, provider).run({ sessionId: session.id, prompt: 'Start it' });
  const child = residency.list()[0]!;
  assert.equal(child.status, 'idle', 'the child survives the run that started it');

  // The parent's next run is told, and the notice says how to pick the work back up.
  const requests: ModelRequest[] = [];
  const resumed = await parentAgent(store, residency, {
    async complete(request) {
      requests.push(request);
      if (isChild(request)) return provider.complete(request);
      if (request.messages.at(-1)?.role === 'tool') return reply('It carried on.');
      assert.match(noticeIn(requests), /send_message childSessionId/);
      return call('s1', 'send_message', {
        childSessionId: child.childSessionId,
        message: 'Please finish the sweep.',
      });
    },
  }).run({ sessionId: session.id, prompt: 'Pick it back up' });
  assert.equal(resumed.status, 'completed', resumed.error);
  assert.equal(childTurns, 2, 'the same child ran a second turn');
  assert.match(
    store
      .messages(child.childSessionId)
      .map((message) => String(message.content))
      .join('\n'),
    /carried on and finished the sweep/,
  );
  // Reading the child's own transcript counts as delivery, so the reminder goes away without a collect call.
  assert.deepEqual(settlementNotices(store, session.id), []);
});

test('the notice names at most a bounded number of children and says what to do about them', async (t) => {
  const { store, session } = await fixture(t);
  // Written straight into the log: what is being tested is the projection's bound, not delegation again.
  for (let index = 0; index < 12; index++)
    store.recordEvent(session.id, 'subagent.assigned', {
      runId: 'r',
      id: `task-${index}`,
      role: 'explore',
      objective: `Objective ${index}`,
      childSessionId: `child-${index}`,
    });
  for (let index = 0; index < 12; index++)
    store.recordEvent(session.id, 'subagent.finished', {
      runId: 'r',
      id: `task-${index}`,
      sessionId: `child-${index}`,
      role: 'explore',
      objective: `Objective ${index}`,
      status: index % 2 ? 'completed' : 'failed',
      rounds: 1,
      toolCalls: 0,
      usage: { inputTokens: 1, outputTokens: 1 },
      // One child carries a report, so the hint that a report is waiting is exercised — and one carries an
      // error, so the notice is shown to keep the reason while dropping the child's own prose.
      ...(index === 0
        ? { report: { summary: 'SECRET-CHILD-PROSE', findings: [] } }
        : index === 2
          ? { error: 'Cancelled: the run that started this sub-agent ended without collecting it' }
          : {}),
    });
  assert.equal(settlementNotices(store, session.id).length, 8);
  assert.equal(settlementNotices(store, session.id, 3).length, 3);
  const text = settlementNoticeText(settlementNotices(store, session.id));
  assert.match(text, /Objective 0/);
  assert.match(text, /a structured report is waiting/);
  assert.match(text, /ended without collecting it/);
  assert.doesNotMatch(text, /SECRET-CHILD-PROSE/);
  assert.doesNotMatch(text, /Objective 11/);
  // A collected id silences exactly that child, by either of its two names.
  store.recordEvent(session.id, 'subagent.collected', { ids: ['task-0'] });
  store.recordEvent(session.id, 'subagent.collected', { ids: ['child-1'] });
  const remaining = settlementNotices(store, session.id).map((notice) => notice.id);
  assert.ok(!remaining.includes('task-0'));
  assert.ok(!remaining.includes('task-1'));
  assert.equal(settlementNoticeText([]), '');
});
