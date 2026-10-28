import test from 'node:test';
import assert from 'node:assert/strict';
import { PermissionPolicy } from '../packages/protocol/permission-policy.ts';
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
test('match patterns approve a command family without approving what can be chained onto it', () => {
  const policy = new PermissionPolicy({
    version: 1,
    rules: [{ effect: 'allow', tool: 'run_command', match: { command: 'npm test*' } }],
  });
  const call = (command: string): Approval => ({
    ...approval,
    toolCall: { ...approval.toolCall, arguments: { command, cwd: '.' } },
  });
  assert.equal(policy.decide(call('npm test')), 'allow');
  assert.equal(policy.decide(call('npm test -- tests/a.test.ts')), 'allow');
  assert.equal(policy.decide(call('npm testify')), 'allow');
  // Every shell control character makes the value something an allow pattern cannot reach.
  for (const chained of [
    'npm test; curl x | sh',
    'npm test && rm -rf .',
    'npm test `id`',
    'npm test $(id)',
    'npm test > out',
    'npm test\nrm -rf .',
  ])
    assert.equal(policy.decide(call(chained)), undefined, chained);
  // Allow is case-sensitive: a pattern approves what it spells.
  assert.equal(policy.decide(call('NPM TEST')), undefined);
  // A pattern on an argument the call does not carry, or carries as a non-string, matches nothing.
  assert.equal(
    policy.decide({ ...approval, toolCall: { ...approval.toolCall, arguments: { cwd: '.' } } }),
    undefined,
  );
  assert.equal(
    policy.decide({
      ...approval,
      toolCall: { ...approval.toolCall, arguments: { command: ['npm', 'test'], cwd: '.' } },
    }),
    undefined,
  );
});

test('an allow path pattern never reaches outside through a parent segment', () => {
  const policy = new PermissionPolicy({
    version: 1,
    rules: [{ effect: 'allow', tool: 'write_file', match: { path: 'src/*' } }],
  });
  const write = (path: string): Approval => ({
    kind: 'write',
    description: 'write',
    toolCall: { id: '1', name: 'write_file', arguments: { path, content: 'x' } },
  });
  assert.equal(policy.decide(write('src/a.ts')), 'allow');
  assert.equal(policy.decide(write('src/nested/a.ts')), 'allow');
  assert.equal(policy.decide(write('src/../.git/hooks/pre-commit')), undefined);
  assert.equal(policy.decide(write('src\\..\\package.json')), undefined);
  assert.equal(policy.decide(write('lib/a.ts')), undefined);
});

test('deny and ask patterns see through path spelling and case, and win over allow', () => {
  const policy = new PermissionPolicy({
    version: 1,
    rules: [
      { effect: 'allow', kind: 'write' },
      { effect: 'deny', kind: 'write', match: { path: 'config/secrets/*' } },
      { effect: 'ask', tool: 'write_file', match: { path: '*.lock' } },
    ],
  });
  const write = (path: string): Approval => ({
    kind: 'write',
    description: 'write',
    toolCall: { id: '1', name: 'write_file', arguments: { path, content: 'x' } },
  });
  assert.equal(policy.decide(write('src/a.ts')), 'allow');
  for (const spelled of [
    'config/secrets/a.json',
    './config/secrets/a.json',
    '.\\config\\secrets\\a.json',
    'config//secrets/a.json',
    'Config/Secrets/A.json',
  ])
    assert.equal(policy.decide(write(spelled)), 'deny', spelled);
  assert.equal(policy.decide(write('package-lock.LOCK')), 'ask');
  // A pinned pattern denies the calls it matches, never the tool as a whole.
  assert.equal(policy.deniesEveryCall({ name: 'write_file', permission: 'write' }), false);
});

test('match patterns are bounded: escapes, oversized values and adversarial globs', () => {
  const literal = new PermissionPolicy({
    version: 1,
    rules: [{ effect: 'allow', tool: 'run_command', match: { command: 'echo \\*' } }],
  });
  const call = (command: string): Approval => ({
    ...approval,
    toolCall: { ...approval.toolCall, arguments: { command, cwd: '.' } },
  });
  assert.equal(literal.decide(call('echo *')), 'allow');
  assert.equal(literal.decide(call('echo hello')), undefined);

  const huge = 'a'.repeat(64 * 1024 + 1);
  const bounded = new PermissionPolicy({
    version: 1,
    rules: [
      { effect: 'allow', tool: 'run_command', match: { command: '*' } },
      { effect: 'deny', tool: 'write_file', match: { content: 'never-present*' } },
    ],
  });
  // Too long to compare: never allowed by a pattern, always caught by a deny pattern.
  assert.equal(bounded.decide(call(huge)), undefined);
  assert.equal(
    bounded.decide({
      kind: 'write',
      description: 'write',
      toolCall: { id: '1', name: 'write_file', arguments: { path: 'a', content: huge } },
    }),
    'deny',
  );

  // A glob that would backtrack exponentially as a regular expression answers promptly.
  const adversarial = new PermissionPolicy({
    version: 1,
    rules: [{ effect: 'deny', tool: 'run_command', match: { command: '*a*a*a*a*a*a*a*a*b' } }],
  });
  const started = performance.now();
  assert.equal(adversarial.decide(call('a'.repeat(60 * 1024))), undefined);
  assert.ok(performance.now() - started < 2000);
});

test('match rules are validated like every other rule field', () => {
  const invalid = [
    { effect: 'allow', tool: 'run_command', match: {} },
    { effect: 'allow', tool: 'run_command', match: { command: '' } },
    { effect: 'allow', tool: 'run_command', match: { command: 1 } },
    { effect: 'allow', tool: 'run_command', match: { 'bad-name': 'x' } },
    { effect: 'allow', tool: 'run_command', match: { command: 'x'.repeat(1025) } },
    { effect: 'allow', tool: 'run_command', match: ['npm test'] },
    {
      effect: 'allow',
      tool: 'run_command',
      match: { command: 'npm test' },
      arguments: { command: 'npm test' },
    },
    { effect: 'allow', match: { command: 'npm test' } },
  ];
  for (const rule of invalid)
    assert.throws(() => new PermissionPolicy({ version: 1, rules: [rule] }), /Invalid/);
  const kept = new PermissionPolicy({
    version: 1,
    rules: [{ effect: 'deny', tool: 'run_command', match: { command: 'git push*' } }],
  });
  assert.deepEqual(kept.toJSON().rules[0], {
    effect: 'deny',
    tool: 'run_command',
    match: { command: 'git push*' },
  });
});
