import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  appcontainerSandboxProvider,
  prepareAppContainer,
} from '../packages/tools/sandbox-appcontainer.ts';
import { runInNewContext } from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import {
  appContainerRuntimeError,
  APPCONTAINER_CHILD_STDIO_PROBE,
} from '../packages/tools/appcontainer-runtime.ts';
import { windows } from './sandbox-appcontainer-fixture.ts';
import { RetryableCleanup } from '../packages/tools/cleanup-sequence.ts';
import { createOwnedFileLease } from '../packages/tools/owned-file-lease.ts';
import { finalizeAppContainerProbe } from '../packages/tools/appcontainer-runtime.ts';
import { open, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { tempRoot } from './temp-fixture.ts';

test('AppContainer cleanup retains confirmed termination across partial control deletion', async () => {
  // Execute the production cleanup boundary with OS operations faulted. No machine grants or profiles.
  const source = await readFile(
    new URL('../packages/tools/sandbox-appcontainer.ts', import.meta.url),
    'utf8',
  );
  const start = source.indexOf('export async function cleanupAppContainer(');
  const end = source.indexOf('\nasync function terminated(', start);
  const markStart = source.indexOf('export function markAppContainerStarted(');
  const markEnd = source.indexOf('\nexport async function stopAppContainer(', markStart);
  const plan = {};
  const resource = {
    started: true,
    pooled: true,
    profile: 'fixture',
    cleanup: new RetryableCleanup(),
    control: 'fixture-control',
    scratch: 'fixture-scratch',
  };
  const owned = new Map([[plan, resource]]);
  const activeProfiles = new Set(['fixture']);
  let complete = true;
  let attempts = 0;
  let confirmations = 0;
  const { cleanup, mark } = runInNewContext(
    stripTypeScriptTypes(
      source.slice(start, end).replace('export ', '') +
        source.slice(markStart, markEnd).replace('export ', ''),
    ) + '\n({cleanup: cleanupAppContainer, mark: markAppContainerStarted})',
    {
      owned,
      activeProfiles,
      releasing: new WeakSet(),
      terminated: async () => {
        confirmations++;
        return complete;
      },
      acl: async () => {},
      releaseWorkspace: async () => {},
      rm: async (directory: string) => {
        if (directory !== resource.control) return;
        complete = false; // complete.json was removed before a later busy entry failed.
        if (++attempts === 1) throw Error('EPERM: busy control entry');
      },
    },
  ) as { cleanup: (plan: object) => Promise<void>; mark: (plan: object) => void };
  await assert.rejects(cleanup(plan), /busy control entry/);
  assert.throws(() => mark(plan), /already released/);
  assert.equal(activeProfiles.has('fixture'), true);
  await cleanup(plan);
  assert.equal(attempts, 2);
  assert.equal(confirmations, 1);
  assert.equal(owned.has(plan), false);
  assert.equal(activeProfiles.size, 0);

  const unknown = { ...resource, cleanup: new RetryableCleanup() };
  const unknownPlan = {};
  owned.set(unknownPlan, unknown);
  activeProfiles.add('fixture');
  await assert.rejects(cleanup(unknownPlan), /termination was not acknowledged/);
  assert.throws(() => mark(unknownPlan), /only be started once/);
  await assert.rejects(cleanup(unknownPlan), /termination was not acknowledged/);
  assert.equal(attempts, 2, 'unknown termination must not delete resources');
  assert.equal(owned.has(unknownPlan), true);
});

test('failed cleanup can retry without releasing a completed workspace lease twice', async () => {
  const cleanup = new RetryableCleanup();
  const calls: string[] = [];
  let fail = true;
  const steps = [
    {
      id: 'workspace',
      run: async () => {
        calls.push('workspace');
      },
    },
    {
      id: 'profile',
      run: async () => {
        calls.push('profile');
        if (fail) throw Error('delete refused');
      },
    },
    {
      id: 'scratch',
      run: async () => {
        calls.push('scratch');
      },
    },
  ];
  await assert.rejects(cleanup.run(steps), /delete refused/);
  assert.deepEqual(calls, ['workspace', 'profile']);
  fail = false;
  await Promise.all([cleanup.run(steps), cleanup.run(steps)]);
  assert.deepEqual(calls, ['workspace', 'profile', 'profile', 'scratch']);
});

test('probe cleanup failure returns an unavailable reason and retains the unconfirmed workspace', async (t) => {
  const root = await tempRoot(t, 'yuantu-probe-retention-');
  const result = await finalizeAppContainerProbe(
    null,
    async () => {
      throw Error('termination not acknowledged');
    },
    () => rm(root, { recursive: true, force: true }),
  );
  assert.match(result!, /cleanup.*termination not acknowledged/);
  assert.equal((await stat(root)).isDirectory(), true);
});

for (const operation of ['writeFile', 'sync'] as const) {
  test(`a failed lease ${operation} releases only its own newly created lock`, async (t) => {
    const root = await tempRoot(t, 'yuantu-lease-failure-');
    const sample = await open(path.join(root, 'sample'), 'wx');
    const prototype = Object.getPrototypeOf(sample);
    await sample.close();
    const fault = t.mock.method(prototype, operation, async () => {
      throw Error('fixture disk failure');
    });
    const file = path.join(root, 'owner.lock');
    await assert.rejects(createOwnedFileLease(file, { pid: process.pid }), /fixture disk failure/);
    fault.mock.restore();
    await assert.rejects(stat(file), { code: 'ENOENT' });
    const lease = await createOwnedFileLease(file, { pid: process.pid });
    await assert.rejects(createOwnedFileLease(file, { pid: 1 }), { code: 'EEXIST' });
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { pid: process.pid });
    await lease.release();
    await lease.release();
    await assert.rejects(stat(file), { code: 'ENOENT' });
  });
}

