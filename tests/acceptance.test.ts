import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  capturePathSnapshot,
  verifyAcceptance,
  MAX_CHECKS,
} from '../packages/core/completion/acceptance.ts';
import { executionPolicy, withExecutionPolicy } from '../packages/sandbox/execution-policy.ts';
import { EnvironmentBlockedError } from '../packages/protocol/environment-blocked.ts';
import {
  SANDBOX_LAUNCH_FAILED_EXIT,
  SANDBOX_LAUNCH_FAILED_PREFIX,
} from '../packages/sandbox/sandbox-launch-failure.ts';
import { verifyCompletionAcceptance } from '../packages/core/completion/task-acceptance.ts';
import {
  registerSandboxProvider,
  sandboxProvider,
  type SandboxPlan,
} from '../packages/sandbox/sandbox.ts';

test('one sandbox startup blocker skips remaining commands but still checks files', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yuantu-acceptance-blocked-'));
  const original = sandboxProvider('host');
  let preparations = 0;
  registerSandboxProvider({
    ...original,
    prepare: async () => {
      preparations++;
      throw new EnvironmentBlockedError(
        'windows-sandbox-acl-failed',
        'Windows sandbox refuses reparse points in ACL trees: fixture/link',
        'Resolve the workspace link.',
      );
    },
  });
  t.after(async () => {
    registerSandboxProvider(original);
    await rm(root, { recursive: true, force: true });
  });
  await writeFile(path.join(root, 'out.txt'), 'ok');
  const result = await withExecutionPolicy(executionPolicy('host'), () =>
    verifyAcceptance(root, [
      { id: 'first', kind: 'command', command: process.execPath },
      { id: 'second', kind: 'command', command: process.execPath },
      { id: 'file', kind: 'file-exact', path: 'out.txt', expected: 'ok' },
    ]),
  );
  assert.equal(preparations, 1);
  assert.equal(result.passed, false);
  assert.equal(result.checks[1]?.failureReason, 'environment-error');
  assert.match(result.checks[1]!.detail, /Not executed.*first/);
  assert.equal(result.checks[1]?.command, undefined);
  assert.equal(result.checks[2]?.passed, true);
  const verdict = await withExecutionPolicy(executionPolicy('host'), () =>
    verifyCompletionAcceptance(
      root,
      [
        {
          description: 'check',
          met: false,
          check: { id: 'first', kind: 'command', command: process.execPath },
        },
      ],
      [],
      {},
    ),
  );
  assert.match(verdict.error!, /blocked by the execution environment/);
  assert.match(verdict.error!, /fixture\/link/);
});

test('a command-specific preparation failure does not suppress independent command checks', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yuantu-acceptance-independent-'));
  const original = sandboxProvider('host');
  registerSandboxProvider({
    ...original,
    prepare: async (request) => {
      if (request.command === '-invalid')
        throw new Error('Sandbox executable cannot begin with an option');
      return original.prepare(request);
    },
  });
  t.after(async () => {
    registerSandboxProvider(original);
    await rm(root, { recursive: true, force: true });
  });
  const result = await withExecutionPolicy(executionPolicy('host'), () =>
    verifyAcceptance(root, [
      { id: 'invalid', kind: 'command', command: '-invalid' },
      { id: 'valid', kind: 'command', command: process.execPath, args: ['-e', 'process.exit(0)'] },
    ]),
  );
  assert.equal(result.checks[0]?.passed, false);
  assert.equal(result.checks[1]?.passed, true);
});

