import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createTools } from '../packages/tools/index.ts';
import { executionPolicy } from '../packages/tools/execution-policy.ts';
import { validateCodeMessage } from '../packages/tools/code-process.ts';
import { Agent } from '../packages/core/agent.ts';
import { SessionStore } from '../packages/storage/sqlite.ts';
import { workflowTool } from '../packages/core/workflow.ts';
import type { ToolContext, ToolCatalog } from '../packages/protocol/index.ts';

async function fixture(t: test.TestContext, mode: 'host' | 'windows' = 'host') {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-program-process-'));
  const tools = createTools(root);
  t.after(async () => {
    await tools.close();
    await rm(root, { recursive: true, force: true });
  });
  const context: ToolContext = {
    signal: new AbortController().signal,
    approve: async () => true,
    executionPolicy: executionPolicy(mode),
  };
  const catalog: ToolCatalog = {
    specs: tools.specs({ mode: 'native' }),
    mode: (call) => tools.executionMode(call),
    parallelLimit: 2,
    invoke: (call, signal) => tools.execute(call, { ...context, signal: signal ?? context.signal }),
  };
  const run = (code: string) =>
    tools.execute(
      { id: 'program', name: 'run_code', arguments: { code } },
      { ...context, catalog },
    );
  return { root, tools, context, catalog, run };
}

test('a VM escape runs in another process', async (t) => {
  const { run } = await fixture(t);
  const pid = await run("return console.log.constructor('return process')().pid;");
  assert.equal(pid.isError, false, pid.content);
  assert.notEqual(Number(pid.content.split('\n')[0]), process.pid);
});

test('a VM escape cannot write through node:fs without a tool approval', async (t) => {
  const { root, run } = await fixture(t);
  const destination = path.join(root, 'direct.txt');
  const write = await run(
    `const p = console.log.constructor('return process')(); try { p.getBuiltinModule('fs').writeFileSync(${JSON.stringify(destination)}, 'unapproved'); return 'wrote'; } catch (error) { return error.code; }`,
  );
  assert.match(write.content, /ERR_ACCESS_DENIED/);
  await assert.rejects(readFile(destination), /ENOENT/);
});

test('a forged RPC cannot reach a tool outside the exposed catalog', async (t) => {
  const { tools, context, catalog } = await fixture(t);
  let escaped = false;
  tools.register({
    name: 'hidden_write',
    description: 'Hidden effect',
    permission: 'write',
    inputSchema: { type: 'object' },
    async execute() {
      escaped = true;
      return { isError: false, content: 'effect' };
    },
  });
  const result = await tools.execute(
    {
      id: 'program',
      name: 'run_code',
      arguments: {
        code: "const p = console.log.constructor('return process')(); p.getBuiltinModule('worker_threads').parentPort.postMessage({ type: 'call', id: 99, name: 'hidden_write', args: {} }); await tools.read_file({path: 'missing'}); return 'finished';",
      },
    },
    { ...context, catalog },
  );
  assert.equal(result.isError, true);
  assert.match(result.content, /outside this run catalog/);
  assert.equal(escaped, false);
});

test('program disconnect preserves known results and waits for an in-flight tool cleanup', async (t) => {
  const { tools, context, root } = await fixture(t);
  let cleaned = false;
  tools.register({
    name: 'slow',
    description: 'Cooperative delayed effect',
    isConcurrencySafe: () => true,
    inputSchema: { type: 'object' },
    async execute(_args, ctx) {
      await new Promise<void>((resolve) =>
        ctx.signal.addEventListener('abort', () => resolve(), { once: true }),
      );
      await new Promise((resolve) => setTimeout(resolve, 40));
      cleaned = true;
      return { isError: true, content: 'Stopped before the delayed effect' };
    },
  });
  tools.register({
    name: 'probe',
    description: 'A known observation',
    isConcurrencySafe: () => true,
    inputSchema: { type: 'object' },
    async execute() {
      return { isError: false, content: 'known' };
    },
  });
  const records: { name: string; state: string }[] = [];
  await assert.rejects(
    tools.execute(
      {
        id: 'program',
        name: 'run_code',
        arguments: {
          code: "await tools.write_file({path:'known.txt',content:'once'}); const slow = tools.slow({}); await tools.probe({}); console.log.constructor('return process')().exit(88); await slow;",
        },
      },
      {
        ...context,
        programJournal: { record: (call, state) => records.push({ name: call.name, state }) },
        catalog: {
          specs: tools.specs({ mode: 'native' }),
          mode: (call) => tools.executionMode(call),
          parallelLimit: 2,
          invoke: (call, signal) =>
            tools.execute(call, { ...context, signal: signal ?? context.signal }),
        },
      },
    ),
    (error) =>
      error instanceof Error &&
      error.name === 'ToolCleanupError' &&
      /disconnected.*unknown/s.test(error.message),
  );
  assert.equal(await readFile(path.join(root, 'known.txt'), 'utf8'), 'once');
  assert.equal(cleaned, true, 'the outer call must wait for cleanup');
  assert.ok(records.some((record) => record.name === 'write_file' && record.state === 'known'));
  assert.ok(
    records.some((record) => record.name === 'slow' && record.state === 'unknown'),
    'an aborted registry call cannot confirm its effect even when its body cleaned up',
  );
});

