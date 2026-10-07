import test from 'node:test';
import assert from 'node:assert/strict';
import { PermissionPolicy } from '../packages/core/permissions.ts';
import type { Approval } from '../packages/protocol/index.ts';
const approval: Approval = {
  kind: 'command',
  description: 'run',
  toolCall: { id: '1', name: 'run_command', arguments: { command: 'npm test', cwd: '.' } },
};
test('permission deny and ask override allow and match exact complete arguments', () => {
  const policy = new PermissionPolicy({
    version: 1,
    rules: [
      { effect: 'allow', kind: 'command' },
      { effect: 'deny', tool: 'run_command', arguments: { cwd: '.', command: 'npm test' } },
    ],
  });
  assert.equal(policy.decide(approval), 'deny');
  assert.equal(
    policy.decide({
      ...approval,
      toolCall: { ...approval.toolCall, arguments: { command: 'npm test && malicious', cwd: '.' } },
    }),
    'allow',
  );
  const exact = new PermissionPolicy({
    version: 1,
    rules: [{ effect: 'allow', tool: 'run_command', arguments: { command: 'npm test', cwd: '.' } }],
  });
  assert.equal(
    exact.decide({
      ...approval,
      toolCall: { ...approval.toolCall, arguments: { command: 'npm test && malicious', cwd: '.' } },
    }),
    undefined,
  );
  const ask = new PermissionPolicy({
    version: 1,
    rules: [
      { effect: 'allow', kind: 'command' },
      { effect: 'ask', tool: 'run_command' },
    ],
  });
  assert.equal(ask.decide(approval), 'ask');
  assert.equal(
    policy.decide({
      ...approval,
      kind: 'external',
      toolCall: { ...approval.toolCall, name: 'mcp_local_call_tool' },
    }),
    undefined,
  );
});
test('a tool no call of which could be approved is recognisable as such', () => {
  const denied = new PermissionPolicy({
    version: 1,
    rules: [
      { effect: 'allow', kind: 'write' },
      { effect: 'deny', kind: 'external' },
      { effect: 'deny', tool: 'run_command' },
    ],
  });
  assert.equal(denied.deniesEveryCall({ name: 'web_fetch', permission: 'external' }), true);
  assert.equal(denied.deniesEveryCall({ name: 'run_command', permission: 'command' }), true);
  assert.equal(denied.deniesEveryCall({ name: 'write_file', permission: 'write' }), false);
  assert.equal(denied.deniesEveryCall({ name: 'read_file' }), false);

  // A rule that pins the arguments denies those calls, not the tool: the tool stays usable in general.
  const pinned = new PermissionPolicy({
    version: 1,
    rules: [{ effect: 'deny', tool: 'run_command', arguments: { command: 'rm -rf /', cwd: '.' } }],
  });
  assert.equal(pinned.deniesEveryCall({ name: 'run_command', permission: 'command' }), false);
  // A tool that asks for no approval never reaches the policy, so a rule naming it hides nothing.
  const named = new PermissionPolicy({
    version: 1,
    rules: [{ effect: 'deny', tool: 'list_files' }],
  });
  assert.equal(named.deniesEveryCall({ name: 'list_files' }), false);
  // `allow` and `ask` decide one call at a time and never make a tool unusable.
  const asking = new PermissionPolicy({
    version: 1,
    rules: [
      { effect: 'ask', kind: 'command' },
      { effect: 'allow', kind: 'write' },
    ],
  });
  assert.equal(asking.deniesEveryCall({ name: 'run_command', permission: 'command' }), false);
  assert.equal(asking.deniesEveryCall({ name: 'write_file', permission: 'write' }), false);
});
test('permission policy snapshots its source and rejects malformed rules', () => {
  const source = { version: 1, rules: [{ effect: 'deny', kind: 'command' }] };
  const policy = new PermissionPolicy(source);
  source.rules[0]!.effect = 'allow';
  assert.equal(policy.decide(approval), 'deny');
  for (const value of [
    { version: 1, rules: [{ effect: ['deny'], kind: 'command' }] },
    { version: 1, rules: [{ effect: 'deny', kind: ['command'] }] },
    { version: 2, rules: [] },
    { version: 1, rules: [{ effect: 'allow' }] },
    { version: 1, rules: [{ effect: 'allow', kind: 'shell' }] },
    { version: 1, rules: [{ effect: 'allow', tool: 'run_*' }] },
    { version: 1, rules: [{ effect: 'allow', tool: 'run_command', prefix: 'npm' }] },
    { version: 1, rules: Array.from({ length: 129 }, () => ({ effect: 'deny', kind: 'command' })) },
  ])
    assert.throws(() => new PermissionPolicy(value));
});
