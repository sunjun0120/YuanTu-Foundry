import test from 'node:test';
import assert from 'node:assert/strict';
import { listeningHost, connectClient } from './listening-host-fixture.ts';
import { httpFixture, frames, sendFrames } from './http-fixture.ts';

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
