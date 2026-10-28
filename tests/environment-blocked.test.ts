import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ToolRegistry } from '../packages/tools/registry.ts';
import { executionPolicy } from '../packages/tools/execution-policy.ts';
import { registerSandboxProvider, sandboxProvider } from '../packages/tools/sandbox.ts';
import {
  EnvironmentBlockedError,
  environmentBlockedCode,
} from '../packages/protocol/environment-blocked.ts';
import {
  inspectWindowsSandboxLeases,
  leaseBlockedError,
  recoverWindowsSandboxLeases,
} from '../packages/tools/windows-sandbox-recovery.ts';
import { ToolProgressGuard } from '../packages/core/tool-progress.ts';
import type { Approval } from '../packages/protocol/index.ts';

test('a command the backend would refuse anyway is refused before anyone is asked to approve it', async (t) => {
  const host = sandboxProvider('host');
  let blocker: Error | undefined = new EnvironmentBlockedError(
    'windows-sandbox-stale-lease',
    'A dead process left the lease.',
    'Run sandbox-recover.',
  );
  registerSandboxProvider({ ...host, blocked: async () => blocker });
  t.after(() => registerSandboxProvider(host));
  const registry = new ToolRegistry();
  let ran = 0;
  registry.register({
    name: 'fake_command',
    description: 'A command-permission tool.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    permission: 'command',
    execute: async () => {
      ran++;
      return { content: 'ran', isError: false };
    },
  });
  const approvals: Approval[] = [];
  const context = {
    signal: new AbortController().signal,
    approve: async (approval: Approval) => {
      approvals.push(approval);
      return true;
    },
    executionPolicy: executionPolicy('host'),
  };
  const refused = await registry.execute({ id: '1', name: 'fake_command', arguments: {} }, context);
  assert.equal(refused.isError, true);
  assert.equal(environmentBlockedCode(refused.content), 'windows-sandbox-stale-lease');
  assert.match(refused.content, /Do not retry/);
  assert.equal(approvals.length, 0);
  assert.equal(ran, 0);
  // Once the machine is fixed, the same call is offered for approval as before.
  blocker = undefined;
  const allowed = await registry.execute({ id: '2', name: 'fake_command', arguments: {} }, context);
  assert.equal(allowed.isError, false);
  assert.equal(approvals.length, 1);
});

test('refusals by one environment blocker are counted by blocker, not by call', () => {
  const guard = new ToolProgressGuard();
  const blocked = (command: string, code = 'windows-sandbox-stale-lease') => ({
    call: { id: command, name: 'run_command', arguments: { command } },
    result: {
      isError: true,
      content: new EnvironmentBlockedError(code, 'Blocked.', 'Fix it.').message,
    },
  });
  // Two different commands refused by the same blocker: the second is already a repeat.
  assert.equal(guard.observeRound([blocked('npm test')]), 'continue');
  assert.equal(guard.observeRound([blocked('node --test')]), 'environment-blocked');
  assert.equal(guard.observeRound([blocked('npx tsc')]), 'conclude');
  // A person stepping in starts the count over.
  guard.reset();
  assert.equal(guard.observeRound([blocked('npm test')]), 'continue');
  // Several refusals in one round count once; another blocker is counted on its own.
  guard.reset();
  assert.equal(guard.observeRound([blocked('a'), blocked('b')]), 'continue');
  assert.equal(guard.observeRound([blocked('c', 'office-pdf-engine-unavailable')]), 'continue');
});

async function leaseDirectory(t: test.TestContext) {
  const directory = await mkdtemp(path.join(tmpdir(), 'yuantu-lease-state-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
const ROOT_LOCK = 'a'.repeat(64);

test('the lease directory is classified by who left it', async (t) => {
  const directory = await leaseDirectory(t);
  const dead = () => false;
  assert.equal((await inspectWindowsSandboxLeases(directory, dead)).state, 'clear');
  await writeFile(path.join(directory, 'workspace-owner.lock'), JSON.stringify({ pid: 4242 }));
  assert.equal((await inspectWindowsSandboxLeases(directory, dead)).state, 'stale');
  assert.equal((await inspectWindowsSandboxLeases(directory, (pid) => pid === 4242)).state, 'held');
  await writeFile(
    path.join(directory, `${ROOT_LOCK}.lock`),
    JSON.stringify({ pid: 4242, root: 'C:\\work', journal: 'x' }),
  );
  await writeFile(path.join(directory, `${ROOT_LOCK}.json`), '{}');
  const report = await inspectWindowsSandboxLeases(directory, dead);
  assert.equal(report.state, 'needs-restore');
  const error = leaseBlockedError(report);
  assert.equal(error.code, 'windows-sandbox-needs-restore');
  assert.match(error.message, /pid 4242/);
  assert.match(error.message, /sandbox-recover/);
  // A lock nobody can attribute is not guessed dead; a fresh one is a lease being published.
  await writeFile(path.join(directory, 'b.lock'), '');
  assert.equal((await inspectWindowsSandboxLeases(directory, dead)).state, 'held');
});

test('recovery restores every journal before it removes any lock, and refuses a live owner', async (t) => {
  const directory = await leaseDirectory(t);
  const owner = path.join(directory, 'workspace-owner.lock');
  const rootLock = path.join(directory, `${ROOT_LOCK}.lock`);
  const journal = path.join(directory, `${ROOT_LOCK}.json`);
  await writeFile(owner, JSON.stringify({ pid: 4242 }));
  await writeFile(rootLock, JSON.stringify({ pid: 4242 }));
  await writeFile(journal, '\uFEFF' + JSON.stringify({ root: 'C:\\work', sid: 'S-1-9-1' }));
  await writeFile(`${journal}.next`, '{}');

  await assert.rejects(
    recoverWindowsSandboxLeases(
      directory,
      () => true,
      async () => assert.fail('restored'),
    ),
    (error: Error) =>
      error instanceof EnvironmentBlockedError && error.code === 'windows-sandbox-in-use',
  );

  const restored: string[][] = [];
  await assert.rejects(
    recoverWindowsSandboxLeases(
      directory,
      () => false,
      async () => {
        throw new Error('ACL changed during sandbox execution');
      },
    ),
    /ACL changed/,
  );
  // A failed restore releases nothing.
  assert.equal((await readdir(directory)).length, 4);

  const result = await recoverWindowsSandboxLeases(
    directory,
    () => false,
    async (root, file, sid) => {
      restored.push([root, file, sid]);
      // The journal helper removes the journal once the permissions are back.
      await rm(file);
    },
  );
  assert.deepEqual(restored, [['C:\\work', journal, 'S-1-9-1']]);
  assert.deepEqual(result.restored, ['C:\\work']);
  assert.equal(path.basename(result.removed.at(-1)!), 'workspace-owner.lock');
  assert.deepEqual(await readdir(directory), []);
});
