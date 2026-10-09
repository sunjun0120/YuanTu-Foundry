import test from 'node:test';
import assert from 'node:assert/strict';
import { listeningHost, connectClient } from './listening-host-fixture.ts';
import { httpFixture, frames, sendFrames } from './http-fixture.ts';
import { permissionPolicyForMode } from '../apps/desktop/permission-settings.ts';

test(
  'switching the session sandbox during approval executes the pending command in the new backend',
  { timeout: 15000 },
  async (t) => {
    const results: unknown[] = [];
    const systems: string[] = [];
    const url = await httpFixture(t, (body, response) => {
      systems.push(JSON.stringify(body.system));
      const last = body.messages.at(-1);
      const result = Array.isArray(last?.content)
        ? last.content.find((block: { type: string }) => block.type === 'tool_result')
        : undefined;
      if (result) {
        results.push(result);
        sendFrames(response, frames('done'));
      } else
        sendFrames(
          response,
          frames('', [
            {
              id: 'pending-command',
              name: 'run_command',
              input: { command: 'echo SWITCHED_PENDING_COMMAND' },
            },
          ]),
        );
    });
    const host = await listeningHost(t, { YUANTU_SANDBOX: 'sbx', YUANTU_BASE_URL: url });
    const { client } = await connectClient(host.port);
    t.after(() => client.stop().catch(() => {}));
    await client.start();
    const session = await client.request('session.create', {});
    await client.request('permission.update', { policy: permissionPolicyForMode('ask') });
    let arrived!: () => void;
    const approval = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    const off = client.subscribe((event) => {
      if (event.type === 'approval.required') arrived();
    });
    const run = client.run(session.id, 'run a pending command');
    void run.catch(() => {});
    t.after(async () => {
      off();
      await client.request('run.cancel', { sessionId: session.id }).catch(() => {});
      await run.catch(() => {});
    });
    await approval;
    await client.request('sandbox.set', { sessionId: session.id, mode: 'host' });
    await client.request('permission.update', {
      sessionId: session.id,
      policy: permissionPolicyForMode('full-access'),
    });
    assert.equal((await run).status, 'completed');
    assert.match(JSON.stringify(results[0]), /SWITCHED_PENDING_COMMAND/);
    assert.doesNotMatch(JSON.stringify(results[0]), /"is_error":true/);
    assert.match(systems[1]!, /Command environment: host/);
  },
);

test(
  'switching to read-only settles pending approval and removes mutation tools from the next round',
  { timeout: 15000 },
  async (t) => {
    const catalogues: Array<Array<{ name: string }>> = [];
    const results: unknown[] = [];
    const url = await httpFixture(t, (body, response) => {
      catalogues.push(body.tools);
      const last = body.messages.at(-1);
      const result = Array.isArray(last?.content)
        ? last.content.find((block: { type: string }) => block.type === 'tool_result')
        : undefined;
      if (result) {
        results.push(result);
        sendFrames(response, frames('denied safely'));
      } else
        sendFrames(
          response,
          frames('', [
            {
              id: 'pending-command',
              name: 'run_command',
              input: { command: 'echo MUST_NOT_EXECUTE' },
            },
          ]),
        );
    });
    const host = await listeningHost(t, { YUANTU_SANDBOX: 'host', YUANTU_BASE_URL: url });
    const { client } = await connectClient(host.port);
    t.after(() => client.stop().catch(() => {}));
    await client.start();
    const session = await client.request('session.create', {});
    let arrived!: () => void;
    const approval = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    const off = client.subscribe((event) => {
      if (event.type === 'approval.required') arrived();
    });
    const run = client.run(session.id, 'request a command');
    void run.catch(() => {});
    t.after(async () => {
      off();
      await client.request('run.cancel', { sessionId: session.id }).catch(() => {});
      await run.catch(() => {});
    });
    await approval;
    await client.request('permission.update', {
      sessionId: session.id,
      policy: permissionPolicyForMode('read-only'),
    });
    assert.equal((await run).status, 'completed');
    assert.match(JSON.stringify(results[0]), /Permission denied/);
    assert.equal(
      catalogues[1]!.some((tool) => tool.name === 'run_command' || tool.name === 'write_file'),
      false,
    );
  },
);

test('the Host selects the visible session policy without changing another session or falling back from an unavailable backend', async (t) => {
  const results: Array<{ is_error?: boolean; content: unknown }> = [];
  const systems: string[] = [];
  const url = await httpFixture(t, (body, response) => {
    systems.push(JSON.stringify(body.system));
    const last = body.messages.at(-1);
    const result = Array.isArray(last?.content)
      ? last.content.find((b: { type: string }) => b.type === 'tool_result')
      : undefined;
    if (result) {
      results.push(result);
      sendFrames(response, frames('done'));
    } else
      sendFrames(
        response,
        frames('', [
          { id: 'command', name: 'run_command', input: { command: 'echo SESSION_POLICY_COMMAND' } },
        ]),
      );
  });
  const host = await listeningHost(t, { YUANTU_SANDBOX: 'host', YUANTU_BASE_URL: url });
  const { client } = await connectClient(host.port);
  t.after(() => client.stop().catch(() => {}));
  await client.start();
  await client.request('permission.update', {
    policy: { version: 1, rules: [{ kind: 'command', effect: 'allow' }] },
  });
  const a = await client.request('session.create', {}),
    b = await client.request('session.create', {});
  await client.request('sandbox.set', { sessionId: a.id, mode: 'host' });
  await client.request('sandbox.set', { sessionId: b.id, mode: 'sbx' });
  assert.equal((await client.run(a.id, 'run a')).status, 'completed');
  assert.notEqual(results[0]?.is_error, true);
  assert.match(JSON.stringify(results[0]?.content), /SESSION_POLICY_COMMAND/);
  assert.match(systems[0]!, /Command environment: host/);
  assert.equal((await client.run(b.id, 'run b')).status, 'completed');
  assert.equal(results[1]?.is_error, true);
  assert.doesNotMatch(JSON.stringify(results[1]?.content), /SESSION_POLICY_COMMAND/);
  assert.match(systems[2]!, /Docker Sandboxes/);
});
