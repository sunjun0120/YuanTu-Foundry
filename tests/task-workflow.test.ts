import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, access, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AgentHostClient } from '../packages/client/host-client.ts';
import { httpFixture, frames, sendFrames } from './http-fixture.ts';
import { projectRoot } from './process-fixture.ts';
import type { Acceptance, Task } from '../packages/protocol/index.ts';

async function fixture(t: TestContext, mode: 'draft' | 'tool' | 'run' = 'run', delayMs = 0) {
  let requests = 0;
  const bodies: any[] = [];
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-task-workflow-'));
  const draft = {
    title: 'Reviewed draft',
    description: 'Only execute after explicit start',
    steps: [{ description: 'Implement', status: 'completed' }],
    acceptance: [{ description: 'User reviews result', met: true }],
  };
  const url = await httpFixture(t, async (body, res) => {
    requests++;
    bodies.push(body);
    if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
    sendFrames(
      res,
      frames(
        mode === 'run' ? 'Done' : JSON.stringify(draft),
        mode === 'tool'
          ? [{ id: 'unsafe', name: 'write_file', input: { path: 'forbidden.txt', content: 'bad' } }]
          : [],
      ),
    );
  });
  const client = new AgentHostClient({
    nodePath: process.execPath,
    hostPath: path.join(projectRoot, 'apps/agent-host/main.ts'),
    workspace: root,
    ...(delayMs ? { requestTimeoutMs: 1000 } : {}),
    env: {
      YUANTU_BASE_URL: url,
      YUANTU_MODEL: 'fixture',
      YUANTU_MAX_CONTEXT_TOKENS: '128000',
      YUANTU_SESSION_TITLES: '0',
      YUANTU_API_KEY: 'test',
      YUANTU_PROTOCOL: 'anthropic',
    },
  });
  t.after(async () => {
    await client.stop();
    await rm(root, { recursive: true, force: true });
  });
  await client.start();
  const session = await client.request('session.create', {});
  const create = (acceptance: Acceptance[] = [{ description: 'Review result', met: false }]) =>
    client.request('task.create', {
      sessionId: session.id,
      title: 'Test task',
      description: 'Perform task',
      steps: [{ description: 'Implement', status: 'pending' }],
      acceptance,
    });
  const get = (task: Task) =>
    client.request('task.get', { sessionId: session.id, taskId: task.id });
  const confirm = (task: Task, indices = [0]) =>
    client.request('task.confirm', {
      sessionId: session.id,
      taskId: task.id,
      expectedUpdatedAt: task.updatedAt,
      indices,
    });
  return {
    client,
    root,
    sessionId: session.id,
    create,
    get,
    confirm,
    bodies,
    requests: () => requests,
  };
}

test('task proposal only drafts, normalizes claimed completion, and makes no tool effects', async (t) => {
  const f = await fixture(t, 'draft');
  const task = await f.create();
  const proposed = await f.client.request('task.propose', {
    sessionId: f.sessionId,
    taskId: task.id,
  });
  assert.equal(proposed.status, 'pending');
  assert.equal(proposed.acceptance[0]!.met, false);
  assert.equal(proposed.steps[0]!.status, 'pending');
  assert.equal(f.requests(), 1);
  assert.deepEqual(f.bodies[0].tools ?? [], []);
  assert.deepEqual(
    await f.client.request('task.attempts', { sessionId: f.sessionId, taskId: task.id }),
    [],
  );
  assert.deepEqual(
    (await f.client.request('session.get', { sessionId: f.sessionId })).messages,
    [],
  );
  await assert.rejects(access(path.join(f.root, 'forbidden.txt')));
  await assert.rejects(f.confirm(proposed), /Execute the current task definition/);
});

test('tool-calling proposal is rejected without execution or task changes', async (t) => {
  const f = await fixture(t, 'tool');
  const task = await f.create();
  await assert.rejects(
    f.client.request('task.propose', { sessionId: f.sessionId, taskId: task.id }),
    /without tool calls/,
  );
  assert.deepEqual(await f.get(task), task);
  await assert.rejects(access(path.join(f.root, 'forbidden.txt')));
});

