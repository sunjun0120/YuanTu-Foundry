// tests/builtin-services-tasks.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import type { AnalysisClient } from '../packages/builtin-services/client.ts';
import { resolveBuiltinService } from '../packages/builtin-services/manifest.ts';
import { AnalysisTasks, MAX_RECORD_OUTPUT } from '../packages/builtin-services/tasks.ts';
import { tempRoot } from './temp-fixture.ts';

const manifest = resolveBuiltinService({ YUANTU_BUILTIN_SERVICES_URL: 'http://127.0.0.1:4100' })!;
const noSleep = async () => {};

/**
 * A stand-in backend, typed as the producer sees its client.
 *
 * The annotation is load-bearing: without it the object literals below widen `type: 'text'` to `string`, and the
 * mock stops being assignable to `Pick<AnalysisClient, 'callTool'>` (whose results are `CallToolResult`).
 */
function backend(statuses: string[], result = 'GPL-3.0: 2 packages') {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const client: Pick<AnalysisClient, 'callTool'> = {
    async callTool(name, args) {
      calls.push({ name, args });
      if (name === 'task_status')
        return {
          content: [],
          structuredContent: { status: statuses.shift() ?? 'running', message: 'scanning' },
        };
      if (name === 'task_result') return { content: [{ type: 'text', text: result }] };
      return { content: [{ type: 'text', text: 'cancelled' }] };
    },
  };
  return { calls, client };
}

test('a started task is listed and its result arrives through job_output', async (t) => {
  const root = await tempRoot(t);
  const { client, calls } = backend(['running', 'completed']);
  const tasks = new AnalysisTasks({
    file: path.join(root, 'tasks.json'),
    manifest,
    client,
    sleep: noSleep,
  });
  const producer = tasks.jobProducer();
  const { id } = tasks.start({
    scope: 's',
    taskId: 't-1',
    tool: 'vuln_scan',
    label: 'vuln_scan p-1',
  });
  assert.equal(id, 'analysis-t-1');
  assert.deepEqual(
    producer.list('s').map((job) => [job.id, job.kind, job.status]),
    [['analysis-t-1', 'analysis', 'queued']],
  );
  assert.deepEqual(producer.list('other'), []);
  assert.equal(producer.owns({ id, scope: 's' }), true);
  assert.equal(producer.owns({ id, scope: 'other' }), false);
  const snapshot = await producer.output({ id, scope: 's', cursor: 0, waitMs: 60_000 });
  assert.equal(snapshot.status, 'completed');
  assert.match(snapshot.output, /GPL-3.0: 2 packages/);
  assert.deepEqual(
    calls.map((call) => call.name),
    ['task_status', 'task_status', 'task_result'],
  );
  assert.deepEqual(calls[0]?.args, { task_id: 't-1' });
  const again = await producer.output({ id, scope: 's', cursor: snapshot.nextCursor, waitMs: 0 });
  assert.equal(again.output, '');
  assert.equal(calls.length, 3, 'a settled task is not asked again');
});

test('waitMs 0 asks once and returns the running state', async (t) => {
  const root = await tempRoot(t);
  const { client, calls } = backend(['running']);
  const tasks = new AnalysisTasks({
    file: path.join(root, 'tasks.json'),
    manifest,
    client,
    sleep: noSleep,
  });
  const { id } = tasks.start({ scope: 's', taskId: 't-2', tool: 'vuln_scan', label: 'x' });
  const snapshot = await tasks.jobProducer().output({ id, scope: 's', cursor: 0, waitMs: 0 });
  assert.equal(snapshot.status, 'running');
  assert.match(snapshot.output, /scanning/);
  assert.equal(calls.length, 1);
});

