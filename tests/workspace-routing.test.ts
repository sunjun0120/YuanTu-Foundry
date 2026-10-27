import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkspaceMirrors } from '../apps/desktop/workspace-routing.ts';
import { SnapshotSender } from '../apps/desktop/snapshot-patch.ts';
import type { CarrierSnapshot } from '../packages/carrier/contract.ts';

const state = (workspace: string, text: string) =>
  ({
    workspace,
    session: { sessionId: 'same-id', messages: [{ role: 'user', content: text }] },
  }) as CarrierSnapshot;

test('workspace mirrors isolate colliding session ids, late replies and obsolete Host epochs', () => {
  const mirrors = new WorkspaceMirrors();
  const a = { workspaceId: 'a', hostEpoch: 1 };
  const b = { workspaceId: 'b', hostEpoch: 2 };
  const first = new SnapshotSender();
  const second = new SnapshotSender();
  mirrors.apply({ ...a, type: 'state', patch: first.diff(state('/a', 'A')), active: true });
  mirrors.apply({ ...b, type: 'state', patch: second.diff(state('/b', 'B')), active: true });
  const late = mirrors.apply({ ...a, type: 'state', patch: first.diff(state('/a', 'A late')) });
  assert.equal(late, null);
  assert.deepEqual(mirrors.target, b);
  assert.equal(mirrors.get(a)?.workspace, '/a');
  assert.equal(mirrors.get(b)?.workspace, '/b');
  mirrors.apply({
    workspaceId: 'a',
    hostEpoch: 3,
    type: 'state',
    active: true,
    patch: new SnapshotSender().diff(state('/a', 'restarted')),
  });
  assert.equal(
    mirrors.apply({ ...a, type: 'state', active: true, patch: first.diff(state('/a', 'stale')) }),
    null,
  );
  assert.equal(mirrors.get(a), undefined);
  assert.equal(mirrors.target?.hostEpoch, 3);
});

test('activating a cached workspace projects every section, even when its patch is unchanged', () => {
  const mirrors = new WorkspaceMirrors();
  const sender = new SnapshotSender();
  const target = { workspaceId: 'a', hostEpoch: 1 };
  mirrors.apply({ ...target, type: 'state', patch: sender.diff(state('/a', 'A')) });
  const selected = mirrors.apply({
    ...target,
    type: 'state',
    active: true,
    patch: { sections: {} },
  });
  assert.equal(selected?.state.workspace, '/a');
  assert.ok(selected?.changed.includes('session'));
});

test('a late activation cannot undo a newer workspace selection', () => {
  const mirrors = new WorkspaceMirrors();
  mirrors.apply({
    workspaceId: 'b',
    hostEpoch: 2,
    type: 'state',
    active: true,
    selection: 3,
    patch: new SnapshotSender().diff(state('/b', 'B')),
  });
  assert.equal(
    mirrors.apply({
      workspaceId: 'a',
      hostEpoch: 1,
      type: 'state',
      active: true,
      selection: 2,
      patch: new SnapshotSender().diff(state('/a', 'A')),
    }),
    null,
  );
  assert.equal(mirrors.target?.workspaceId, 'b');
});
