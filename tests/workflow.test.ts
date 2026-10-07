import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Agent } from '../packages/core/agent.ts';
import { workflowTool, WORKFLOW, WORKFLOW_CEILINGS } from '../packages/core/workflow.ts';
import type { SubAgentAnswer } from '../packages/core/subagents.ts';
import { DeferredApprovalError } from '../packages/core/approval-deferred.ts';
import { SessionStore } from '../packages/storage/sqlite.ts';
import { ToolRegistry } from '../packages/tools/registry.ts';
import { createTools } from '../packages/tools/index.ts';
import type {
  ModelRequest,
  ModelResponse,
  Provider,
  ToolContext,
} from '../packages/protocol/index.ts';

/**
 * `workflow`: a script that orchestrates sub-agents.
 *
 * The capability being pinned is *orchestration in one call*: a model writes the fan-out, the branches and the
 * ordering once, and the run executes them without a model round per step. What the tests have to hold down, then,
 * is not "does it run scripts" but the four things that make a script safe to hand to a model:
 *
 * 1. **The children are ordinary children.** Every `agent()` goes through the coordinator, so the caps, the
 *    events, the sessions and the transcripts are the same ones `delegate_task` produces — checked through a real
 *    agent run, not against a stub.
 * 2. **A failing child is the script's problem, not a silent `undefined`.** `agent()` rejects; `parallel` and
 *    `pipeline` turn that into `null` for the item they own; everything else propagates.
 * 3. **Misuse kills the script.** An unknown option, an empty prompt, one child too many: each one comes back as
 *    an error that the script cannot walk away from.
 * 4. **The surface is the whole capability set.** A workflow gets the hooks and nothing else — no tool catalog, no
 *    `process`, no filesystem.
 */

/** A stub coordinator: records the prompts, answers from a table, so the tool is tested without an agent run. */
function stubAgents(
  answer: (prompt: string, options: { model?: string }) => Promise<SubAgentAnswer> | SubAgentAnswer,
): {
  runAgent: (
    prompt: string,
    options: { model?: string },
    signal: AbortSignal,
  ) => Promise<SubAgentAnswer>;
  prompts: string[];
  options: { model?: string }[];
  signal: AbortSignal;
} {
  const prompts: string[] = [];
  const options: { model?: string }[] = [];
  const signal = new AbortController().signal;
  return {
    prompts,
    options,
    signal,
    runAgent: async (prompt, chosen) => {
      prompts.push(prompt);
      options.push(chosen);
      return await answer(prompt, chosen);
    },
  };
}
function completion(answer: string, extra: Partial<SubAgentAnswer> = {}): SubAgentAnswer {
  return { status: 'completed', sessionId: 'child-session', answer, rounds: 1, ...extra };
}
const context = (signal: AbortSignal): ToolContext => ({ signal, approve: async () => true });

test('a workflow returns its value, its logs and which phases it ran', async () => {
  const stub = stubAgents((prompt) => completion(`answer for ${prompt}`));
  const tool = workflowTool({ runAgent: stub.runAgent });
  const result = await tool.execute!(
    {
      name: 'audit',
      args: { topic: 'the config loader' },
      code: [
        "log('starting', args.topic);",
        "phase('inventory');",
        "const a = await agent('find the loader');",
        "phase('analyse');",
        "const b = await agent('check ' + args.topic);",
        'return JSON.stringify([a, b]);',
      ].join('\n'),
    },
    context(stub.signal),
  );
  assert.equal(result.isError, false);
  assert.equal(
    result.content.split('\n')[0],
    '["answer for find the loader","answer for check the config loader"]',
  );
  assert.match(result.content, /\[log\]\nstarting the config loader/);
  assert.match(
    result.content,
    /\[agents\] 2 sub-agent call\(s\) in \d+ms; by phase: inventory\(1\), analyse\(1\)/,
  );
  assert.deepEqual(stub.prompts, ['find the loader', 'check the config loader']);
});

