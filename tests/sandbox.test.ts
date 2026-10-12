import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { commandTool } from '../packages/tools/command.ts';
import { verifyAcceptance } from '../packages/core/acceptance.ts';
import { validationTools } from '../packages/tools/validation.ts';
import { BackgroundCommands } from '../packages/tools/background.ts';
import { sandboxProvider, registerSandboxProvider } from '../packages/tools/sandbox.ts';
import { executionPolicy } from '../packages/tools/execution-policy.ts';
import { parseArgs } from '../apps/shared/args.ts';
import { readConfig } from '../packages/providers/config.ts';
import { readSse } from '../packages/providers/sse.ts';
import { fetchModel } from '../packages/providers/http.ts';
import { httpFixture } from './http-fixture.ts';
import { OpenAIProvider } from '../packages/providers/openai.ts';

test('unavailable native runner fails closed for command, acceptance, validation and background execution', async (t) => {
  const original = sandboxProvider('native');
  registerSandboxProvider({
    ...original,
    capabilities: () => ({
      processFiles: 'workspace-write',
      network: 'denied',
      pathKind: 'local',
      links: 'refused',
    }),
    available: async () => 'Native fixture runner unavailable',
    prepare: async () => {
      throw new Error('unavailable provider must not prepare');
    },
  });
  const root = await mkdtemp(path.join(os.tmpdir(), 'native-unavailable-'));
  const old = process.env.YUANTU_SANDBOX;
  process.env.YUANTU_SANDBOX = 'native';
  const manager = new BackgroundCommands(root);
  t.after(async () => {
    await manager.close();
    registerSandboxProvider(original);
    if (old === undefined) delete process.env.YUANTU_SANDBOX;
    else process.env.YUANTU_SANDBOX = old;
    await rm(root, { recursive: true, force: true });
  });
  const context = {
    signal: new AbortController().signal,
    approve: async () => true,
    executionPolicy: executionPolicy('native'),
  };
  await assert.rejects(
    commandTool(root).execute({ command: 'echo escaped > escaped.txt' }, context),
    /Native fixture runner unavailable/,
  );
  await writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ scripts: { test: 'echo escaped > escaped.txt' } }),
  );
  await assert.rejects(
    validationTools(root)[1]!.execute({ id: 'npm:test' }, context),
    /Native fixture runner unavailable/,
  );
  await assert.rejects(
    manager.tools('native')[0]!.execute({ command: 'echo escaped > escaped.txt' }, context),
    /Native fixture runner unavailable/,
  );
  const outcome = await verifyAcceptance(
    root,
    [
      {
        id: 'no-fallback',
        kind: 'command',
        command: process.execPath,
        args: ['-e', 'require("fs").writeFileSync("escaped.txt","escaped")'],
        expectedExitCode: 0,
      },
    ],
    { approve: async () => true },
  );
  assert.equal(outcome.passed, false);
  await assert.rejects(readFile(path.join(root, 'escaped.txt')), { code: 'ENOENT' });
});

// ---- merged from runtime-limits.test.ts ----

test('undeclared runtime capacities remain available for automatic resolution', () => {
  /**
   * The window used to default to 1,000,000 for every protocol. That number is not this runtime's to choose:
   * a gateway serving 128k would be measured against it and the run that failed would be blamed on the
   * conversation. Undeclared stays distinct from a manual override so entry points can resolve it automatically.
   */
  const options = parseArgs([], {}).options;
  assert.equal(options.maxContextTokens, undefined);
  assert.equal(options.maxOutputTokens, undefined);
});

test('runtime limits from the selected desktop model reach Host arguments', () => {
  const env = {
    YUANTU_MAX_CONTEXT_TOKENS: '128000',
    YUANTU_AUTO_COMPACT_TOKENS: '100000',
    YUANTU_MAX_OUTPUT_TOKENS: '8192',
  };
  const options = parseArgs([], env).options;
  assert.equal(options.maxContextTokens, 128000);
  assert.equal(options.autoCompactTokens, 100000);
  assert.equal(options.maxOutputTokens, 8192);
  assert.equal(parseArgs(['--max-output-tokens', '4096'], env).options.maxOutputTokens, 4096);
  assert.throws(() => parseArgs([], { YUANTU_MAX_CONTEXT_TOKENS: 'nope' }));
});

test('model stream idle timeout is validated from the selected connection', () => {
  const env = {
    YUANTU_MODEL: 'fixture',
    YUANTU_MAX_CONTEXT_TOKENS: '128000',
    YUANTU_API_KEY: 'test',
    YUANTU_STREAM_IDLE_TIMEOUT_MS: '300000',
  };
  assert.equal(readConfig(env).streamIdleTimeoutMs, 300000);
  assert.throws(() => readConfig({ ...env, YUANTU_STREAM_IDLE_TIMEOUT_MS: '0' }));
});
test('SSE idle timeout resets on received chunks and stops stalled streams', async () => {
  const encoder = new TextEncoder();
  const timers: ReturnType<typeof setTimeout>[] = [];
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode('data: {"n":1}\n\n'));
      timers.push(setTimeout(() => controller.enqueue(encoder.encode('data: {"n":2}\n\n')), 20));
      timers.push(setTimeout(() => controller.enqueue(encoder.encode('data: {"n":3}\n\n')), 40));
      timers.push(setTimeout(() => controller.close(), 150));
    },
    cancel() {
      for (const timer of timers) clearTimeout(timer);
    },
  });
  const received: number[] = [];
  await assert.rejects(async () => {
    for await (const event of readSse(stream, new AbortController().signal, false, 35)) {
      received.push(event.n as number);
    }
  }, /idle|timeout/i);
  assert.deepEqual(received, [1, 2, 3]);
});
test('initial model response cannot wait indefinitely for headers', async (t) => {
  const url = await httpFixture(t, () => {});
  await assert.rejects(fetchModel(url, { method: 'POST', body: '{}' }, 40), /idle timeout/i);
});

test('provider reports initial response idle timeout to the run', async (t) => {
  const url = await httpFixture(t, () => {});
  const provider = new OpenAIProvider({
    apiKey: 'fixture',
    model: 'fixture',
    baseUrl: url,
    streamIdleTimeoutMs: 40,
  });
  await assert.rejects(
    provider.complete({
      system: 'test',
      messages: [{ role: 'user', content: 'hello' }],
      tools: [],
      maxOutputTokens: 16,
      signal: new AbortController().signal,
      onText: () => {},
    }),
    /idle timeout/i,
  );
});