test('unsupported program backend refuses without host execution', async (t) => {
  const { tools, context, catalog, root } = await fixture(t);
  const result = await tools.execute(
    {
      id: 'program',
      name: 'run_code',
      arguments: {
        code: "await tools.write_file({path:'escaped.txt',content:'escaped'}); return 'ran';",
      },
    },
    { ...context, executionPolicy: executionPolicy('docker'), catalog },
  );
  assert.equal(result.isError, true);
  assert.match(result.content, /does not support the program runner/);
  await assert.rejects(readFile(path.join(root, 'escaped.txt')), /ENOENT/);
});

test('program RPC rejects duplicate ids, malformed arguments and oversized logs', () => {
  const names = new Set(['read_file']);
  const ids = new Set<number>();
  validateCodeMessage({ type: 'call', id: 1, name: 'read_file', args: {} }, names, ids);
  assert.throws(
    () => validateCodeMessage({ type: 'call', id: 1, name: 'read_file', args: {} }, names, ids),
    /repeated/,
  );
  for (const args of [null, [], 'path', 1])
    assert.throws(
      () => validateCodeMessage({ type: 'call', id: 2, name: 'read_file', args }, names, ids),
      /arguments/,
    );
  assert.throws(
    () =>
      validateCodeMessage({ type: 'result', value: 'ok', logs: ['x'.repeat(8001)] }, names, ids),
    /log limit/,
  );
  assert.throws(
    () => validateCodeMessage({ type: 'result', value: 22, logs: [] }, names, ids),
    /result/,
  );
  assert.throws(() => validateCodeMessage({ type: 'other' }, names, ids), /Unknown/);
});

test('a raw output flood is stopped before it can become an unbounded Host log', async (t) => {
  const { run } = await fixture(t);
  const result = await run(
    "console.log.constructor('return process')().stdout.write('x'.repeat(1100000)); await tools.read_file({path:'missing'});",
  );
  assert.equal(result.isError, true);
  assert.match(result.content, /RPC|JSON/);
  assert.ok(result.content.length < 25000);
});

test('console truncation stays within the RPC log budget', async (t) => {
  const { run } = await fixture(t);
  const result = await run(
    "console.log('x'.repeat(7990)); console.log('y'.repeat(100)); return 'done';",
  );
  assert.equal(result.isError, false, result.content);
  assert.match(result.content, /console output truncated/);
});

test(
  'a Windows program uses the selected backend and RPC writes still require approval',
  { skip: process.platform !== 'win32' },
  async (t) => {
    const { tools, context, root } = await fixture(t, 'windows');
    let approvals = 0;
    const chosen = {
      ...context,
      approve: async () => {
        approvals++;
        return true;
      },
    };
    const result = await tools.execute(
      {
        id: 'win-program',
        name: 'run_code',
        arguments: {
          code: "await tools.write_file({path:'approved.txt',content:'approved'}); const p=console.log.constructor('return process')(); return p.permission.has('fs.write') + ':' + p.pid;",
        },
      },
      {
        ...chosen,
        catalog: {
          specs: tools.specs({ mode: 'native' }),
          mode: (call) => tools.executionMode(call),
          parallelLimit: 2,
          invoke: (call, signal) =>
            tools.execute(call, { ...chosen, signal: signal ?? chosen.signal }),
        },
      },
    );
    assert.equal(result.isError, false, result.content);
    assert.equal(approvals, 1);
    assert.equal(await readFile(path.join(root, 'approved.txt'), 'utf8'), 'approved');
    assert.match(result.content, /^false:\d+/);
    assert.notEqual(Number(result.content.split(':')[1]?.split('\n')[0]), process.pid);
  },
);

