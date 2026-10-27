import test from 'node:test';
import assert from 'node:assert/strict';
import { listeningHost, connectClient } from './listening-host-fixture.ts';
import { httpFixture, frames, sendFrames } from './http-fixture.ts';
import { permissionPolicyForMode } from '../apps/desktop/permission-settings.ts';
import { nativeSkip } from './native-platform.ts';

test('the Host advertises and echoes the file and network policy it was given', async (t) => {
  const host = await listeningHost(t, { YUANTU_SANDBOX: 'host' });
  const { client } = await connectClient(host);
  t.after(() => client.stop().catch(() => {}));
  const info = await client.start();
  // The carrier refuses a strict selection unless the Host says it can acknowledge one, so this string is the
  // contract between the two halves: `CarrierService.applySelection` reads exactly this capability.
  assert.ok(
    info.capabilities.includes('execution-policy-files-network-v1'),
    `capabilities: ${info.capabilities.join(', ')}`,
  );
  const session = await client.request('session.create', {});
  const selection = await client.request('sandbox.set', {
    sessionId: session.id,
    mode: 'seatbelt',
    files: 'read-only',
    network: 'denied',
  });
  assert.deepEqual(selection, { mode: 'seatbelt', files: 'read-only', network: 'denied' });
});

test('unsupported and retired selections are rejected before changing the Host selection', async (t) => {
  const host = await listeningHost(t, { YUANTU_SANDBOX: 'host' });
  const { client } = await connectClient(host);
  t.after(() => client.stop().catch(() => {}));
  await client.start();
  const session = await client.request('session.create', {});
  await assert.rejects(
    client.request('sandbox.set', { sessionId: session.id, mode: 'host', files: 'read-only' }),
    /filesystem capability/,
  );
  // The retired token backend fails closed through the same wire command, naming the replacement.
  await assert.rejects(
    client.request('sandbox.set', { sessionId: session.id, mode: 'windows', files: 'read-only' }),
    /windows sandbox was removed; select native/,
  );
});

test(
  'a read-only workspace selection blocks a pending write even when permission is allowed',
  { timeout: 15000 },
  async (t) => {
    const results: unknown[] = [];
    const url = await httpFixture(t, (body, response) => {
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
              id: 'pending-write',
              name: 'write_file',
              input: { path: 'should-not-exist.txt', content: 'denied' },
            },
          ]),
        );
    });
    const host = await listeningHost(t, { YUANTU_SANDBOX: 'host', YUANTU_BASE_URL: url });
    const { client } = await connectClient(host);
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
    const run = client.run(session.id, 'write a file');
    void run.catch(() => {});
    t.after(async () => {
      off();
      await client.request('run.cancel', { sessionId: session.id }).catch(() => {});
      await run.catch(() => {});
    });
    await approval;
    await client.request('sandbox.set', {
      sessionId: session.id,
      mode: 'seatbelt',
      files: 'read-only',
    });
    await client.request('permission.update', {
      sessionId: session.id,
      policy: permissionPolicyForMode('full-access'),
    });
    assert.equal((await run).status, 'completed');
    assert.match(JSON.stringify(results[0]), /read.only/i);
    assert.match(JSON.stringify(results[0]), /"is_error":true/);
    const { stat } = await import('node:fs/promises');
    const { join } = await import('node:path');
    await assert.rejects(stat(join(host.root, 'should-not-exist.txt')), { code: 'ENOENT' });
  },
);

