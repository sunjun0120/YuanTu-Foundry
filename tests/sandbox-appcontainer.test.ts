import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  appcontainerSandboxProvider,
  prepareAppContainer,
} from '../packages/tools/sandbox-appcontainer.ts';
import { runInNewContext } from 'node:vm';
import {
  appContainerRuntimeError,
  APPCONTAINER_CHILD_STDIO_PROBE,
} from '../packages/tools/appcontainer-runtime.ts';
import { windows } from './sandbox-appcontainer-fixture.ts';

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
