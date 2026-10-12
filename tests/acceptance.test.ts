import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { verifyAcceptance } from '../packages/core/acceptance.ts';
import { executionPolicy, withExecutionPolicy } from '../packages/tools/execution-policy.ts';
import {
  registerSandboxProvider,
  sandboxProvider,
  type SandboxPlan,
} from '../packages/tools/sandbox.ts';

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
    }
    assert.equal(cleaned, 1);
  });
}

test(
  'POSIX acceptance normal leader exit stops remaining same-group descendants',
  { skip: process.platform === 'win32' },
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