test('AppContainer refuses unrestricted networking without fallback', windows, async () => {
  await assert.rejects(
    prepareAppContainer({
      root: process.cwd(),
      cwd: process.cwd(),
      command: process.execPath,
      argv: ['-e', ''],
      config: { mode: 'appcontainer' as never, image: 'native', network: 'unrestricted' },
    }),
    /denied network only/,
  );
});

test('AppContainer runtime versions are identity metadata, not capability evidence', () => {
  for (const uv of [undefined, 'unknown', '1.52', '1.52.1\n'])
    assert.match(appContainerRuntimeError(uv)!, /identity/);
  for (const uv of ['1.52.1', '1.9.9', '1.53.0', '1.54.1', '2.0.0'])
    assert.equal(appContainerRuntimeError(uv), null);
});

test('AppContainer child stdio probe rejects spawn failure, timeout, nonzero exit and broken channels', () => {
  const success = { status: 0, stdout: 'yuantu-stdin', stderr: 'yuantu-stderr' };
  const stages: string[] = [];
  const probe = (result: object) =>
    runInNewContext(APPCONTAINER_CHILD_STDIO_PROBE, {
      process: { execPath: 'C:\\runtime\\node.exe' },
      recordAppContainerProbeStage: (stage: string) => stages.push(stage),
      require: (name: string) => {
        assert.equal(name, 'node:child_process');
        return {
          spawnSync: (
            file: string,
            args: string[],
            options: { input: string; timeout: number },
          ) => {
            assert.equal(file, 'C:\\runtime\\node.exe');
            assert.equal(args[0], '-e');
            assert.equal(options.input, 'yuantu-stdin');
            assert.ok(options.timeout > 0);
            return result;
          },
        };
      },
    });
  assert.doesNotThrow(() => probe(success));
  assert.deepEqual(stages, ['child-stdio-started', 'child-spawn-returned', 'child-stdio-passed']);
  for (const result of [
    { ...success, error: { code: 'EPERM' } },
    { ...success, error: { code: 'ETIMEDOUT' }, status: null },
    { ...success, status: 1 },
    { ...success, stdout: '' },
    { ...success, stderr: '' },
  ])
    assert.throws(() => probe(result), /child stdio capability probe failed/);
});

test('AppContainer failure diagnostics distinguish an actual cancelled phase from an unknown stage', async () => {
  const runtime = await import('../packages/tools/appcontainer-runtime.ts');
  const format = (
    runtime as unknown as {
      appContainerProbeFailure: (stage: unknown, cancelled: boolean, error: unknown) => string;
    }
  ).appContainerProbeFailure;
  assert.equal(typeof format, 'function');
  assert.match(
    format('child-stdio-started', true, Error('helper exit 1')),
    /timed out during child-stdio-started/,
  );
  assert.match(
    format('network-started', false, Error('EPERM')),
    /failed during network-started.*EPERM/,
  );
  for (const stage of [null, { stage: 'fake' }, 'untrusted-path-and-secret']) {
    const result = format(stage, true, Error('helper exit 1'));
    assert.match(result, /unknown/);
    assert.doesNotMatch(result, /untrusted-path-and-secret/);
  }
});

test('AppContainer public execution refuses a failed capability probe before preparing a workload', async () => {
  const original = appcontainerSandboxProvider.available;
  appcontainerSandboxProvider.available = async () =>
    'AppContainer enforcement probe failed: child stdio capability probe failed: EPERM';
  try {
    await assert.rejects(
      prepareAppContainer({
        root: 'nonexistent-workspace-must-not-be-prepared',
        cwd: 'nonexistent-workspace-must-not-be-prepared',
        command: process.execPath,
        argv: ['-e', 'throw Error("must not execute")'],
        config: { mode: 'appcontainer' as never, image: 'native', network: 'denied' },
      }),
      /child stdio capability probe failed: EPERM/,
    );
  } finally {
    appcontainerSandboxProvider.available = original;
  }
});
