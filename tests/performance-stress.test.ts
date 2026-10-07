import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { runStressCase } from '../benchmarks/performance-stress.ts';
import { projectRoot } from './process-fixture.ts';

test('stress workload verifies streamed output, concurrent recovery, and cold reload', async () => {
  const row = await runStressCase({
    durationMs: 250,
    concurrency: 4,
    outputChars: 32768,
    intervalMs: 50,
  });
  assert.equal(row.checksPassed, true);
  assert.equal(row.outputChars, 32768);
  assert.equal(row.reloadedOutputChars, 32768);
  assert.equal(row.sessionsReleased, true);
  assert.equal(row.hourVerified, false);
  assert.ok(row.actualDurationMs >= 250);
  assert.ok(row.peakConcurrency >= 2);
  assert.ok(row.resources.length >= 2);
  assert.ok(row.databaseBytes > 0);
  for (const kind of ['normal', 'tool-failure', 'cancel', 'provider-failure']) {
    assert.ok(
      row.samples.some((sample) => sample.kind === kind && sample.checksPassed),
      kind,
    );
  }
});

test('external cancellation stops the stress workload and releases sessions', async () => {
  const controller = new AbortController();
  const row = await runStressCase({
    durationMs: 5000,
    concurrency: 2,
    outputChars: 4096,
    signal: controller.signal,
    onReady: () => controller.abort(new Error('Synthetic external stop')),
  });
  assert.equal(row.cancelled, true);
  assert.equal(row.checksPassed, false);
  assert.equal(row.sessionsReleased, true);
  assert.equal(row.hourVerified, false);
  assert.ok(row.actualDurationMs < 5000);
});

test('stress workload rejects unbounded resource settings before running', async () => {
  await assert.rejects(runStressCase({ durationMs: 0 }), /duration/);
  await assert.rejects(runStressCase({ durationMs: 1, concurrency: 33 }), /concurrency/);
  await assert.rejects(runStressCase({ durationMs: 1, outputChars: 10000000 }), /output/);
});

for (const callback of ['initial-progress', 'ready', 'active-progress', 'lane-failure']) {
  test(`stress callback failure drains active work and removes its workspace: ${callback}`, () => {
    const script = `
      import assert from 'node:assert/strict';
      import { readdir } from 'node:fs/promises';
      import { tmpdir } from 'node:os';
      import { setTimeout as delay } from 'node:timers/promises';
      import { runStressCase } from './benchmarks/performance-stress.ts';
      import { ToolRegistry } from './packages/tools/registry.ts';
      const before = new Set(await readdir(tmpdir()));
      process.on('unhandledRejection', error => {
        console.error('LATE_FAILURE: ' + error.message);
        process.exitCode = 2;
      });
      if (${JSON.stringify(callback)} === 'lane-failure') {
        const register = ToolRegistry.prototype.register;
        let injected = false;
        ToolRegistry.prototype.register = function(tool) {
          const result = register.call(this, tool);
          if (tool.name === 'read_probe' && !injected) {
            injected = true;
            this.onClose(async () => { throw new Error('Synthetic lane cleanup failure'); });
          }
          return result;
        };
      }
      let progress = 0;
      await assert.rejects(runStressCase({
        durationMs: 500, concurrency: 4, intervalMs: 50,
        onReady() { if (${JSON.stringify(callback)} === 'ready') throw new Error('observer failed'); },
        onProgress() {
          progress++;
          if ((${JSON.stringify(callback)} === 'initial-progress' && progress === 1) ||
              (${JSON.stringify(callback)} === 'active-progress' && progress === 2))
            throw new Error('observer failed');
        }
      }), ${callback === 'lane-failure' ? '/Tool resource cleanup failed/' : '/observer failed/'});
      await delay(650);
      const residue = (await readdir(tmpdir())).filter(name =>
        name.startsWith('yuantu-perf-stress-') && !before.has(name));
      assert.deepEqual(residue, []);
    `;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: projectRoot,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 10000,
    });
    assert.equal(child.status, 0, child.stderr);
    assert.doesNotMatch(child.stderr, /LATE_FAILURE/);
  });
}