test('parallel resolves a failing child to null and keeps the others', async () => {
  const stub = stubAgents((prompt) =>
    prompt === 'bad'
      ? { status: 'failed', sessionId: 's', answer: '', rounds: 0, error: 'it broke' }
      : completion(`ok:${prompt}`),
  );
  const tool = workflowTool({ runAgent: stub.runAgent });
  const result = await tool.execute!(
    {
      code: [
        'const [a, b, c] = await parallel([',
        "  () => agent('one'),",
        "  () => agent('bad'),",
        "  () => agent('three'),",
        ']);',
        'return JSON.stringify([a, b, c]);',
      ].join('\n'),
    },
    context(stub.signal),
  );
  assert.equal(result.isError, false);
  assert.equal(result.content.split('\n')[0], '["ok:one",null,"ok:three"]');
  // The child that did not complete is named, with its own reason: a script catching a failure must not hide it.
  assert.match(result.content, /\[agents\] 3 sub-agent call\(s\) in \d+ms, 1 did not complete/);
  assert.match(result.content, /bad → failed: it broke/);
});

test('pipeline runs each item through the stages in order, with no barrier between stages', async () => {
  const stub = stubAgents((prompt) => completion(prompt));
  const tool = workflowTool({ runAgent: stub.runAgent });
  const result = await tool.execute!(
    {
      code: [
        "const items = ['a', 'b'];",
        'const out = await pipeline(',
        '  items,',
        "  (item) => agent('first:' + item),",
        "  (previous, item) => agent('second:' + item + ' after ' + previous),",
        ');',
        'return JSON.stringify(out);',
      ].join('\n'),
    },
    context(stub.signal),
  );
  assert.equal(result.isError, false);
  assert.equal(
    result.content.split('\n')[0],
    '["second:a after first:a","second:b after first:b"]',
  );
  /**
   * The order of the four calls is the assertion.
   *
   * A pipeline with a barrier would be `first:a, second:a, first:b, second:b`. Running each item's own chain
   * independently gives `first:a, first:b, second:a, second:b`, which is the property that makes a pipeline worth
   * having: item `b` starts while item `a` is still working.
   */
  assert.deepEqual(stub.prompts, [
    'first:a',
    'first:b',
    'second:a after first:a',
    'second:b after first:b',
  ]);
});

test('a pipeline stage that throws drops that item only', async () => {
  const stub = stubAgents((prompt) =>
    prompt.startsWith('first:b')
      ? { status: 'failed', sessionId: 's', answer: '', rounds: 0, error: 'nope' }
      : completion(`done:${prompt}`),
  );
  const tool = workflowTool({ runAgent: stub.runAgent });
  const result = await tool.execute!(
    {
      code: [
        "const out = await pipeline(['a', 'b'], (item) => agent('first:' + item), (v) => agent('second:' + v));",
        'return JSON.stringify(out);',
      ].join('\n'),
    },
    context(stub.signal),
  );
  assert.equal(result.isError, false);
  assert.equal(result.content.split('\n')[0], '["done:second:done:first:a",null]');
  assert.deepEqual(
    stub.prompts,
    ['first:a', 'first:b', 'second:done:first:a'],
    'item b never reached stage 2',
  );
});

test('a child that fails outside a combinator throws inside the script', async () => {
  const stub = stubAgents(() => ({
    status: 'failed',
    sessionId: 's',
    answer: '',
    rounds: 0,
    error: 'no such file',
  }));
  const tool = workflowTool({ runAgent: stub.runAgent });
  const result = await tool.execute!(
    {
      code: [
        'let caught = "";',
        "try { await agent('look'); } catch (error) { caught = error.message; }",
        'return caught;',
      ].join('\n'),
    },
    context(stub.signal),
  );
  assert.equal(result.isError, false);
  assert.equal(result.content.split('\n')[0], 'no such file');
});

test('agent(prompt, { schema }) resolves to the object the caller asked for', async () => {
  const stub = stubAgents(() => ({
    status: 'completed',
    sessionId: 'child-session',
    // What the host does for a schema call: the object is the answer, and `answer` is its serialisation.
    answer: '{"verdict":"clean","files":["a.ts","b.ts"]}',
    data: { verdict: 'clean', files: ['a.ts', 'b.ts'] },
    rounds: 1,
  }));
  const tool = workflowTool({ runAgent: stub.runAgent });
  const result = await tool.execute!(
    {
      code: [
        "const data = await agent('check the loader', { schema: args.SCHEMA });",
        'return typeof data + "|" + data.verdict + "|" + data.files.length;',
      ].join('\n'),
      // The schema is the script's own value, so the test's script needs it: `args` is how a workflow is handed
      // data, and it is also the shortest way to show that a caller-defined shape is just a value here.
      args: { SCHEMA: { type: 'object', properties: { verdict: { type: 'string' } } } },
    },
    context(stub.signal),
  );
  assert.equal(result.isError, false);
  assert.equal(
    result.content.split('\n')[0],
    'object|clean|2',
    'a schema call resolves to the object, not to a string of JSON',
  );
  assert.deepEqual(stub.options, [
    { schema: { type: 'object', properties: { verdict: { type: 'string' } } } },
  ]);
});

