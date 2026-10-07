import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SessionStore } from '../packages/storage/sqlite.ts';
import { httpFixture, frames, sendFrames } from './http-fixture.ts';
import { listeningHost, connectClient } from './listening-host-fixture.ts';

test('cold Host skips stale cron and automatically delivers only the latest occurrence of another', async (t) => {
  let requests = 0;
  const url = await httpFixture(t, (_body, res) => {
    requests++;
    sendFrames(res, frames('Cron checked'));
  });
  let sessionId = '',
    latestId = '',
    skipId = '';
  const host = await listeningHost(
    t,
    { YUANTU_BASE_URL: url, YUANTU_WORKFLOWS: 'true', YUANTU_WORKFLOW_INTERVAL_MS: '1000' },
    (file) => {
      const store = new SessionStore(file);
      try {
        sessionId = store.create(path.dirname(file)).id;
        latestId = store.createTask(sessionId, {
          title: 'Latest cron',
          trigger: {
            kind: 'cron',
            enabled: true,
            expression: '0 9 * * *',
            timeZone: 'Asia/Shanghai',
            misfire: 'latest',
          },
        }).id;
        skipId = store.createTask(sessionId, {
          title: 'Skip cron',
          trigger: {
            kind: 'cron',
            enabled: true,
            expression: '0 9 * * *',
            timeZone: 'Asia/Shanghai',
            misfire: 'skip',
          },
        }).id;
      } finally {
        store.close();
      }
      const db = new DatabaseSync(file);
      try {
        db.prepare('UPDATE tasks SET next_run_at=?').run('2000-01-01T01:00:00.000Z');
      } finally {
        db.close();
      }
    },
  );
  const { client } = await connectClient(host.port);
  t.after(() => client.stop().catch(() => {}));
  await client.start();
  const end = Date.now() + 15000;
  let latest = await client.request('task.get', { sessionId, taskId: latestId });
  while (!latest.lastRunAt) {
    if (Date.now() > end) throw Error(host.stderr());
    await new Promise((r) => setTimeout(r, 25));
    latest = await client.request('task.get', { sessionId, taskId: latestId });
  }
  const skip = await client.request('task.get', { sessionId, taskId: skipId });
  assert.equal(requests, 1);
  assert.equal(skip.attemptCount, 0);
  assert.equal(latest.attemptCount, 1);
  assert.ok(Date.parse(latest.nextRunAt!) > Date.now());
  assert.ok(Date.parse(skip.nextRunAt!) > Date.now());
  const attempts = await client.request('task.attempts', { sessionId, taskId: latestId });
  assert.equal(attempts[0]!.trigger, 'cron');
  const events = await client.request('session.events', { sessionId });
  assert.equal(events.entries.filter((e) => e.type === 'task.admitted').length, 1);
  assert.equal(events.entries.filter((e) => e.type === 'task.skipped').length, 1);
  const admission = events.entries.find((e) => e.type === 'task.admitted')!;
  assert.ok(Date.parse(String(admission.data.scheduledAt)) > Date.parse('2000-01-01T01:00:00Z'));
});