test('a launcher that cannot start the image is an environment blocker, not a failed assertion', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yuantu-acceptance-launch-'));
  const original = sandboxProvider('host');
  registerSandboxProvider({
    ...original,
    prepare: async (request) => {
      const plan = await original.prepare(request);
      // What the Windows launcher now does when `CreateProcessAsUser` cannot start the image at all.
      plan.executable = process.execPath;
      plan.args = [
        '-e',
        `console.error(${JSON.stringify(SANDBOX_LAUNCH_FAILED_PREFIX + 'CreateProcessAsUser 系统找不到指定的文件')});process.exit(${SANDBOX_LAUNCH_FAILED_EXIT})`,
      ];
      return plan;
    },
  });
  t.after(async () => {
    registerSandboxProvider(original);
    await rm(root, { recursive: true, force: true });
  });
  const spec = [{ id: 'launch', kind: 'command' as const, command: 'npm', args: ['test'] }];
  const result = await withExecutionPolicy(executionPolicy('host'), () =>
    verifyAcceptance(root, spec),
  );
  assert.equal(result.passed, false);
  assert.equal(result.checks[0]?.failureReason, 'environment-error');
  assert.match(result.checks[0]!.detail, /could not start the command/);
  assert.match(result.checks[0]!.detail, /CreateProcessAsUser/);
  // The classification is what stops the repair loop: `decideCompletion` only hands `assertion-failed` back to
  // the model, and the verdict says so in words the person reading the result can act on.
  const verdict = await withExecutionPolicy(executionPolicy('host'), () =>
    verifyCompletionAcceptance(
      root,
      [{ description: 'tests run', met: false, check: spec[0]! }],
      [],
      {},
    ),
  );
  assert.equal(verdict.passed, false);
  assert.match(verdict.error!, /blocked by the execution environment/);
});

test('a Windows-sandboxed command that cannot fork is an environment blocker, not a failed assertion', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yuantu-acceptance-fork-'));
  const original = sandboxProvider('host');
  registerSandboxProvider({
    ...original,
    prepare: async (request) => {
      const plan = await original.prepare(request);
      // What `node --test` reports after the restricted token refuses its per-file child process.
      plan.backend = 'windows';
      plan.executable = process.execPath;
      plan.args = ['-e', "console.error('Error: spawn EPERM');process.exit(1)"];
      return plan;
    },
  });
  t.after(async () => {
    registerSandboxProvider(original);
    await rm(root, { recursive: true, force: true });
  });
  const result = await withExecutionPolicy(executionPolicy('host'), () =>
    verifyAcceptance(root, [{ id: 'fork', kind: 'command', command: 'npm', args: ['test'] }]),
  );
  assert.equal(result.passed, false);
  assert.equal(result.checks[0]?.failureReason, 'environment-error');
  assert.match(result.checks[0]!.detail, /could not create a child process/);
  assert.match(result.checks[0]!.detail, /not a failing test/);
});

test('a host command that reports spawn EPERM keeps its own assertion failure', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yuantu-acceptance-fork-host-'));
  const original = sandboxProvider('host');
  registerSandboxProvider({
    ...original,
    prepare: async (request) => {
      const plan = await original.prepare(request);
      plan.backend = 'host';
      plan.executable = process.execPath;
      plan.args = ['-e', "console.error('Error: spawn EPERM');process.exit(1)"];
      return plan;
    },
  });
  t.after(async () => {
    registerSandboxProvider(original);
    await rm(root, { recursive: true, force: true });
  });
  const result = await withExecutionPolicy(executionPolicy('host'), () =>
    verifyAcceptance(root, [{ id: 'fork', kind: 'command', command: 'npm', args: ['test'] }]),
  );
  assert.equal(result.checks[0]?.failureReason, 'assertion-failed');
});

test('an ordinary exit code 125 without the launcher marker stays an assertion failure', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yuantu-acceptance-125-'));
  const original = sandboxProvider('host');
  registerSandboxProvider({
    ...original,
    prepare: async (request) => {
      const plan = await original.prepare(request);
      // Same code, no marker: a command is free to choose 125 as its own failure code.
      plan.executable = process.execPath;
      plan.args = ['-e', 'console.error("suite exploded");process.exit(125)'];
      return plan;
    },
  });
  t.after(async () => {
    registerSandboxProvider(original);
    await rm(root, { recursive: true, force: true });
  });
  const result = await withExecutionPolicy(executionPolicy('host'), () =>
    verifyAcceptance(root, [{ id: 'code', kind: 'command', command: 'npm', args: ['test'] }]),
  );
  assert.equal(result.checks[0]?.passed, false);
  assert.equal(result.checks[0]?.failureReason, 'assertion-failed');
});

