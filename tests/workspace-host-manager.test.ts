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

test('concurrent starts share one Host and a start completed after quit is stopped', async () => {
  let release!: () => void;
  let starts = 0;
  let stops = 0;
  const manager = new WorkspaceHostManager(() => ({
    start: async () => {
      starts++;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    },
    stop: async () => {
      stops++;
    },
  }));
  const first = manager.ensure('a', '/a');
  const second = manager.ensure('a', '/a');
  assert.equal(starts, 1);
  await manager.stopAll();
  release();
  const replies = await Promise.allSettled([first, second]);
  assert.ok(replies.every((reply) => reply.status === 'rejected'));
  assert.equal(manager.get('a'), undefined);
  assert.ok(stops > 0);
});

test('idle cleanup retains busy background Hosts and shutdown reports a failed stop', async () => {
  const now = { value: 0 };
  const manager = new WorkspaceHostManager(
    (id) => ({
      id,
      busy: id === 'a',
      start: async () => {},
      stop: async () => {
        if (id === 'a') throw new Error('cleanup failed');
      },
    }),
    { now: () => now.value, keepIdle: 0, idleMs: 1, isBusy: (host) => host.busy },
  );
  await manager.ensure('a', '/a');
  await manager.ensure('b', '/b');
  now.value = 100;
  assert.deepEqual(await manager.releaseIdle(), []);
  assert.ok(manager.get('a'));
  await assert.rejects(() => manager.stopAll(), /cleanup failed/);
});

test('an idle candidate activated while an earlier stop waits is retained', async () => {
  let release!: () => void;
  let began!: () => void;
  const started = new Promise<void>((resolve) => {
    began = resolve;
  });
  const stopped: string[] = [];
  const manager = new WorkspaceHostManager(
    (id) => ({
      start: async () => {},
      stop: async () => {
        stopped.push(id);
        if (id === 'a') {
          began();
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
      },
    }),
    { keepIdle: 0, idleMs: 0 },
  );
  await manager.ensure('a', '/a');
  await manager.ensure('b', '/b');
  await manager.ensure('c', '/c');
  const cleanup = manager.releaseIdle();
  await started;
  manager.activate('b');
  release();
  assert.deepEqual(await cleanup, ['a']);
  assert.equal(manager.activeWorkspaceId, 'b');
  assert.deepEqual(stopped, ['a']);
});

test('a starting workspace cannot be removed through the idle stop path', async () => {
  let release!: () => void;
  const manager = new WorkspaceHostManager(() => ({
    start: async () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    stop: async () => {},
  }));
  const starting = manager.ensure('a', '/a');
  assert.equal(manager.isStarting('a'), true);
  await assert.rejects(() => manager.stop('a'), /starting/);
  release();
  await starting;
  await manager.stopAll();
});