for (const mode of ['native', 'ptc'] as const)
  test(`${mode} program records each task effect after its durable receipt`, async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), 'yuantu-program-receipts-'));
    const file = path.join(root, 'sessions.sqlite');
    const store = new SessionStore(file);
    const tools = createTools(root);
    tools.toolMode = mode;
    t.after(async () => {
      store.close();
      await tools.close();
      await rm(root, { recursive: true, force: true });
    });
    const session = store.create(root);
    const task = store.createTask(session.id, { title: 'Two approved effects' });
    const attempt = store.startTaskAttempt(session.id, task.id, { kind: 'run', trigger: 'manual' });
    let rounds = 0;
    const agent = new Agent({
      store,
      tools,
      approve: async () => true,
      taskEffectScope: { sessionId: session.id, taskId: task.id, attemptId: attempt.id },
      provider: {
        async complete() {
          return rounds++ === 0
            ? {
                text: '',
                finishReason: 'tool_calls',
                usage: { inputTokens: 1, outputTokens: 1 },
                toolCalls: [
                  {
                    id: 'program',
                    name: 'run_code',
                    arguments: {
                      code: "await tools.write_file({path:'a.txt',content:'a'}); await tools.write_file({path:'b.txt',content:'b'}); return 'done';",
                    },
                  },
                ],
              }
            : {
                text: 'Done',
                finishReason: 'stop',
                usage: { inputTokens: 1, outputTokens: 1 },
                toolCalls: [],
              };
        },
      },
    });
    const result = await agent.run({ sessionId: session.id, prompt: 'Use a program' });
    assert.equal(result.status, 'completed', result.error);
    assert.equal(store.hasPendingTaskEffects(session.id, task.id), false);
    const receipts = store
      .events(session.id)
      .filter((event) => event.type === 'program.call.settled');
    assert.equal(receipts.length, 2);
    assert.ok(receipts.every((event) => event.data.state === 'known'));
    const reopened = new SessionStore(file);
    try {
      assert.equal(
        reopened.events(session.id).filter((event) => event.type === 'program.call.settled').length,
        2,
      );
      assert.equal(reopened.hasPendingTaskEffects(session.id, task.id), false);
    } finally {
      reopened.close();
    }
  });

test('a disconnected workflow waits for its child and refuses automatic continuation', async () => {
  let cleaned = false;
  const tool = workflowTool({
    runAgent: async (_prompt, _options, signal) => {
      await new Promise<void>((resolve) =>
        signal.addEventListener('abort', () => resolve(), { once: true }),
      );
      await new Promise((resolve) => setTimeout(resolve, 40));
      cleaned = true;
      return { status: 'cancelled', sessionId: 'child', answer: 'Preserved report', rounds: 1 };
    },
  });
  await assert.rejects(
    tool.execute(
      {
        code: "const child=agent('work'); phase('started'); await phase('flushed'); console.log.constructor('return process')().exit(88); await child;",
      },
      { signal: new AbortController().signal, approve: async () => true },
    ),
    (error) => error instanceof Error && error.name === 'ToolCleanupError',
  );
  assert.equal(cleaned, true);
});

test('PTC with an unsupported backend refuses before spending a model round', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-program-unsupported-'));
  const store = new SessionStore(path.join(root, 'sessions.sqlite'));
  const tools = createTools(root);
  tools.toolMode = 'ptc';
  t.after(async () => {
    store.close();
    await tools.close();
    await rm(root, { recursive: true, force: true });
  });
  const session = store.create(root);
  let requests = 0;
  const agent = new Agent({
    store,
    tools,
    approve: async () => true,
    executionPolicy: () => executionPolicy('docker'),
    provider: {
      async complete() {
        requests++;
        throw new Error('No model call should occur');
      },
    },
  });
  const result = await agent.run({ sessionId: session.id, prompt: 'Read' });
  assert.equal(result.status, 'failed');
  assert.equal(result.code, 'unsupported');
  assert.match(result.error ?? '', /select native tool mode/);
  assert.equal(requests, 0);
});

test('a tool wrapper cannot replace the program workspace identity', async (t) => {
  const { root, tools, run } = await fixture(t);
  const other = await mkdtemp(path.join(tmpdir(), 'yuantu-program-other-'));
  t.after(() => rm(other, { recursive: true, force: true }));
  tools.registerHooks({
    aroundTool: async (dispatch, next) =>
      next(dispatch.withScope({ ...dispatch.scope, workspaceRoot: other })),
  });
  const result = await run("return console.log.constructor('return process')().cwd();");
  assert.equal(result.isError, false, result.content);
  assert.equal(result.content.split('\n')[0], root);
});
