import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { httpFixture, frames, sendFrames } from './http-fixture.ts';

test('compiled desktop example uses the compiled Host to read a real project', async (t) => {
  const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-compiled-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'answer.txt'), '42');
  let step = 0;
  const url = await httpFixture(t, (body, res) => {
    if (step++ === 0) {
      sendFrames(
        res,
        frames('Reading', [{ id: 'read', name: 'read_file', input: { path: 'answer.txt' } }]),
      );
    } else {
      assert.match(JSON.stringify(body.messages), /1: 42/);
      sendFrames(res, frames('The answer is 42'));
    }
  });
  const child = spawn(
    process.execPath,
    [path.join(project, 'examples/desktop-session.mjs'), root, 'Read answer.txt'],
    {
      cwd: project,
      env: {
        ...process.env,
        YUANTU_BASE_URL: url,
        YUANTU_MODEL: 'fixture',
        YUANTU_MAX_CONTEXT_TOKENS: '128000',
        YUANTU_API_KEY: 'example-secret',
        /**
         * This fixture scripts one response per request, and the first one is the tool call this test is about.
         * The Host's session-naming call is a real request to the endpoint, so it must not be paid here;
         * `session-title.test.ts` is where that call is asserted, because counting it is its subject.
         */
        YUANTU_SESSION_TITLES: '0',
      },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let stdout = '',
    stderr = '';
  child.stdout.on('data', (data) => {
    stdout += data;
  });
  child.stderr.on('data', (data) => {
    stderr += data;
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
  t.after(() => clearTimeout(timer));
  const code = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });
  assert.equal(code, 0, stderr);
  const packets = stdout
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  const result = packets.find((packet) => packet.type === 'result');
  assert.equal(result.result.status, 'completed');
  assert.equal(result.result.text, 'The answer is 42');
  // Streamed text is what a client shows while the model is still typing, and it travels on its own
  // channel: a snapshot-only client would only ever see the finished answer.
  assert.ok(
    packets.some((packet) => packet.type === 'delta' && packet.delta.text.includes('Reading')),
    'the example receives streamed text on the delta channel',
  );
  assert.doesNotMatch(stdout, /example-secret/);
});

test('compiled background command resolves and cleans up its JavaScript supervisor', async (t) => {
  const previousSandbox = process.env.YUANTU_SANDBOX;
  process.env.YUANTU_SANDBOX = 'host';
  t.after(() => {
    if (previousSandbox === undefined) delete process.env.YUANTU_SANDBOX;
    else process.env.YUANTU_SANDBOX = previousSandbox;
  });
  const { createTools } = await import('../dist/packages/tools/index.js');
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-compiled-background-'));
  const tools = createTools(root);
  t.after(async () => {
    await tools.close();
    await rm(root, { recursive: true, force: true });
  });
  await writeFile(path.join(root, 'job.cjs'), 'console.log("COMPILED_WORKER_OK");');
  const ctx = { signal: new AbortController().signal, approve: async () => true };
  const started = await tools.execute(
    { id: 'start', name: 'start_command', arguments: { command: 'node job.cjs' } },
    ctx,
  );
  assert.equal(started.isError, false, started.content);
  const id = JSON.parse(started.content).id;
  let result;
  for (let i = 0; i < 50; i++) {
    const response = await tools.execute(
      { id: 'poll', name: 'job_output', arguments: { id, wait_ms: 50 } },
      ctx,
    );
    assert.equal(response.isError, false, response.content);
    result = JSON.parse(response.content);
    if (result.status === 'completed') break;
  }
  assert.equal(result.exitCode, 0);
  assert.match(result.output, /COMPILED_WORKER_OK/);
});

test('compiled programs resolve the JavaScript broker and guest beside the installed tools', async (t) => {
  const { createTools } = await import('../dist/packages/tools/index.js');
  const { executionPolicy } = await import('../dist/packages/tools/execution-policy.js');
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-compiled-program-'));
  const tools = createTools(root);
  t.after(async () => {
    await tools.close();
    await rm(root, { recursive: true, force: true });
  });
  await writeFile(path.join(root, 'answer.txt'), '42');
  const ctx = {
    signal: new AbortController().signal,
    approve: async () => true,
    executionPolicy: executionPolicy('host'),
  };
  const result = await tools.execute(
    {
      id: 'program',
      name: 'run_code',
      arguments: {
        code: "return (await tools.read_file({path:'answer.txt'})).includes('42') ? 'COMPILED_PROGRAM_OK' : 'missing';",
      },
    },
    {
      ...ctx,
      catalog: {
        specs: tools.specs({ mode: 'native' }),
        mode: (call) => tools.executionMode(call),
        parallelLimit: 2,
        invoke: (call, signal) => tools.execute(call, { ...ctx, signal: signal ?? ctx.signal }),
      },
    },
  );
  assert.equal(result.isError, false, result.content);
  assert.match(result.content, /COMPILED_PROGRAM_OK/);
});
