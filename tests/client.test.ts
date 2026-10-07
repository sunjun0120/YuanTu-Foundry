import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { AgentHostClient, HostDisconnectedError } from '../packages/sdk/index.ts';
import { fileChangeAction, undoConfirmKey } from '../packages/client/change-actions.ts';
import { translate } from '../apps/desktop/i18n.ts';
import { httpFixture, frames, sendFrames } from './http-fixture.ts';
import { projectRoot } from './process-fixture.ts';
import { SessionController } from '../packages/client/session-controller.ts';
import type { SessionSnapshot, StatisticsDelta } from '../packages/client/session-controller.ts';
import type { AgentEvent, RunResult } from '../packages/protocol/index.ts';
import { emptyStatistics } from '../packages/protocol/statistics.ts';
import { DatabaseSync } from 'node:sqlite';
import { createProvider } from '../packages/providers/index.ts';

test('rejected send removes an optimistic message absent from durable history', async (t) => {
  const client = {
    status: 'ready',
    subscribe: () => () => {},
    subscribeStatus: () => () => {},
    async request(method: string) {
      if (method === 'session.get') return { messages: [] };
      if (method === 'plan.get') return null;
      if (method === 'subagents.list') return [];
      throw new Error(`Unexpected method: ${method}`);
    },
    async run() {
      throw new Error('This Host already has an active run');
    },
  };
  const controller = new SessionController(client as unknown as AgentHostClient);
  t.after(() => controller.dispose());
  await controller.load('session-1');
  await assert.rejects(controller.send('second request'), /already has an active run/);
  assert.deepEqual(controller.snapshot.messages, []);
  assert.equal(controller.snapshot.status, 'failed');
});

// ---- merged from client.test.ts ----

async function setup(t: test.TestContext, env: NodeJS.ProcessEnv = {}, extra = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-client-'));
  const client = new AgentHostClient({
    nodePath: process.execPath,
    hostPath: path.join(projectRoot, 'apps/agent-host/main.ts'),
    workspace: root,
    /**
     * Every Host this helper starts is quiet and declares its window.
     *
     * Two defaults, both about the fixture rather than the subject under test. The session-naming call is
     * switched off because this file scripts one response per request — a naming call is a real request to the
     * configured endpoint and would take the first response, shifting every later assertion by a step. The
     * window is declared because the runtime **refuses to guess one** (`declaredCapacity` in
     * `apps/shared/runtime.ts`): a connection that declares none is rejected before any request leaves, which
     * is a property of its own (`tests/model-capacity.test.ts`) and not what these tests are about. It belongs
     * here rather than in each caller's `env` for the same reason the naming flag does.
     */
    env: { YUANTU_MAX_CONTEXT_TOKENS: '128000', YUANTU_SESSION_TITLES: '0', ...env },
    ...extra,
  });
  t.after(async () => {
    await client.stop();
    await rm(root, { recursive: true, force: true });
  });
  return { root, client };
}
test('typed client handshakes, streams, approves a real write and reloads history', async (t) => {
  let step = 0;
  const url = await httpFixture(t, (_, res) => {
    sendFrames(
      res,
      step++ === 0
        ? frames('Creating', [
            { id: 'w', name: 'write_file', input: { path: 'hello.txt', content: 'hello' } },
          ])
        : frames('Created'),
    );
  });
  const { root, client } = await setup(t, {
    YUANTU_MODEL: 'fixture',
    YUANTU_API_KEY: 'secret-test',
    YUANTU_BASE_URL: url,
  });
  const info = await client.start();
  assert.equal(info.protocolVersion, 1);
  await assert.rejects(
    client.request('host.info', { protocolVersions: [2] }),
    (error: unknown) =>
      error instanceof Error && 'code' in error && error.code === 'UNSUPPORTED_PROTOCOL',
  );
  assert.equal((await client.request('host.info', {})).protocolVersion, 1);
  assert.equal(client.status, 'ready');
  assert.equal(info.workspace, root);
  assert.doesNotMatch(JSON.stringify(info), /secret-test/);
  const session = await client.request('session.create', {});
  const texts: string[] = [];
  let approval!: Promise<unknown>;
  client.subscribe((event) => {
    if (event.type === 'message.delta') texts.push(String(event.data.text));
    if (event.type === 'approval.required')
      approval = client.request('approval.respond', {
        approvalId: String(event.data.approvalId),
        allow: true,
      });
  });
  const result = await client.run(session.id, 'Create hello.txt');
  assert.equal(result.status, 'completed');
  await approval;
  assert.deepEqual(texts, ['Creating', 'Created']);
  assert.equal(await readFile(path.join(root, 'hello.txt'), 'utf8'), 'hello');
  const history = await client.request('session.get', { sessionId: session.id });
  assert.equal(history.messages.at(-1)?.content, 'Created');
  await client.stop();
  assert.equal(client.status, 'stopped');
  await client.start();
  assert.equal((await client.request('session.list', {})).length, 1);
});
test('run AbortSignal sends cancellation and waits for a terminal result', async (t) => {
  let opened!: () => void;
  const ready = new Promise<void>((resolve) => {
    opened = resolve;
  });
  const url = await httpFixture(t, (_, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(': wait\n\n');
    opened();
  });
  const { client } = await setup(t, {
    YUANTU_MODEL: 'fixture',
    YUANTU_API_KEY: 'test',
    YUANTU_BASE_URL: url,
  });
  await client.start();
  const session = await client.request('session.create', {});
  const controller = new AbortController();
  const run = client.run(session.id, 'wait', { signal: controller.signal });
  await ready;
  controller.abort();
  assert.equal((await run).status, 'cancelled');
  assert.equal(
    (await client.request('session.get', { sessionId: session.id })).session.activeRun,
    null,
  );
});
test('stop during approval cancels the run and keeps side effects absent', async (t) => {
  const url = await httpFixture(t, (_, res) =>
    sendFrames(
      res,
      frames('', [{ id: 'w', name: 'write_file', input: { path: 'never.txt', content: 'no' } }]),
    ),
  );
  const { root, client } = await setup(t, {
    YUANTU_MODEL: 'fixture',
    YUANTU_API_KEY: 'test',
    YUANTU_BASE_URL: url,
  });
  await client.start();
  const session = await client.request('session.create', {});
  let pending!: () => void;
  const approval = new Promise<void>((resolve) => {
    pending = resolve;
  });
  client.subscribe((event) => {
    if (event.type === 'approval.required') pending();
  });
  const run = client.run(session.id, 'write');
  await approval;
  await client.stop();
  assert.equal((await run).status, 'cancelled');
  await assert.rejects(readFile(path.join(root, 'never.txt')), { code: 'ENOENT' });
});
test('spawn failures leave no ready client or hanging requests', async (t) => {
  const { client } = await setup(
    t,
    {},
    { nodePath: path.join(projectRoot, 'missing-node-executable') },
  );
  await assert.rejects(client.start(), /start|spawn|ENOENT/i);
  assert.equal(client.status, 'failed');
  await assert.rejects(client.request('session.list', {}), /ready/i);
});

