import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { HookRegistry } from '../packages/tools/hooks.ts';
import { ToolRegistry } from '../packages/tools/registry.ts';
import { Agent } from '../packages/core/agent.ts';
import { SessionStore } from '../packages/storage/sqlite.ts';
import { currentExecutionPolicy } from '../packages/sandbox/execution-policy.ts';
import { installHookBridge } from '../packages/resources/hook-bridge.ts';
import { executionPolicy, withExecutionPolicy } from '../packages/sandbox/execution-policy.ts';
import {
  registerSandboxProvider,
  sandboxProvider,
  resolveSandboxConfig,
} from '../packages/sandbox/sandbox.ts';

test('hook inherits the live call file and network policy instead of the launch default', () => {
  withExecutionPolicy(
    executionPolicy('seatbelt', { files: 'read-only', network: 'denied' }),
    () => {
      const config = resolveSandboxConfig({ YUANTU_SANDBOX: 'host' }, 'hook');
      assert.equal(config.mode, 'seatbelt');
      assert.equal(config.files, 'read-only');
      assert.equal(config.network, 'denied');
    },
  );
});

test('a hook timeout cannot allow execution after failed sandbox cleanup', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yuantu-hook-cleanup-'));
  await writeFile(path.join(root, 'wait.cjs'), 'setInterval(()=>{},1000)');
  const original = sandboxProvider('host');
  const hooks = new HookRegistry();
  registerSandboxProvider({
    ...original,
    cleanup: async () => {
      throw new Error('fixture lease restoration failed');
    },
  });
  t.after(async () => {
    registerSandboxProvider(original);
    await hooks.close();
    await rm(root, { recursive: true, force: true });
  });
  installHookBridge({
    workspace: root,
    hooks,
    declarations: [
      {
        event: 'PreToolUse',
        command: 'node wait.cjs',
        timeoutMs: 150,
        file: 'fixture',
      },
    ],
  });
  const outcome = await withExecutionPolicy(executionPolicy('host'), () =>
    hooks.runGuards(
      {
        tool: 'write_file',
        attempt: 1,
        call: {
          id: 'write',
          name: 'write_file',
          arguments: { path: 'must-not-run.txt', content: 'forbidden' },
        },
      },
      [],
      new AbortController().signal,
    ),
  );
  assert.match(outcome ?? '', /guard failed.*fixture lease restoration failed/);
});

test('an explicit hook backend override retains the call file and network requirements', () => {
  withExecutionPolicy(
    executionPolicy('seatbelt', { files: 'read-only', network: 'denied' }),
    () => {
      const config = resolveSandboxConfig({ YUANTU_SANDBOX_HOOK: 'host' }, 'hook');
      assert.equal(config.mode, 'host');
      assert.equal(config.files, 'read-only');
      assert.equal(config.network, 'denied');
      assert.throws(() => executionPolicy(config.mode, config), /network/);
    },
  );
});

test('prompt and stop hooks execute under the current session policy', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yuantu-hook-session-'));
  const store = new SessionStore(':memory:');
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const session = store.create(root);
  const observed: unknown[] = [];
  const hooks = new HookRegistry();
  hooks.register({
    promptSubmit: () => {
      observed.push(currentExecutionPolicy());
    },
    stop: () => {
      observed.push(currentExecutionPolicy());
    },
  });
  const tools = new ToolRegistry(hooks);
  const policy = executionPolicy('seatbelt', { network: 'denied', files: 'read-only' });
  const agent = new Agent({
    store,
    tools,
    executionPolicy: () => policy,
    provider: {
      complete: async () => ({
        text: 'Done',
        toolCalls: [],
        finishReason: 'stop',
        usage: { inputTokens: 0, outputTokens: 0 },
      }),
    },
    approve: async () => true,
    onEvent: () => {},
  });
  assert.equal((await agent.run({ sessionId: session.id, prompt: 'hello' })).status, 'completed');
  assert.deepEqual(observed, [policy, policy]);
});