test('one task record keeps a bounded amount of output', async (t) => {
  const root = await tempRoot(t);
  const { client } = backend(['completed'], 'x'.repeat(MAX_RECORD_OUTPUT + 10));
  const tasks = new AnalysisTasks({
    file: path.join(root, 'tasks.json'),
    manifest,
    client,
    sleep: noSleep,
  });
  const { id } = tasks.start({ scope: 's', taskId: 't-6', tool: 'vuln_scan', label: 'x' });
  const snapshot = await tasks.jobProducer().output({ id, scope: 's', cursor: 0, waitMs: 0 });
  assert.equal(snapshot.status, 'completed');
  assert.equal(snapshot.truncated, true);
  assert.ok(
    snapshot.output.length <= MAX_RECORD_OUTPUT + 200,
    'the record and the file it is rewritten into stay bounded',
  );
});

test('job_kill cancels on the backend once, and is idempotent', async (t) => {
  const root = await tempRoot(t);
  const { client, calls } = backend([]);
  const tasks = new AnalysisTasks({
    file: path.join(root, 'tasks.json'),
    manifest,
    client,
    sleep: noSleep,
  });
  const { id } = tasks.start({ scope: 's', taskId: 't-3', tool: 'vuln_scan', label: 'x' });
  const producer = tasks.jobProducer();
  assert.equal((await producer.kill({ id, scope: 's' })).status, 'cancelled');
  assert.equal((await producer.kill({ id, scope: 's' })).status, 'cancelled');
  assert.deepEqual(
    calls.map((call) => call.name),
    ['task_cancel'],
  );
});

test('records survive a new instance, as after a Host restart', async (t) => {
  const root = await tempRoot(t);
  const file = path.join(root, 'tasks.json');
  const first = new AnalysisTasks({ file, manifest, client: backend([]).client, sleep: noSleep });
  first.start({ scope: 's', taskId: 't-4', tool: 'vuln_scan', label: 'x' });
  await first.flush();
  const second = new AnalysisTasks({
    file,
    manifest,
    client: backend(['completed']).client,
    sleep: noSleep,
  });
  assert.deepEqual(
    second
      .jobProducer()
      .list('s')
      .map((job) => job.id),
    ['analysis-t-4'],
  );
  const snapshot = await second
    .jobProducer()
    .output({ id: 'analysis-t-4', scope: 's', cursor: 0, waitMs: 0 });
  assert.equal(snapshot.status, 'completed');
});

test('an unknown backend status is a failure, not a silent wait', async (t) => {
  const root = await tempRoot(t);
  const tasks = new AnalysisTasks({
    file: path.join(root, 'tasks.json'),
    manifest,
    client: backend(['exploded']).client,
    sleep: noSleep,
  });
  const { id } = tasks.start({ scope: 's', taskId: 't-5', tool: 'vuln_scan', label: 'x' });
  await assert.rejects(
    tasks.jobProducer().output({ id, scope: 's', cursor: 0, waitMs: 0 }),
    /status/,
  );
});
test('a completed backend task retries result retrieval after a temporary failure', async (t) => {
  const root = await tempRoot(t);
  let results = 0;
  const client: Pick<AnalysisClient, 'callTool'> = {
    async callTool(name) {
      if (name === 'task_status')
        return { content: [], structuredContent: { status: 'completed' } };
      if (++results === 1) throw new Error('temporary');
      return { content: [{ type: 'text', text: 'recovered result' }] };
    },
  };
  const tasks = new AnalysisTasks({ file: path.join(root, 'tasks.json'), manifest, client });
  const id = tasks.start({ scope: 's', taskId: 'retry', tool: 'scan', label: 'scan' }).id;
  await assert.rejects(tasks.jobProducer().output({ id, scope: 's', cursor: 0, waitMs: 0 }));
  const result = await tasks.jobProducer().output({ id, scope: 's', cursor: 0, waitMs: 0 });
  assert.match(result.output, /recovered result/);
});

