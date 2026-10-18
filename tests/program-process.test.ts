import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createTools } from '../packages/catalog/index.ts';
import { executionPolicy } from '../packages/tools/execution-policy.ts';
import { validateCodeMessage } from '../packages/tools/code-process.ts';
import { Agent } from '../packages/core/agent.ts';
import { SessionStore } from '../packages/storage/sqlite.ts';
import { workflowTool } from '../packages/core/workflow.ts';

import { fixture } from './program-process-fixture.ts';

test('a program cannot reach the runner process through a host-realm constructor', async (t) => {
  const { run } = await fixture(t);
  for (const attempt of [
    "return console.log.constructor('return process')().pid;",
    "return tools.read_file.constructor('return globalThis')().fetch;",
    'return typeof escapedProcess;',
  ]) {
    const result = await run(attempt);
    assert.ok(
      result.isError || /^undefined/.test(result.content),
      `${attempt} -> ${result.content}`,
    );
  }
});

test('a VM escape runs in another process', async (t) => {
  const { run } = await fixture(t, 'host', { escaped: true });
  const pid = await run('return escapedProcess.pid;');
  assert.equal(pid.isError, false, pid.content);
  assert.notEqual(Number(pid.content.split('\n')[0]), process.pid);
});

test('a VM escape cannot write through node:fs without a tool approval', async (t) => {
  const { root, run } = await fixture(t, 'host', { escaped: true });
  const destination = path.join(root, 'direct.txt');
  const write = await run(
    `const p = escapedProcess; try { p.getBuiltinModule('fs').writeFileSync(${JSON.stringify(destination)}, 'unapproved'); return 'wrote'; } catch (error) { return error.code; }`,
  );
  assert.match(write.content, /ERR_ACCESS_DENIED/);
  await assert.rejects(readFile(destination), /ENOENT/);
});

test('a forged RPC cannot reach a tool outside the exposed catalog', async (t) => {
  const { tools, context, catalog } = await fixture(t, 'host', { escaped: true });
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
        code: "const p = escapedProcess; p.getBuiltinModule('worker_threads').parentPort.postMessage({ type: 'call', id: 99, name: 'hidden_write', args: {} }); await tools.read_file({path: 'missing'}); return 'finished';",
      },
    },
    { ...context, catalog },
  );
  assert.equal(result.isError, true);
  assert.match(result.content, /outside this run catalog/);
  assert.equal(escaped, false);
});

test('program disconnect preserves known results and waits for an in-flight tool cleanup', async (t) => {
  const { tools, context, root } = await fixture(t, 'host', { escaped: true });
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
          code: "await tools.write_file({path:'known.txt',content:'once'}); const slow = tools.slow({}); await tools.probe({}); escapedProcess.exit(88); await slow;",
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

test('unavailable native program backend refuses without host execution', async (t) => {
  const { sandboxProvider, registerSandboxProvider } = await import('../packages/tools/sandbox.ts');
  const original = sandboxProvider('seatbelt');
  registerSandboxProvider({
    ...original,
    available: async () => 'Native program runner unavailable',
  });
  t.after(() => registerSandboxProvider(original));
  const { tools, context, catalog, root } = await fixture(t, 'host', { escaped: true });
  const result = await tools.execute(
    {
      id: 'program',
      name: 'run_code',
      arguments: {
        code: "await tools.write_file({path:'escaped.txt',content:'escaped'}); return 'ran';",
      },
    },
    { ...context, executionPolicy: executionPolicy('seatbelt'), catalog },
  );
  assert.equal(result.isError, true);
  assert.match(result.content, /Native program runner unavailable/);
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
  const { run } = await fixture(t, 'host', { escaped: true });
  const result = await run(
    "escapedProcess.stdout.write('x'.repeat(1100000)); await tools.read_file({path:'missing'});",
  );
  assert.equal(result.isError, true);
  assert.match(result.content, /RPC|JSON/);
  assert.ok(result.content.length < 25000);
});

test('console truncation stays within the RPC log budget', async (t) => {
  const { run } = await fixture(t, 'host', { escaped: true });
  const result = await run(
    "console.log('x'.repeat(7990)); console.log('y'.repeat(100)); return 'done';",
  );
  assert.equal(result.isError, false, result.content);
  assert.match(result.content, /console output truncated/);
});

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
    exposeProcessForTests: true,
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
        code: "const child=agent('work'); phase('started'); await phase('flushed'); escapedProcess.exit(88); await child;",
      },
      { signal: new AbortController().signal, approve: async () => true },
    ),
    (error) => error instanceof Error && error.name === 'ToolCleanupError',
  );
  assert.equal(cleaned, true);
});

test('a tool wrapper cannot replace the program workspace identity', async (t) => {
  const { root, tools, run } = await fixture(t, 'host', { escaped: true });
  const other = await mkdtemp(path.join(tmpdir(), 'yuantu-program-other-'));
  t.after(() => rm(other, { recursive: true, force: true }));
  tools.registerHooks({
    aroundTool: async (dispatch, next) =>
      next(dispatch.withScope({ ...dispatch.scope, workspaceRoot: other })),
  });
  const result = await run(
    "return escapedProcess.env.YUANTU_PROGRAM_LAUNCH_DIR + '|' + escapedProcess.cwd();",
  );
  assert.equal(result.isError, false, result.content);
  const [launched, cwd] = result.content.split('\n')[0]!.split('|');
  assert.equal(launched, root);
  // The runner leaves the workspace before its worker exists: a worker under `--permission` may read its working
  // directory, and that directory must not be the one holding `.env`.
  assert.notEqual(cwd, root);
});

test('an escaped program cannot read workspace files directly', async (t) => {
  const { root, run } = await fixture(t, 'host', { escaped: true });
  await writeFile(path.join(root, '.env'), 'API_KEY=fake-test-value');
  const result = await run(
    `try { return escapedProcess.getBuiltinModule('fs').readFileSync(${JSON.stringify(path.join(root, '.env'))}, 'utf8'); } catch (error) { return error.code; }`,
  );
  assert.equal(result.isError, false, result.content);
  assert.match(result.content, /^ERR_ACCESS_DENIED/);
});
