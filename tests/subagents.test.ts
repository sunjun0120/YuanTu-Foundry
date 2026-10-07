import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Agent } from '../packages/core/agent.ts';
import {
  EXPLORE_TOOLS,
  SUBAGENT_ERROR_CHARS,
  SUBAGENT_REPORT_CHARS,
  SubAgentCoordinator,
  resolveSubAgentOptions,
  type SubAgentOptions,
} from '../packages/core/subagents.ts';
import {
  SUBAGENT_CAPABILITIES,
  SubAgentProviderRegistry,
  inProcessProvider,
} from '../packages/core/subagent-providers.ts';
import { SessionStore } from '../packages/storage/sqlite.ts';
import { RunFailure } from '../packages/protocol/failure.ts';
import { createTools } from '../packages/tools/index.ts';
import type {
  AgentEvent,
  ModelRequest,
  ModelResponse,
  Provider,
} from '../packages/protocol/index.ts';

const reply = (text = 'Finished'): ModelResponse => ({
  text,
  toolCalls: [],
  finishReason: 'stop',
  usage: { inputTokens: 10, outputTokens: 5 },
});
const delegate = (tasks: unknown[], id = 'delegate-1', wait?: boolean): ModelResponse => ({
  text: 'Delegating',
  finishReason: 'tool_calls',
  toolCalls: [
    {
      id,
      name: 'delegate_task',
      arguments: { tasks, ...(wait === undefined ? {} : { wait }) },
    },
  ],
  usage: { inputTokens: 10, outputTokens: 5 },
});
const collect = (id: string): ModelResponse => ({
  text: 'Collecting',
  finishReason: 'tool_calls',
  toolCalls: [{ id, name: 'collect_subagents', arguments: {} }],
  usage: { inputTokens: 10, outputTokens: 5 },
});
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** A child ends its run with this; the schema requires a summary and at least one evidenced finding. */
const submitReport = (
  id: string,
  summary: string,
  statement: string,
  evidence: string,
): ModelResponse => ({
  text: '',
  finishReason: 'tool_calls',
  toolCalls: [
    {
      id,
      name: 'submit_report',
      arguments: { summary, findings: [{ statement, evidence }] },
    },
  ],
  usage: { inputTokens: 10, outputTokens: 5 },
});
const SUBAGENT_MARK = 'You are a sub-agent delegated by a parent agent';
function isChild(request: ModelRequest): boolean {
  return request.system.includes(SUBAGENT_MARK);
}
/**
 * A run's first round ends with the user prompt and later rounds end with a tool result. Routing on
 * "the history contains a tool message" would misroute the second run of a session, whose history
 * already contains one.
 */
function turn(request: ModelRequest): { prompt: string; afterTool: boolean } {
  const last = request.messages.at(-1);
  const prompt = [...request.messages].reverse().find((message) => message.role === 'user');
  return {
    prompt: prompt?.role === 'user' ? prompt.content : '',
    afterTool: last?.role === 'tool',
  };
}
/** Everything the model was told by tools so far, which is how a parent sees a sub-agent report. */
function toolResults(request: ModelRequest): string {
  return request.messages
    .filter((message) => message.role === 'tool')
    .map((message) => message.content)
    .join('\n');
}
async function fixture(
  t: test.TestContext,
  provider: Provider,
  extra: { subagents?: SubAgentOptions } & Record<string, unknown> = {},
) {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-subagents-'));
  const store = new SessionStore(path.join(root, 'sessions.sqlite'));
  const tools = createTools(root);
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const session = store.create(root);
  const events: AgentEvent[] = [];
  const { subagents, ...rest } = extra;
  const agent = new Agent({
    store,
    provider,
    tools,
    approve: async () => true,
    onEvent: (event) => events.push(event),
    // The kernel leaves delegation off; these tests exercise it, and one turns it off again.
    subagents: { enabled: true, ...subagents },
    ...rest,
  });
  return { root, store, session, agent, events, tools };
}
function subagentEvents(events: readonly AgentEvent[], type: string): AgentEvent[] {
  return events.filter((event) => event.type === type);
}