test(
  'switching the session sandbox during approval executes the pending command in the new backend',
  { timeout: 15000, skip: nativeSkip },
  async (t) => {
    const results: unknown[] = [];
    const systems: string[] = [];
    const url = await httpFixture(t, (body, response) => {
      systems.push(JSON.stringify(body.system));
      const last = body.messages.at(-1);
      const result = Array.isArray(last?.content)
        ? last.content.find((block: { type: string }) => block.type === 'tool_result')
        : undefined;
      if (
        result ||
        body.messages.some(
          (message: { content: unknown }) =>
            Array.isArray(message.content) &&
            message.content.some((block) => block.type === 'tool_result'),
        )
      ) {
        if (result) results.push(result);
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
    const host = await listeningHost(t, { YUANTU_SANDBOX: 'native', YUANTU_BASE_URL: url });
    const { client } = await connectClient(host);
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
    const completed = await run;
    /**
     * `echo` changes nothing in the project, so the automatic-verification gate has nothing to ask for: the
     * sandbox switch is what this test is about, and a query command is allowed to finish without checks.
     */
    assert.equal(completed.status, 'completed');
    assert.equal(completed.completion, undefined);
    assert.equal(results.length, 1, 'the command must not be replayed by the sandbox switch');
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
    const { client } = await connectClient(host);
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
    if (
      result ||
      body.messages.some(
        (message: { content: unknown }) =>
          Array.isArray(message.content) &&
          message.content.some((block) => block.type === 'tool_result'),
      )
    ) {
      if (result) results.push(result);
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
  const { client } = await connectClient(host);
  t.after(() => client.stop().catch(() => {}));
  await client.start();
  await client.request('permission.update', {
    policy: { version: 1, rules: [{ kind: 'command', effect: 'allow' }] },
  });
  const a = await client.request('session.create', {}),
    b = await client.request('session.create', {});
  await client.request('sandbox.set', { sessionId: a.id, mode: 'host' });
  await client.request('sandbox.set', { sessionId: b.id, mode: 'seatbelt' });
  const ran = await client.run(a.id, 'run a');
  // The command is a query: it changes no project file, so automatic verification has nothing to require.
  assert.equal(ran.status, 'completed');
  assert.equal(ran.completion, undefined);
  assert.notEqual(results[0]?.is_error, true);
  assert.match(JSON.stringify(results[0]?.content), /SESSION_POLICY_COMMAND/);
  assert.match(systems[0]!, /Command environment: host/);
  assert.equal((await client.run(b.id, 'run b')).status, 'completed');
  assert.equal(results[1]?.is_error, true);
  assert.doesNotMatch(JSON.stringify(results[1]?.content), /SESSION_POLICY_COMMAND/);
  assert.match(systems.at(-1)!, /macOS native Seatbelt/);
});

test(
  "changing another session's permission policy leaves a pending approval untouched",
  { timeout: 15000 },
  async (t) => {
    const results: unknown[] = [];
    const url = await httpFixture(t, (body, response) => {
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
              id: 'isolated-command',
              name: 'run_command',
              input: { command: 'echo ISOLATED_PENDING_COMMAND' },
            },
          ]),
        );
    });
    const host = await listeningHost(t, { YUANTU_SANDBOX: 'host', YUANTU_BASE_URL: url });
    const { client } = await connectClient(host);
    t.after(() => client.stop().catch(() => {}));
    await client.start();
    await client.request('permission.update', { policy: permissionPolicyForMode('ask') });
    const a = await client.request('session.create', {});
    const b = await client.request('session.create', {});
    let arrived!: () => void;
    const approval = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    const off = client.subscribe((event) => {
      if (event.type === 'approval.required') arrived();
    });
    const run = client.run(a.id, 'run a pending command');
    void run.catch(() => {});
    t.after(async () => {
      off();
      await client.request('run.cancel', { sessionId: a.id }).catch(() => {});
      await run.catch(() => {});
    });
    await approval;
    const other = await client.request('permission.update', {
      sessionId: b.id,
      policy: permissionPolicyForMode('read-only'),
    });
    assert.equal(other.resolvedApprovals, 0);
    const own = await client.request('permission.update', {
      sessionId: a.id,
      policy: permissionPolicyForMode('full-access'),
    });
    assert.equal(own.resolvedApprovals, 1);
    const completed = await run;
    // A query command leaves the project unchanged; it needs no verification and ends completed.
    assert.equal(completed.status, 'completed');
    assert.equal(completed.completion, undefined);
    assert.match(JSON.stringify(results[0]), /ISOLATED_PENDING_COMMAND/);
    assert.doesNotMatch(JSON.stringify(results[0]), /"is_error":true/);
  },
);
