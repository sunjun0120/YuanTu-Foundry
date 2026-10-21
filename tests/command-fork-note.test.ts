/**
 * What a sandboxed command says when it could not start its own child process.
 *
 * A test runner that forks (`node --test`, vitest, jest) fails inside the Windows restricted-token sandbox with
 * `spawn EPERM`, and the result used to be the raw stack alone: neither the model nor the person could tell that
 * the command was fine and the environment was not. The note is added only when the backend that ran the command
 * is the Windows one and the output carries the signature — a command that legitimately prints "EPERM" on
 * another backend is not relabelled.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { commandTool } from '../packages/tools/command.ts';
import {
  registerSandboxProvider,
  sandboxProvider,
  type SandboxPlan,
} from '../packages/tools/sandbox.ts';
import { sandboxChildSpawnBlocked } from '../packages/tools/sandbox-launch-failure.ts';

const node = (script: string): SandboxPlan['args'] => ['-e', script];

function planFor(root: string, backend: SandboxPlan['backend'], script: string): SandboxPlan {
  return {
    executable: process.execPath,
    args: node(script),
    cwd: root,
    env: process.env,
    windowsVerbatimArguments: false,
    ...(backend ? { backend } : {}),
  };
}

async function runReported(
  root: string,
  backend: SandboxPlan['backend'],
  script: string,
): Promise<{ isError: boolean; payload: Record<string, unknown>; output?: unknown }> {
  const original = sandboxProvider('host');
  registerSandboxProvider({ ...original, prepare: async () => planFor(root, backend, script) });
  try {
    const tool = commandTool(root);
    const result = await tool.execute(
      { command: 'node --test' },
      { signal: new AbortController().signal, approve: async () => true },
    );
    return {
      isError: result.isError,
      payload: JSON.parse(result.content) as Record<string, unknown>,
      ...(result.output ? { output: result.output } : {}),
    };
  } finally {
    registerSandboxProvider(original);
  }
}

test('a Windows sandboxed command that cannot fork says why', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yuantu-command-fork-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const { isError, payload, output } = await runReported(
    root,
    'windows',
    "console.error('Error: spawn EPERM'); process.exit(1)",
  );
  assert.equal(isError, true);
  assert.match(String(payload.sandboxNote), /child process/i);
  assert.match(String(payload.sandboxNote), /node --test/);
  // The structured payload is what the desktop card reads; the same note must be there, not only in the text
  // form the model sees.
  const structured = output as { value?: Record<string, unknown> } | undefined;
  assert.match(String(structured?.value?.sandboxNote), /child process/i);
  // The exit code and the raw output stay exactly as the command produced them.
  assert.equal(payload.exitCode, 1);
  assert.match(String(payload.stderr), /spawn EPERM/);
});

test('the same failure on another backend, or a clean result, is not relabelled', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yuantu-command-fork-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  // A host command may print EPERM for its own reasons; the note names the Windows sandbox, so it does not apply.
  const host = await runReported(
    root,
    'host',
    "console.error('Error: spawn EPERM'); process.exit(1)",
  );
  assert.equal(host.isError, true);
  assert.equal(host.payload.sandboxNote, undefined);
  // A successful Windows command has no note either.
  const ok = await runReported(root, 'windows', 'console.log("2 passing")');
  assert.equal(ok.isError, false);
  assert.equal(ok.payload.sandboxNote, undefined);
});

test('the signature is narrow enough for a command that merely mentions EPERM', () => {
  assert.equal(sandboxChildSpawnBlocked('Error: spawn EPERM\n  at ChildProcess.spawn'), true);
  assert.equal(sandboxChildSpawnBlocked('EPERM (-4048) spawnSync node.exe EPERM'), true);
  // A report about a permission code, without a failed spawn, is not the sandbox refusing to fork.
  assert.equal(sandboxChildSpawnBlocked('tests failed: expected EPERM handling'), false);
  assert.equal(sandboxChildSpawnBlocked('write failed: EPERM'), false);
});