test('task edit rejects stale revisions and clears all completion evidence', async (t) => {
  const f = await fixture(t);
  const task = await f.create();
  await f.client.run(f.sessionId, 'Perform task', { taskId: task.id });
  const reviewed = await f.get(task);
  const complete = await f.confirm(reviewed);
  assert.equal(complete.status, 'completed');
  assert.ok(complete.verification?.passed);
  const edited = await f.client.request('task.update', {
    sessionId: f.sessionId,
    taskId: task.id,
    expectedUpdatedAt: complete.updatedAt,
    description: 'New definition',
    steps: complete.steps,
    acceptance: complete.acceptance,
  });
  assert.equal(edited.status, 'pending');
  assert.equal(edited.verification, undefined);
  assert.equal(edited.acceptance[0]!.met, false);
  assert.equal(edited.steps[0]!.status, 'pending');
  assert.notEqual(edited.updatedAt, complete.updatedAt);
  await assert.rejects(
    f.client.request('task.update', {
      sessionId: f.sessionId,
      taskId: task.id,
      expectedUpdatedAt: complete.updatedAt,
      description: 'Stale write',
    }),
    /Task changed/,
  );
  await assert.rejects(f.confirm(complete), /Task changed/);
  assert.deepEqual(await f.get(task), edited);
  await assert.rejects(f.confirm(edited), /Execute the current task definition/);
});

test('unexecuted tasks cannot be manually confirmed even after standalone verification', async (t) => {
  const f = await fixture(t);
  const task = await f.create();
  await assert.rejects(f.confirm(task), /Execute the current task definition/);
  const verified = await f.client.request('task.verify', {
    sessionId: f.sessionId,
    taskId: task.id,
  });
  await assert.rejects(f.confirm(verified.task), /Execute the current task definition/);
  assert.equal(f.requests(), 0);
});

test('manual confirmation cannot select machine checks or override their failure', async (t) => {
  const f = await fixture(t);
  const task = await f.create([
    { description: 'Review result', met: false },
    {
      description: 'Required output',
      met: false,
      check: { id: 'output', kind: 'file-exact', path: 'missing.txt', expected: 'ok' },
    },
  ]);
  const result = await f.client.run(f.sessionId, 'Perform task', { taskId: task.id });
  assert.equal(result.status, 'needs_review');
  const reviewed = await f.get(task);
  await assert.rejects(f.confirm(reviewed, [1]), /Only manual criteria/);
  const confirmed = await f.confirm(reviewed);
  assert.equal(confirmed.status, 'needs_review');
  assert.equal(confirmed.acceptance[0]!.met, true);
  assert.equal(confirmed.acceptance[1]!.met, false);
  assert.equal(confirmed.verification?.passed, false);
  assert.equal(confirmed.verification?.checks.find((x) => x.id === 'output')?.passed, false);
});

test('old run plus verification cannot authorize confirmation of a revised task', async (t) => {
  const f = await fixture(t);
  const task = await f.create();
  await f.client.run(f.sessionId, 'Perform task', { taskId: task.id });
  const reviewed = await f.get(task);
  const edited = await f.client.request('task.update', {
    sessionId: f.sessionId,
    taskId: task.id,
    expectedUpdatedAt: reviewed.updatedAt,
    description: 'A different task requiring a new run',
  });
  const verified = await f.client.request('task.verify', {
    sessionId: f.sessionId,
    taskId: edited.id,
  });
  await assert.rejects(f.confirm(verified.task), /Execute the current task definition/);
  assert.equal(f.requests(), 1);
});