test('a schema call whose child never submitted the object is a failure, not prose', async () => {
  const stub = stubAgents(() => ({
    status: 'completed',
    sessionId: 'child-session',
    answer: 'I looked around but did not fill anything in.',
    rounds: 3,
  }));
  const tool = workflowTool({ runAgent: stub.runAgent });
  const result = await tool.execute!(
    {
      code: [
        'let caught = "";',
        "try { await agent('check', { schema: { type: 'object', properties: { a: { type: 'string' } } } }); }",
        'catch (error) { caught = error.message; }',
        'return caught;',
      ].join('\n'),
    },
    context(stub.signal),
  );
  assert.equal(result.isError, false);
  assert.match(
    result.content.split('\n')[0]!,
    /without submitting the object this task asked for/,
    'the script is told the shape it declared was not honoured instead of receiving unshaped prose',
  );
});
test('misuse kills the script instead of being ignored', async () => {
  const stub = stubAgents(() => completion('never runs'));
  const tool = workflowTool({ runAgent: stub.runAgent });
  const cases: [string, string, RegExp][] = [
    [
      'an option this host does not implement',
      "return await agent('x', { reasoningEffort: 'high' });",
      /does not accept reasoningEffort/,
    ],
    ['an empty prompt', "return await agent('   ');", /needs a non-empty prompt/],
    ['a prompt that is not a string', 'return await agent(42);', /needs a non-empty prompt/],
    ['an empty phase title', "phase('');", /needs a non-empty title/],
    ['a phase title that is not a string', 'phase(7);', /needs a non-empty title/],
    [
      'a schema that is not an object',
      "return await agent('x', { schema: 5 });",
      /schema must be a JSON Schema object/,
    ],
    [
      'a schema that describes something other than an object',
      "return await agent('x', { schema: { type: 'array', items: { type: 'string' } } });",
      /must describe an object/,
    ],
    [
      'parallel over something that is not an array',
      'return await parallel(5);',
      /takes an array of functions/,
    ],
    ['parallel over a non-function', 'return await parallel([1]);', /item 0 is not a function/],
    ['a pipeline with no stages', "return await pipeline(['a']);", /needs at least one stage/],
    [
      'a pipeline stage that is not a function',
      "return await pipeline(['a'], 3);",
      /stage 0 is not a function/,
    ],
  ];
  for (const [what, code, expected] of cases) {
    const result = await tool.execute!({ code }, context(stub.signal));
    assert.equal(result.isError, true, `${what} should fail the script`);
    assert.match(result.content, expected, what);
  }
  assert.deepEqual(stub.prompts, [], 'no sub-agent was started by a rejected call');
});

test('one workflow cannot start more children than its cap', async () => {
  const stub = stubAgents((prompt) => completion(prompt));
  const tool = workflowTool({ runAgent: stub.runAgent });
  const result = await tool.execute!(
    {
      code: [
        `for (let index = 0; index < ${WORKFLOW_CEILINGS.maxAgents + 3}; index += 1) {`,
        "  await agent('child ' + index);",
        '}',
        "return 'finished';",
      ].join('\n'),
    },
    context(stub.signal),
  );
  assert.equal(result.isError, true);
  assert.match(
    result.content,
    new RegExp(`already started ${WORKFLOW_CEILINGS.maxAgents} sub-agents`),
  );
  assert.equal(
    stub.prompts.length,
    WORKFLOW_CEILINGS.maxAgents,
    'the cap is counted before the call, so a parallel burst cannot pass it many times over',
  );
  // The trace names what did run, which is the difference between "the workflow failed" and "it failed on call 25".
  assert.match(result.content, /\[agents\] 24 sub-agent call\(s\)/);
  assert.match(result.content, /\[inventory\]|child 0 → completed/);
});