test('delegated tasks run in parallel, in isolated sessions, and are reported in request order', async (t) => {
  let childRequests = 0;
  let inFlight = 0,
    peak = 0;
  const order: string[] = [];
  const provider: Provider = {
    async complete(request) {
      if (!isChild(request)) {
        if (turn(request).afterTool) return reply('Both reports received');
        return delegate([{ objective: 'Investigate alpha' }, { objective: 'Investigate beta' }]);
      }
      childRequests++;
      inFlight++;
      peak = Math.max(peak, inFlight);
      // Alpha is slower, so a reporter that used completion order would return beta first.
      const slow = turn(request).prompt.includes('alpha');
      await new Promise((resolve) => setTimeout(resolve, slow ? 60 : 5));
      inFlight--;
      order.push(slow ? 'alpha' : 'beta');
      const text = slow ? 'alpha report' : 'beta report';
      request.onText(text);
      return reply(text);
    },
  };
  const { store, session, agent, events } = await fixture(t, provider);
  const result = await agent.run({ sessionId: session.id, prompt: 'Investigate both' });

  assert.equal(result.status, 'completed');
  assert.equal(result.text, 'Both reports received');
  assert.equal(childRequests, 2);
  assert.equal(peak, 2, 'both sub-agents should be in flight at once');
  assert.deepEqual(order, ['beta', 'alpha'], 'the faster child finishes first');

  // Report order follows the request, not the completion order.
  const report = events.find((event) => event.type === 'tool.finished')!;
  const content = String(report.data.content);
  assert.ok(content.indexOf('Investigate alpha') < content.indexOf('Investigate beta'), content);
  assert.match(content, /### Sub-agent 1\/2 \[explore\] completed/);
  assert.match(content, /alpha report/);
  assert.match(content, /beta report/);

  // Isolation: children have their own sessions, linked to the parent and hidden from the list.
  const children = store.childSessions(session.id);
  assert.equal(children.length, 2);
  assert.deepEqual(
    children.map((child) => child.parentSessionId),
    [session.id, session.id],
  );
  assert.deepEqual(
    store.list('').map((listed) => listed.id),
    [session.id],
  );
  assert.equal(store.messages(children[0]!.id).length, 2, 'each child kept its own transcript');
  assert.equal(
    store.messages(session.id).length,
    4,
    'the parent kept only its own turn: prompt, tool call, tool result, answer',
  );

  assert.deepEqual(
    result.subagents?.map((entry) => [entry.role, entry.status, entry.rounds]),
    [
      ['explore', 'completed', 1],
      ['explore', 'completed', 1],
    ],
  );
  // Child usage is charged to the parent run: two rounds of the parent plus two children.
  assert.equal(result.usage.inputTokens, 40);
  assert.equal(result.usage.outputTokens, 20);

  // Every sub-agent event must stay on the parent's session and run id, or the client drops it.
  const started = subagentEvents(events, 'subagent.started');
  const finished = subagentEvents(events, 'subagent.finished');
  const deltas = subagentEvents(events, 'subagent.delta');
  assert.equal(started.length, 2);
  assert.equal(finished.length, 2);
  assert.ok(deltas.length >= 2, 'child text is forwarded as parent-scoped deltas');
  const parentRunId = events.find((event) => event.type === 'run.started')!.runId;
  for (const event of [...started, ...finished, ...deltas]) {
    assert.equal(event.sessionId, session.id);
    assert.equal(event.runId, parentRunId);
  }
  assert.equal(started[0]!.data.childSessionId, children[0]!.id);
  // The panel is rebuilt from the stored run result, so the summaries must survive the run.
  assert.deepEqual(
    store.subagents(session.id).map((entry) => [entry.objective, entry.sessionId, entry.status]),
    [
      ['Investigate alpha', children[0]!.id, 'completed'],
      ['Investigate beta', children[1]!.id, 'completed'],
    ],
  );
  assert.equal(started[0]!.data.total, 2);
  assert.equal(started[0]!.data.objective, 'Investigate alpha');
  // Progress events fire when each child actually reaches them, so beta's report lands first.
  const alphaFinished = finished.find((event) => event.data.objective === 'Investigate alpha')!;
  assert.equal(alphaFinished.data.text, 'alpha report');
  assert.equal(finished[0]!.data.text, 'beta report');
});

test('a parent request never contains the sub-agent conversation', async (t) => {
  let parentSawChildPrompt = true;
  const provider: Provider = {
    async complete(request) {
      if (!isChild(request)) {
        if (!turn(request).afterTool) return delegate([{ objective: 'Investigate alpha' }]);
        // The child's final report arrives as a tool result; its own prompt and transcript must not.
        parentSawChildPrompt = JSON.stringify(request.messages).includes(
          'Delegated task from a parent agent',
        );
        assert.match(toolResults(request), /alpha report/);
        return reply('Done');
      }
      return reply('alpha report');
    },
  };
  const { session, agent } = await fixture(t, provider);
  const result = await agent.run({ sessionId: session.id, prompt: 'Go' });
  assert.equal(result.status, 'completed');
  assert.equal(parentSawChildPrompt, false);
});

test('explore sub-agents are read-only: write tools are hidden and refusals are final', async (t) => {
  let sawWriteTool = true;
  const provider: Provider = {
    async complete(request) {
      if (!isChild(request)) {
        if (!turn(request).afterTool) return delegate([{ objective: 'Investigate alpha' }]);
        return reply(toolResults(request));
      }
      if (!turn(request).afterTool) {
        sawWriteTool = request.tools.some(
          (tool) => tool.name === 'edit_file' || tool.name === 'write_file',
        );
        return {
          text: 'Trying to write',
          finishReason: 'tool_calls',
          toolCalls: [
            {
              id: 'write-1',
              name: 'write_file',
              arguments: { path: 'subagent.txt', content: 'should not exist' },
            },
          ],
          usage: { inputTokens: 10, outputTokens: 5 },
        };
      }
      const refused = request.messages.find(
        (message) => message.role === 'tool' && message.toolCallId === 'write-1',
      );
      /**
       * Two layers refuse this now, and each says which one it was: the registry does not *offer* the tool (the
       * explore allowlist, reported as "not available in this run") and the approver would refuse it anyway
       * (read-only, "Permission denied"). Either way the write must not happen. The distinction is the point of
       * the refusal text — a model that is told "unknown tool" goes looking for a typo, and one that is told the
       * tool is excluded by a restriction reports a limit instead.
       */
      return reply(
        refused?.content.includes('not available in this run') ||
          refused?.content.includes('Permission denied')
          ? 'Write refused by the read-only policy'
          : 'Unexpected: the write was allowed',
      );
    },
  };
  const { root, session, agent } = await fixture(t, provider);
  const result = await agent.run({ sessionId: session.id, prompt: 'Investigate' });

  assert.equal(result.status, 'completed');
  assert.equal(sawWriteTool, false, 'a read-only sub-agent must not be shown write tools');
  assert.match(result.text, /Write refused by the read-only policy/);
  await assert.rejects(readFile(path.join(root, 'subagent.txt'), 'utf8'));
  assert.equal(result.subagents?.[0]?.status, 'completed');
});

test('a sub-agent cannot delegate further, and a read-only parent cannot delegate general work', async (t) => {
  let childSawDelegation = true;
  const provider: Provider = {
    async complete(request) {
      if (!isChild(request)) {
        if (!turn(request).afterTool)
          return delegate([
            {
              objective: 'Investigate alpha',
              // 'and fix' asks for write capability, which a read-only parent must refuse.
              role: turn(request).prompt.includes('fix') ? 'general' : 'explore',
            },
          ]);
        return reply(toolResults(request));
      }
      if (!turn(request).afterTool) {
        childSawDelegation = request.tools.some((tool) => tool.name === 'delegate_task');
        return {
          text: 'Trying to delegate',
          finishReason: 'tool_calls',
          toolCalls: [
            {
              id: 'nested-1',
              name: 'delegate_task',
              arguments: { tasks: [{ objective: 'Nested work' }] },
            },
          ],
          usage: { inputTokens: 10, outputTokens: 5 },
        };
      }
      const refused = request.messages.find(
        (message) => message.role === 'tool' && message.toolCallId === 'nested-1',
      );
      return reply(
        refused?.content.includes('Unknown tool')
          ? 'No delegation at depth 1'
          : 'Nested delegation ran',
      );
    },
  };
  const { session, agent } = await fixture(t, provider);
  const result = await agent.run({ sessionId: session.id, prompt: 'Investigate' });
  assert.equal(childSawDelegation, false, 'the tool is not offered past the depth cap');
  assert.match(result.text, /No delegation at depth 1/);

  // A read-only run must not be able to buy write capability through a general sub-agent.
  const { session: planSession, agent: planAgent } = await fixture(t, provider);
  const refused = await planAgent.run({
    sessionId: planSession.id,
    prompt: 'Investigate and fix',
    readOnly: true,
  });
  assert.equal(refused.subagents, undefined, 'a refused call starts nothing at all');
  assert.match(refused.text, /read-only/);
  assert.equal(childSawDelegation, false, 'the refused task never started a child');
});

test('a run that has used its task allowance refuses the next delegation with a count', async () => {
  let spawned = 0;
  const providers = new SubAgentProviderRegistry();
  providers.register(
    inProcessProvider({
      capabilities: [...SUBAGENT_CAPABILITIES],
      run: async () => {
        spawned++;
        return {
          sessionId: 'child',
          status: 'completed',
          text: 'x',
          rounds: 1,
          toolCalls: 0,
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    }),
  );
  /**
   * The limit is a count of tasks, not a balance to spend: this run gets one, the second call is refused
   * before any child exists, and the refusal says which count it hit. A token floor used to decide this, and
   * it could refuse a delegation for reasons that had nothing to do with how much work was left.
   */
  const coordinator = new SubAgentCoordinator({
    options: resolveSubAgentOptions({ maxPerRun: 1 }),
    signal: new AbortController().signal,
    readOnly: false,
    emit: () => {},
    onUsage: () => {},
    providers,
    provider: 'in-process',
    parent: { sessionId: 'parent', workspace: '/tmp', depth: 0 },
  });
  const call = (objective: string) =>
    coordinator
      .tool()
      .execute(
        { tasks: [{ objective }] },
        { signal: new AbortController().signal, approve: async () => true },
      );
  const first = await call('Investigate alpha');
  assert.equal(first.isError, false);
  assert.equal(spawned, 1);
  const refused = await call('Investigate beta');
  assert.equal(refused.isError, true, 'the refusal is a tool result, not a thrown error');
  assert.match(refused.content, /already used its 1 sub-agent tasks/);
  assert.equal(spawned, 1, 'the refused call started nothing');
});

test('cancellation wins when a child returns completed while its coordinator is settling', async () => {
  const providers = new SubAgentProviderRegistry();
  providers.register(
    inProcessProvider({
      capabilities: [...SUBAGENT_CAPABILITIES],
      run: async ({ signal }) => {
        await new Promise<void>((resolve) =>
          signal.addEventListener('abort', () => resolve(), { once: true }),
        );
        return {
          sessionId: 'child',
          status: 'completed',
          text: 'Known report',
          rounds: 1,
          toolCalls: 0,
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    }),
  );
  const coordinator = new SubAgentCoordinator({
    options: resolveSubAgentOptions({}),
    signal: new AbortController().signal,
    readOnly: false,
    emit: () => {},
    onUsage: () => {},
    providers,
    provider: 'in-process',
    parent: { sessionId: 'parent', workspace: '/tmp', depth: 0 },
  });
  await coordinator
    .tool()
    .execute(
      { wait: false, tasks: [{ objective: 'Sweep' }] },
      { signal: new AbortController().signal, approve: async () => true },
    );
  await coordinator.settle();
  assert.equal(coordinator.summaries[0]!.status, 'cancelled');
  assert.match(coordinator.summaries[0]!.error!, /Cancelled/);
});

test('fan-out and per-run caps stop a run before it spends without limit', async (t) => {
  const provider: Provider = {
    async complete(request) {
      if (!isChild(request)) {
        const { prompt, afterTool } = turn(request);
        if (afterTool) return reply(toolResults(request));
        if (prompt.includes('too many')) return delegate(new Array(5).fill({ objective: 'Task' }));
        if (prompt.includes('over cap'))
          return {
            text: 'Delegating twice',
            finishReason: 'tool_calls',
            toolCalls: [
              {
                id: 'delegate-1',
                name: 'delegate_task',
                arguments: { tasks: [{ objective: 'A' }, { objective: 'B' }] },
              },
              {
                id: 'delegate-2',
                name: 'delegate_task',
                arguments: { tasks: [{ objective: 'C' }] },
              },
            ],
            usage: { inputTokens: 10, outputTokens: 5 },
          };
        return delegate([{ objective: 'Investigate alpha' }]);
      }
      return reply('child report');
    },
  };
  const { session, agent, events } = await fixture(t, provider, {
    subagents: { maxPerRun: 2 },
  });
  // Fan-out: the tool schema caps one call at four tasks, so five never reach the coordinator.
  const wide = await agent.run({ sessionId: session.id, prompt: 'too many' });
  assert.match(wide.text, /Invalid arguments/);
  // Per-run: two tasks then one more exceeds a cap of two, and the second call is refused whole.
  const capped = await agent.run({ sessionId: session.id, prompt: 'over cap' });
  assert.match(capped.text, /already used its 2 sub-agent tasks/);
  assert.equal(subagentEvents(events, 'subagent.started').length, 2);
  assert.equal(events.filter((event) => event.type === 'subagent.finished').length, 2);
});

test('cancelling the parent cancels its sub-agents and releases their sessions', async (t) => {
  const provider: Provider = {
    async complete(request) {
      if (!isChild(request)) {
        if (turn(request).afterTool) return reply('Done');
        return delegate([{ objective: 'Investigate alpha' }, { objective: 'Investigate beta' }]);
      }
      // A real provider rejects its request when the signal aborts; a child that ignored the signal
      // would hang the parent, so this fixture mirrors the contract.
      return new Promise<ModelResponse>((_resolve, reject) => {
        request.signal.addEventListener('abort', () => reject(new Error('aborted')), {
          once: true,
        });
      });
    },
  };
  const { store, session, agent } = await fixture(t, provider);
  const controller = new AbortController();
  const run = agent.run({
    sessionId: session.id,
    prompt: 'Investigate',
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 50);
  const result = await run;
  assert.equal(result.status, 'cancelled');
  assert.deepEqual(
    result.subagents?.map((entry) => entry.status),
    ['cancelled', 'cancelled'],
  );
  for (const child of store.childSessions(session.id))
    assert.equal(store.get(child.id).activeRun, null, 'a cancelled child must not stay locked');
});

test('a stalled sub-agent is reported as having made no progress, not as a hung run', async (t) => {
  const provider: Provider = {
    async complete(request) {
      if (!isChild(request)) {
        if (!turn(request).afterTool) return delegate([{ objective: 'Investigate alpha' }]);
        return reply(toolResults(request));
      }
      return new Promise<ModelResponse>((_resolve, reject) => {
        request.signal.addEventListener('abort', () => reject(new Error('aborted')), {
          once: true,
        });
      });
    },
  };
  const { session, agent } = await fixture(t, provider, { subagents: { timeoutMs: 60 } });
  const result = await agent.run({ sessionId: session.id, prompt: 'Investigate' });
  assert.equal(result.subagents?.[0]?.status, 'cancelled');
  assert.match(String(result.subagents?.[0]?.error), /made no progress/);
  assert.match(result.text, /made no progress/);
});

test('a child that works through tools without talking is not mistaken for a stalled one', async (t) => {
  /**
   * The expensive failure the comments already promised could not happen: the watchdog was re-armed by
   * `subagent.delta` alone, so a child that read files and ran commands without producing text — or answered
   * through a provider that does not stream — was stopped after the stall window and its finished work was
   * discarded. The `subagent.tool` frames carried the child's own id all along and were simply never consulted.
   *
   * Usage is reported as zero and no deltas are emitted, so the progress frames carry no token growth either:
   * the tool frames are the only signal under test. Each gap is well inside the window and their sum is not,
   * which is exactly the difference between bounding stall and bounding duration.
   */
  const provider: Provider = {
    async complete(request) {
      if (!isChild(request)) {
        if (!turn(request).afterTool) return delegate([{ objective: 'Investigate alpha' }]);
        return reply(toolResults(request));
      }
      if (!turn(request).afterTool) {
        await sleep(90);
        return {
          text: '',
          finishReason: 'tool_calls',
          toolCalls: [{ id: 'ls-1', name: 'list_files', arguments: { path: '.' } }],
          usage: { inputTokens: 0, outputTokens: 0 },
        };
      }
      await sleep(90);
      return { ...reply('read the listing'), usage: { inputTokens: 0, outputTokens: 0 } };
    },
  };
  const { session, agent } = await fixture(t, provider, { subagents: { timeoutMs: 150 } });
  const result = await agent.run({ sessionId: session.id, prompt: 'Investigate' });
  assert.equal(
    result.subagents?.[0]?.status,
    'completed',
    `child said: ${String(result.subagents?.[0]?.error)}`,
  );
  assert.match(result.text, /read the listing/);
});

test('a child whose answer is enormous reaches the parent cut, and says so', async (t) => {
  /**
   * The report path's bound, asserted rather than assumed.
   *
   * A dated comparison with another runtime claimed the parent receives an unbounded report — "fork input is capped
   * at 120k characters, the output is not". Reading the code, every path it can take is bounded: the rendered report
   * is `SUBAGENT_REPORT_CHARS` with a per-child share and a truncation notice, the live `subagent.finished` text is
   * cut at 4 000, the durable record carries the *structured* report (itself bounded by `REPORT_SCHEMA` and
   * `normalizeReport`) and no prose at all, and the settlement notice deliberately carries none either. So the claim
   * needs no code change, and the property is pinned here instead: it is exactly what would quietly stop being true
   * if the bound were removed, and the parent's context is what pays when it is.
   */
  const provider: Provider = {
    async complete(request) {
      if (!isChild(request)) {
        if (!turn(request).afterTool)
          return delegate([{ objective: 'Investigate alpha' }], 'd1', true);
        // The parent answers with what it was given, which is how the report reaches this assertion.
        return reply(toolResults(request));
      }
      return reply('x'.repeat(60_000));
    },
  };
  const { store, session, agent } = await fixture(t, provider);
  const result = await agent.run({ sessionId: session.id, prompt: 'Investigate' });
  assert.equal(result.subagents?.[0]?.status, 'completed');
  assert.match(result.text, /\[report truncated;/);
  assert.ok(
    result.text.length <= SUBAGENT_REPORT_CHARS,
    `the report the parent read stayed within its share (${result.text.length})`,
  );
  assert.ok(
    result.text.length > 10_000,
    'and it is the child answer under test, not an empty report',
  );
  // No durable copy of the prose either: the summary carries the structured report, and the child's own transcript
  // is where its prose lives.
  const finished = store.events(session.id).filter((event) => event.type === 'subagent.finished');
  assert.equal(finished.length, 1);
  assert.equal(finished[0]!.data.text, undefined);
});

test('a child that fails with an enormous message does not hand its whole error to the parent', async (t) => {
  /**
   * The other half of the report's bound, and the one the comparison's item was about: the durable
   * `subagent.finished` record cut this field at 600 characters while the tool result the *parent model* reads was
   * unbounded — so the one place the size actually costs something (a parent spending its own context) was the
   * one place nothing bounded it. The cut announces itself, because half an error read as the whole one is a
   * premise the parent cannot check.
   */
  const provider: Provider = {
    async complete(request) {
      if (!isChild(request)) {
        if (!turn(request).afterTool) return delegate([{ objective: 'Investigate alpha' }]);
        return reply(toolResults(request));
      }
      throw new RunFailure('server', 'E'.repeat(50_000));
    },
  };
  const { session, agent } = await fixture(t, provider);
  const result = await agent.run({ sessionId: session.id, prompt: 'Investigate' });
  assert.equal(result.subagents?.[0]?.status, 'failed');
  const error = result.subagents?.[0]?.error ?? '';
  assert.ok(
    error.length <= SUBAGENT_ERROR_CHARS,
    `the failure every reader sees is bounded (${error.length})`,
  );
  // Cut *and said to be cut*, inside the bound: a reader that takes half an error for the whole one reasons from
  // a premise it cannot check, and the durable record's own 600 is why the notice sits inside rather than after.
  assert.match(error, /…\[truncated\]$/);
  assert.match(result.text, /…\[truncated\]/);
  assert.ok(
    result.text.length < SUBAGENT_ERROR_CHARS + 1_000,
    `the parent read a bounded failure, not the endpoint's whole body (${result.text.length})`,
  );
  assert.ok(
    !result.text.includes('E'.repeat(SUBAGENT_ERROR_CHARS + 1)),
    'and none of the message beyond the bound reached it',
  );
});

test('a slow child finishes, because the default bounds silence rather than duration', async (t) => {
  // The default used to be a ten-minute stopwatch on every child. A child doing real work looks exactly like
  // this one — slow, but still moving — and a stopwatch cannot tell the two apart, so it discarded the work and
  // told the parent its child had "timed out".
  const provider: Provider = {
    async complete(request) {
      if (!isChild(request)) {
        if (!turn(request).afterTool) return delegate([{ objective: 'Investigate alpha' }]);
        return reply(toolResults(request));
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
      return reply('finished, slowly');
    },
  };
  // No `subagents.timeoutMs` at all: this is the shipped default, not a configured exemption.
  const { session, agent } = await fixture(t, provider);
  const result = await agent.run({ sessionId: session.id, prompt: 'Investigate' });
  assert.equal(result.subagents?.[0]?.status, 'completed');
  assert.equal(result.subagents?.[0]?.error, undefined);
  assert.match(result.text, /finished, slowly/);
});

test('a child that keeps producing frames outlives a watchdog window it never fits inside', async (t) => {
  // The property the idle watchdog exists for, and the one a deadline could not express: two frames 90ms apart
  // sit *outside* a 150ms window individually, but each one starts the window over, so the child is never
  // stopped. A child that does this for an hour is working; a child that stops doing it is wedged.
  const provider: Provider = {
    async complete(request) {
      if (!isChild(request)) {
        if (!turn(request).afterTool) return delegate([{ objective: 'Investigate alpha' }]);
        return reply(toolResults(request));
      }
      for (const piece of ['still ', 'working']) {
        await sleep(90);
        request.onText(piece);
      }
      return reply('done after repeated frames');
    },
  };
  const { session, agent } = await fixture(t, provider, { subagents: { timeoutMs: 150 } });
  const result = await agent.run({ sessionId: session.id, prompt: 'Investigate' });
  assert.equal(
    result.subagents?.[0]?.status,
    'completed',
    `child said: ${String(result.subagents?.[0]?.error)}`,
  );
  assert.equal(result.subagents?.[0]?.error, undefined);
  assert.match(result.text, /done after repeated frames/);
});

test('a child that never starts working is still stopped by the run that owns it', async (t) => {
  // The stop the watchdog must not remove. `settle()` ends an uncollected child at run end, and it is the reason
  // "no progress" is a bounded condition rather than an unbounded wait.
  const provider: Provider = {
    async complete(request) {
      if (!isChild(request)) {
        if (!turn(request).afterTool)
          return delegate([{ objective: 'Investigate alpha' }], 'delegate-1', false);
        return reply(toolResults(request));
      }
      return new Promise<ModelResponse>((_resolve, reject) => {
        request.signal.addEventListener('abort', () => reject(new Error('aborted')), {
          once: true,
        });
      });
    },
  };
  const { session, agent } = await fixture(t, provider);
  const result = await agent.run({ sessionId: session.id, prompt: 'Investigate' });
  assert.equal(result.subagents?.[0]?.status, 'cancelled');
  assert.match(String(result.subagents?.[0]?.error), /ended without collecting it/);
});

test('a write-capable sub-agent journals its files against the parent session', async (t) => {
  const provider: Provider = {
    async complete(request) {
      if (!isChild(request)) {
        if (!turn(request).afterTool)
          return delegate([{ objective: 'Create the file', role: 'general' }]);
        return reply(toolResults(request));
      }
      if (turn(request).afterTool) return reply('Created subagent.txt');
      return {
        text: 'Writing',
        finishReason: 'tool_calls',
        toolCalls: [
          {
            id: 'write-1',
            name: 'write_file',
            arguments: { path: 'subagent.txt', content: 'written by a sub-agent' },
          },
        ],
        usage: { inputTokens: 10, outputTokens: 5 },
      };
    },
  };
  const { root, store, session, agent } = await fixture(t, provider);
  const result = await agent.run({ sessionId: session.id, prompt: 'Create the file' });
  assert.equal(result.status, 'completed');
  assert.equal(await readFile(path.join(root, 'subagent.txt'), 'utf8'), 'written by a sub-agent');
  // Undo and the session change list stay one surface: the write belongs to the parent session.
  assert.deepEqual(
    store.fileChanges(session.id).map((entry) => [entry.change.path, entry.status]),
    [['subagent.txt', 'applied']],
  );
  const child = store.childSessions(session.id)[0]!;
  assert.deepEqual(store.fileChanges(child.id), []);
});

test('a sub-agent answers through a structured report, and the tool never leaks to the parent', async (t) => {
  let sawReportToolInParent = true;
  let childRounds = 0;
  const provider: Provider = {
    async complete(request) {
      if (!isChild(request)) {
        sawReportToolInParent = request.tools.some((tool) => tool.name === 'submit_report');
        if (!turn(request).afterTool) return delegate([{ objective: 'Investigate alpha' }]);
        return reply(toolResults(request));
      }
      childRounds++;
      assert.ok(
        request.tools.some((tool) => tool.name === 'submit_report'),
        'a delegated child must be offered the report tool',
      );
      if (childRounds === 1)
        return {
          text: 'Submitting',
          finishReason: 'tool_calls',
          toolCalls: [
            { id: 'report-1', name: 'submit_report', arguments: { summary: '', findings: [] } },
          ],
          usage: { inputTokens: 10, outputTokens: 5 },
        };
      // The empty report must have been refused, with the reason in the tool result.
      const refusal = request.messages.find(
        (message) => message.role === 'tool' && message.toolCallId === 'report-1',
      );
      assert.equal(refusal?.role === 'tool' ? refusal.isError : undefined, true);
      assert.match(refusal?.content ?? '', /summary|finding/);
      return {
        text: '',
        finishReason: 'tool_calls',
        toolCalls: [
          {
            id: 'report-2',
            name: 'submit_report',
            arguments: {
              summary: 'The loader lives in packages/core.',
              findings: [
                {
                  statement: 'Loader entry point is packages/core/agent.ts',
                  evidence: 'read_file returned the Agent class at line 96',
                  paths: ['packages/core/agent.ts'],
                },
              ],
              unverified: ['runtime behaviour under load'],
              blockers: ['no test run available'],
            },
          },
        ],
        usage: { inputTokens: 10, outputTokens: 5 },
      };
    },
  };
  const { store, session, agent, events } = await fixture(t, provider);
  const result = await agent.run({ sessionId: session.id, prompt: 'Investigate' });

  assert.equal(result.status, 'completed');
  assert.equal(sawReportToolInParent, false, 'the report tool belongs to the child run only');
  assert.equal(childRounds, 2, 'the run ended at the report instead of spending another round');
  const summary = result.subagents?.[0];
  assert.equal(summary?.status, 'completed');
  assert.deepEqual(summary?.report, {
    summary: 'The loader lives in packages/core.',
    findings: [
      {
        statement: 'Loader entry point is packages/core/agent.ts',
        evidence: 'read_file returned the Agent class at line 96',
        paths: ['packages/core/agent.ts'],
      },
    ],
    unverified: ['runtime behaviour under load'],
    blockers: ['no test run available'],
  });
  // The parent reads findings with their evidence, not a wall of prose, and the run stores the report.
  assert.match(result.text, /findings:/);
  assert.match(result.text, /evidence: read_file returned the Agent class/);
  assert.match(result.text, /unverified: runtime behaviour under load/);
  assert.deepEqual(store.subagents(session.id)[0]?.report, summary?.report);
  const finished = events.find((event) => event.type === 'subagent.finished')!;
  assert.deepEqual((finished.data.report as { summary: string }).summary, summary?.report?.summary);
  // The child's own transcript records the tool call, which is where a reader goes for the raw text.
  assert.match(store.messages(summary!.sessionId)[0]!.content as string, /Delegated task/);
});

test('an explore child cannot reach tools that manage its parent resources', async (t) => {
  let childTools: string[] = [];
  let refusal = '';
  const provider: Provider = {
    async complete(request) {
      if (!isChild(request)) {
        if (!turn(request).afterTool) return delegate([{ objective: 'Investigate alpha' }]);
        return reply(toolResults(request));
      }
      if (!turn(request).afterTool) {
        childTools = request.tools.map((tool) => tool.name);
        return {
          text: 'Trying to stop a job',
          finishReason: 'tool_calls',
          toolCalls: [{ id: 'stop-1', name: 'job_kill', arguments: { id: 'job' } }],
          usage: { inputTokens: 10, outputTokens: 5 },
        };
      }
      const result = request.messages.find(
        (message) => message.role === 'tool' && message.toolCallId === 'stop-1',
      );
      refusal = result?.content ?? '';
      return reply('Reported');
    },
  };
  const { tools, session, agent } = await fixture(t, provider);
  await agent.run({ sessionId: session.id, prompt: 'Investigate' });

  // The allowlist is enforced, not advertised: the tool is absent from the schema *and* unreachable — and the
  // refusal says which of the two reasons it was, because "you may not use this" and "there is no such tool" send
  // a model to different places.
  assert.equal(childTools.includes('job_kill'), false);
  assert.match(refusal, /"job_kill" is not available in this run/);
  assert.match(refusal, /excluded by a restriction/);
  // Every allowlisted name must exist and be permission-free, or the list has rotted.
  const readOnlyNames = tools.specs({ readOnly: true }).map((tool) => tool.name);
  const registered = new Set(tools.specs().map((tool) => tool.name));
  for (const name of EXPLORE_TOOLS) {
    assert.ok(registered.has(name), `explore allowlist names an unknown tool: ${name}`);
    assert.ok(readOnlyNames.includes(name), `${name} must be readable without a permission`);
  }
  // The trimming has to be real: the allowlist is smaller than what read-only already left.
  assert.ok(EXPLORE_TOOLS.length < readOnlyNames.length);
  // A write-capable child keeps the broader surface, since its job is to act.
  const { session: generalSession, agent: generalAgent } = await fixture(t, {
    async complete(request) {
      if (!isChild(request)) {
        if (!turn(request).afterTool)
          return delegate([{ objective: 'Write the file', role: 'general' }]);
        return reply(toolResults(request));
      }
      childTools = request.tools.map((tool) => tool.name);
      return reply('child report');
    },
  });
  await generalAgent.run({ sessionId: generalSession.id, prompt: 'Write the file' });
  assert.ok(childTools.includes('write_file'), 'a general child must still be able to write');
});

test('wait:false returns at once, and the parent keeps taking rounds while the child works', async (t) => {
  let childFinished = false;
  let releaseChild!: () => void;
  const childReleased = new Promise<void>((resolve) => {
    releaseChild = resolve;
  });
  let parentTurn = 0;
  const provider: Provider = {
    async complete(request) {
      if (isChild(request)) {
        await childReleased;
        childFinished = true;
        return reply('alpha report');
      }
      if (!turn(request).afterTool)
        return delegate([{ objective: 'Investigate alpha' }], 'd1', false);
      parentTurn++;
      if (parentTurn === 1) {
        // The whole point of this batch: the parent gets a round back while the child is still working.
        assert.equal(childFinished, false, 'the child must still be working here');
        return collect('c1');
      }
      if (parentTurn === 2) {
        releaseChild();
        await sleep(30);
        return collect('c2');
      }
      return reply(toolResults(request));
    },
  };
  const { store, session, agent, events } = await fixture(t, provider, {
    // This case is about the instantaneous state while a child runs, so it opts out of the collect wait
    // window that the cases below exercise.
    subagents: { collectWaitMs: 0 },
  });
  const result = await agent.run({
    sessionId: session.id,
    prompt: 'Investigate in the background',
  });

  assert.equal(result.status, 'completed');
  const finishes = events.filter((event) => event.type === 'tool.finished');
  // The started notice names the task and tells the parent how to get the report, and the parent really
  // did get two more rounds before the child finished.
  assert.match(String(finishes[0]!.data.content), /Started 1 sub-agent task\(s\)/);
  assert.match(String(finishes[0]!.data.content), /collect_subagents/);
  assert.match(String(finishes[1]!.data.content), /Still running/);
  assert.match(String(finishes[2]!.data.content), /alpha report/);
  assert.equal(childFinished, true);
  assert.match(result.text, /alpha report/);
  // One summary for the whole run, whatever mode it was started in.
  assert.deepEqual(
    result.subagents?.map((entry) => [entry.role, entry.status]),
    [['explore', 'completed']],
  );
  assert.equal(store.childSessions(session.id).length, 1);
});

test('a collected report is not delivered twice, and collecting nothing says so', async (t) => {
  const collects: string[] = [];
  let releaseChild!: () => void;
  const childReleased = new Promise<void>((resolve) => {
    releaseChild = resolve;
  });
  const provider: Provider = {
    async complete(request) {
      if (isChild(request)) {
        await childReleased;
        return reply('alpha report');
      }
      const seen = turn(request).afterTool ? toolResults(request) : '';
      if (!seen) return delegate([{ objective: 'Investigate alpha' }], 'd1', false);
      if (collects.length === 0) {
        releaseChild();
        await sleep(30);
      }
      collects.push(seen);
      if (collects.length === 3) return reply('Done');
      return collect(`c${collects.length}`);
    },
  };
  const { agent, session, events } = await fixture(t, provider);
  const result = await agent.run({ sessionId: session.id, prompt: 'Investigate' });
  assert.equal(result.status, 'completed');
  // Read the collect results themselves: `toolResults` accumulates the whole transcript, so it would
  // report the earlier report again on every later round no matter how collection behaved.
  const finished = events.filter((event) => event.type === 'tool.finished');
  assert.equal(finished.length, 3);
  assert.match(String(finished[1]!.data.content), /alpha report/);
  // The report appears in exactly one collect result, so a polling parent cannot grow its context by
  // re-reading the same findings.
  assert.doesNotMatch(String(finished[2]!.data.content), /alpha report/);
  assert.match(String(finished[2]!.data.content), /No outstanding sub-agents/);
});

test('a steer is consumed while a background child is still running', async (t) => {
  let childFinished = false;
  let released = false;
  let releaseChild!: () => void;
  const childReleased = new Promise<void>((resolve) => {
    releaseChild = resolve;
  });
  let steerEnqueued = false;
  const provider: Provider = {
    async complete(request) {
      if (isChild(request)) {
        await childReleased;
        childFinished = true;
        return reply('alpha report');
      }
      const { afterTool } = turn(request);
      if (!afterTool) return delegate([{ objective: 'Investigate alpha' }], 'd1', false);
      if (!steerEnqueued) {
        // What the user does while a fan-out runs: correct the course. Before this batch the parent was
        // parked inside one tool call, so the correction could not be read until the fan-out returned.
        steerEnqueued = true;
        agent.enqueue(session.id, { prompt: 'Also check the tests' }, 'steer');
        assert.equal(childFinished, false);
        return collect('c1');
      }
      // The steer is consumed at this round boundary while the child is still working. The run may reach
      // this branch more than once, so the check happens on the first visit only.
      if (!released) {
        assert.equal(
          childFinished,
          false,
          'the child must still be running when the steer arrives',
        );
        assert.ok(
          JSON.stringify(request.messages).includes('Also check the tests'),
          'the steer must reach the model before the child finishes',
        );
        released = true;
        releaseChild();
        await sleep(30);
        return collect('c2');
      }
      return reply('Corrected');
    },
  };
  const { agent, session } = await fixture(t, provider);
  const result = await agent.run({ sessionId: session.id, prompt: 'Investigate' });
  assert.equal(result.status, 'completed', result.error);
  assert.equal(result.text, 'Corrected');
});

test('a background child that is never collected is cancelled when its run ends', async (t) => {
  let aborted = false;
  let childStarted!: () => void;
  const childStartedPromise = new Promise<void>((resolve) => {
    childStarted = resolve;
  });
  const provider: Provider = {
    async complete(request) {
      if (isChild(request)) {
        // A real provider rejects its request when the signal aborts; this one records that it did.
        return new Promise<ModelResponse>((_resolve, reject) => {
          childStarted();
          request.signal.addEventListener(
            'abort',
            () => {
              aborted = true;
              reject(new Error('aborted'));
            },
            { once: true },
          );
        });
      }
      if (!turn(request).afterTool)
        return delegate([{ objective: 'Investigate alpha' }], 'd1', false);
      // The child is definitely inside its request before the parent decides to answer without it.
      await childStartedPromise;
      return reply('Answered without collecting');
    },
  };
  const { store, session, agent } = await fixture(t, provider);
  const result = await agent.run({ sessionId: session.id, prompt: 'Investigate' });

  assert.equal(result.status, 'completed');
  assert.equal(aborted, true, 'the run must cancel a child it did not collect');
  assert.deepEqual(
    result.subagents?.map((entry) => [entry.status, entry.error]),
    [['cancelled', 'Cancelled: the run that started this sub-agent ended without collecting it']],
  );
  // Nothing may be left running behind a finished run: no run row, no session lock.
  for (const child of store.childSessions(session.id))
    assert.equal(store.get(child.id).activeRun, null);
});

test('background and blocking delegation share one concurrency cap and one per-run count', async (t) => {
  let inFlight = 0,
    peak = 0;
  let blocked = false;
  const provider: Provider = {
    async complete(request) {
      if (isChild(request)) {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await sleep(40);
        inFlight--;
        return reply('child report');
      }
      if (!turn(request).afterTool)
        return delegate(
          [{ objective: 'Background A' }, { objective: 'Background B' }],
          'd1',
          false,
        );
      // Then a blocking task while the background pair is still queued or running: the cap counts all
      // of them together, so this one must wait its turn rather than start alongside them.
      if (!blocked) {
        blocked = true;
        return delegate([{ objective: 'Blocking C' }], 'd2', true);
      }
      return reply(toolResults(request));
    },
  };
  const { agent, session, events } = await fixture(t, provider, {
    subagents: { maxConcurrency: 1, maxPerRun: 3 },
  });
  const result = await agent.run({ sessionId: session.id, prompt: 'Investigate' });
  assert.equal(result.status, 'completed');
  assert.equal(peak, 1, 'the cap counts background and blocking children together');
  assert.equal(result.subagents?.length, 3);
  assert.equal(events.filter((event) => event.type === 'subagent.started').length, 3);
});

test('collect waits for a running child instead of making the model poll', async (t) => {
  let toolRounds = 0;
  const provider: Provider = {
    async complete(request) {
      if (isChild(request)) {
        // The child needs longer than a model round, which is exactly the case the wait window exists
        // for: without it the parent would have to poll and, as the live run showed, invent filler work.
        await sleep(120);
        return reply('alpha report');
      }
      if (!turn(request).afterTool)
        return delegate([{ objective: 'Investigate alpha' }], 'd1', false);
      toolRounds++;
      // Exactly one collect is issued; it waits for the child rather than returning "still running".
      if (toolRounds === 1)
        return {
          text: 'Collecting',
          finishReason: 'tool_calls',
          toolCalls: [{ id: 'c1', name: 'collect_subagents', arguments: { waitMs: 800 } }],
          usage: { inputTokens: 10, outputTokens: 5 },
        };
      return reply(toolResults(request));
    },
  };
  const { agent, session, events } = await fixture(t, provider);
  const started = performance.now();
  const result = await agent.run({
    sessionId: session.id,
    prompt: 'Investigate in the background',
  });
  const elapsed = performance.now() - started;

  assert.equal(result.status, 'completed');
  assert.equal(toolRounds, 2, 'one delegate round plus one collect round');
  const finished = events.filter((event) => event.type === 'tool.finished');
  assert.equal(finished.length, 2, 'delegate plus a single collect');
  assert.match(String(finished[1]!.data.content), /alpha report/);
  assert.doesNotMatch(String(finished[1]!.data.content), /Still running/);
  assert.ok(
    elapsed >= 100,
    `the collect must have waited for the child (elapsed ${Math.round(elapsed)}ms)`,
  );
});

test('the collect wait is bounded, and reports what is still running', async (t) => {
  let collecting = false;
  const provider: Provider = {
    async complete(request) {
      // Still running for the whole window, but it honours cancellation so the run can end: a provider
      // that ignored its signal would hang finalisation, which is a fixture bug, not a behaviour to test.
      if (isChild(request))
        return new Promise<ModelResponse>((_resolve, reject) =>
          request.signal.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          }),
        );
      if (!turn(request).afterTool)
        return delegate([{ objective: 'Investigate alpha' }], 'd1', false);
      if (!collecting) {
        collecting = true;
        return {
          text: 'Collecting',
          finishReason: 'tool_calls',
          toolCalls: [{ id: 'c1', name: 'collect_subagents', arguments: { waitMs: 150 } }],
          usage: { inputTokens: 10, outputTokens: 5 },
        };
      }
      return reply(toolResults(request));
    },
  };
  const { agent, session, events } = await fixture(t, provider, {
    subagents: { collectWaitMs: 150 },
  });
  const started = performance.now();
  const result = await agent.run({
    sessionId: session.id,
    prompt: 'Investigate in the background',
  });
  const elapsed = performance.now() - started;
  assert.equal(result.status, 'completed');
  const finished = events.filter((event) => event.type === 'tool.finished');
  assert.match(String(finished[1]!.data.content), /Still running after waiting 150 ms \(1\)/);
  assert.ok(elapsed < 5_000, `the wait must be bounded (elapsed ${Math.round(elapsed)}ms)`);
});

test('cancelling the run interrupts a long collect wait instead of being swallowed by it', async (t) => {
  let collecting = false;
  let childReached = 0;
  const provider: Provider = {
    async complete(request) {
      if (isChild(request)) {
        childReached++;
        return new Promise<ModelResponse>((_resolve, reject) =>
          request.signal.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          }),
        );
      }
      if (!turn(request).afterTool)
        return delegate([{ objective: 'Investigate alpha' }], 'd1', false);
      if (!collecting) {
        collecting = true;
        return {
          text: 'Collecting',
          finishReason: 'tool_calls',
          toolCalls: [{ id: 'c1', name: 'collect_subagents', arguments: { waitMs: 30_000 } }],
          usage: { inputTokens: 10, outputTokens: 5 },
        };
      }
      return reply(toolResults(request));
    },
  };
  const { agent, session } = await fixture(t, provider);
  const controller = new AbortController();
  const started = performance.now();
  const run = agent.run({
    sessionId: session.id,
    prompt: 'Investigate in the background',
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 200);
  const result = await run;
  const elapsed = performance.now() - started;
  assert.equal(result.status, 'cancelled');
  assert.equal(childReached, 1);
  // A 30 s window that ignored cancellation would be a worse bug than the polling it replaces.
  assert.ok(
    elapsed < 5_000,
    `Stop must not wait out the window (elapsed ${Math.round(elapsed)}ms)`,
  );
  assert.deepEqual(
    result.subagents?.map((entry) => entry.status),
    ['cancelled'],
  );
});

test('a correction ends a long collect wait instead of being held behind it', async (t) => {
  let collecting = false;
  let steered = false;
  const provider: Provider = {
    async complete(request) {
      // Still running for the whole window, but it honours cancellation so the run can finalise.
      if (isChild(request))
        return new Promise<ModelResponse>((_resolve, reject) =>
          request.signal.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          }),
        );
      if (!turn(request).afterTool)
        return delegate([{ objective: 'Investigate alpha' }], 'd1', false);
      if (!collecting) {
        collecting = true;
        // A 120 s window: without the steer yield this test would take two minutes.
        return {
          text: 'Collecting',
          finishReason: 'tool_calls',
          toolCalls: [{ id: 'c1', name: 'collect_subagents', arguments: { waitMs: 120_000 } }],
          usage: { inputTokens: 10, outputTokens: 5 },
        };
      }
      steered = JSON.stringify(request.messages).includes('Change of plan');
      return reply(toolResults(request));
    },
  };
  const { agent, session } = await fixture(t, provider);
  const started = performance.now();
  const run = agent.run({ sessionId: session.id, prompt: 'Investigate in the background' });
  // The user corrects the course while the parent is parked in the collect window.
  setTimeout(() => agent.enqueue(session.id, { prompt: 'Change of plan' }, 'steer'), 200);
  const result = await run;
  const elapsed = performance.now() - started;

  assert.equal(result.status, 'completed');
  assert.equal(steered, true, 'the correction must reach the model');
  assert.ok(
    elapsed < 3_000,
    `the correction must end the wait, not queue behind it (elapsed ${Math.round(elapsed)}ms)`,
  );
});

test('an over-ceiling collect wait is refused rather than silently truncated', async (t) => {
  let asked = false;
  const provider: Provider = {
    async complete(request) {
      if (isChild(request)) return reply('child report');
      if (!turn(request).afterTool)
        return delegate([{ objective: 'Investigate alpha' }], 'd1', false);
      if (!asked) {
        asked = true;
        return {
          text: 'Collecting',
          finishReason: 'tool_calls',
          toolCalls: [{ id: 'c1', name: 'collect_subagents', arguments: { waitMs: 600_000 } }],
          usage: { inputTokens: 10, outputTokens: 5 },
        };
      }
      return reply(toolResults(request));
    },
  };
  const { agent, session, events } = await fixture(t, provider);
  const result = await agent.run({ sessionId: session.id, prompt: 'Investigate' });
  assert.equal(result.status, 'completed');
  const finished = events.filter((event) => event.type === 'tool.finished');
  assert.match(String(finished[1]!.data.content), /Invalid arguments/);
});

test('a correction ends a blocking fan-out wait without losing the work', async (t) => {
  let rounds = 0;
  let steered = false;
  let childFinished = false;
  /** True when the correction was read while the child was still working. */
  let readWhileRunning = false;
  const provider: Provider = {
    async complete(request) {
      if (isChild(request)) {
        // Slow enough that the correction is certainly noticed first (the coordinator polls every 250 ms),
        // quick enough to still be collected afterwards.
        await sleep(2000);
        childFinished = true;
        return submitReport('r-child', 'child ran', 'child finished', 'the fixture returned');
      }
      // Routed by round, not by "the last message is a tool result": the steer is appended as the last
      // message, which would otherwise look like the start of a new run.
      rounds++;
      if (rounds === 1) return delegate([{ objective: 'Investigate alpha' }], 'd1', true);
      if (rounds === 2) {
        // The blocking wait was interrupted, so this round is where the correction is read — and it
        // happens while the child is still working, which is the point of yielding.
        steered = JSON.stringify(request.messages).includes('Change of plan');
        readWhileRunning = !childFinished;
        return collect('c1');
      }
      return reply(toolResults(request));
    },
  };
  const { agent, session, events } = await fixture(t, provider);
  const run = agent.run({ sessionId: session.id, prompt: 'Investigate thoroughly' });
  setTimeout(() => agent.enqueue(session.id, { prompt: 'Change of plan' }, 'steer'), 200);
  const result = await run;

  assert.equal(result.status, 'completed');
  const finished = events.filter((event) => event.type === 'tool.finished');
  // The blocking call degraded to "started" instead of parking until the child finished. This is the
  // structural proof of the yield: had the wait run to completion, this result would hold the report.
  assert.match(String(finished[0]!.data.content), /Stopped waiting for 1 sub-agent task\(s\)/);
  assert.match(String(finished[0]!.data.content), /collect_subagents/);
  assert.equal(steered, true, 'the correction must be read on the next round');
  assert.equal(readWhileRunning, true, 'the correction must be read before the child finishes');
  // The work was not thrown away: the collect that follows still gets the report, and the child — which
  // the 5 s collect window waited for — completed rather than being cancelled.
  assert.match(String(finished[1]!.data.content), /child ran/);
  assert.deepEqual(
    result.subagents?.map((entry) => entry.status),
    ['completed'],
  );
});

test('nesting: a child can delegate further when the depth cap allows it', async (t) => {
  const seen: string[] = [];
  let nestedTools: string[] = [];
  const provider: Provider = {
    async complete(request) {
      const { prompt, afterTool } = turn(request);
      if (!isChild(request)) {
        seen.push('root');
        if (!afterTool) return delegate([{ objective: 'Root investigation' }], 'd-root', true);
        return reply(toolResults(request));
      }
      if (prompt.includes('Root investigation')) {
        seen.push('depth-1');
        if (!afterTool) return delegate([{ objective: 'Nested investigation' }], 'd-nested', true);
        // Its own child's report arrived; the depth-1 child still answers through submit_report.
        assert.match(toolResults(request), /nested report/);
        return submitReport(
          'r-1',
          'Nested work done',
          'depth 1 could delegate',
          'delegate_task ran',
        );
      }
      seen.push('depth-2');
      nestedTools = request.tools.map((tool) => tool.name);
      return submitReport('r-2', 'nested report', 'depth 2 answered', 'no delegation offered');
    },
  };
  const { store, session, agent, events } = await fixture(t, provider, {
    subagents: { maxDepth: 2 },
  });
  const result = await agent.run({ sessionId: session.id, prompt: 'Investigate the whole thing' });

  assert.equal(result.status, 'completed');
  // Every level ran, in order. Each level takes two rounds (delegate, then answer), so this checks the
  // order of first appearance rather than the raw call sequence.
  assert.deepEqual([...new Set(seen)], ['root', 'depth-1', 'depth-2'], 'all three levels ran');
  // The cap still applies one level down: the deepest child is not offered the tool at all.
  assert.equal(nestedTools.includes('delegate_task'), false);
  assert.equal(nestedTools.includes('collect_subagents'), false);
  assert.equal(nestedTools.includes('submit_report'), true);

  // Lineage: root -> child -> grandchild, all hidden from the session list.
  const children = store.childSessions(session.id);
  assert.equal(children.length, 1);
  const grandchildren = store.childSessions(children[0]!.id);
  assert.equal(grandchildren.length, 1);
  assert.equal(grandchildren[0]!.parentSessionId, children[0]!.id);
  assert.deepEqual(
    store.list('').map((entry) => entry.id),
    [session.id],
  );

  // The root only sees its own child's report; the nested report stays one level down, in the middle
  // child's transcript (which is where its own delegate_task result lives).
  assert.equal(result.subagents?.length, 1);
  assert.equal(result.subagents?.[0]?.report?.summary, 'Nested work done');
  assert.match(
    store
      .messages(result.subagents![0]!.sessionId)
      .map((message) => message.content)
      .join('\n'),
    /nested report/,
  );
  // Usage chains: the root's totals include the grandchild's tokens.
  assert.ok(
    result.usage.inputTokens > (result.subagents?.[0]?.usage.inputTokens ?? 0),
    'child usage is charged upward through every level',
  );
  // The root's stream reports exactly one child: the grandchild is the middle child's own delegation, not
  // a sibling of it. What the root does see is that child running `delegate_task` itself, which keeps
  // nesting visible without pretending the grandchild is a sibling of the first level.
  assert.equal(events.filter((event) => event.type === 'subagent.started').length, 1);
  assert.ok(
    events.some((event) => event.type === 'subagent.tool' && event.data.name === 'delegate_task'),
    'the child delegating is visible on the parent stream',
  );

  // Deleting the root removes the whole chain, not just the first level.
  store.delete(session.id);
  assert.throws(() => store.get(children[0]!.id), /Session not found/);
  assert.throws(() => store.get(grandchildren[0]!.id), /Session not found/);
});

test('a child run left behind by a crashed Host is converged instead of staying running', async (t) => {
  const provider: Provider = {
    async complete(request) {
      if (!isChild(request)) {
        if (!turn(request).afterTool) return delegate([{ objective: 'Investigate alpha' }]);
        return reply(toolResults(request));
      }
      return reply('child report');
    },
  };
  const { root, store, session, agent } = await fixture(t, provider);
  await agent.run({ sessionId: session.id, prompt: 'Investigate' });
  const child = store.childSessions(session.id)[0]!;
  // Simulate a Host dying mid-delegation: a `running` run row owned by a dead process. The public API
  // never leaves this state, so the fixture writes it directly, as the task-recovery test does.
  const db = new DatabaseSync(path.join(root, 'sessions.sqlite'));
  db.prepare(
    "INSERT INTO runs(id,session_id,owner_pid,status,started_at) VALUES(?,?,?,'running',?)",
  ).run('crashed-run', child.id, 2147483647, new Date().toISOString());
  db.prepare('UPDATE sessions SET active_run=? WHERE id=?').run('crashed-run', child.id);
  db.close();
  assert.equal(store.get(child.id).activeRun, 'crashed-run');

  assert.equal(store.reconcileChildRuns(root), 1);
  assert.equal(store.get(child.id).activeRun, null);
  const check = new DatabaseSync(path.join(root, 'sessions.sqlite'));
  assert.equal(
    check.prepare('SELECT status FROM runs WHERE id=?').get('crashed-run')?.status,
    'interrupted',
  );
  check.close();

  // A live owner is left alone: nothing may converge a run that is still working.
  const live = store.beginRun(child.id);
  assert.equal(store.reconcileChildRuns(root), 0);
  assert.equal(store.get(child.id).activeRun, live);
  const parentRun = store.beginRun(session.id);
  assert.equal(store.reconcileChildRuns(root), 0);
  assert.equal(store.get(session.id).activeRun, parentRun);
  // The two passes do not overlap: a delegated child belongs to this one, which is also what records the
  // interruption on the parent's log. Ordinary and forked sessions belong to `reconcileInterruptedRuns`.
  assert.equal(store.reconcileInterruptedRuns(root), 0);
});

test('crashed child remains reviewable with its transcript and unknown tool outcome', async (t) => {
  const { root, store, session } = await fixture(t, { complete: async () => reply() });
  const child = store.create(root, session.id);
  // What the provider records when it starts a child: the assignment is a durable fact about the *parent*,
  // so a reader of the parent's log never has to reach into the child's session to know it existed.
  store.recordEvent(session.id, 'subagent.assigned', {
    id: 'recover-1',
    role: 'general',
    objective: 'Inspect the project',
    childSessionId: child.id,
  });
  store.append(child.id, {
    role: 'assistant',
    content: '',
    toolCalls: [{ id: 'write-1', name: 'run_command', arguments: { command: 'echo test' } }],
  });
  const db = new DatabaseSync(path.join(root, 'sessions.sqlite'));
  db.prepare(
    "INSERT INTO runs(id,session_id,owner_pid,status,started_at) VALUES(?,?,?,'running',?)",
  ).run('crashed-child', child.id, 2147483647, new Date().toISOString());
  db.prepare('UPDATE sessions SET active_run=? WHERE id=?').run('crashed-child', child.id);
  db.close();

  assert.equal(store.reconcileChildRuns(root), 1);
  assert.match(String(store.messages(child.id).at(-1)?.content), /Execution outcome is unknown/);
  assert.deepEqual(
    store.subagents(session.id).map((item) => ({
      id: item.id,
      sessionId: item.sessionId,
      status: item.status,
      error: item.error,
    })),
    [
      {
        id: 'recover-1',
        sessionId: child.id,
        status: 'interrupted',
        error: 'Interrupted; inspect the child transcript and current state before retrying.',
      },
    ],
  );
  assert.equal(store.reconcileChildRuns(root), 0);
  assert.equal(store.messages(child.id).length, 2);
});
test('delegation can be switched off, and a child session is deleted with its parent', async (t) => {
  const provider: Provider = {
    async complete(request) {
      if (!isChild(request)) {
        if (!turn(request).afterTool) return delegate([{ objective: 'Investigate alpha' }]);
        return reply(toolResults(request));
      }
      return reply('child report');
    },
  };
  const { session, agent } = await fixture(t, provider, { subagents: { enabled: false } });
  const result = await agent.run({ sessionId: session.id, prompt: 'Investigate' });
  assert.match(result.text, /Unknown tool: delegate_task/);
  assert.equal(result.subagents, undefined);

  const { store: store2, session: session2, agent: agent2 } = await fixture(t, provider);
  await agent2.run({ sessionId: session2.id, prompt: 'Investigate' });
  const child = store2.childSessions(session2.id)[0]!;
  await writeFile(path.join(child.workspace, 'note.txt'), 'x');
  // A session fork points at its source with the same `parent_session_id` column, so it must not be
  // mistaken for a delegated child: it stays in the session list and survives deleting its source.
  const forkDb = new DatabaseSync(path.join(child.workspace, 'sessions.sqlite'));
  forkDb
    .prepare(
      'INSERT INTO sessions(id,workspace,created_at,parent_session_id,fork_message_count) VALUES(?,?,?,?,?)',
    )
    .run('forked', child.workspace, new Date().toISOString(), session2.id, 3);
  forkDb.close();
  assert.ok(store2.list('').some((listed) => listed.id === 'forked'));
  store2.delete(session2.id);
  assert.throws(() => store2.get(child.id), /Session not found/);
  assert.equal(store2.get('forked').id, 'forked');
  assert.deepEqual(
    store2.list('').map((listed) => listed.id),
    ['forked'],
  );
});

test('delegate_task rejects malformed task lists before any child starts', async (t) => {
  const provider: Provider = {
    async complete(request) {
      if (isChild(request)) throw new Error('no child should start');
      const { prompt, afterTool } = turn(request);
      if (afterTool) return reply(toolResults(request));
      const tasks: unknown[] = prompt.includes('empty')
        ? []
        : prompt.includes('role')
          ? [{ objective: 'Task', role: 'admin' }]
          : [{ objective: '   ' }];
      return delegate(tasks);
    },
  };
  const { session, agent } = await fixture(t, provider);
  const empty = await agent.run({ sessionId: session.id, prompt: 'empty' });
  assert.match(empty.text, /at least one task|Invalid arguments/);
  const role = await agent.run({ sessionId: session.id, prompt: 'role' });
  assert.match(role.text, /role must be explore or general|Invalid arguments/);
  const blank = await agent.run({ sessionId: session.id, prompt: 'blank' });
  assert.match(blank.text, /non-empty objective|Invalid arguments/);
  assert.equal(blank.subagents, undefined);
});
