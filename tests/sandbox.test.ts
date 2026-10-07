import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveSandboxConfig, prepareSandbox } from '../packages/tools/sandbox.ts';
import { spawnSync } from 'node:child_process';
import { commandTool } from '../packages/tools/command.ts';
import { mcpTools } from '../packages/mcp/tools.ts';
import { verifyAcceptance } from '../packages/core/acceptance.ts';
import { validationTools } from '../packages/tools/validation.ts';
import { BackgroundCommands } from '../packages/tools/background.ts';
import { parseArgs } from '../apps/shared/args.ts';
import { readConfig } from '../packages/providers/config.ts';
import { readSse } from '../packages/providers/sse.ts';
import { fetchModel } from '../packages/providers/http.ts';
import { httpFixture } from './http-fixture.ts';
import { OpenAIProvider } from '../packages/providers/openai.ts';

// ---- merged from sandbox.test.ts ----

test('sandbox configuration rejects unknown modes and option-like images', () => {
  assert.equal(resolveSandboxConfig({}).mode, 'host');
  assert.equal(resolveSandboxConfig({ YUANTU_SANDBOX: 'sbx' }).mode, 'sbx');
  assert.equal(resolveSandboxConfig({ YUANTU_SANDBOX: 'docker' }).image, 'node:24-bookworm-slim');
  assert.throws(() => resolveSandboxConfig({ YUANTU_SANDBOX: 'other' }));
  assert.throws(() => resolveSandboxConfig({ YUANTU_SANDBOX_IMAGE: '--privileged' }));
});
test('docker invocation has bounded isolation and does not inherit secrets', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sandbox-'));
  try {
    await mkdir(path.join(root, '.yuantu'));
    await writeFile(path.join(root, '.yuantu', 'secret'), 'private');
    const plan = await prepareSandbox(root, root, 'echo hello', undefined, {
      mode: 'docker',
      image: 'node:24-bookworm-slim',
    });
    for (const flag of [
      '--pull=never',
      '--network=none',
      '--read-only',
      '--cap-drop=ALL',
      '--security-opt=no-new-privileges',
      '--pids-limit=128',
    ])
      assert.ok(plan.args.includes(flag));
    assert.ok(plan.args.some((v) => v.includes('readonly') && v.includes(root)));
    assert.ok(plan.args.includes('/workspace/.yuantu:ro,noexec,nosuid,nodev,size=1m'));
    assert.equal(plan.env.OPENAI_API_KEY, undefined);
    assert.equal(plan.env.NODE_OPTIONS, undefined);
    assert.ok(plan.containerName);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('docker refuses sensitive workspace files and out-of-root cwd', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sandbox-'));
  try {
    await writeFile(path.join(root, '.env'), 'KEY=secret');
    await assert.rejects(
      prepareSandbox(root, root, 'true', undefined, {
        mode: 'docker',
        image: 'node:24-bookworm-slim',
      }),
      /sensitive/i,
    );
    await assert.rejects(
      prepareSandbox(root, os.tmpdir(), 'true', undefined, {
        mode: 'docker',
        image: 'node:24-bookworm-slim',
      }),
      /outside/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

const context = () => ({ signal: new AbortController().signal, approve: async () => true });
test('Docker mode blocks native stdio MCP before spawning', async () => {
  const old = process.env.YUANTU_SANDBOX;
  process.env.YUANTU_SANDBOX = 'docker';
  const mcp = mcpTools(os.tmpdir(), [
    {
      id: 'local',
      transport: 'stdio',
      command: process.execPath,
      args: ['-e', 'process.exit(0)'],
      cwd: '.',
      env: {},
      headers: {},
    },
  ]);
  try {
    const result = await mcp.tools[0]!.execute({}, context());
    assert.equal(result.isError, true);
    assert.match(result.content, /native processes are blocked/);
  } finally {
    await mcp.close();
    if (old === undefined) delete process.env.YUANTU_SANDBOX;
    else process.env.YUANTU_SANDBOX = old;
  }
});
test('Docker mode rejects directory junctions', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sandbox-'));
  try {
    await symlink(
      os.tmpdir(),
      path.join(root, 'escape'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await assert.rejects(
      prepareSandbox(root, root, 'true', undefined, {
        mode: 'docker',
        image: 'node:24-bookworm-slim',
      }),
      /links/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('missing Docker engine fails closed without running the host command', async (t) => {
  if (!spawnSync('docker', ['--version'], { windowsHide: true }).error)
    return t.skip('Docker executable present; missing-engine case unavailable');
  const root = await mkdtemp(path.join(os.tmpdir(), 'sandbox-'));
  const old = process.env.YUANTU_SANDBOX;
  process.env.YUANTU_SANDBOX = 'docker';
  try {
    await assert.rejects(
      commandTool(root).execute({ command: 'echo escaped > escaped.txt' }, context()),
      /Docker CLI is unavailable/,
    );
    await assert.rejects(readFile(path.join(root, 'escaped.txt')), /ENOENT/);
  } finally {
    if (old === undefined) delete process.env.YUANTU_SANDBOX;
    else process.env.YUANTU_SANDBOX = old;
    await rm(root, { recursive: true, force: true });
  }
});
test(
  'real Docker denies workspace writes and hides internal state',
  {
    skip:
      process.env.YUANTU_TEST_DOCKER !== '1'
        ? 'Set YUANTU_TEST_DOCKER=1 with preinstalled Docker and local node image'
        : false,
  },
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sandbox-'));
    const old = process.env.YUANTU_SANDBOX;
    process.env.YUANTU_SANDBOX = 'docker';
    try {
      await mkdir(path.join(root, '.yuantu'));
      await writeFile(path.join(root, '.yuantu', 'secret'), 'secret');
      const result = await commandTool(root).execute(
        {
          command:
            'test ! -e /workspace/.yuantu/secret && ! touch /workspace/forbidden && echo isolated',
        },
        context(),
      );
      assert.equal(result.isError, false, result.content);
      assert.match(result.content, /isolated/);
      await assert.rejects(readFile(path.join(root, 'forbidden')), /ENOENT/);
    } finally {
      if (old === undefined) delete process.env.YUANTU_SANDBOX;
      else process.env.YUANTU_SANDBOX = old;
      await rm(root, { recursive: true, force: true });
    }
  },
);
test(
  'real sbx denies network and workspace writes, hides internal state, and cleans up',
  {
    skip:
      process.env.YUANTU_TEST_SBX !== '1'
        ? 'Set YUANTU_TEST_SBX=1 with a healthy local Docker Sandboxes service'
        : false,
    timeout: 660000,
  },
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sandbox-sbx-'));
    const previous = process.env.YUANTU_SANDBOX;
    process.env.YUANTU_SANDBOX = 'sbx';
    try {
      await mkdir(path.join(root, '.git'));
      await mkdir(path.join(root, '.yuantu'));
      await writeFile(path.join(root, '.git', 'config'), 'private');
      await writeFile(path.join(root, '.yuantu', 'session.db.example'), 'private');
      await writeFile(path.join(root, 'visible.txt'), 'visible');
      const result = await commandTool(root).execute(
        {
          command:
            'test -f visible.txt && test ! -e .git && test ! -e .yuantu && ! touch forbidden && if command -v getent >/dev/null; then ! getent hosts example.com >/dev/null 2>&1; fi && echo sbx-isolated',
          timeout_ms: 120000,
        },
        context(),
      );
      assert.equal(result.isError, false, result.content);
      assert.match(result.content, /sbx-isolated/);
      await assert.rejects(readFile(path.join(root, 'forbidden')), /ENOENT/);
      const listed = spawnSync('sbx', ['ls', '--json'], { encoding: 'utf8', windowsHide: true });
      assert.equal(listed.status, 0, listed.stderr);
      const sandboxes = JSON.parse(listed.stdout).sandboxes;
      assert.equal(
        sandboxes.some((item: { name?: string }) => item.name?.startsWith('yuantu-')),
        false,
      );
    } finally {
      if (previous === undefined) delete process.env.YUANTU_SANDBOX;
      else process.env.YUANTU_SANDBOX = previous;
      await rm(root, { recursive: true, force: true });
    }
  },
);

test('missing Docker never bypasses sandbox through acceptance, validation or background', async (t) => {
  if (!spawnSync('docker', ['--version'], { windowsHide: true }).error)
    return t.skip('Docker executable present');
  const root = await mkdtemp(path.join(os.tmpdir(), 'sandbox-'));
  const old = process.env.YUANTU_SANDBOX;
  process.env.YUANTU_SANDBOX = 'docker';
  const manager = new BackgroundCommands(root);
  try {
    const result = await verifyAcceptance(root, [
      {
        id: 'cmd',
        kind: 'command',
        command: process.execPath,
        args: ['-e', 'require("fs").writeFileSync("escaped.txt","escaped")'],
      },
    ]);
    assert.equal(result.passed, false);
    assert.match(result.checks[0]!.detail, /ENOENT/);
    await writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({ scripts: { test: 'echo escaped > escaped.txt' } }),
    );
    await assert.rejects(
      validationTools(root)[1]!.execute({ id: 'npm:test' }, context()),
      /Docker CLI is unavailable/,
    );
    await assert.rejects(
      manager.tools('sandbox')[0]!.execute({ command: 'echo escaped > escaped.txt' }, context()),
      /Docker CLI is unavailable/,
    );
    await assert.rejects(readFile(path.join(root, 'escaped.txt')), /ENOENT/);
  } finally {
    await manager.close().catch(() => {});
    if (old === undefined) delete process.env.YUANTU_SANDBOX;
    else process.env.YUANTU_SANDBOX = old;
    await rm(root, { recursive: true, force: true });
  }
});

test('Docker mode blocks native Git before repository filters can run', async () => {
  const { gitTools } = await import('../packages/tools/git.ts');
  const root = await mkdtemp(path.join(os.tmpdir(), 'sandbox-git-'));
  const previous = process.env.YUANTU_SANDBOX;
  process.env.YUANTU_SANDBOX = 'docker';
  try {
    for (const tool of gitTools(root))
      await assert.rejects(tool.execute({}, context()), /Native Git tools are disabled/);
  } finally {
    if (previous === undefined) delete process.env.YUANTU_SANDBOX;
    else process.env.YUANTU_SANDBOX = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test('docker allows a tracked environment template while still refusing real environment files', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sandbox-'));
  try {
    await writeFile(path.join(root, '.env.example'), 'API_KEY=\n');
    const plan = await prepareSandbox(root, root, 'true', undefined, {
      mode: 'docker',
      image: 'node:24-bookworm-slim',
    });
    assert.equal(plan.executable, 'docker');

    await writeFile(path.join(root, '.env.local'), 'API_KEY=secret\n');
    await assert.rejects(
      prepareSandbox(root, root, 'true', undefined, {
        mode: 'docker',
        image: 'node:24-bookworm-slim',
      }),
      /sensitive/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('sbx preflight reports an unavailable binary before inspecting workspace files', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sandbox-preflight-'));
  const previousPath = process.env.PATH;
  const previousPathAlias = process.env.Path;
  try {
    await writeFile(path.join(root, '.env'), 'KEY=private');
    process.env.PATH = '';
    process.env.Path = '';
    await assert.rejects(
      prepareSandbox(root, root, 'true', undefined, {
        mode: 'sbx',
        image: 'node:24-bookworm-slim',
      }),
      /sbx.*unavailable|sbx.*not found/i,
    );
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousPathAlias === undefined) delete process.env.Path;
    else process.env.Path = previousPathAlias;
    await rm(root, { recursive: true, force: true });
  }
});

test('sensitive nested workspace errors identify the relative file path', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sandbox-path-'));
  try {
    await mkdir(path.join(root, 'src', 'config'), { recursive: true });
    await writeFile(path.join(root, 'src', 'config', '.env'), 'KEY=private');
    await assert.rejects(
      prepareSandbox(root, root, 'true', undefined, {
        mode: 'docker',
        image: 'node:24-bookworm-slim',
      }),
      /src[\\/]config[\\/]\.env/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---- merged from runtime-limits.test.ts ----

test('an undeclared window stays undeclared, and the output cap keeps its default', () => {
  /**
   * The window used to default to 1,000,000 for every protocol. That number is not this runtime's to choose:
   * a gateway serving 128k would be measured against it and the run that failed would be blamed on the
   * conversation. Undeclared now means undeclared, and the run is refused where the model is configured.
   */
  const options = parseArgs([], {}).options;
  assert.equal(options.maxContextTokens, undefined);
  assert.equal(options.maxOutputTokens, 256000);
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