test('Host startup failure reports a safe, classified diagnostic without stderr secrets', async (t) => {
  const { client } = await setup(
    t,
    { FIXTURE_MODE: 'startup-error', YUANTU_API_KEY: 'secret-fixture-key' },
    { hostPath: path.join(projectRoot, 'tests/faulty-host.ts') },
  );
  await assert.rejects(client.start(), (error) => {
    assert.match(String(error), /ERR_MODULE_NOT_FOUND/);
    assert.match(String(error), /dependency/i);
    assert.doesNotMatch(String(error), /secret-fixture-key|missing fixture package/);
    return true;
  });
  assert.equal(client.status, 'failed');
});
test('unexpected Host exit rejects requests and restart never replays a mutation', async (t) => {
  const { root } = await setup(
    t,
    { FIXTURE_MODE: 'crash' },
    { hostPath: path.join(projectRoot, 'tests/faulty-host.ts') },
  );
  // Use a unique marker path derived from this fixture's workspace.
  const marker = path.join(root, 'marker.txt');
  const real = new AgentHostClient({
    nodePath: process.execPath,
    hostPath: path.join(projectRoot, 'tests/faulty-host.ts'),
    workspace: root,
    env: { FIXTURE_MODE: 'crash', FIXTURE_MARKER: marker, YUANTU_SESSION_TITLES: '0' },
  });
  t.after(() => real.stop());
  await real.start();
  // The rejection is typed, not prose: a caller has to be able to tell "this round is over because the process
  // died" from an ordinary failure it could retry, and it has to be able to name the process that died.
  const pid = real.pid;
  const failure: unknown = await real.request('session.create', {}).then(
    () => null,
    (error: unknown) => error,
  );
  assert.ok(failure instanceof HostDisconnectedError, String(failure));
  assert.equal(failure.pid, pid);
  assert.equal(real.status, 'failed');
  assert.equal(real.recoverable, true, 'a Host that died on its own can be started again');
  await real.start();
  assert.deepEqual(await real.request('session.list', {}), []);
  assert.equal(await readFile(marker, 'utf8'), 'mutation\n');
  await real.stop();
});

test('malformed stdout rejects without leaking Host text or credentials', async (t) => {
  const { client } = await setup(
    t,
    { FIXTURE_MODE: 'malformed', YUANTU_API_KEY: 'secret-fixture-key' },
    { hostPath: path.join(projectRoot, 'tests/faulty-host.ts') },
  );
  await client.start();
  await assert.rejects(client.request('session.create', {}), (error) => {
    assert.match(String(error), /Invalid JSONL/);
    assert.doesNotMatch(String(error), /secret-fixture-key/);
    return true;
  });
});