for (const scenario of [
  'normal',
  'cancel-before-start',
  'cancel-after-start',
  'timeout',
  'spawn-error',
  'cleanup-error',
] as const) {
  test(`acceptance command owns startup and resource cleanup (${scenario})`, async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'yuantu-acceptance-lifecycle-'));
    const original = sandboxProvider('host');
    const controller = new AbortController();
    let prepared: SandboxPlan | undefined;
    let started = 0;
    let cleaned = 0;
    registerSandboxProvider({
      ...original,
      prepare: async (request) => {
        prepared = await original.prepare(request);
        if (scenario === 'cancel-before-start')
          controller.abort(new Error('fixture canceled during prepare'));
        if (scenario === 'spawn-error') prepared.executable = path.join(root, 'missing-executable');
        return prepared;
      },
      started: (plan) => {
        assert.equal(plan, prepared);
        started++;
        if (scenario === 'cancel-after-start')
          setTimeout(() => controller.abort(new Error('fixture canceled after start')), 100);
      },
      cleanup: async (plan) => {
        assert.equal(plan, prepared);
        cleaned++;
        if (scenario === 'cleanup-error') throw new Error('fixture lease cleanup failed');
      },
    });
    t.after(async () => {
      registerSandboxProvider(original);
      await rm(root, { recursive: true, force: true });
    });
    const run = () =>
      withExecutionPolicy(executionPolicy('host'), () =>
        verifyAcceptance(
          root,
          [
            {
              id: 'lifecycle',
              kind: 'command',
              command: process.execPath,
              args: [
                '-e',
                scenario === 'timeout' || scenario === 'cancel-after-start'
                  ? 'setTimeout(()=>process.exit(0),10000);setInterval(()=>{},1000)'
                  : 'console.log("accepted")',
              ],
              ...(scenario === 'timeout' ? { timeoutMs: 100 } : {}),
            },
          ],
          { signal: controller.signal },
        ),
      );
    if (scenario === 'cancel-before-start' || scenario === 'cancel-after-start') {
      await assert.rejects(run(), /fixture canceled/);
      assert.equal(started, scenario === 'cancel-before-start' ? 0 : 1);
    } else {
      const result = await run();
      assert.equal(started, 1);
      assert.equal(result.passed, scenario === 'normal');
      if (scenario === 'spawn-error') assert.match(result.checks[0]!.detail, /ENOENT/);
      if (scenario === 'cleanup-error')
        assert.match(result.checks[0]!.detail, /fixture lease cleanup failed/);
      if (scenario === 'timeout') assert.equal(result.checks[0]!.command!.timedOut, true);
      // The classification is what the repair policy branches on, so it is asserted per scenario rather than
      // left to the one test that reads the prose. A successful check carries no reason at all.
      assert.equal(
        result.checks[0]!.failureReason,
        scenario === 'normal'
          ? undefined
          : scenario === 'timeout'
            ? 'timeout'
            : 'environment-error',
      );
    }
    assert.equal(cleaned, 1);
  });
}

