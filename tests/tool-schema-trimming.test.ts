/**
 * The tool schema a run sends is the schema it can use.
 *
 * Sending a tool the run can never call is not free: the model spends rounds choosing it, the user is asked
 * to approve something the policy already refused, and every request carries the schema. A planning phase
 * already trimmed on its own (`readOnly`); this is about the *effective permission policy* trimming too, so
 * a desktop session in read-only mode no longer receives 29 schemas whose every call would be refused.
 *
 * Hiding is never the guarantee — `ToolRegistry.execute` still refuses the call — so these tests check both
 * halves: what is sent, and that a denied tool is refused when the model asks for it anyway.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SessionStore } from '../packages/storage/sqlite.ts';
import { PermissionPolicy } from '../packages/core/permissions.ts';
import { permissionPolicyForMode } from '../apps/desktop/permission-settings.ts';
import { Agent } from '../packages/core/agent.ts';
import { createTools } from '../packages/tools/index.ts';
import type { ModelResponse, ToolSpec } from '../packages/protocol/index.ts';

const names = (specs: readonly ToolSpec[]): string[] => specs.map((spec) => spec.name).sort();
const policyOf = (
  rules: { effect: 'allow' | 'deny' | 'ask'; kind?: 'write' | 'command' | 'external' }[],
) => new PermissionPolicy({ version: 1, rules });

test('a policy that denies a kind trims that kind and leaves the rest', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-trim-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const tools = createTools(root);
  const all = names(tools.specs());
  const noExternal = names(
    tools.specs({ policy: policyOf([{ effect: 'deny', kind: 'external' }]) }),
  );
  assert.ok(all.length > noExternal.length, 'a denied kind is a real trim');
  assert.ok(!noExternal.includes('web_fetch'), 'a denied external tool is not sent');
  assert.ok(noExternal.includes('read_file'), 'a tool with no permission stays');
  assert.ok(noExternal.includes('write_file'), 'a tool of another kind stays');
  assert.deepEqual(
    names(tools.specs({ policy: policyOf([{ effect: 'allow', kind: 'write' }]) })),
    all,
    'allow rules trim nothing',
  );
  assert.deepEqual(
    names(tools.specs({ policy: policyOf([{ effect: 'ask', kind: 'command' }]) })),
    all,
    'a rule that asks per call trims nothing',
  );
});

test("the desktop's read-only mode sends what it will allow", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-trim-mode-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const tools = createTools(root);
  const policy = new PermissionPolicy(permissionPolicyForMode('read-only'));
  const trimmed = tools.specs({ policy });
  assert.deepEqual(
    names(trimmed),
    names(tools.specs({ readOnly: true })),
    'read-only mode and a read-only phase agree on the same set, however they got there',
  );
  assert.ok(
    JSON.stringify(tools.specs()).length > JSON.stringify(trimmed).length,
    'and the schema that goes over the wire is smaller',
  );
});

test('a tool the policy denies is refused even when the model calls it', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-trim-refuse-'));
  const store = new SessionStore(path.join(root, 'sessions.sqlite'));
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const session = store.create(root);
  const seen: string[][] = [];
  let turn = 0;
  const policy = policyOf([
    { effect: 'deny', kind: 'write' },
    { effect: 'deny', kind: 'command' },
    { effect: 'deny', kind: 'external' },
  ]);
  const reply = (text: string): ModelResponse => ({
    text,
    toolCalls: [],
    finishReason: 'stop',
    usage: { inputTokens: 10, outputTokens: 5 },
  });
  const agent = new Agent({
    store,
    tools: createTools(root),
    permissionPolicy: () => policy,
    approve: async (approval) => policy.decide(approval) !== 'deny',
    provider: {
      async complete(request) {
        seen.push(request.tools.map((tool) => tool.name));
        turn++;
        // The first round asks for a tool the policy denies. The registry refuses it whether or not the
        // schema advertised it, which is the half that makes hiding a courtesy rather than the guarantee.
        return turn === 1
          ? {
              text: '',
              finishReason: 'tool_calls',
              toolCalls: [
                { id: 'w1', name: 'write_file', arguments: { path: 'x.txt', content: 'x' } },
              ],
              usage: { inputTokens: 10, outputTokens: 5 },
            }
          : reply('stopped');
      },
    },
  });
  const result = await agent.run({ sessionId: session.id, prompt: 'Try to write' });
  assert.equal(result.status, 'completed', result.error);
  assert.ok(seen.length >= 2);
  assert.ok(
    !seen[0]!.includes('write_file') && !seen[0]!.includes('run_command'),
    'the schema did not offer the tools the policy denies',
  );
  const tool = store.messages(session.id).find((message) => message.role === 'tool');
  assert.equal(
    tool?.role === 'tool' && tool.isError,
    true,
    'the denied call came back as a refusal',
  );
});
