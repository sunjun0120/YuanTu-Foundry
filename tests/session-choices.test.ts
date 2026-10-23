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
  return { choices, sandboxes, failures };
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

test('the weaker sandbox is a new session default only after the person chose it', async () => {
  const { choices } = harness();
  assert.equal(choices.view().sandbox.mode, 'native');
  choices.weakDefault = true;
  assert.equal(choices.chosen('fresh').sandbox, 'windows');
  assert.equal(choices.view().current, null, 'the restricted token is no preset');
  choices.weakDefault = false;
  assert.equal(choices.chosen('fresh').sandbox, 'native');
});