test(
  'POSIX acceptance normal leader exit stops remaining same-group descendants',
  {
    skip:
      process.platform === 'win32'
        ? 'POSIX process groups: same-group signalling is not a Windows concept'
        : false,
  },
  async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'yuantu-acceptance-descendant-'));
    const pidPath = path.join(root, 'pid');
    const childScript = `require('node:fs').writeFileSync(${JSON.stringify(pidPath)},String(process.pid));setTimeout(()=>process.exit(0),5000);setInterval(()=>{},1000)`;
    const leaderScript = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(childScript)}],{stdio:'ignore'});const timer=setInterval(()=>{if(require('node:fs').existsSync(${JSON.stringify(pidPath)})){clearInterval(timer);process.exit(0)}},20);setTimeout(()=>process.exit(2),3000)`;
    let descendant: number | undefined;
    const startedAt = Date.now();
    t.after(async () => {
      if (!descendant) descendant = await readFile(pidPath, 'utf8').then(Number, () => undefined);
      if (descendant) {
        try {
          process.kill(descendant, 'SIGKILL');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
        }
      } else {
        // If startup failed before the PID report, wait past the controlled
        // guest's independent deadline instead of leaving it behind the test.
        const remaining = 6500 - (Date.now() - startedAt);
        if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
      }
      await rm(root, { recursive: true, force: true });
    });
    const result = await withExecutionPolicy(executionPolicy('host'), () =>
      verifyAcceptance(root, [
        {
          id: 'orphan',
          kind: 'command',
          command: process.execPath,
          args: ['-e', leaderScript],
          timeoutMs: 5000,
        },
      ]),
    );
    descendant = Number(await readFile(pidPath, 'utf8'));
    assert.equal(result.passed, true);
    // The kernel may keep a just-killed child as a zombie until the init reaper
    // runs. A signal probe alone is not a portable proof of running status.
    const { execFileSync } = await import('node:child_process');
    const deadline = Date.now() + 3000;
    let state = '';
    do {
      try {
        state = execFileSync('/bin/ps', ['-p', String(descendant), '-o', 'stat='], {
          encoding: 'utf8',
        }).trim();
      } catch (error) {
        if ((error as { status?: number }).status !== 1) throw error;
        state = '';
      }
      if (!state || state.startsWith('Z')) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    } while (Date.now() < deadline);
    assert.ok(!state || state.startsWith('Z'), `descendant remains active: ${state}`);
  },
);

test('acceptance reads are bounded and refuse binary content', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yuantu-acceptance-bounds-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'large.txt'), 'x'.repeat(64));
  await writeFile(path.join(root, 'binary.txt'), Buffer.from([0x61, 0x00, 0x62]));
  // `maxBytes` has to be enforced by the read itself: without it the verifier would load a file it was told to
  // bound, and `file-contains` would report success on content it was never allowed to read.
  const oversized = await verifyAcceptance(root, [
    { id: 'oversized', kind: 'file-contains', path: 'large.txt', expected: 'x', maxBytes: 4 },
  ]);
  assert.equal(oversized.passed, false);
  assert.match(oversized.checks[0]!.detail, /exceeds 4 byte acceptance limit/i);
  // A NUL byte means this is not the UTF-8 text the check claims to compare.
  const binary = await verifyAcceptance(root, [
    { id: 'binary', kind: 'file-contains', path: 'binary.txt', expected: 'a' },
  ]);
  assert.equal(binary.passed, false);
  assert.match(binary.checks[0]!.detail, /UTF-8 text/i);
});

test('an unchanged-path check notices a content change of the same size', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yuantu-acceptance-snapshot-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'guarded.txt'), 'original');
  const baseline = await capturePathSnapshot(root, 'guarded.txt');
  // Same length on purpose: the path still exists and its size is unchanged, so a comparison that looked only
  // at the entry count or the byte count would call this untouched.
  await writeFile(path.join(root, 'guarded.txt'), 'ORIGINAL');
  const result = await verifyAcceptance(root, [
    {
      id: 'guarded',
      kind: 'forbidden-path',
      path: 'guarded.txt',
      expectation: 'unchanged',
      baseline,
    },
  ]);
  assert.equal(result.passed, false);
  assert.match(result.checks[0]!.detail, /changed/i);
});

test('the verifier applies the check limit to specs it is handed directly', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yuantu-acceptance-limit-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  // A stored task is validated when it is created, but the verifier is also reachable with a spec list that
  // never went through that validator, so it cannot rely on the other layer to have applied the limit.
  const specs = Array.from({ length: MAX_CHECKS + 1 }, (_, index) => ({
    id: `limit-${index}`,
    kind: 'file-contains' as const,
    path: 'missing.txt',
    expected: 'x',
  }));
  await assert.rejects(verifyAcceptance(root, specs), /exceed limit/i);
});

test('the verifier refuses a duplicate check id in specs it is handed directly', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yuantu-acceptance-duplicate-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const spec = { id: 'same', kind: 'file-contains' as const, path: 'missing.txt', expected: 'x' };
  await assert.rejects(
    verifyAcceptance(root, [spec, { ...spec }]),
    /Duplicate acceptance check id/,
  );
});

/**
 * The failure classification is the input to the repair policy, so each class is pinned to the condition the
 * plan names for it. Reading `detail` would work today and break the first time a message is reworded, which is
 * why these assertions are on the reason field and never on the text.
 */
test('a command that finishes with the wrong exit code is a repairable assertion failure', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yuantu-acceptance-exit-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = await withExecutionPolicy(executionPolicy('host'), () =>
    verifyAcceptance(root, [
      { id: 'exit', kind: 'command', command: process.execPath, args: ['-e', 'process.exit(3)'] },
    ]),
  );
  assert.equal(result.passed, false);
  assert.equal(result.checks[0]!.failureReason, 'assertion-failed');
  assert.equal(result.checks[0]!.command!.exitCode, 3);
  assert.equal(result.checks[0]!.command!.timedOut, false);
});

test('a refused command approval is a permission failure, not work to retry', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yuantu-acceptance-denied-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let approvals = 0;
  const result = await withExecutionPolicy(executionPolicy('host'), () =>
    verifyAcceptance(
      root,
      [{ id: 'denied', kind: 'command', command: process.execPath, args: ['-e', ''] }],
      {
        approve: async () => {
          approvals++;
          return false;
        },
      },
    ),
  );
  assert.equal(approvals, 1);
  assert.equal(result.passed, false);
  assert.equal(result.checks[0]!.failureReason, 'permission-denied');
});

test('file content that does not match is an assertion failure', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yuantu-acceptance-content-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'present.txt'), 'actual');
  const mismatch = await verifyAcceptance(root, [
    { id: 'exact', kind: 'file-exact', path: 'present.txt', expected: 'expected' },
  ]);
  assert.equal(mismatch.checks[0]!.failureReason, 'assertion-failed');
  const missing = await verifyAcceptance(root, [
    { id: 'missing', kind: 'file-contains', path: 'absent.txt', expected: 'x' },
  ]);
  assert.equal(missing.checks[0]!.failureReason, 'assertion-failed');
  assert.match(missing.checks[0]!.detail, /does not exist/i);
});

test('a forbidden path that changed is never automatically repairable', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yuantu-acceptance-forbidden-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'guarded.txt'), 'original');
  const baseline = await capturePathSnapshot(root, 'guarded.txt');
  await writeFile(path.join(root, 'guarded.txt'), 'tampered');
  const changed = await verifyAcceptance(root, [
    {
      id: 'guarded',
      kind: 'forbidden-path',
      path: 'guarded.txt',
      expectation: 'unchanged',
      baseline,
    },
  ]);
  assert.equal(changed.passed, false);
  assert.equal(changed.checks[0]!.failureReason, 'protected-path-changed');
  // A path that must be absent but exists is the model's own output, which it can still remove.
  await writeFile(path.join(root, 'leftover.txt'), 'x');
  const leftover = await verifyAcceptance(root, [
    { id: 'absent', kind: 'forbidden-path', path: 'leftover.txt', expectation: 'absent' },
  ]);
  assert.equal(leftover.checks[0]!.failureReason, 'assertion-failed');
});

test('a definition that cannot be executed is an invalid definition', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yuantu-acceptance-definition-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const escaped = await verifyAcceptance(root, [
    { id: 'escaped', kind: 'file-contains', path: '..', expected: 'x' },
  ]);
  assert.equal(escaped.checks[0]!.failureReason, 'invalid-definition');
});

test('a fenced directory that holds a link is imaged by what the link says', async (t) => {
  // Refusing a link made a fenced directory that merely contained one impossible to protect, and the refusal read as
  // an environment fault. The link is imaged, never followed, and retargeting it is a change.
  const root = await mkdtemp(path.join(os.tmpdir(), 'yuantu-acceptance-link-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'fenced'));
  await writeFile(path.join(root, 'fenced', 'a.txt'), 'a');
  await writeFile(path.join(root, 'b.txt'), 'b');
  try {
    await symlink('a.txt', path.join(root, 'fenced', 'link'));
  } catch {
    t.skip('this machine cannot create symbolic links');
    return;
  }
  const baseline = await capturePathSnapshot(root, 'fenced');
  assert.equal(baseline.version, 2, 'new images use code-unit order');
  const check = () =>
    verifyAcceptance(root, [
      {
        id: 'fence',
        kind: 'forbidden-path',
        path: 'fenced',
        expectation: 'unchanged',
        baseline,
      },
    ]);
  assert.equal((await check()).passed, true);
  await rm(path.join(root, 'fenced', 'link'));
  await symlink('../b.txt', path.join(root, 'fenced', 'link'));
  const changed = await check();
  assert.equal(changed.passed, false);
  assert.equal(changed.checks[0]!.failureReason, 'protected-path-changed');
});

test('a baseline recorded in the older entry order is compared like for like', async (t) => {
  // Collation can change with the ICU a Node build ships, so new images order entries by code unit; an image
  // stored by an earlier build is compared against one taken its own way rather than read as a change.
  const root = await mkdtemp(path.join(os.tmpdir(), 'yuantu-acceptance-order-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'fenced'));
  // Upper and lower case sort differently under the two orders, so the digests genuinely differ.
  for (const name of ['B.txt', 'a.txt', 'C.txt'])
    await writeFile(path.join(root, 'fenced', name), name);
  const legacy = await capturePathSnapshot(root, 'fenced', 1);
  const current = await capturePathSnapshot(root, 'fenced');
  assert.notEqual(legacy.digest, current.digest, 'the two orders produce different images');
  const result = await verifyAcceptance(root, [
    {
      id: 'fence',
      kind: 'forbidden-path',
      path: 'fenced',
      expectation: 'unchanged',
      baseline: legacy,
    },
  ]);
  assert.equal(result.passed, true, result.checks[0]!.detail);
});

test('a fenced path too large to image is a definition to fix, not an environment fault', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yuantu-acceptance-large-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'fenced'));
  await Promise.all(
    Array.from({ length: 2_001 }, (_, index) =>
      writeFile(path.join(root, 'fenced', `${index}.txt`), ''),
    ),
  );
  const result = await verifyAcceptance(root, [
    {
      id: 'fence',
      kind: 'forbidden-path',
      path: 'fenced',
      expectation: 'unchanged',
      baseline: { version: 2, state: 'absent', entries: 0, bytes: 0 },
    },
  ]);
  assert.equal(result.checks[0]!.failureReason, 'invalid-definition');
  assert.match(result.checks[0]!.detail, /fence a smaller path/);
});

test('a verification command is shown quoted so it cannot read as a shell line', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yuantu-acceptance-display-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const seen: { description: string; command: unknown }[] = [];
  await withExecutionPolicy(executionPolicy('host'), () =>
    verifyAcceptance(root, [{ id: 'shown', kind: 'command', command: 'node', args: ['a;b', ''] }], {
      approve: async (approval) => {
        seen.push({
          description: approval.description,
          command: approval.toolCall.arguments.command,
        });
        return false;
      },
    }),
  );
  assert.equal(seen[0]!.description, 'Verification command (run without a shell): node "a;b" ""');
  // The policy-facing spelling is unchanged, so an exact-match rule written against it still matches.
  assert.equal(seen[0]!.command, 'node a;b ');
});