test('slow task planning outlives ordinary RPC timeout without starting tools', async (t) => {
  const f = await fixture(t, 'draft', 1500);
  const task = await f.create();
  const proposed = await f.client.request('task.propose', {
    sessionId: f.sessionId,
    taskId: task.id,
  });
  assert.equal(proposed.status, 'pending');
  assert.equal(proposed.attemptCount, 0);
  assert.equal(f.requests(), 1);
  assert.deepEqual(f.bodies[0].tools ?? [], []);
});

test('slow task retry outlives ordinary RPC timeout', async (t) => {
  const f = await fixture(t, 'run', 1500);
  const task = await f.create();
  const result = await f.client.request('task.retry', {
    sessionId: f.sessionId,
    taskId: task.id,
    prompt: 'Perform the task',
  });
  assert.equal(result.status, 'needs_review');
  assert.equal(f.requests(), 1);
});

test('creating a task cannot forge manual completion before verification', async (t) => {
  const f = await fixture(t);
  const task = await f.create([{ description: 'Human checks result', met: true }]);
  assert.equal(task.acceptance[0]!.met, false);
  const verified = await f.client.request('task.verify', {
    sessionId: f.sessionId,
    taskId: task.id,
  });
  assert.equal(verified.task.status, 'needs_review');
  assert.equal(verified.task.verification?.passed, false);
  assert.equal(f.requests(), 0);
});

test('verifying a task that was never run cannot complete it', async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.root, 'result.txt'), 'expected');
  const task = await f.create([
    {
      description: 'result file matches',
      met: false,
      check: { id: 'exact', kind: 'file-exact', path: 'result.txt', expected: 'expected' },
    },
  ]);
  const verified = await f.client.request('task.verify', {
    sessionId: f.sessionId,
    taskId: task.id,
  });
  assert.equal(verified.task.status, 'needs_review');
  assert.equal(verified.task.verification?.passed, true);
  assert.match(verified.attempt.error ?? '', /not been run/);
  assert.equal(f.requests(), 0);
});

test('task creation validates executable check ids and kinds', async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.create([
      {
        description: 'first',
        met: false,
        check: { id: 'dup', kind: 'file-exact', path: 'a.txt', expected: 'a' },
      },
      {
        description: 'second',
        met: false,
        check: { id: 'dup', kind: 'file-exact', path: 'b.txt', expected: 'b' },
      },
    ]),
    /Duplicate acceptance check id/,
  );
  await assert.rejects(
    f.create([
      {
        description: 'bad kind',
        met: false,
        check: { id: 'x', kind: 'bogus' as never, path: 'a.txt' },
      },
    ]),
    /Unsupported acceptance kind/,
  );
});

test('task verification refuses a command acceptance denied by permission policy', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-task-verify-deny-'));
  const policy = path.join(root, 'policy.json');
  await writeFile(
    policy,
    JSON.stringify({ version: 1, rules: [{ effect: 'deny', kind: 'command' }] }),
  );
  const outside = path.join(tmpdir(), `yuantu-verify-pwn-${Date.now()}-${Math.random()}`);
  const client = new AgentHostClient({
    nodePath: process.execPath,
    hostPath: path.join(projectRoot, 'apps/agent-host/main.ts'),
    workspace: root,
    env: { YUANTU_PERMISSION_POLICY: policy },
  });
  t.after(async () => {
    await client.stop();
    await rm(root, { recursive: true, force: true });
  });
  await client.start();
  const session = await client.request('session.create', {});
  const task = await client.request('task.create', {
    sessionId: session.id,
    title: 'denied command acceptance',
    steps: [{ description: 'no-op', status: 'pending' }],
    acceptance: [
      {
        description: 'writes outside the workspace',
        met: false,
        check: {
          id: 'pwn',
          kind: 'command',
          command: process.execPath,
          args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(outside)}, 'pwn')`],
        },
      },
    ],
  });
  const verified = await client.request('task.verify', {
    sessionId: session.id,
    taskId: task.id,
  });
  assert.equal(verified.task.status, 'needs_review');
  assert.equal(verified.attempt.verification?.passed, false);
  await assert.rejects(access(outside));
});