test('request timeout rejects once and the connection remains usable', async (t) => {
  const { client } = await setup(
    t,
    { FIXTURE_MODE: 'timeout' },
    { hostPath: path.join(projectRoot, 'tests/faulty-host.ts'), requestTimeoutMs: 500 },
  );
  await client.start();
  await assert.rejects(client.request('session.create', {}), /timed out.*unknown/);
  assert.deepEqual(await client.request('session.list', {}), []);
});

test('terminal errors in both Host events and results redact configured credentials', async (t) => {
  const { client } = await setup(
    t,
    { FIXTURE_MODE: 'leak-result', YUANTU_API_KEY: 'secret-fixture-key' },
    { hostPath: path.join(projectRoot, 'tests/faulty-host.ts') },
  );
  await client.start();
  let eventError = '';
  client.subscribe((event) => {
    if (event.type === 'run.finished')
      eventError = String((event.data.result as { error: string }).error);
  });
  const result = await client.run('fixture-session', 'test');
  assert.doesNotMatch(result.error!, /secret-fixture-key/);
  assert.doesNotMatch(eventError, /secret-fixture-key/);
  assert.match(result.error!, /redacted/);
});

test('abnormal exit while stopping is reported as failed shutdown', async (t) => {
  // The subject is the exit that happens *during* shutdown: stdin is closed and the process answers with a
  // nonzero code instead of a clean exit, so the cleanup the caller was promised cannot be confirmed. It gets
  // its own client (rather than the `setup` helper) because a second `stop()` on a client whose shutdown
  // already failed is itself a failure — the fixture's `t.after` cleanup must not turn that into a second one.
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-stop-crash-'));
  const client = new AgentHostClient({
    nodePath: process.execPath,
    hostPath: path.join(projectRoot, 'tests/faulty-host.ts'),
    workspace: root,
    env: {
      FIXTURE_MODE: 'crash-on-eof',
      YUANTU_MAX_CONTEXT_TOKENS: '128000',
      YUANTU_SESSION_TITLES: '0',
    },
  });
  t.after(async () => {
    await client.stop().catch(() => {});
    await rm(root, { recursive: true, force: true });
  });
  await client.start();
  await assert.rejects(client.stop(), /abnormally/);
  assert.equal(client.status, 'failed');
});

