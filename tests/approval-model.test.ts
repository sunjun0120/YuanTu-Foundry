import test from 'node:test';
import assert from 'node:assert/strict';
import type { Approval } from '../packages/protocol/index.ts';
import {
  approvalDecisions,
  approvalEntries,
} from '../apps/desktop/ui/conversation/approval-model.ts';

/**
 * The approval card list: identical requests waiting together are one card, and a command offers one more answer than a
 * file change — allow this exact call for the rest of the session.
 */
function approval(overrides: Partial<Approval> = {}): Approval {
  return {
    kind: 'command',
    description: 'run the tests',
    toolCall: { name: 'run_command', arguments: {} },
    ...overrides,
  } as Approval;
}

test('identical requests collapse into one card that counts its copies', () => {
  const entries = approvalEntries([
    { id: 'a', approval: approval() },
    { id: 'b', approval: approval() },
    {
      id: 'c',
      approval: approval({
        toolCall: { name: 'run_command', arguments: { command: 'other' } } as never,
      }),
    },
  ]);
  assert.deepEqual(
    entries.map((entry) => [entry.id, entry.count]),
    [
      ['a', 2],
      ['c', 1],
    ],
  );
});

test('a command offers remember-for-session, a diff and a service do not', () => {
  assert.deepEqual(
    approvalDecisions('command').map((decision) => [decision.allow, decision.remember]),
    [
      [false, false],
      [true, false],
      [true, true],
    ],
  );
  for (const kind of ['write', 'external'] as const)
    assert.deepEqual(
      approvalDecisions(kind).map((decision) => [decision.allow, decision.remember]),
      [
        [false, false],
        [true, false],
      ],
    );
});
