/**
 * A preset switch is two writes — the sandbox, then the approval policy — and it must land as both or neither.
 *
 * What used to happen when the second write failed: the sandbox had already moved, nothing put it back, and the
 * chip redrew the *old* preset from the session's remembered choice. From `guarded` to `unconfined` that is
 * isolation already gone under a chip that still said "write in the workspace". Pinned here: the sandbox is put
 * back, and when it cannot be the desktop says the pair is unknown instead of naming one.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionChoices } from '../apps/desktop/session-choices.ts';
import type { CarrierService } from '../packages/carrier/index.ts';
import type { SandboxEnvironment } from '../apps/desktop/sandbox-environment.ts';

const GUARDED = { sandbox: 'native', permission: 'ask' } as const;
const UNCONFINED = { sandbox: 'host', permission: 'full-access' } as const;

function harness() {
  const sandboxes: string[] = [];
  /** `rollback` refuses every sandbox write after the switch's own, so nothing can be put back. */
  const failures = { permission: false, sandbox: false, rollback: false };
  const service = {
    snapshot: { session: { sessionId: 's1' } },
    /** Set while a command that changes what a session holds is running; see `CarrierService.sessionOperation`. */
    sessionOperation: false,
    async dispatch(command: { type: string; mode: string }) {
      if (failures.sandbox) throw new Error('sandbox switch failed');
      if (failures.rollback && sandboxes.length >= 2) throw new Error('rollback failed');
      sandboxes.push(command.mode);
    },
    async updatePermissionPolicy() {
      if (failures.permission) throw new Error('permission update failed');
    },
  };
  const environment = {
    defaultMode: 'native',
    image: undefined,
    known: () => true,
    probe: async () => undefined,
    cached: () => null,
  };
  const choices = new SessionChoices({
    service: () => service as unknown as CarrierService,
    window: () => null,
    sandbox: () => environment as unknown as SandboxEnvironment,
  });
  return { choices, sandboxes, failures, service };
}

test('a failed approval half puts the sandbox back and the chip shows the pair in force', async () => {
  const { choices, sandboxes, failures } = harness();
  await choices.apply({ ...GUARDED }, 's1');
  choices.remember('s1', { ...GUARDED });
  failures.permission = true;
  await assert.rejects(choices.apply({ ...UNCONFINED }, 's1'), /permission update failed/);
  assert.deepEqual(sandboxes, ['native', 'host', 'native'], 'the sandbox was not put back');
  assert.equal(choices.unknown, false);
  assert.equal(choices.view().current, 'guarded');
  assert.equal(choices.view().sandbox.mode, 'native');
});

test('a switch whose rollback also fails is reported as unknown until a pair is written again', async () => {
  const { choices, sandboxes, failures } = harness();
  await choices.apply({ ...GUARDED }, 's1');
  choices.remember('s1', { ...GUARDED });
  failures.permission = true;
  failures.rollback = true;
  await assert.rejects(choices.apply({ ...UNCONFINED }, 's1'), /permission update failed/);
  assert.deepEqual(sandboxes, ['native', 'host']);
  assert.equal(choices.unknown, true);
  // The remembered choice is `guarded`, and naming it now would be naming the pair that is *not* in force.
  assert.throws(() => choices.view(), /unknown/);

  // Recovering writes the session's own pair, both halves, and only then is there an answer again.
  failures.permission = false;
  failures.rollback = false;
  await choices.recover('s1');
  assert.equal(choices.unknown, false);
  assert.deepEqual(sandboxes, ['native', 'host', 'native']);
  assert.equal(choices.view().current, 'guarded');
});

test('a failure before the sandbox moved leaves nothing to undo and nothing unknown', async () => {
  const { choices, sandboxes, failures } = harness();
  await choices.apply({ ...GUARDED }, 's1');
  choices.remember('s1', { ...GUARDED });
  failures.sandbox = true;
  await assert.rejects(choices.apply({ ...UNCONFINED }, 's1'), /sandbox switch failed/);
  assert.deepEqual(sandboxes, ['native']);
  assert.equal(choices.unknown, false);
  assert.equal(choices.view().current, 'guarded');
});

/**
 * Deleting or archiving the open session moves to another one inside a session command, and the state that
 * command publishes on the way already names the session it is about to show. Following that progress report
 * dispatched the preset into `sessionOperationBusy`, which was caught and logged as a failed switch (the
 * `desktop: could not apply the session sandbox` line); the command's own last publish then applied the choice
 * a second time. The follow now waits for that last publish, and waiting is not a failure.
 */
test('a follow that arrives during a session command waits for the command to finish', async () => {
  const { choices, sandboxes, service } = harness();
  const logged: unknown[][] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    logged.push(args);
  };
  try {
    service.sessionOperation = true;
    choices.follow('s2');
    const busyFollow = choices.following;
    assert.equal(busyFollow, undefined, 'a busy follow started a switch');
    assert.deepEqual(sandboxes, [], 'a busy follow dispatched the sandbox');
    service.sessionOperation = false;
    choices.follow('s2');
    const applied = choices.following;
    assert.ok(applied, 'the follow after the command did not start');
    await applied;
  } finally {
    console.error = original;
  }
  assert.deepEqual(logged, [], 'waiting for the command was logged as a failure');
  assert.deepEqual(sandboxes, ['native']);
  assert.equal(choices.view().current, 'auto');
});