test('a workflow gets the hooks and nothing else', async () => {
  const stub = stubAgents(() => completion('x'));
  const tool = workflowTool({ runAgent: stub.runAgent });
  const result = await tool.execute!(
    {
      code: [
        'return JSON.stringify({',
        '  tools: typeof tools,',
        '  process: typeof process,',
        '  require: typeof require,',
        '  fetch: typeof fetch,',
        '  agent: typeof agent,',
        '  parallel: typeof parallel,',
        '  pipeline: typeof pipeline,',
        '  phase: typeof phase,',
        '  log: typeof log,',
        '  args: typeof args,',
        '});',
      ].join('\n'),
    },
    context(stub.signal),
  );
  assert.equal(result.isError, false);
  assert.deepEqual(JSON.parse(result.content.split('\n')[0]!), {
    tools: 'undefined',
    process: 'undefined',
    require: 'undefined',
    fetch: 'undefined',
    agent: 'function',
    parallel: 'function',
    pipeline: 'function',
    phase: 'function',
    log: 'function',
    args: 'object',
  });
});

test('a workflow with no deadline finishes work that outlives a default budget', async () => {
  /**
   * The failure this option exists for, and the reason `workflow` is exempt from the deployment's tool deadline.
   *
   * A script's length is set by its children's work, not by the call: a fan-out over four investigations is four
   * child runs deep, and a stopwatch on the *call* kills the script together with the reports the parent asked for.
   * `0` is the caller saying so — tested as its own value rather than treated as "unset", because the two are
   * different requests and this is the one a real fan-out makes.
   */
  const stub = stubAgents(async (prompt) => {
    await new Promise((resolve) => setTimeout(resolve, 120));
    return completion(`slow answer for ${prompt}`);
  });
  const tool = workflowTool({ runAgent: stub.runAgent });
  const result = await tool.execute!(
    {
      timeoutMs: 0,
      code: [
        "const [a, b] = await parallel([() => agent('one'), () => agent('two')]);",
        'return a + " | " + b;',
      ].join('\n'),
    },
    context(new AbortController().signal),
  );
  assert.equal(result.isError, false);
  assert.match(result.content, /slow answer for one/);
  assert.match(result.content, /slow answer for two/);
});

test('a workflow that exceeds its own budget is stopped and told which budget it was', async () => {
  // The other half: `timeoutMs` bounds the script itself, so a caller that wants a stopwatch still gets one even
  // though the deployment default no longer applies to this tool.
  const stub = stubAgents(async (prompt) => {
    await new Promise((resolve) => setTimeout(resolve, 400));
    return completion(`answer for ${prompt}`);
  });
  const tool = workflowTool({ runAgent: stub.runAgent });
  await assert.rejects(
    tool.execute!(
      { timeoutMs: 80, code: "return await agent('slow');" },
      context(new AbortController().signal),
    ),
    /exceeded its 80ms budget/,
  );
});

test('a workflow that runs out of budget stops the children it had already started', async () => {
  /**
   * A deadline used to stop the script and nothing else. The children a script had started were handed the
   * *run's* signal — the one nobody aborts until the whole run is cancelled — so they kept working for a call
   * that had already reported itself stopped: spending tokens, writing to their own sessions, and holding the
   * run's concurrency slots. The same hole covered a script that returned without awaiting its last `agent()`:
   * its answer could not reach anybody, and it ran anyway.
   *
   * The call now carries its own cancellation, every child follows both signals, and the answer waits for the
   * children to unwind before it is given.
   *
   * The deadline is deliberately loose (half a second for a call that does nothing but hand one call to one
   * child) and the child records that it started: what is under test is the abort reaching a child that was in
   * flight, and a budget tight enough to expire before the worker's message arrives would test the machine's load
   * instead. The start is asserted rather than assumed, so a machine slow enough to lose that race fails with the
   * reason instead of passing on an empty list.
   */
  const aborted: string[] = [];
  let started = 0;
  const runAgent = async (
    prompt: string,
    _options: { model?: string },
    signal: AbortSignal,
  ): Promise<SubAgentAnswer> => {
    started += 1;
    await new Promise<void>((resolve) => {
      if (signal.aborted) return resolve();
      signal.addEventListener(
        'abort',
        () => {
          aborted.push(prompt);
          resolve();
        },
        { once: true },
      );
    });
    // What a real child answers when its own signal fires: a cancelled run, reported as such.
    return { status: 'cancelled', sessionId: 'child-session', answer: '', rounds: 1 };
  };
  const tool = workflowTool({ runAgent });
  await assert.rejects(
    tool.execute!(
      { timeoutMs: 500, code: "return await agent('slow');" },
      context(new AbortController().signal),
    ),
    /exceeded its 500ms budget/,
  );
  assert.equal(started, 1, 'the child was in flight when the budget ran out');
  assert.deepEqual(aborted, ['slow'], 'the child the script had started was told to stop');
});

