import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { projectRoot } from './process-fixture.ts';

for (const entry of ['apps/cli/main.ts', 'apps/web/main.ts', 'apps/agent-acp/main.ts']) {
  test(`${entry} refuses startup while its public entry is paused`, (t) => {
    const workspace = mkdtempSync(path.join(tmpdir(), 'yuantu-paused-entry-'));
    t.after(() => rmSync(workspace, { recursive: true, force: true }));
    const result = spawnSync(process.execPath, [path.join(projectRoot, entry), '--help'], {
      cwd: workspace,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 10000,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /temporarily disabled in the desktop-only product/);
    assert.deepEqual(readdirSync(workspace), [], 'a paused entry must not create workspace state');
  });
}

test('the public SDK package subpath is not exported while paused', () => {
  assert.throws(() => import.meta.resolve('yuantu-agent/sdk'), {
    code: 'ERR_PACKAGE_PATH_NOT_EXPORTED',
  });
});

test('the retained Web bridge refuses programmatic startup while paused', async (t) => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'yuantu-paused-bridge-'));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const { startBridge } = await import('../apps/web/main.ts');
  await assert.rejects(
    startBridge({ workspace, port: 0, token: 'paused-test', page: workspace }),
    /temporarily disabled in the desktop-only product/,
  );
  assert.deepEqual(readdirSync(workspace), []);
});
