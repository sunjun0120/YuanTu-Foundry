import test from 'node:test';
import assert from 'node:assert/strict';
import { Agent } from '../packages/core/agent.ts';
import { SubAgentResidency } from '../packages/core/subagents/residency.ts';
import { createResidentMessageTool } from '../packages/core/run/residency.ts';
import { ToolRegistry } from '../packages/tools/registry.ts';
import type { ModelResponse, Provider, Usage } from '../packages/protocol/index.ts';
import { storeFixture } from './temp-fixture.ts';
import { until } from './wait-fixture.ts';

async function fixture(t: test.TestContext) {
  const { root, store, cleanup } = await storeFixture(t, 'yuantu-child-usage-');
  const residency = new SubAgentResidency();
  cleanup(() => residency.disposeAll());
  const session = store.create(root);
  const measured: Usage = {
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
  };
  function response(
    child: boolean,
    name?: string,
    args: Record<string, unknown> = {},
  ): ModelResponse {
    const usage = {
      inputTokens: child ? 1000 : 10,
      outputTokens: child ? 20 : 2,
      cachedInputTokens: child ? 100 : 1,
      cacheWriteInputTokens: child ? 50 : 3,
    };
    measured.inputTokens += usage.inputTokens;
    measured.outputTokens += usage.outputTokens;
    measured.cachedInputTokens! += usage.cachedInputTokens;
    measured.cacheWriteInputTokens! += usage.cacheWriteInputTokens;
    return {
      text: name ? '' : 'done',
      finishReason: name ? 'tool_calls' : 'stop',
      usage,
      toolCalls: name ? [{ id: `call-${measured.inputTokens}`, name, arguments: args }] : [],
    };
  }
  const check = (result: Awaited<ReturnType<Agent['run']>>, finishes: number) => {
    assert.equal(result.status, 'completed', result.error);
    assert.deepEqual(result.usage, measured, 'each provider response reaches raw usage once');
    for (const key of [
      'inputTokens',
      'outputTokens',
      'cachedInputTokens',
      'cacheWriteInputTokens',
    ] as const)
      assert.equal(result.statistics?.[key], measured[key], `${key} reaches statistics once`);
    assert.equal(store.statistics(session.id).inputTokens, measured.inputTokens);
    assert.equal(
      store.events(session.id).filter((event) => event.type === 'subagent.finished').length,
      finishes,
    );
  };
  return { root, store, residency, session, response, check };
}

for (const wait of [true, false]) {
  test(`a correction observing an existing child turn does not count it twice (wait=${wait})`, async (t) => {
    const f = await fixture(t);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    t.after(() => release());
    let parentRound = 0,
      childRequests = 0;
    const provider: Provider = {
      async complete(request) {
        const child = request.system.includes('You are a sub-agent delegated by a parent agent');
        if (child) {
          childRequests++;
          if (childRequests === 1) {
            await gate;
            return f.response(true, 'submit_report', {
              summary: 'checked',
              findings: [{ statement: 'checked', evidence: 'fixture' }],
            });
          }
          return f.response(true);
        }
        parentRound++;
        if (parentRound === 1)
          return f.response(false, 'delegate_task', {
            tasks: [{ objective: 'Check the fixture' }],
            wait: false,
          });
        if (parentRound === 2)
          return f.response(false, 'send_message', {
            childSessionId: f.residency.list()[0]!.childSessionId,
            message: 'Also check this',
            wait,
          });
        await until(() => f.residency.list()[0]?.status === 'idle');
        return f.response(false);
      },
    };
    const running = new Agent({
      ...f,
      provider,
      tools: new ToolRegistry(),
      approve: async () => true,
      subagents: { enabled: true },
      subagentResidency: f.residency,
      childTools: () => new ToolRegistry(),
    }).run({ sessionId: f.session.id, prompt: 'Delegate, then correct' });
    await until(() =>
      f.store.events(f.session.id).some((event) => event.type === 'subagent.message.handed'),
    );
    release();
    f.check(await running, 1);
  });

  test(`a new resident follow-up reaches raw usage and statistics (wait=${wait})`, async (t) => {
    const f = await fixture(t);
    let parentRound = 0,
      childRequests = 0;
    const provider: Provider = {
      async complete(request) {
        const child = request.system.includes('You are a sub-agent delegated by a parent agent');
        if (child) {
          childRequests++;
          return childRequests === 1
            ? f.response(true, 'submit_report', {
                summary: 'checked',
                findings: [{ statement: 'checked', evidence: 'fixture' }],
              })
            : f.response(true);
        }
        parentRound++;
        if (parentRound === 1)
          return f.response(false, 'delegate_task', {
            tasks: [{ objective: 'Check the fixture' }],
          });
        if (parentRound === 2)
          return f.response(false, 'send_message', {
            childSessionId: f.residency.list()[0]!.childSessionId,
            message: 'Do a follow-up',
            wait,
          });
        await until(
          () =>
            f.store.events(f.session.id).filter((event) => event.type === 'subagent.finished')
              .length === 2,
        );
        return f.response(false);
      },
    };
    const result = await new Agent({
      ...f,
      provider,
      tools: new ToolRegistry(),
      approve: async () => true,
      subagents: { enabled: true },
      subagentResidency: f.residency,
      childTools: () => new ToolRegistry(),
    }).run({ sessionId: f.session.id, prompt: 'Delegate, then ask again' });
    f.check(result, 2);
  });
}