test('a late poll cannot undo a successful cancellation', async (t) => {
  const root = await tempRoot(t);
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const client: Pick<AnalysisClient, 'callTool'> = {
    async callTool(name) {
      if (name === 'task_status') {
        entered();
        await barrier;
        return { content: [], structuredContent: { status: 'running' } };
      }
      return { content: [] };
    },
  };
  const tasks = new AnalysisTasks({ file: path.join(root, 'tasks.json'), manifest, client });
  const id = tasks.start({ scope: 's', taskId: 'race', tool: 'scan', label: 'scan' }).id;
  const output = tasks.jobProducer().output({ id, scope: 's', cursor: 0, waitMs: 0 });
  await started;
  assert.equal((await tasks.jobProducer().kill({ id, scope: 's' })).status, 'cancelled');
  release();
  assert.equal((await output).status, 'cancelled');
});

test('cancelling one waiter does not cancel a shared poll', async (t) => {
  const root = await tempRoot(t);
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const client: Pick<AnalysisClient, 'callTool'> = {
    async callTool(_name, _args, signal) {
      calls++;
      entered();
      await barrier;
      signal.throwIfAborted();
      return { content: [], structuredContent: { status: 'running' } };
    },
  };
  const tasks = new AnalysisTasks({ file: path.join(root, 'tasks.json'), manifest, client });
  const id = tasks.start({ scope: 's', taskId: 'waiters', tool: 'scan', label: 'scan' }).id;
  const controller = new AbortController();
  const first = tasks
    .jobProducer()
    .output({ id, scope: 's', cursor: 0, waitMs: 0, signal: controller.signal });
  await started;
  const second = tasks.jobProducer().output({ id, scope: 's', cursor: 0, waitMs: 0 });
  controller.abort();
  release();
  await assert.rejects(first);
  assert.equal((await second).status, 'running');
  assert.equal(calls, 1);
});

test('aborting one job_kill does not fail another waiting on the same cancellation', async (t) => {
  const root = await tempRoot(t);
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const client: Pick<AnalysisClient, 'callTool'> = {
    async callTool(_name, _args, signal) {
      calls++;
      entered();
      await barrier;
      signal.throwIfAborted();
      return { content: [] };
    },
  };
  const tasks = new AnalysisTasks({ file: path.join(root, 'tasks.json'), manifest, client });
  const id = tasks.start({ scope: 's', taskId: 'kill-waiters', tool: 'scan', label: 'scan' }).id;
  const controller = new AbortController();
  const first = tasks.jobProducer().kill({ id, scope: 's', signal: controller.signal });
  await started;
  const second = tasks.jobProducer().kill({ id, scope: 's' });
  controller.abort();
  release();
  await assert.rejects(first);
  assert.equal((await second).status, 'cancelled');
  assert.equal(calls, 1);
});

test('concurrent cancellations share a request and failures remain retryable', async (t) => {
  const root = await tempRoot(t);
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const client: Pick<AnalysisClient, 'callTool'> = {
    async callTool() {
      calls++;
      if (calls === 1) {
        entered();
        await barrier;
        return { isError: true, content: [] };
      }
      return { content: [] };
    },
  };
  const tasks = new AnalysisTasks({ file: path.join(root, 'tasks.json'), manifest, client });
  const id = tasks.start({ scope: 's', taskId: 'cancel', tool: 'scan', label: 'scan' }).id;
  const first = tasks.jobProducer().kill({ id, scope: 's' });
  await started;
  const second = tasks.jobProducer().kill({ id, scope: 's' });
  release();
  await assert.rejects(first);
  await assert.rejects(second);
  assert.equal(calls, 1);
  assert.equal((await tasks.jobProducer().kill({ id, scope: 's' })).status, 'cancelled');
  assert.equal(calls, 2);
});

test('flush reports persistence failure instead of pretending the task was saved', async (t) => {
  const root = await tempRoot(t);
  const blocker = path.join(root, 'not-a-directory');
  const { writeFile } = await import('node:fs/promises');
  await writeFile(blocker, 'x');
  const tasks = new AnalysisTasks({
    file: path.join(blocker, 'tasks.json'),
    manifest,
    client: backend([]).client,
  });
  tasks.start({ scope: 's', taskId: 'persist', tool: 'scan', label: 'scan' });
  await assert.rejects(tasks.flush());
});
