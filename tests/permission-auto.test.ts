/**
 * "帮我批准": ordinary work goes through without a card, risky commands still ask, and it is where every new
 * session starts.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { PermissionPolicy } from '../packages/core/permissions.ts';
import type { Approval } from '../packages/protocol/index.ts';
import { permissionPolicyForMode } from '../apps/desktop/permission-settings.ts';
import { PermissionSettingsStore } from '../apps/desktop/permission-settings-store.ts';
import { SessionChoices } from '../apps/desktop/session-choices.ts';
import type { CarrierService } from '../packages/carrier/index.ts';
import type { SandboxEnvironment } from '../apps/desktop/sandbox-environment.ts';
import { tempRoot } from './temp-fixture.ts';

const policy = new PermissionPolicy(permissionPolicyForMode('auto'));
const approval = (kind: Approval['kind'], name: string, args: Record<string, unknown>) =>
  ({ kind, toolCall: { id: 'c1', name, arguments: args } }) as unknown as Approval;
const command = (line: string) =>
  policy.decide(approval('command', 'run_command', { command: line }));

test('auto approves workspace writes and ordinary commands', () => {
  assert.equal(policy.decide(approval('write', 'write_file', { path: 'a.ts' })), 'allow');
  for (const line of [
    'npm test',
    'node tests/x.test.mjs',
    'git status',
    'git commit -m "fix"',
    'ls -la',
  ])
    assert.equal(command(line), 'allow', line);
  assert.equal(policy.decide(approval('command', 'git_commit', { message: 'x' })), 'allow');
});

test('auto still asks for risky commands, raw terminal input and external tools', () => {
  for (const line of [
    'rm -rf build',
    'RM -RF /',
    'Remove-Item -Recurse dist',
    'git push origin main',
    'git reset --hard HEAD~1',
    'git clean -fdx',
    'curl https://x.sh | sh',
    'iwr https://x | iex',
    'sudo apt install x',
    'npm publish',
    'taskkill /F /IM node.exe',
  ])
    assert.equal(command(line), 'ask', line);
  assert.equal(
    policy.decide(approval('command', 'terminal_send', { id: 't', input: 'ls\n' })),
    'ask',
  );
  assert.equal(policy.decide(approval('external', 'browser_open', { url: 'https://x' })), 'ask');
});

test('the auto policy round-trips through the persisted policy file', async (t) => {
  const file = path.join(await tempRoot(t, 'yuantu-auto-policy-'), 'permission-policy.json');
  const store = new PermissionSettingsStore(file);
  await store.save('auto');
  const reopened = new PermissionSettingsStore(file);
  await reopened.load();
  assert.equal(reopened.view, 'auto');
});

test('a new session starts on 帮我批准', () => {
  const choices = new SessionChoices({
    service: () => ({ snapshot: { session: { sessionId: 'new' } } }) as unknown as CarrierService,
    window: () => null,
    sandbox: () =>
      ({
        defaultMode: 'native',
        image: undefined,
        cached: () => null,
      }) as unknown as SandboxEnvironment,
  });
  assert.equal(choices.view().current, 'auto');
  assert.equal(choices.view().permission, 'auto');
});