test('a cancelled wait still accounts for the owned follow-up when it settles', async (t) => {
  const f = await fixture(t);
  let began!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => {
    began = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const usage: Usage = { inputTokens: 0, outputTokens: 0 };
  const statistics = f.store.statistics(f.session.id);
  const events: string[] = [];
  const child = f.residency.open({
    id: 'cancelled-child',
    childSessionId: 'cancelled-session',
    parentSessionId: f.session.id,
    objective: 'A measured follow-up',
    depth: 1,
    async turn() {
      began();
      await gate;
      return {
        text: 'stopped',
        status: 'cancelled',
        rounds: 1,
        toolCalls: 0,
        usage: { inputTokens: 50, outputTokens: 2, cachedInputTokens: 5, cacheWriteInputTokens: 3 },
      };
    },
  });
  const tool = createResidentMessageTool({
    store: f.store,
    parentSessionId: f.session.id,
    depth: 0,
    residency: f.residency,
    childTurns: () => {
      throw new Error('cold resume unused');
    },
    emit: (type) => {
      events.push(type);
    },
    statistics,
    usage,
    nextMessageId: () => 1,
  });
  const controller = new AbortController();
  try {
    const pending = tool.execute(
      { childSessionId: child.childSessionId, message: 'follow up' },
      { signal: controller.signal, approve: async () => true },
    );
    await entered;
    controller.abort(new Error('stop waiting'));
    assert.equal((await pending).isError, true);
    release();
    await child.dispose();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(usage, {
      inputTokens: 50,
      outputTokens: 2,
      cachedInputTokens: 5,
      cacheWriteInputTokens: 3,
    });
    assert.equal(statistics.inputTokens, 50);
    assert.equal(statistics.outputTokens, 2);
    assert.equal(events.filter((type) => type === 'subagent.finished').length, 1);
  } finally {
    release();
  }
});

test('a cancelled Agent joins owned resident accounting before persisting its totals', async (t) => {
  const f = await fixture(t);
  let began!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => {
    began = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const childSession = f.store.create(f.root);
  f.residency.open({
    id: 'persisted-child',
    childSessionId: childSession.id,
    parentSessionId: f.session.id,
    objective: 'A measured follow-up',
    depth: 1,
    async turn() {
      began();
      await gate;
      return {
        text: 'stopped',
        status: 'cancelled',
        rounds: 1,
        toolCalls: 0,
        usage: { inputTokens: 50, outputTokens: 2, cachedInputTokens: 5, cacheWriteInputTokens: 3 },
      };
    },
  });
  const controller = new AbortController();
  const agent = new Agent({
    ...f,
    provider: {
      async complete() {
        return f.response(false, 'send_message', {
          childSessionId: childSession.id,
          message: 'follow up',
        });
      },
    },
    tools: new ToolRegistry(),
    approve: async () => true,
    subagents: { enabled: true },
    subagentResidency: f.residency,
    childTools: () => new ToolRegistry(),
  });
  let finished = false;
  const running = agent.run({
    sessionId: f.session.id,
    prompt: 'Ask the resident child',
    signal: controller.signal,
  });
  void running.then(() => {
    finished = true;
  });
  try {
    await entered;
    controller.abort(new Error('stop'));
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(finished, false, 'the parent must join child settlement before finalizing');
  } finally {
    release();
  }
  const result = await running;
  assert.equal(result.status, 'cancelled');
  assert.equal(result.usage.inputTokens, 60);
  assert.equal(result.statistics?.inputTokens, 60);
  assert.equal(f.store.statistics(f.session.id).inputTokens, 60);
  assert.equal(f.store.statistics(f.session.id).cachedInputTokens, 6);
  assert.equal(
    f.store.events(f.session.id).filter((event) => event.type === 'subagent.finished').length,
    1,
  );
});

test('ending a parent run cancels and accounts for its background resident follow-up', async (t) => {
  const f = await fixture(t);
  const childSession = f.store.create(f.root);
  let childStopped = false;
  f.residency.open({
    id: 'background-child',
    childSessionId: childSession.id,
    parentSessionId: f.session.id,
    objective: 'A background follow-up',
    depth: 1,
    async turn(_prompt, signal) {
      if (!signal.aborted)
        await new Promise<void>((resolve) =>
          signal.addEventListener('abort', () => resolve(), { once: true }),
        );
      childStopped = true;
      return {
        text: 'stopped',
        status: 'cancelled',
        rounds: 1,
        toolCalls: 0,
        usage: { inputTokens: 50, outputTokens: 2 },
      };
    },
  });
  let requests = 0;
  const result = await new Agent({
    ...f,
    provider: {
      async complete() {
        return ++requests === 1
          ? f.response(false, 'send_message', {
              childSessionId: childSession.id,
              message: 'follow up',
              wait: false,
            })
          : f.response(false);
      },
    },
    tools: new ToolRegistry(),
    approve: async () => true,
    subagents: { enabled: true },
    subagentResidency: f.residency,
    childTools: () => new ToolRegistry(),
  }).run({ sessionId: f.session.id, prompt: 'Ask in the background' });
  assert.equal(result.status, 'completed', result.error);
  assert.equal(childStopped, true);
  assert.equal(result.usage.inputTokens, 70);
  assert.equal(f.store.statistics(f.session.id).inputTokens, 70);
});

test('an already rejected background resident turn cannot finalize the parent successfully', async (t) => {
  const f = await fixture(t);
  const childSession = f.store.create(f.root);
  const child = f.residency.open({
    id: 'failed-background-child',
    childSessionId: childSession.id,
    parentSessionId: f.session.id,
    objective: 'A failed follow-up',
    depth: 1,
    async turn() {
      throw new Error('fixture resident failure');
    },
  });
  let requests = 0;
  const result = await new Agent({
    ...f,
    provider: {
      async complete() {
        if (++requests === 1)
          return f.response(false, 'send_message', {
            childSessionId: childSession.id,
            message: 'follow up',
            wait: false,
          });
        await until(() => child.status === 'idle');
        return f.response(false);
      },
    },
    tools: new ToolRegistry(),
    approve: async () => true,
    subagents: { enabled: true },
    subagentResidency: f.residency,
    childTools: () => new ToolRegistry(),
  }).run({ sessionId: f.session.id, prompt: 'Ask in the background' });
  assert.equal(result.status, 'failed');
  assert.match(result.error!, /Resident sub-agent settlement failed/);
});

test('a resident follow-up that spends past the child token budget is stopped and says why', async (t) => {
  const f = await fixture(t);
  let parentRound = 0,
    childRequests = 0;
  const seenByParent: string[] = [];
  const childTools = () => {
    const tools = new ToolRegistry();
    tools.register({
      name: 'noop',
      description: 'Does nothing',
      inputSchema: { type: 'object', properties: {} },
      async execute() {
        return { isError: false, content: 'ok' };
      },
    });
    return tools;
  };
  const provider: Provider = {
    async complete(request) {
      const child = request.system.includes('You are a sub-agent delegated by a parent agent');
      if (child) {
        childRequests++;
        // The first turn answers; every follow-up request keeps working, 1020 tokens at a time.
        return childRequests === 1
          ? f.response(true, 'submit_report', {
              summary: 'checked',
              findings: [{ statement: 'checked', evidence: 'fixture' }],
            })
          : f.response(true, 'noop');
      }
      seenByParent.push(request.messages.map((message) => message.content).join('\n'));
      parentRound++;
      if (parentRound === 1)
        return f.response(false, 'delegate_task', { tasks: [{ objective: 'Check the fixture' }] });
      if (parentRound === 2)
        return f.response(false, 'send_message', {
          childSessionId: f.residency.list()[0]!.childSessionId,
          message: 'Keep going',
          wait: true,
        });
      return f.response(false);
    },
  };
  const result = await new Agent({
    ...f,
    provider,
    tools: new ToolRegistry(),
    approve: async () => true,
    subagents: { enabled: true, maxTokens: 4000 },
    subagentResidency: f.residency,
    childTools,
  }).run({ sessionId: f.session.id, prompt: 'Delegate, then ask again' });
  assert.equal(result.status, 'completed', result.error);
  assert.ok(childRequests < 10, `the follow-up was stopped (${childRequests} child requests)`);
  assert.match(seenByParent.at(-1)!, /token budget of 4000/);
});