test('a malformed workflow budget is refused rather than read as a value', async () => {
  // `-1` and a fraction are not "small budgets": reading either as one would run the script under a deadline
  // nobody asked for, which is what guessing at an invalid argument produces.
  const stub = stubAgents(() => completion('unused'));
  const tool = workflowTool({ runAgent: stub.runAgent });
  for (const bad of [-1, 1.5]) {
    const result = await tool.execute!(
      { timeoutMs: bad, code: "return 'never runs';" },
      context(new AbortController().signal),
    );
    assert.equal(result.isError, true);
    assert.match(result.content, /timeoutMs must be a non-negative integer/);
  }
});

test('cancelling the call stops the script and its worker', async () => {
  const stub = stubAgents(() => completion('x'));
  const controller = new AbortController();
  const tool = workflowTool({ runAgent: stub.runAgent });
  const running = tool.execute!(
    { code: 'while (true) { /* a script that ignores everything */ }' },
    context(controller.signal),
  );
  setTimeout(() => controller.abort(new Error('workflow was cancelled')), 50);
  await assert.rejects(running, /workflow was cancelled/);
});

test('a deferred approval is the run speaking, so the script cannot catch it', async () => {
  const deferred = new DeferredApprovalError();
  const stub = stubAgents(() => {
    throw deferred;
  });
  const tool = workflowTool({ runAgent: stub.runAgent });
  await assert.rejects(
    tool.execute!(
      {
        code: [
          "try { await agent('x'); } catch (error) { return 'caught: ' + error.message; }",
          "return 'not reached';",
        ].join('\n'),
      },
      context(stub.signal),
    ),
    (error: unknown) => error === deferred,
  );
});

// ---- through a real agent run ----

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
/** Children answer through `submit_report`: a delegated child is asked for a structured report, always. */
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

test('a workflow’s agent() can hold a real child to the schema the script declares', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-workflow-schema-'));
  const store = new SessionStore(path.join(root, 'sessions.sqlite'));
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const session = store.create(root);
  /** The schema the script declares: nothing to do with the report contract. */
  const scriptSchema = {
    type: 'object',
    properties: {
      files: { type: 'array', items: { type: 'string' }, description: 'Paths inspected.' },
      verdict: { type: 'string', enum: ['clean', 'suspect'] },
    },
    required: ['files', 'verdict'],
    additionalProperties: false,
  };
  let childSchema: Record<string, unknown> | undefined;
  let parentRound = 0;
  const provider: Provider = {
    async complete(request) {
      if (isChild(request)) {
        childSchema = request.tools.find((tool) => tool.name === 'submit_report')?.inputSchema;
        return toolCall('custom-1', 'submit_report', {
          files: ['loader.ts', 'config.ts'],
          verdict: 'suspect',
        });
      }
      parentRound++;
      if (parentRound === 1)
        return toolCall('wf-1', 'workflow', {
          code: [
            "const data = await agent('Inspect the loader', { schema: args.schema });",
            'return data.verdict + ": " + data.files.join(", ");',
          ].join('\n'),
          args: { schema: scriptSchema },
        });
      return reply('Done');
    },
  };
  const agent = new Agent({
    store,
    provider,
    tools: new ToolRegistry(),
    approve: async () => true,
    subagents: { enabled: true },
  });
  assert.equal((await agent.run({ sessionId: session.id, prompt: 'Sweep' })).status, 'completed');
  assert.deepEqual(
    childSchema,
    scriptSchema,
    'the child’s submission tool schema is the one the script declared, applied by the same Ajv pass',
  );
  const output = store
    .messages(session.id)
    .filter((message) => message.role === 'tool')
    .map((message) => String(message.content))
    .join('\n');
  assert.match(
    output,
    /^suspect: loader\.ts, config\.ts/m,
    'the object reached the script, which is what let it answer in the shape it asked for',
  );
});