test('unresponsive Host shutdown is bounded and reports forced termination', async (t) => {
  const temp = await mkdtemp(path.join(tmpdir(), 'yuantu-forced-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const marker = path.join(temp, 'child.txt');
  const { client } = await setup(
    t,
    { FIXTURE_MODE: 'ignore-eof', FIXTURE_CHILD_MARKER: marker },
    { hostPath: path.join(projectRoot, 'tests/faulty-host.ts'), shutdownTimeoutMs: 200 },
  );
  await client.start();
  await assert.rejects(client.stop(), /unknown|termination|cleanup/i);
  assert.equal(client.status, 'failed');
  await new Promise((resolve) => setTimeout(resolve, 1800));
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
});

test('an interrupted undo stays actionable in the session-change list', () => {
  // Regression: the desktop offered the undo button only for 'applied'. A row left in 'undoing' by
  // a crash therefore showed "the result is uncertain" with nothing to click, even though
  // file-undo.ts can finish the restoration from that exact state — and assertMutable blocked
  // every rename and delete meanwhile. The recovery existed but was unreachable.
  const interrupted = fileChangeAction('undoing');
  assert.notEqual(interrupted.kind, 'none', 'an interrupted undo must stay actionable');
  assert.equal(interrupted.kind, 'resume');
  assert.equal(interrupted.actionKey, 'ui.resumeUndo');
  assert.equal(interrupted.noticeKey, 'ui.undoInterrupted');

  // A fresh change is a plain undo, not a resume.
  const applied = fileChangeAction('applied');
  assert.equal(applied.kind, 'undo');
  assert.equal(applied.actionKey, 'ui.undoChange');

  // Terminal and unresolved states describe themselves and offer nothing.
  assert.equal(fileChangeAction('undone').kind, 'none');
  assert.equal(fileChangeAction('undone').noticeKey, 'ui.undone');
  for (const status of ['pending', 'abandoned', 'conflict'] as const) {
    const action = fileChangeAction(status);
    assert.equal(action.kind, 'none', `${status} must not offer an undo`);
    assert.equal(action.noticeKey, 'ui.uncertainResult');
  }

  // Every notice an action can return must resolve to real copy in both locales: a missing key
  // renders as the raw key, which is how a UI regression would reach the user unnoticed.
  for (const status of [
    'applied',
    'undoing',
    'undone',
    'pending',
    'abandoned',
    'conflict',
  ] as const) {
    const { noticeKey } = fileChangeAction(status);
    for (const lang of ['zh-CN', 'en-US'] as const)
      assert.notEqual(translate(noticeKey, lang), noticeKey, `${noticeKey} is missing for ${lang}`);
  }
  for (const lang of ['zh-CN', 'en-US'] as const) {
    assert.notEqual(translate('ui.resumeUndo', lang), 'ui.resumeUndo');
    assert.notEqual(translate(undoConfirmKey('create'), lang), undoConfirmKey('create'));
    assert.notEqual(translate(undoConfirmKey('edit'), lang), undoConfirmKey('edit'));
  }
});

// ---- merged from session-controller.test.ts ----

async function setup2(t: test.TestContext, url: string) {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-controller-'));
  const client = new AgentHostClient({
    nodePath: process.execPath,
    hostPath: path.join(projectRoot, 'apps/agent-host/main.ts'),
    workspace: root,
    env: {
      YUANTU_MAX_CONTEXT_TOKENS: '128000',
      YUANTU_BASE_URL: url,
      YUANTU_MODEL: 'fixture',
      YUANTU_API_KEY: 'test',
      YUANTU_SESSION_TITLES: '0',
    },
  });
  const controller = new SessionController(client);
  t.after(async () => {
    controller.dispose();
    await client.stop();
    await rm(root, { recursive: true, force: true });
  });
  await client.start();
  await controller.create();
  return { root, client, controller };
}
test('controller reloads image history larger than a single transport frame', async (t) => {
  const url = await httpFixture(t, (_, res) => sendFrames(res, frames('Image received')));
  const { controller, client } = await setup2(t, url);
  const bytes = Buffer.alloc(4 * 1024 * 1024);
  Buffer.from('89504e470d0a1a0a', 'hex').copy(bytes);
  const images = [{ mimeType: 'image/png' as const, data: bytes.toString('base64') }];
  for (let i = 0; i < 3; i++) {
    const sent = await controller.send('Inspect image ' + i, images);
    assert.equal(sent.status, 'completed', sent.error);
  }
  const id = controller.snapshot.sessionId!;
  await controller.load(id);
  assert.equal(
    controller.snapshot.messages.filter((m) => m.role === 'user' && m.images?.length).length,
    3,
  );
  assert.equal(client.status, 'ready');
});

test('controller projects separate assistant turns, handles approval and reconciles persisted history', async (t) => {
  let step = 0;
  const url = await httpFixture(t, (_, res) =>
    sendFrames(
      res,
      step++ === 0
        ? frames('First turn', [
            { id: 'w', name: 'write_file', input: { path: 'a.txt', content: 'ok' } },
          ])
        : frames('Final turn'),
    ),
  );
  const { root, controller } = await setup2(t, url);
  const snapshots: SessionSnapshot[] = [];
  const streamed: string[] = [];
  let approve: Promise<void> | undefined;
  const unsubscribeDelta = controller.subscribeDelta((delta) => streamed.push(delta.text));
  const unsubscribe = controller.subscribe((state) => {
    snapshots.push(state);
    if (state.approvals.length && !approve)
      approve = controller.approve(state.approvals[0]!.id, true);
  });
  const result = await controller.send('Create file');
  await approve;
  assert.equal(result.status, 'completed');
  assert.equal(await readFile(path.join(root, 'a.txt'), 'utf8'), 'ok');
  const state = controller.snapshot;
  assert.equal(state.running, false);
  assert.equal(state.approvals.length, 0);
  assert.equal(state.liveMessage, null);
  assert.deepEqual(
    state.messages.filter((m) => m.role === 'assistant').map((m) => m.content),
    ['First turn', 'Final turn'],
  );
  assert.equal(state.messages.filter((m) => m.role === 'user').length, 1);
  // Streamed text is delivered on the delta channel, in order and complete. Snapshots no longer
  // republish per token, so asserting on snapshot text would only pass by accident of event ordering.
  assert.equal(streamed.join(''), 'First turnFinal turn');
  state.messages.length = 0;
  assert.ok(
    controller.snapshot.messages.length > 0,
    'snapshot mutation must not corrupt internal state',
  );
  unsubscribeDelta();
  unsubscribe();
});
test('controller cancellation clears approval and leaves the session ready for a followup', async (t) => {
  let step = 0;
  const url = await httpFixture(t, (_, res) =>
    sendFrames(
      res,
      step++ === 0
        ? frames('', [
            { id: 'w', name: 'write_file', input: { path: 'denied.txt', content: 'bad' } },
          ])
        : frames('Followup'),
    ),
  );
  const { root, controller } = await setup2(t, url);
  let ready!: () => void;
  const approval = new Promise<void>((resolve) => {
    ready = resolve;
  });
  controller.subscribe((state) => {
    if (state.approvals.length) ready();
  });
  const pending = controller.send('write');
  await approval;
  await controller.cancel();
  assert.equal((await pending).status, 'cancelled');
  assert.equal(controller.snapshot.approvals.length, 0);
  assert.equal(controller.snapshot.running, false);
  await assert.rejects(readFile(path.join(root, 'denied.txt')), { code: 'ENOENT' });
  assert.equal((await controller.send('followup')).status, 'completed');
});

test('controller sends images and steers a pending Host approval without stale writes', async (t) => {
  let step = 0;
  const image = {
    mimeType: 'image/png' as const,
    data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/5u8AAAAASUVORK5CYII=',
  };
  const url = await httpFixture(t, (body, res) => {
    if (step++ === 0) {
      assert.equal(body.messages[0].content[1].type, 'image');
      sendFrames(
        res,
        frames('Approval', [
          { id: 'w', name: 'write_file', input: { path: 'blocked.txt', content: 'bad' } },
        ]),
      );
    } else {
      assert.match(JSON.stringify(body.messages), /just explain/);
      sendFrames(res, frames('Explained'));
    }
  });
  const { root, controller, client } = await setup2(t, url);
  let ready!: () => void;
  const waiting = new Promise<void>((r) => (ready = r));
  controller.subscribe((s) => {
    if (s.approvals.length) ready();
  });
  const running = controller.send('Inspect image', [image]);
  await Promise.race([waiting, running.then(() => assert.fail('approval missing'))]);
  await controller.enqueue('just explain', 'steer');
  assert.equal((await running).text, 'Explained');
  assert.equal(controller.snapshot.queue.length, 0);
  assert.equal(controller.snapshot.messages.filter((m) => m.role === 'user').length, 2);
  await assert.rejects(readFile(path.join(root, 'blocked.txt')), { code: 'ENOENT' });
  const resources = await client.request('resources.list', {});
  assert.deepEqual(resources.skills, []);
});
test('controller rejects a second send and session switch during an active run', async (t) => {
  let ready!: () => void;
  const waiting = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const url = await httpFixture(t, (_, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(': wait\n\n');
    ready();
  });
  const { controller } = await setup2(t, url);
  const pending = controller.send('wait');
  await waiting;
  await assert.rejects(controller.send('second'), /running/i);
  await assert.rejects(controller.create(), /running/i);
  await controller.cancel();
  await pending;
});

test('a completion snapshot accepts the next send immediately', async (t) => {
  const url = await httpFixture(t, (_, res) => sendFrames(res, frames('Done')));
  const { controller } = await setup2(t, url);
  let started = false,
    next: ReturnType<SessionController['send']> | undefined;
  controller.subscribe((state) => {
    if (state.status === 'completed' && !state.running && !state.loading && !started) {
      started = true;
      next = controller.send('followup');
      void next.catch(() => {});
    }
  });
  await controller.send('first');
  assert.ok(next);
  assert.equal((await next).status, 'completed');
  assert.equal(controller.snapshot.messages.filter((m) => m.role === 'user').length, 2);
});

test('provider error data cannot expose a credential in terminal state or persisted run error', async (t) => {
  const url = await httpFixture(t, (_, res) => {
    const events = frames('');
    events.splice(1, 0, { type: 'content_block_start', index: 0, content_block: { type: 'test' } });
    sendFrames(res, events);
  });
  const { root, controller } = await setup2(t, url); // fixture API key is 'test'
  const result = await controller.send('inspect');
  assert.equal(result.status, 'failed');
  assert.doesNotMatch(result.error!, /block: test/);
  assert.doesNotMatch(controller.snapshot.error!, /block: test/);
  const db = new DatabaseSync(path.join(root, '.yuantu', 'sessions.sqlite'));
  try {
    assert.doesNotMatch(String(db.prepare('SELECT result FROM runs').get()?.result), /block: test/);
  } finally {
    db.close();
  }
});

// ---- merged from statistics-integration.test.ts ----

test('session statistics count cached usage once, measure tools, and reload from SQLite', async (t) => {
  let requests = 0;
  const url = await httpFixture(t, async (_body, res) => {
    await new Promise((resolve) => setTimeout(resolve, 25));
    const events = frames(
      'hello',
      requests++ === 0 ? [{ id: 'read-1', name: 'list_files', input: {} }] : [],
    );
    (events[0]!.message as any).usage.cache_read_input_tokens = 80;
    sendFrames(res, events);
  });
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-statistics-'));
  const client = new AgentHostClient({
    nodePath: process.execPath,
    hostPath: path.join(projectRoot, 'apps/agent-host/main.ts'),
    workspace: root,
    env: {
      YUANTU_MAX_CONTEXT_TOKENS: '128000',
      YUANTU_SESSION_TITLES: '0',
      YUANTU_BASE_URL: url,
      YUANTU_MODEL: 'fixture',
      YUANTU_API_KEY: 'test',
      YUANTU_PROTOCOL: 'anthropic',
    },
  });
  let controller = new SessionController(client);
  t.after(async () => {
    controller.dispose();
    await client.stop();
    await rm(root, { recursive: true, force: true });
  });
  await client.start();
  const id = await controller.create();
  const first = await controller.send('inspect');
  assert.equal(first.status, 'completed');
  let stats = controller.snapshot.statistics!;
  assert.equal(stats.inputTokens, 200);
  assert.equal(stats.outputTokens, 20);
  assert.equal(stats.cachedInputTokens, 160);
  assert.equal(stats.cacheKnown, true);
  assert.ok(stats.modelMs >= 50);
  assert.ok(stats.toolMs > 0);
  assert.equal(stats.firstTokenCount, 2);
  assert.ok(stats.firstTokenMs >= 50);
  await controller.send('continue');
  stats = controller.snapshot.statistics!;
  assert.equal(stats.inputTokens, 300);
  assert.equal(stats.outputTokens, 30);
  assert.equal(stats.cachedInputTokens, 240);
  await controller.create();
  assert.equal(controller.snapshot.statistics!.inputTokens, 0);
  controller.dispose();
  await client.stop();
  await client.start();
  controller = new SessionController(client);
  await controller.load(id);
  assert.deepEqual(controller.snapshot.statistics, stats);
});

test('the checklist arrives live and comes back after a reload', async (t) => {
  let turns = 0;
  const url = await httpFixture(t, (body, res) => {
    if (turns++ === 0)
      sendFrames(
        res,
        frames('Planning', [
          {
            id: 'todo-1',
            name: 'todo_write',
            input: {
              todos: [
                { id: 'a', content: 'Read the loader', status: 'in_progress' },
                { id: 'b', content: 'Fix the retry', status: 'pending' },
              ],
            },
          },
        ]),
      );
    else {
      // The tool result is the only place the model reads the list back, so the second request must carry it.
      assert.match(JSON.stringify(body.messages), /Fix the retry/);
      sendFrames(res, frames('Planned'));
    }
  });
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-client-todo-'));
  const client = new AgentHostClient({
    nodePath: process.execPath,
    hostPath: path.join(projectRoot, 'apps/agent-host/main.ts'),
    workspace: root,
    env: {
      YUANTU_MAX_CONTEXT_TOKENS: '128000',
      YUANTU_BASE_URL: url,
      YUANTU_MODEL: 'fixture',
      YUANTU_API_KEY: 'test',
      YUANTU_SESSION_TITLES: '0',
    },
  });
  let controller = new SessionController(client);
  t.after(async () => {
    controller.dispose();
    await client.stop();
    await rm(root, { recursive: true, force: true });
  });
  await client.start();
  const id = await controller.create();
  assert.deepEqual(controller.snapshot.todos, [], 'a new session starts with no checklist');
  assert.equal((await controller.send('plan it')).status, 'completed');
  const expected = [
    { id: 'a', content: 'Read the loader', status: 'in_progress' },
    { id: 'b', content: 'Fix the retry', status: 'pending' },
  ];
  assert.deepEqual(controller.snapshot.todos, expected);
  // A reload must not lose the checklist: it is session state, read back through `todos.get`.
  controller.dispose();
  await client.stop();
  await client.start();
  controller = new SessionController(client);
  await controller.load(id);
  assert.deepEqual(controller.snapshot.todos, expected);
});

for (const protocol of ['openai', 'openai-responses'] as const) {
  test(protocol + ' preserves cached input details and missing values', async (t) => {
    let count = 0;
    const url = await httpFixture(t, (_body, res) => {
      const cache = count++ === 0 ? { cached_tokens: 80 } : undefined;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if (protocol === 'openai') {
        res.write(
          'data: ' +
            JSON.stringify({
              choices: [{ index: 0, delta: { content: 'hello' }, finish_reason: 'stop' }],
            }) +
            '\n\n',
        );
        res.write(
          'data: ' +
            JSON.stringify({
              choices: [],
              usage: {
                prompt_tokens: 100,
                completion_tokens: 10,
                prompt_tokens_details: cache,
              },
            }) +
            '\n\n',
        );
        res.end('data: [DONE]\n\n');
      } else {
        res.end(
          'data: ' +
            JSON.stringify({
              type: 'response.completed',
              response: {
                status: 'completed',
                output: [
                  {
                    type: 'message',
                    id: 'm',
                    role: 'assistant',
                    status: 'completed',
                    content: [{ type: 'output_text', text: 'hello', annotations: [] }],
                  },
                ],
                usage: { input_tokens: 100, output_tokens: 10, input_tokens_details: cache },
              },
            }) +
            '\n\n',
        );
      }
    });
    const provider = createProvider({ protocol, baseUrl: url, apiKey: 'test', model: 'fixture' });
    const request = () => ({
      system: 'test',
      messages: [{ role: 'user' as const, content: 'hello' }],
      tools: [],
      maxOutputTokens: 128,
      signal: new AbortController().signal,
      onText() {},
    });
    assert.deepEqual((await provider.complete(request())).usage, {
      inputTokens: 100,
      outputTokens: 10,
      cachedInputTokens: 80,
    });
    assert.deepEqual((await provider.complete(request())).usage, {
      inputTokens: 100,
      outputTokens: 10,
    });
  });
}

test('cancelled approval time remains in persisted statistics', async (t) => {
  const url = await httpFixture(t, (_body, res) =>
    sendFrames(
      res,
      frames('write', [{ id: 'w', name: 'write_file', input: { path: 'a.txt', content: 'test' } }]),
    ),
  );
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-statistics-cancel-'));
  const client = new AgentHostClient({
    nodePath: process.execPath,
    hostPath: path.join(projectRoot, 'apps/agent-host/main.ts'),
    workspace: root,
    env: {
      YUANTU_MAX_CONTEXT_TOKENS: '128000',
      YUANTU_SESSION_TITLES: '0',
      YUANTU_BASE_URL: url,
      YUANTU_MODEL: 'fixture',
      YUANTU_API_KEY: 'test',
      YUANTU_PROTOCOL: 'anthropic',
    },
  });
  const controller = new SessionController(client);
  t.after(async () => {
    controller.dispose();
    await client.stop();
    await rm(root, { recursive: true, force: true });
  });
  await client.start();
  await controller.create();
  const approved = new Promise<void>((resolve) =>
    controller.subscribe((s) => {
      if (s.approvals.length) resolve();
    }),
  );
  const pending = controller.send('write');
  await approved;
  await new Promise((resolve) => setTimeout(resolve, 40));
  await controller.cancel();
  assert.equal((await pending).status, 'cancelled');
  assert.ok(controller.snapshot.statistics!.toolMs >= 40);
  assert.equal(controller.snapshot.statisticsActivity, null);
  assert.equal(controller.snapshot.statistics!.inputTokens, 20);
});

test('mid-stream cancellation marks cumulative token usage incomplete', async (t) => {
  let calls = 0;
  const url = await httpFixture(t, (_body, res) => {
    if (calls++ === 0) return sendFrames(res, frames('complete'));
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const event of frames('partial').slice(0, -2))
      res.write('data: ' + JSON.stringify(event) + '\n\n');
  });
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-statistics-stream-'));
  const client = new AgentHostClient({
    nodePath: process.execPath,
    hostPath: path.join(projectRoot, 'apps/agent-host/main.ts'),
    workspace: root,
    env: {
      YUANTU_MAX_CONTEXT_TOKENS: '128000',
      YUANTU_SESSION_TITLES: '0',
      YUANTU_BASE_URL: url,
      YUANTU_MODEL: 'fixture',
      YUANTU_API_KEY: 'test',
      YUANTU_PROTOCOL: 'anthropic',
    },
  });
  const controller = new SessionController(client);
  t.after(async () => {
    controller.dispose();
    await client.stop();
    await rm(root, { recursive: true, force: true });
  });
  await client.start();
  const id = await controller.create();
  await controller.send('first');
  // The mid-stream text is what tells us the second request is actually streaming; it now arrives on
  // the delta channel rather than by republishing the snapshot once per token.
  const received = new Promise<void>((resolve) => {
    let text = '';
    controller.subscribeDelta((delta) => {
      text += delta.text;
      if (text === 'partial') resolve();
    });
  });
  const pending = controller.send('second');
  await received;
  await controller.cancel();
  assert.equal((await pending).status, 'cancelled');
  const stats = controller.snapshot.statistics!;
  assert.equal(stats.usageComplete, false);
  assert.equal(stats.inputTokens, 20);
  assert.equal(stats.outputTokens, 10);
  await controller.load(id);
  assert.deepEqual(controller.snapshot.statistics, stats);
});

test('a live statistics update travels on its own channel instead of republishing the session', async (t) => {
  // A hand-driven client: the point is which channel an event takes, and a Host process would only make
  // that harder to see. Progress updates arrive once a second while a model call runs, and each one used
  // to republish the whole session (every message, images included) for a panel of numbers.
  class ProgressClient {
    status = 'ready';
    readonly events = new Set<(event: AgentEvent) => void>();
    settle!: (result: RunResult) => void;
    private pending = new Promise<RunResult>((resolve) => {
      this.settle = resolve;
    });
    subscribe(listener: (event: AgentEvent) => void): () => void {
      this.events.add(listener);
      return () => this.events.delete(listener);
    }
    subscribeStatus(): () => void {
      return () => {};
    }
    run(): Promise<RunResult> {
      return this.pending;
    }
    async request(method: string): Promise<unknown> {
      if (method === 'session.get')
        return {
          session: { id: 's1', workspace: '.', createdAt: '', activeRun: null },
          messages: [],
        };
      if (method === 'plan.get') return null;
      if (method === 'subagents.list') return [];
      if (method === 'changes.list') return [];
      if (method === 'background.list') return [];
      if (method === 'task.list') return [];
      return {};
    }
    emit(event: AgentEvent): void {
      for (const listener of this.events) listener(event);
    }
  }
  const client = new ProgressClient();
  const controller = new SessionController(client as unknown as AgentHostClient);
  t.after(() => controller.dispose());
  await controller.load('s1');
  const deltas: StatisticsDelta[] = [];
  controller.subscribeStatisticsDelta((delta) => deltas.push(delta));
  let publishes = 0;
  controller.subscribe(() => publishes++);

  const sending = controller.send('go');
  // Every frame carries the session's durable cursor. `run.started` is a durable fact, and the two statistics
  // frames announce none, so they carry that same mark unchanged (see `AgentEvent.seq`).
  client.emit({ type: 'run.started', sessionId: 's1', runId: 'r1', seq: 1, data: {} });
  const before = publishes;
  const progress = { ...emptyStatistics(), inputTokens: 120, outputTokens: 30, modelMs: 2000 };
  client.emit({
    type: 'statistics.updated',
    sessionId: 's1',
    runId: 'r1',
    seq: 1,
    data: { statistics: progress, activity: { kind: 'model', startedAt: 1, phase: 'reasoning' } },
  });
  assert.equal(publishes, before, 'a progress update must not republish the snapshot');
  assert.equal(deltas.length, 1);
  assert.equal(deltas[0]!.sessionId, 's1');
  assert.equal(deltas[0]!.activity?.kind, 'model');
  assert.equal(deltas[0]!.statistics?.inputTokens, 120);
  // The snapshot still carries the numbers, so a reader that only ever takes snapshots stays correct.
  assert.equal(controller.snapshot.statistics?.inputTokens, 120);
  assert.equal(controller.snapshot.statisticsActivity?.phase, 'reasoning');
  // A late delta from another session must be rejectable by its session id, not applied blind.
  client.emit({
    type: 'statistics.updated',
    sessionId: 'other',
    runId: 'r1',
    seq: 1,
    data: { statistics: progress },
  });
  assert.equal(
    deltas.length,
    1,
    'an event for another session is filtered before it reaches a listener',
  );
  client.settle({
    runId: 'r1',
    sessionId: 's1',
    status: 'completed',
    text: 'done',
    usage: { inputTokens: 120, outputTokens: 30 },
  });
  assert.equal((await sending).status, 'completed');
  assert.ok(publishes > before, 'the end of a run is structural and still publishes a snapshot');
});

test('live statistics events reach client subscribers instead of being filtered out', async (t) => {
  // Regression: the client kept its own hand-written event allow-list and omitted
  // statistics.updated, so the Host emitted the event on every provider request while the live
  // activity indicator stayed frozen until the run ended. The list is now derived from
  // AGENT_EVENT_TYPES in the protocol.
  const url = await httpFixture(t, (_body, res) => sendFrames(res, frames('done')));
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-statistics-events-'));
  const client = new AgentHostClient({
    nodePath: process.execPath,
    hostPath: path.join(projectRoot, 'apps/agent-host/main.ts'),
    workspace: root,
    env: {
      YUANTU_MAX_CONTEXT_TOKENS: '128000',
      YUANTU_SESSION_TITLES: '0',
      YUANTU_BASE_URL: url,
      YUANTU_MODEL: 'fixture',
      YUANTU_API_KEY: 'test',
      YUANTU_PROTOCOL: 'anthropic',
    },
  });
  const controller = new SessionController(client);
  const types: string[] = [];
  const unsubscribe = client.subscribe((event) => types.push(event.type));
  t.after(async () => {
    unsubscribe();
    controller.dispose();
    await client.stop();
    await rm(root, { recursive: true, force: true });
  });
  await client.start();
  await controller.create();
  await controller.send('hello');
  assert.ok(
    types.includes('statistics.updated'),
    `expected a live statistics event, saw: ${types.join(', ') || '(none)'}`,
  );
  assert.ok(types.includes('run.started') && types.includes('run.finished'));
});
