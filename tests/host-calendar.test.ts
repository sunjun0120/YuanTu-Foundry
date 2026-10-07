import test from 'node:test';
import assert from 'node:assert/strict';
import { httpFixture, frames, sendFrames } from './http-fixture.ts';
import { listeningHost, connectClient } from './listening-host-fixture.ts';

test('one-shot Host approval recovery keeps one logical delivery and records automatic attempts', async (t) => {
  let requests = 0;
  const url = await httpFixture(t, (_body, res) => {
    requests++;
    sendFrames(
      res,
      requests <= 2
        ? frames('', [
            {
              id: `write-${requests}`,
              name: 'write_file',
              input: { path: 'once.txt', content: 'approved once' },
            },
          ])
        : frames('Done'),
    );
  });
  const host = await listeningHost(t, {
    YUANTU_BASE_URL: url,
    YUANTU_WORKFLOWS: 'true',
    YUANTU_WORKFLOW_INTERVAL_MS: '1000',
  });
  const { client } = await connectClient(host.port);
  t.after(() => client.stop().catch(() => {}));
  await client.start();
  const session = await client.request('session.create', {});
  const task = await client.request('task.create', {
    sessionId: session.id,
    title: 'Create once.txt',
  });
  await client.request('task.trigger', {
    sessionId: session.id,
    taskId: task.id,
    trigger: { kind: 'at', enabled: true, at: '2020-01-01T00:00:00Z' },
  });
  const end = Date.now() + 15000;
  const until = async (check: () => Promise<boolean>) => {
    while (!(await check())) {
      if (Date.now() > end) throw Error('scheduled recovery timed out');
      await new Promise((r) => setTimeout(r, 20));
    }
  };
  await until(async () =>
    Boolean(
      (await client.request('task.get', { sessionId: session.id, taskId: task.id }))
        .pendingApproval,
    ),
  );
  const pending = await client.request('task.get', { sessionId: session.id, taskId: task.id });
  assert.equal(pending.nextRunAt, undefined);
  assert.equal(requests, 1);
  await client.request('task.approval.respond', {
    sessionId: session.id,
    taskId: task.id,
    allow: true,
    approvalId: pending.pendingApproval!.id,
  });
  await until(
    async () =>
      (await client.request('task.get', { sessionId: session.id, taskId: task.id })).status ===
      'completed',
  );
  const finished = await client.request('task.get', { sessionId: session.id, taskId: task.id });
  assert.equal(finished.nextRunAt, undefined);
  assert.equal(requests, 3);
  const attempts = await client.request('task.attempts', {
    sessionId: session.id,
    taskId: task.id,
  });
  assert.deepEqual(
    attempts.map((a) => a.trigger),
    ['at', 'recovery'],
  );
  const events = await client.request('session.events', { sessionId: session.id });
  assert.equal(events.entries.filter((e) => e.type === 'task.admitted').length, 1);
});
