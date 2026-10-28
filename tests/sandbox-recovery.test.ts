/**
 * The desktop's half of the sandbox-lease remedy.
 *
 * The backend tests prove that a dead owner's journal can be restored; these prove that the window can ask for
 * it and report it — the part that was missing entirely, which left a person who ran only the desktop with no
 * way out of a state the product itself created.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  inspectSandboxRecovery,
  parseSandboxRecoveryCommand,
  recoverSandboxLease,
} from '../apps/desktop/sandbox-recovery.ts';
import { leaseBlockedError } from '../packages/sandbox/windows-sandbox-recovery.ts';
import { environmentBlockedCode } from '../packages/protocol/environment-blocked.ts';
import type { WindowsSandboxLeaseReport } from '../packages/sandbox/windows-sandbox-recovery.ts';

const needsRestore: WindowsSandboxLeaseReport = {
  state: 'needs-restore',
  directory: 'C:\\Users\\me\\.yuantu\\sandbox-state\\windows',
  locks: [
    { file: 'a.lock', pid: 4242, alive: false },
    { file: 'workspace-owner.lock', pid: 4242, alive: false },
  ],
  journals: ['C:\\Users\\me\\.yuantu\\sandbox-state\\windows\\a.json'],
};

test('the window can read and repair the lease without the CLI', async () => {
  // A lease a dead owner left: there is something to repair.
  const inspect = await inspectSandboxRecovery({
    platform: 'win32',
    inspect: async () => needsRestore,
  });
  assert.deepEqual(inspect, {
    supported: true,
    state: 'needs-restore',
    recoverable: true,
    restored: [],
    removed: [],
  });
  // `held` is not a repair: the owner is alive, and the backend refuses to guess otherwise.
  const held = await inspectSandboxRecovery({
    platform: 'win32',
    inspect: async () => ({
      ...needsRestore,
      state: 'held',
      locks: [{ ...needsRestore.locks[0]!, alive: true }],
    }),
  });
  assert.equal(held.recoverable, false);
  // The repair itself reports what it restored.
  const repaired = await recoverSandboxLease({
    platform: 'win32',
    recover: async () => ({
      ...needsRestore,
      state: 'clear',
      locks: [],
      journals: [],
      restored: ['E:\\project'],
      removed: ['a.lock', 'workspace-owner.lock'],
    }),
  });
  assert.equal(repaired.state, 'clear');
  assert.deepEqual(repaired.restored, ['E:\\project']);
  assert.equal(repaired.removed.length, 2);
  assert.equal(repaired.recoverable, false);
  // Off Windows there is no ACL lease, and the window must not offer a button that does nothing.
  const elsewhere = await inspectSandboxRecovery({ platform: 'linux' });
  assert.equal(elsewhere.supported, false);
  assert.equal(elsewhere.recoverable, false);
});

test('a repair the backend refuses stays an error rather than a silent success', async () => {
  await assert.rejects(
    recoverSandboxLease({
      platform: 'win32',
      recover: async () => {
        throw leaseBlockedError({
          ...needsRestore,
          state: 'held',
          locks: [{ ...needsRestore.locks[0]!, alive: true }],
        });
      },
    }),
    /windows-sandbox-in-use/,
  );
});

test('only the two commands cross the IPC boundary', () => {
  assert.deepEqual(parseSandboxRecoveryCommand({ type: 'status' }), { type: 'status' });
  assert.deepEqual(parseSandboxRecoveryCommand({ type: 'recover' }), { type: 'recover' });
  for (const invalid of [
    {},
    { type: 'recover', path: 'C:\\Windows' },
    { type: 'repair' },
    'recover',
    null,
    [{ type: 'recover' }],
  ])
    assert.throws(() => parseSandboxRecoveryCommand(invalid), /Invalid sandbox recovery request/);
});

test('the kernel refusal the window reacts to names the lease state', () => {
  // The renderer offers the repair button exactly for the `windows-sandbox-*` codes; if the kernel stopped
  // emitting one of them the button would silently never appear.
  for (const state of ['needs-restore', 'stale', 'held', 'unreadable'] as const) {
    const error = leaseBlockedError({
      ...needsRestore,
      state,
      locks: state === 'held' ? [{ ...needsRestore.locks[0]!, alive: true }] : [],
    });
    assert.equal(
      environmentBlockedCode(error.message)?.startsWith('windows-sandbox-'),
      true,
      state,
    );
  }
});
