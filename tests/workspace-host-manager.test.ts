import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkspaceHostManager } from '../apps/desktop/workspace-host-manager.ts';

class FakeHost {
  starts = 0;
  stops = 0;
  readonly label: string;
  private readonly fail: boolean;
  constructor(label: string, fail = false) {
    this.label = label;
    this.fail = fail;
  }
  async start(): Promise<void> {
    this.starts++;
    if (this.fail) throw new Error('start failed');
  }
  async stop(): Promise<void> {
    this.stops++;
  }
}

function fixture(now = { value: 1000 }, options: { keepIdle?: number } = {}) {
  const hosts: FakeHost[] = [];
  const manager = new WorkspaceHostManager<FakeHost>(
    (id, path) => {
      const host = new FakeHost(`${id}:${path}`);
      hosts.push(host);
      return host;
    },
    { now: () => now.value, idleMs: 100, ...options },
  );
  return { manager, hosts, now };
}

test('a Host starts on demand, is reused and becomes active', async () => {
  const { manager, hosts } = fixture();
  const first = await manager.ensure('a', '/repo/a');
  assert.equal(first.epoch, 1);
  assert.equal(hosts[0]?.starts, 1);
  const again = await manager.ensure('a', '/repo/a');
  assert.equal(again.host, first.host);
  assert.equal(hosts.length, 1);
  assert.equal(manager.activeWorkspaceId, 'a');
  const second = await manager.ensure('b', '/repo/b');
  assert.equal(second.epoch, 2);
  assert.equal(manager.activeWorkspaceId, 'b');
});

test('a failed start is stopped and not registered', async () => {
  const manager = new WorkspaceHostManager<FakeHost>((id) => new FakeHost(id, true));
  await assert.rejects(() => manager.ensure('a', '/repo/a'), /start failed/);
  assert.equal(manager.get('a'), undefined);
  assert.equal(manager.activeWorkspaceId, null);
});

test('the same id cannot be rebound to another directory', async () => {
  const { manager } = fixture();
  await manager.ensure('a', '/repo/a');
  await assert.rejects(() => manager.ensure('a', '/repo/other'), /another directory/);
});

test('idle release keeps the active Host and the newest idle ones', async () => {
  const { manager, hosts, now } = fixture(undefined, { keepIdle: 1 });
  await manager.ensure('a', '/repo/a');
  now.value += 1;
  await manager.ensure('b', '/repo/b');
  now.value += 1;
  await manager.ensure('c', '/repo/c');
  now.value += 1;
  await manager.ensure('d', '/repo/d');
  manager.activate('a');
  now.value += 200;
  const released = await manager.releaseIdle();
  assert.deepEqual(released, ['c', 'b']);
  assert.equal(manager.get('a')?.host.stops, 0);
  assert.equal(manager.get('d')?.host.stops, 0);
  assert.equal(hosts.filter((host) => host.stops === 1).length, 2);
});

test('stopping one entry and stopping all are idempotent', async () => {
  const { manager, hosts } = fixture();
  await manager.ensure('a', '/repo/a');
  await manager.ensure('b', '/repo/b');
  await manager.stop('a');
  await manager.stop('a');
  assert.equal(hosts[0]?.stops, 1);
  assert.equal(manager.activeWorkspaceId, 'b');
  await manager.stopAll();
  assert.equal(hosts[1]?.stops, 1);
  await manager.stopAll();
  assert.equal(hosts[1]?.stops, 1);
  await assert.rejects(() => manager.ensure('c', '/repo/c'), /disposed/);
});