test('a workflow runs real sub-agents through the same coordinator as delegate_task', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-workflow-'));
  const store = new SessionStore(path.join(root, 'sessions.sqlite'));
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const session = store.create(root);
  const seen: ModelRequest[] = [];
  let parentRound = 0;
  const provider: Provider = {
    async complete(request) {
      if (isChild(request)) {
        const objective = String(
          request.messages.find((message) => message.role === 'user')?.content ?? '',
        );
        return report(`found: ${objective.slice(0, 40)}`);
      }
      seen.push(request);
      parentRound++;
      if (parentRound === 1)
        return toolCall('wf-1', 'workflow', {
          name: 'sweep',
          args: { area: 'the loader' },
          code: [
            "phase('inventory');",
            'const [a, b] = await parallel([',
            "  () => agent('find the config'),",
            "  () => agent('find the entry point'),",
            ']);',
            "phase('analyse');",
            "const c = await agent('summarise ' + args.area);",
            'return JSON.stringify({ a: a.length > 0, b: b.length > 0, c: c.length > 0 });',
          ].join('\n'),
        });
      return reply('Done');
    },
  };
  const agent = new Agent({
    store,
    provider,
    tools: new ToolRegistry(),
    approve: async () => true,
    subagents: { enabled: true },
  });
  const result = await agent.run({ sessionId: session.id, prompt: 'Sweep the project' });
  assert.equal(result.status, 'completed', result.error);
  assert.ok(
    seen[0]?.tools.some((tool) => tool.name === WORKFLOW),
    'a run that may delegate is offered the workflow tool',
  );
  const output = store
    .messages(session.id)
    .filter((message) => message.role === 'tool')
    .map((message) => String(message.content))
    .join('\n');
  assert.match(output, /\{"a":true,"b":true,"c":true\}/, 'the script’s value is the tool result');
  assert.match(
    output,
    /\[agents\] 3 sub-agent call\(s\) in \d+ms; by phase: inventory\(2\), analyse\(1\)/,
  );
  const events = store.events(session.id);
  assert.equal(events.filter((event) => event.type === 'subagent.assigned').length, 3);
  assert.equal(events.filter((event) => event.type === 'subagent.finished').length, 3);
  assert.equal(
    store.subagents(session.id).length,
    3,
    'workflow children are ordinary children: they appear on the cards like any other delegation',
  );
  // Every child answered from its own session, which is where its transcript lives.
  for (const card of store.subagents(session.id)) {
    assert.equal(card.status, 'completed');
    assert.ok(store.messages(card.sessionId).length > 0);
  }
});

test('a run that cannot delegate is not offered the workflow tool', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-workflow-off-'));
  const store = new SessionStore(path.join(root, 'sessions.sqlite'));
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const session = store.create(root);
  let offered: string[] = [];
  const agent = new Agent({
    store,
    provider: {
      async complete(request) {
        offered = request.tools.map((tool) => tool.name);
        return reply('Done');
      },
    },
    tools: new ToolRegistry(),
    approve: async () => true,
  });
  assert.equal((await agent.run({ sessionId: session.id, prompt: 'Hi' })).status, 'completed');
  assert.ok(!offered.includes(WORKFLOW), 'no coordinator, no orchestration tool');
});

test('a delegated run does not inherit the parent’s workflow tool', async () => {
  // The list is what does it: a child works on a copy of the parent's registry, and this tool holds the parent's
  // coordinator — inheriting it would let a child delegate through the parent's caps and lineage.
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-workflow-copy-'));
  const tools = createTools(root);
  const stub = stubAgents(() => completion('x'));
  tools.replace(workflowTool({ runAgent: stub.runAgent }));
  assert.ok(
    tools.specs().some((spec) => spec.name === WORKFLOW),
    'installed on the run',
  );
  const childCopy = tools.forRun({});
  assert.ok(
    !childCopy.specs().some((spec) => spec.name === WORKFLOW),
    'absent from a delegated copy',
  );
  assert.ok(
    childCopy.specs().some((spec) => spec.name === 'read_file'),
    'while the tools a child legitimately uses are still there',
  );
  await rm(root, { recursive: true, force: true });
});
