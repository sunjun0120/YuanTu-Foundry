import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { AgentHostClient, HostDisconnectedError } from '../packages/client/host-client.ts';
import { fileChangeAction, undoConfirmKey } from '../packages/client/change-actions.ts';
import { translate } from '../apps/desktop/i18n.ts';
import { httpFixture, frames, sendFrames } from './http-fixture.ts';
import { projectRoot } from './process-fixture.ts';
import { largePng } from './image-fixture.ts';
import { SessionController } from '../packages/client/session-controller.ts';
import type { SessionSnapshot, StatisticsDelta } from '../packages/client/session-controller.ts';
import type { AgentEvent, CompletionSpec, Message, RunResult } from '../packages/protocol/index.ts';
import { isRuntimeContext } from '../packages/protocol/context.ts';
import { emptyStatistics } from '../packages/protocol/statistics.ts';
import { DatabaseSync } from 'node:sqlite';
import { createProvider } from '../packages/providers/index.ts';
import type { HostTransport } from '../packages/client/host-transport.ts';
import { tempRoot } from './temp-fixture.ts';

// Transport fixtures supply checks so automatic verification does not add unrelated model turns.
function fileCompletion(file: string, expected: string): CompletionSpec {
  return {
    version: 1,
    objective: 'Produce the fixture file',
    constraints: [],
    steps: [],
    inputs: [file],
    acceptance: [
      {
        description: 'Fixture file has the expected content',
        met: false,
        check: { id: 'fixture-file', kind: 'file-contains', path: file, expected },
      },
    ],
  };
}

/**
 * The user-role messages a person actually typed.
 *
 * A runtime snapshot — the built-in skills catalogue, a goal notice — is persisted as a user-role message so the
 * model reads it where it is needed. It is conversation the runtime wrote, not a turn somebody took, so a test that
 * counts a conversation's turns excludes it.
 */
function typedUserMessages(messages: readonly Message[]): Message[] {
  return messages.filter(
    (message) => message.role === 'user' && !isRuntimeContext(message.content),
  );
}

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

test('change subscribers are told without a copy, and scalar reads match the snapshot', async (t) => {
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
  };
  const controller = new SessionController(client as unknown as AgentHostClient);
  t.after(() => controller.dispose());
  const calls: unknown[][] = [];
  const unsubscribe = controller.subscribeChanges((...args: unknown[]) => calls.push(args));
  assert.equal(calls.length, 0, 'subscribing is not itself a change');
  await controller.load('session-1');
  assert.ok(calls.length > 0, 'a load is announced');
  // The carrier builds its own view from `snapshot`; a copy handed to it here would be cloned and thrown away.
  assert.ok(calls.every((args) => args.length === 0));
  const snapshot = controller.snapshot;
  assert.equal(controller.sessionId, snapshot.sessionId);
  assert.equal(controller.running, snapshot.running);
  assert.equal(controller.loading, snapshot.loading);
  assert.equal(
    controller.findSubAgent(() => true),
    undefined,
  );
  unsubscribe();
  const seen = calls.length;
  await controller.load('session-1');
  assert.equal(calls.length, seen, 'an unsubscribed listener is not called');
});

test('frozen snapshots share every message an earlier one handed out', async (t) => {
  let emit: (event: AgentEvent) => void = () => {};
  const client = {
    status: 'ready',
    subscribe: (listener: (event: AgentEvent) => void) => {
      emit = listener;
      return () => {};
    },
    subscribeStatus: () => () => {},
    async request(method: string) {
      if (method === 'session.get')
        return {
          messages: [
            { role: 'user', content: 'one', createdAt: '2026-01-01T00:00:00.000Z' },
            { role: 'assistant', content: 'two', createdAt: '2026-01-01T00:00:01.000Z' },
          ],
        };
      if (method === 'plan.get') return null;
      if (method === 'subagents.list') return [];
      throw new Error(`Unexpected method: ${method}`);
    },
  };
  const controller = new SessionController(client as unknown as AgentHostClient);
  t.after(() => controller.dispose());
  await controller.load('session-1');
  const first = controller.frozenSnapshot;
  assert.ok(Object.isFrozen(first) && Object.isFrozen(first.messages[0]));
  assert.deepEqual(first, controller.snapshot);
  emit({ type: 'run.started', sessionId: 'session-1', runId: 'run-1', data: {} } as AgentEvent);
  emit({
    type: 'tool.finished',
    sessionId: 'session-1',
    runId: 'run-1',
    data: { callId: 'call-1', name: 'read', content: 'ok' },
  } as unknown as AgentEvent);
  const second = controller.frozenSnapshot;
  assert.equal(second.messages.length, 3);
  assert.equal(second.messages[0], first.messages[0]);
  assert.equal(second.messages[1], first.messages[1]);
  assert.deepEqual(second, controller.snapshot);
});

test('an approval allowed for the session answers the next identical request itself', async (t) => {
  let emit: (event: AgentEvent) => void = () => {};
  const responses: { approvalId: string; allow: boolean }[] = [];
  const client = {
    status: 'ready',
    subscribe: (listener: (event: AgentEvent) => void) => {
      emit = listener;
      return () => {};
    },
    subscribeStatus: () => () => {},
    async request(method: string, params: Record<string, unknown>) {
      if (method === 'session.get') return { messages: [] };
      if (method === 'plan.get') return null;
      if (method === 'subagents.list') return [];
      if (method === 'approval.respond') {
        responses.push(params as { approvalId: string; allow: boolean });
        return {};
      }
      throw new Error(`Unexpected method: ${method}`);
    },
  };
  const controller = new SessionController(client as unknown as AgentHostClient);
  t.after(() => controller.dispose());
  await controller.load('session-1');
  emit({ type: 'run.started', sessionId: 'session-1', runId: 'run-1', data: {} } as AgentEvent);
  const approval = (id: string, command: string) => ({
    kind: 'command',
    description: 'run it',
    toolCall: { id, name: 'run_command', arguments: { command } },
  });
  const required = (approvalId: string, command: string) =>
    emit({
      type: 'approval.required',
      sessionId: 'session-1',
      runId: 'run-1',
      data: { approvalId, approval: approval(approvalId, command) },
    } as unknown as AgentEvent);
  required('a1', 'npm test');
  assert.equal(controller.snapshot.approvals.length, 1);
  await controller.approve('a1', true, true);
  assert.deepEqual(responses, [{ approvalId: 'a1', allow: true }]);
  assert.equal(controller.snapshot.approvals.length, 0);
  // The same command asked again is the decision the person already made, not a new one.
  required('a2', 'npm test');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(controller.snapshot.approvals.length, 0);
  assert.deepEqual(responses.at(-1), { approvalId: 'a2', allow: true });
  // A different command is still a new decision: remembering `npm test` must not allow `npm publish`.
  required('a3', 'npm publish');
  assert.equal(controller.snapshot.approvals.length, 1);
  assert.equal(controller.snapshot.approvals[0]?.id, 'a3');
  // Identical requests already waiting are one decision, even when it is only "allow once": the window draws them
  // as one card, and the answer reaches every copy — but never a different call.
  required('a4', 'node -v');
  required('a5', 'node -v');
  assert.equal(controller.snapshot.approvals.length, 3);
  await controller.approve('a4', true);
  assert.deepEqual(responses.slice(-2), [
    { approvalId: 'a4', allow: true },
    { approvalId: 'a5', allow: true },
  ]);
  assert.deepEqual(
    controller.snapshot.approvals.map((item) => item.id),
    ['a3'],
  );
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
  const result = await client.run(session.id, 'Create hello.txt', {
    completion: fileCompletion('hello.txt', 'hello'),
  });
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
test('a failed link is released before its status is announced, so it reads as recoverable', async (t) => {
  /**
   * The carrier's only recovery check runs *inside* the status notification and asks `recoverable`, which
   * requires the transport to be gone. Spending the transport after the notification made every failure that
   * arrives through `fail()` — malformed frames, a dropped stdin, an invalid reply id — look unrecoverable:
   * the carrier saw a live transport, returned, and nothing re-evaluates the flag, so the one-shot Host
   * restart ran for process exits only. `pid` is the observable form of that field.
   */
  const { client } = await setup(
    t,
    { FIXTURE_MODE: 'malformed', YUANTU_API_KEY: 'secret-fixture-key' },
    { hostPath: path.join(projectRoot, 'tests/faulty-host.ts') },
  );
  await client.start();
  assert.ok(client.pid, 'a spawned Host has a process a restart could replace');
  const during: { status: string; recoverable: boolean; pid: number | undefined }[] = [];
  const unsubscribe = client.subscribeStatus((status) =>
    during.push({ status, recoverable: client.recoverable, pid: client.pid }),
  );
  t.after(unsubscribe);
  await assert.rejects(client.request('session.create', {}), /Invalid JSONL/);
  const failed = during.find((entry) => entry.status === 'failed');
  assert.ok(failed, 'the failure has to be announced at all');
  assert.equal(
    failed.pid,
    undefined,
    'the transport is released before the listener runs, which is the field `recoverable` reads',
  );
  assert.equal(failed.recoverable, true, 'so the carrier is told a new Host may be started');
});

for (const retirement of ['graceful', 'forced', 'unconfirmed'] as const) {
  test(`restart retires the previous Host before opening another (${retirement})`, async (t) => {
    const client = new AgentHostClient({
      nodePath: process.execPath,
      hostPath: path.join(projectRoot, 'tests/faulty-host.ts'),
      workspace: projectRoot,
      shutdownTimeoutMs: 20,
    });
    const links: { exit: () => void; fail: () => void; kills: number }[] = [];
    const internal = client as unknown as {
      openTransport(generation: number): HostTransport;
      wireTransport(link: HostTransport, generation: number): HostTransport;
    };
    t.mock.method(internal, 'openTransport', (generation: number) => {
      const first = links.length === 0;
      const lines = new Set<(line: string) => void>();
      const errors = new Set<(error: Error) => void>();
      const exits = new Set<
        (exit: { code: number | null; signal: NodeJS.Signals | null }) => void
      >();
      const control = {
        exit: () => {
          for (const fn of exits) fn({ code: 0, signal: null });
        },
        fail: () => {
          for (const fn of errors) fn(Error('fixture broken link'));
        },
        kills: 0,
      };
      links.push(control);
      return internal.wireTransport(
        {
          label: 'owned fake Host',
          pid: undefined,
          writable: true,
          send(line) {
            const { id } = JSON.parse(line);
            queueMicrotask(() => {
              for (const fn of lines)
                fn(
                  JSON.stringify({
                    id,
                    result: {
                      protocolVersion: 1,
                      runtime: 'yuantu',
                      workspace: projectRoot,
                      capabilities: ['sessions'],
                    },
                  }),
                );
            });
            return true;
          },
          onLine(fn) {
            lines.add(fn);
            return () => lines.delete(fn);
          },
          onError(fn) {
            errors.add(fn);
            return () => errors.delete(fn);
          },
          onExit(fn) {
            exits.add(fn);
            return () => exits.delete(fn);
          },
          onDiagnostic: () => () => {},
          end() {
            if (!first) control.exit();
          },
          kill() {
            control.kills++;
            if (retirement === 'forced') control.exit();
          },
        },
        generation,
      );
    });
    try {
      await client.start();
      links[0]!.fail();
      const restarting = client.start();
      if (retirement === 'graceful') {
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(links.length, 1, 'old Host must exit before a new one opens');
        links[0]!.exit();
      }
      if (retirement === 'unconfirmed') {
        await assert.rejects(restarting, /unconfirmed/);
        assert.equal(links.length, 1);
        links[0]!.exit();
        await client.start();
      } else await restarting;
      assert.equal(links.length, 2);
      assert.equal(links[0]!.kills, retirement === 'graceful' ? 0 : 1);
    } finally {
      for (const link of links) link.exit();
      await client.stop();
    }
  });
}

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
  const temp = await tempRoot(t, 'yuantu-forced-');
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
  const bytes = largePng(4 * 1024 * 1024);
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
  const result = await controller.send('Create file', undefined, undefined, {
    completion: fileCompletion('a.txt', 'ok'),
  });
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
  assert.equal(typedUserMessages(state.messages).length, 1);
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
    data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  };
  const url = await httpFixture(t, (body, res) => {
    if (step++ === 0) {
      // Positional would break the first time the runtime writes a user-role snapshot (the built-in skills
      // catalogue is one): find the turn that carries the picture, wherever it sits.
      const withImage = (body.messages as { content: { type: string }[] }[]).find((message) =>
        Array.isArray(message.content)
          ? message.content.some((block) => block.type === 'image')
          : false,
      );
      assert.ok(withImage, 'the request carries the image the person attached');
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
  assert.equal(typedUserMessages(controller.snapshot.messages).length, 2);
  await assert.rejects(readFile(path.join(root, 'blocked.txt')), { code: 'ENOENT' });
  const resources = await client.request('resources.list', {});
  // The workspace declares no skills of its own; what is listed is what this build ships with.
  assert.deepEqual(
    resources.skills.map((skill) => skill.path),
    ['builtin:office-documents'],
  );
});
test('controller rejects a second send during an active run but lets another session open', async (t) => {
  let ready!: () => void;
  const waiting = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const url = await httpFixture(t, (_, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(': wait\n\n');
    ready();
  });
  const { client, controller } = await setup2(t, url);
  const running = controller.sessionId!;
  const pending = controller.send('wait');
  await waiting;
  await assert.rejects(controller.send('second'), /running/i);
  // The Host runs sessions side by side, so a run no longer pins the window to its session.
  await controller.create();
  assert.notEqual(controller.sessionId, running);
  assert.equal(controller.running, false);
  assert.deepEqual(
    controller.snapshot.otherRuns?.map((run) => run.sessionId),
    [running],
  );
  await client.request('run.cancel', { sessionId: running });
  assert.equal((await pending).status, 'cancelled');
  assert.deepEqual(controller.snapshot.otherRuns, []);
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
  assert.equal(typedUserMessages(controller.snapshot.messages).length, 2);
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

test('an event type this build does not know is ignored without costing the link', async (t) => {
  /**
   * The compatibility boundary that a new *live* event type has to cross.
   *
   * `context.compaction.failed` is emitted by a Host that reports a compression it could not perform, and a
   * client that predates the type must survive hearing it: the frame is structurally valid, so dropping it is a
   * decision the client makes (its delivery allow-list) rather than a failure it reports. The mark it carries
   * still moves — what the client has *received* is what its cursor means, whether or not a consumer could use
   * it — and its state is still cleared by `run.finished`, which is what an older client has always relied on.
   * Both halves are asserted here against an in-memory link, so neither depends on a Host process being started.
   */
  const lines = new Set<(line: string) => void>();
  const exits = new Set<(exit: { code: number | null; signal: NodeJS.Signals | null }) => void>();
  const deliver = (line: string) => {
    for (const listener of lines) listener(line);
  };
  const transport: HostTransport = {
    label: 'in-memory test pair',
    pid: undefined,
    writable: true,
    send(line) {
      const request = JSON.parse(line) as { id: string; method: string };
      const result =
        request.method === 'host.info'
          ? {
              protocolVersion: 1,
              runtime: 'yuantu',
              workspace: projectRoot,
              capabilities: ['sessions'],
            }
          : [];
      queueMicrotask(() => deliver(JSON.stringify({ id: request.id, result })));
      return true;
    },
    onLine(listener) {
      lines.add(listener);
      return () => lines.delete(listener);
    },
    onDiagnostic: () => () => {},
    onError: () => () => {},
    onExit(listener) {
      exits.add(listener);
      return () => exits.delete(listener);
    },
    // A link with no process behind it still has to be closeable: `stop()` waits for the exit it asked for, and
    // an in-memory pair that never reports one would make the *cleanup* the test's failure rather than the
    // compatibility behaviour it is asserting.
    end() {
      for (const listener of exits) listener({ code: 0, signal: null });
    },
    kill: () => {},
  };
  const client = new AgentHostClient({ transport, requestTimeoutMs: 5000 });
  t.after(() => client.stop());
  await client.start();
  assert.equal(client.status, 'ready');
  const seen: string[] = [];
  client.subscribe((event) => seen.push(event.type));
  // A frame from a Host newer than this build — the shape `context.compaction.failed` has for a client that
  // predates it. `context.compaction.deferred` is deliberately a name no build emits: the promise is about
  // unknown types, not about one particular one.
  deliver(
    JSON.stringify({
      event: {
        type: 'context.compaction.deferred',
        sessionId: 's1',
        runId: 'r1',
        seq: 4,
        data: { reason: 'from a newer Host' },
      },
    }),
  );
  deliver(
    JSON.stringify({
      event: {
        type: 'run.finished',
        sessionId: 's1',
        runId: 'r1',
        seq: 5,
        data: {
          result: {
            runId: 'r1',
            sessionId: 's1',
            status: 'completed',
            text: 'done',
            usage: { inputTokens: 1, outputTokens: 1 },
          },
        },
      },
    }),
  );
  assert.deepEqual(
    seen,
    ['run.finished'],
    'the unknown frame is dropped rather than delivered or fatal',
  );
  assert.equal(client.cursorOf('s1'), 5, 'but the position it carried is still recorded');
  assert.equal(client.status, 'ready', 'and the link survives it');
  assert.deepEqual(await client.request('session.list', {}), [], 'so the next request still works');
  // The type itself is live for this build: the allow-list is derived from the protocol rather than hand-written,
  // so a client that knows the type hands it to its listeners instead of ignoring it.
  deliver(
    JSON.stringify({
      event: {
        type: 'context.compaction.failed',
        sessionId: 's1',
        runId: 'r1',
        seq: 6,
        data: { reason: 'the summary provider failed' },
      },
    }),
  );
  assert.deepEqual(seen, ['run.finished', 'context.compaction.failed']);
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

// ---- the controller over a scripted Host ----
//
// A real Host (above) pins the end-to-end contract; these pin the reading of it, which is the part that has no
// honest way to be produced on demand: a session that is already running when a client opens it, a run that ends
// in the middle of that read, and the frames a client is willing to apply afterwards.

interface ScriptedHost {
  client: AgentHostClient;
  requests: { method: string; params: Record<string, unknown> }[];
  /** Deliver one frame the way the transport would. */
  emit: (event: {
    type: string;
    runId?: string;
    sessionId?: string;
    data?: Record<string, unknown>;
  }) => void;
}

function scriptedHost(
  options: {
    messages?: Message[] | ((call: number) => Message[]);
    /** What `session.get` says the session's active run is: the only identity an old Host offers. */
    activeRun?: string | null | ((call: number) => string | null);
    /** Answers `run.queue.get`, per call, so a test can change the answer mid-read. */
    inbox?: (call: number) => { running: boolean; items: unknown[]; runId?: string };
    /** Methods this Host does not have, as one that predates them answers. */
    missing?: string[];
    /** Hold one request open, so a test can make a second read overtake the first. */
    before?: (method: string, call: number) => Promise<void> | undefined;
  } = {},
): ScriptedHost {
  const listeners = new Set<(event: AgentEvent) => void>();
  const requests: { method: string; params: Record<string, unknown> }[] = [];
  let inboxCalls = 0;
  let historyCalls = 0;
  const client = {
    status: 'ready',
    supports: () => false,
    cursorOf: () => 0,
    noteCursor: () => {},
    subscribe: (listener: (event: AgentEvent) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    subscribeStatus: () => () => {},
    async request(method: string, params: Record<string, unknown>) {
      // The call index is counted before anything can hold the request: a held request still owns its place in
      // the sequence, and a later one must not be handed the same number.
      const call =
        method === 'session.get' ? historyCalls++ : method === 'run.queue.get' ? inboxCalls++ : 0;
      const held = options.before?.(method, call);
      if (held) await held;
      requests.push({ method, params });
      if (options.missing?.includes(method)) throw new Error(`${method} is not available`);
      if (method === 'session.get') {
        const messages =
          typeof options.messages === 'function'
            ? options.messages(call)
            : (options.messages ?? []);
        const activeRun =
          typeof options.activeRun === 'function'
            ? options.activeRun(call)
            : (options.activeRun ?? null);
        return {
          messages,
          offset: 0,
          totalMessages: messages.length,
          session: {
            id: String(params.sessionId),
            workspace: '.',
            createdAt: '',
            activeRun,
          },
        };
      }
      if (method === 'run.queue.get') {
        const answer = options.inbox?.(call) ?? { running: false, items: [] };
        // An old Host answers the queue question without naming the run it holds: the field simply is not there.
        return answer.runId === undefined
          ? { running: answer.running, items: answer.items }
          : { running: answer.running, items: answer.items, runId: answer.runId };
      }
      if (method === 'plan.get') return null;
      if (method === 'subagents.list') return [];
      if (method === 'todos.get') return { todos: [], change: null };
      if (method === 'deliverables.get') return [];
      if (method === 'goal.get') return null;
      throw new Error(`Unexpected method: ${method}`);
    },
    async run() {
      throw new Error('Unexpected run');
    },
  };
  return {
    client: client as unknown as AgentHostClient,
    requests,
    emit: (event) => {
      const frame = {
        sessionId: 'session-1',
        runId: 'run-A',
        seq: 1,
        data: {},
        ...event,
      } as AgentEvent;
      for (const listener of [...listeners]) listener(frame);
    },
  };
}

test('dispose leaves no listener collection behind', async () => {
  // `dispose` is a teardown: the window is gone, and every closure it registered has to go with it. Three of the
  // four channels were cleared and the statistics one was not, so a disposed controller kept a subscriber — and
  // through it whatever that subscriber closed over — alive for as long as anything held the controller.
  const host = scriptedHost();
  const controller = new SessionController(host.client);
  await controller.load('session-1');
  controller.subscribe(() => {});
  controller.subscribeDelta(() => {});
  controller.subscribeSubAgentDelta(() => {});
  controller.subscribeStatisticsDelta(() => {});
  const collections = [
    'listeners',
    'deltaListeners',
    'subagentDeltaListeners',
    'statisticsDeltaListeners',
  ];
  const held = () =>
    collections.map(
      (name) => (controller as unknown as Record<string, Set<unknown>>)[name]?.size ?? -1,
    );
  assert.deepEqual(held(), [1, 1, 1, 1], 'each channel holds the subscriber it was given');
  controller.dispose();
  assert.deepEqual(held(), [0, 0, 0, 0], 'and dispose releases all four of them');
});

test('a compaction that failed stops the session saying it is compacting', async (t) => {
  // A compaction that fails leaves the *old* summary in force: the run continues on the context it had, with no
  // new summary and no usage to count. What the client has to do about it is stop claiming the window is being
  // compacted — and nothing else: there is no summary to fetch and no transcript to change.
  const host = scriptedHost();
  const controller = new SessionController(host.client);
  t.after(() => controller.dispose());
  await controller.load('session-1');
  host.emit({ type: 'run.started' });
  host.emit({ type: 'context.compacting' });
  assert.equal(controller.snapshot.compacting, true);
  const reads = host.requests.length;
  host.emit({
    type: 'context.compaction.failed',
    data: { coveredMessages: 12, reason: 'the summary provider failed' },
  });
  assert.equal(
    controller.snapshot.compacting,
    false,
    'a failed compaction is not still compacting',
  );
  assert.equal(controller.snapshot.running, true, 'and the run it belongs to is still running');
  assert.equal(host.requests.length, reads, 'the failure asks the Host for nothing');
});

const queued = (prompt: string) => ({
  id: `queued-${prompt}`,
  mode: 'follow-up' as const,
  prompt,
  createdAt: '2026-10-10T00:00:00.000Z',
  imageCount: 0,
});

test('a read that is overtaken does not write its answers over the newer one', async (t) => {
  // A read is a sequence of requests, and a slower one can finish after a later read has already shown the
  // session. Without a generation check the older answers win by arriving last, which is one session's history
  // written under another's name — the reason every step of a read checks that it is still the current one.
  let open!: () => void;
  const held = new Promise<void>((resolve) => (open = resolve));
  const host = scriptedHost({
    // Each history read answers with the next word, so which read won is visible in the transcript.
    messages: (call): Message[] => [
      { role: 'user', content: ['seed', 'stale', 'fresh'][call] ?? 'later' },
    ],
    before: (method, call) => (method === 'session.get' && call === 1 ? held : undefined),
  });
  const controller = new SessionController(host.client);
  t.after(() => controller.dispose());
  await controller.load('session-1');
  const overtaken = controller.load('session-1');
  await Promise.resolve();
  // The second read is the one a carrier makes to catch up, and it finishes first.
  await controller.catchUp();
  assert.deepEqual(
    controller.snapshot.messages.map((message) => message.content),
    ['fresh'],
  );
  open();
  await overtaken;
  assert.deepEqual(
    controller.snapshot.messages.map((message) => message.content),
    ['fresh'],
    'the overtaken read drops its answers instead of writing them over the newer ones',
  );
});

test('a session opened while a run is live adopts that run and applies its frames', async (t) => {
  // The hardcoded read: a reloaded session was always `running: false`, `queue: []`, `runId: null`, so every
  // frame of the run that was actually in flight failed the identity check and was thrown away — the window
  // showed a still session while somebody was working in it.
  const host = scriptedHost({
    inbox: () => ({ running: true, items: [queued('one'), queued('two')], runId: 'run-A' }),
    activeRun: 'run-A',
  });
  const controller = new SessionController(host.client);
  t.after(() => controller.dispose());
  await controller.load('session-1');
  const opened = controller.snapshot;
  assert.equal(opened.running, true, 'a session with a live run is not read as idle');
  assert.equal(opened.status, 'running');
  assert.deepEqual(
    opened.queue.map((item) => item.prompt),
    ['one', 'two'],
    'the input the run is holding is part of the session',
  );
  // The frames of that run are applied rather than dropped for want of an identity.
  host.emit({
    type: 'tool.started',
    data: { call: { id: 'tool-1', name: 'read_file', args: {} } },
  });
  assert.equal(controller.snapshot.tools.length, 1);
  host.emit({ type: 'message.started', data: { messageId: 'm1' } });
  host.emit({ type: 'message.delta', data: { messageId: 'm1', text: 'hello' } });
  host.emit({
    type: 'message.finished',
    data: { messageId: 'm1', message: { role: 'assistant', content: 'hello' } },
  });
  assert.deepEqual(
    controller.snapshot.messages.map((message) => message.content),
    ['hello'],
  );
  // A frame from another run is still refused: adopting one identity does not mean accepting every one.
  host.emit({ type: 'message.started', runId: 'run-B', data: { messageId: 'm2' } });
  assert.equal(controller.snapshot.liveMessage, null, 'another run may not start a message here');
  host.emit({
    type: 'run.finished',
    data: {
      result: {
        runId: 'run-A',
        sessionId: 'session-1',
        status: 'completed',
        text: 'hello',
        usage: { inputTokens: 1, outputTokens: 1 },
      },
    },
  });
  assert.equal(controller.snapshot.running, false, 'the run that was adopted also ends here');
});

test('a session that is not running still brings back the input nobody delivered', async (t) => {
  // The other half of the same read: with no run holding the queue, the inbox is what nobody ever delivered —
  // the follow-up a process died holding. It is still the session's input, and a reopened window has to show it.
  const host = scriptedHost({
    inbox: () => ({ running: false, items: [queued('never sent')] }),
    activeRun: null,
  });
  const controller = new SessionController(host.client);
  t.after(() => controller.dispose());
  await controller.load('session-1');
  assert.equal(controller.snapshot.running, false);
  assert.deepEqual(
    controller.snapshot.queue.map((item) => item.prompt),
    ['never sent'],
  );
});

test('a run that ends while the session is loading is read back as history', async (t) => {
  // The race the read has to survive: the transcript is fetched while the run is live and the run is gone by the
  // time the read asks about it. Adopting the end without re-reading would leave a window showing a session that
  // stopped in the middle of the very run that just ended.
  const host = scriptedHost({
    inbox: () => ({ running: false, items: [] }),
    activeRun: (call) => (call === 0 ? 'run-A' : null),
    messages: (call): Message[] =>
      call === 0
        ? [{ role: 'user', content: 'start' }]
        : [
            { role: 'user', content: 'start' },
            { role: 'assistant', content: 'finished while you were reading', toolCalls: [] },
          ],
  });
  const controller = new SessionController(host.client);
  t.after(() => controller.dispose());
  await controller.load('session-1');
  assert.equal(
    controller.snapshot.running,
    false,
    'the run the transcript was read under had ended',
  );
  assert.deepEqual(
    controller.snapshot.messages.map((message) => message.content),
    ['start', 'finished while you were reading'],
    'and its turn is in the transcript, not lost with it',
  );
});

test('the running state of one session does not follow the controller to the next', async (t) => {
  let which = 'running';
  const host = scriptedHost({
    inbox: () =>
      which === 'running'
        ? { running: true, items: [queued('one')], runId: 'run-A' }
        : { running: false, items: [] },
    activeRun: () => (which === 'running' ? 'run-A' : null),
    messages: () => (which === 'running' ? [] : [{ role: 'user', content: 'second session' }]),
  });
  const controller = new SessionController(host.client);
  t.after(() => controller.dispose());
  await controller.load('session-1');
  assert.equal(controller.snapshot.running, true);
  assert.equal(controller.snapshot.queue.length, 1);
  host.emit({
    type: 'run.finished',
    data: {
      result: {
        runId: 'run-A',
        sessionId: 'session-1',
        status: 'completed',
        text: '',
        usage: { inputTokens: 1, outputTokens: 1 },
      },
    },
  });
  // `run.finished` announces the end and then re-reads the transcript; the next load can only start once that
  // read has released the controller.
  await new Promise<void>((resolve) => {
    const off = controller.subscribe((state) => {
      if (!state.running && !state.loading) {
        off();
        resolve();
      }
    });
  });
  assert.equal(controller.snapshot.running, false, 'the run that was adopted also ends here');
  which = 'idle';
  await controller.load('session-2');
  const second = controller.snapshot;
  assert.equal(second.running, false, 'the session that is loaded is the one that is shown');
  assert.deepEqual(second.queue, [], 'the first session’s queue is not part of it');
  assert.deepEqual(
    second.messages.map((message) => message.content),
    ['second session'],
  );
  // A frame of the run left behind belongs to a session this controller no longer shows.
  host.emit({ type: 'run.started', sessionId: 'session-1', runId: 'run-A' });
  assert.equal(
    controller.snapshot.running,
    false,
    'and it cannot make the shown session look busy',
  );
});

test('a Host that does not name its run is read from the session info, and trusted with nothing else', async (t) => {
  // An older Host answers the queue question without naming the run it holds. The session info is then the only
  // identity available, and it is adopted — but only it: a Host that cannot say which run is running is not
  // licence to apply whichever run's frame happens to arrive.
  const host = scriptedHost({
    inbox: () => ({ running: true, items: [queued('one')] }),
    activeRun: 'run-A',
  });
  const controller = new SessionController(host.client);
  t.after(() => controller.dispose());
  await controller.load('session-1');
  assert.equal(controller.snapshot.running, true);
  host.emit({ type: 'message.started', data: { messageId: 'm1' } });
  host.emit({ type: 'message.delta', data: { messageId: 'm1', text: 'ok' } });
  assert.equal(controller.snapshot.liveMessage?.text, 'ok');
  host.emit({
    type: 'message.delta',
    runId: 'run-Z',
    data: { messageId: 'm1', text: 'wrong run' },
  });
  assert.equal(controller.snapshot.liveMessage?.text, 'ok', 'another run’s text is not applied');
});

test('a Host without the queue question at all is still read from the session info', async (t) => {
  // The method itself is what an old Host does not have. The session info is read on every load anyway, so the
  // identity survives the missing method; without one either way the session stays idle, which is the boundary.
  const named = scriptedHost({ missing: ['run.queue.get'], activeRun: 'run-A' });
  const controller = new SessionController(named.client);
  t.after(() => controller.dispose());
  await controller.load('session-1');
  assert.equal(controller.snapshot.running, true, 'the session info names the run');
  named.emit({ type: 'message.started', data: { messageId: 'm1' } });
  assert.notEqual(controller.snapshot.liveMessage, null, 'so that run’s frames are applied');
  const unnamed = scriptedHost({ missing: ['run.queue.get'] });
  const idle = new SessionController(unnamed.client);
  t.after(() => idle.dispose());
  await idle.load('session-1');
  assert.equal(idle.snapshot.running, false, 'with no identity anywhere the session reads as idle');
});

test('a session read while a run is live restores the run, its queue and its frames', async (t) => {
  // End to end against a real Host: the provider's answer is held open, which is what keeps the run in flight
  // while a second reader opens the session. Before this fix the reader saw an idle session, and every frame of
  // the run it was actually watching — the text, the tools, the end — was dropped on arrival.
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  let answers = 0;
  const url = await httpFixture(t, async (body, res) => {
    // A probe is not part of the conversation and must not be held: only the run's own stream is.
    if (!body || body.stream !== true) {
      sendFrames(res, frames(''));
      return;
    }
    const turn = answers++;
    if (turn === 0) {
      // The first answer is held open, which is what keeps the run in flight while the session is read.
      await held;
      sendFrames(res, frames('first'));
      return;
    }
    sendFrames(res, frames(turn === 1 ? 'second' : 'third'));
  });
  const { client } = await setup(t, {
    YUANTU_MODEL: 'fixture',
    YUANTU_API_KEY: 'test',
    YUANTU_BASE_URL: url,
    // The naming call is a real model request and would take the answer this test is holding open. `'0'` is not
    // the value that switches it off — `parseSetting` reads it as a number, so the naming call still runs.
    YUANTU_SESSION_TITLES: 'false',
  });
  await client.start();
  const session = await client.request('session.create', {});
  const started = new Promise<void>((resolve) => {
    const off = client.subscribe((event) => {
      if (event.type === 'run.started') {
        off();
        resolve();
      }
    });
  });
  const running = client.run(session.id, 'hold this open');
  await started;
  await client.request('run.enqueue', {
    sessionId: session.id,
    mode: 'follow-up',
    prompt: 'queued one',
  });
  await client.request('run.enqueue', {
    sessionId: session.id,
    mode: 'follow-up',
    prompt: 'queued two',
  });
  const inbox = await client.request('run.queue.get', { sessionId: session.id });
  assert.equal(inbox.running, true);
  assert.equal(inbox.items.length, 2);
  const active = (await client.request('session.get', { sessionId: session.id })).session.activeRun;
  assert.ok(active, 'a running session names its run');
  assert.equal(inbox.runId, active, 'and the queue names the same one');
  const controller = new SessionController(client);
  t.after(() => controller.dispose());
  await controller.load(session.id);
  assert.equal(
    controller.snapshot.running,
    true,
    'the session is running while a run is in flight',
  );
  assert.deepEqual(
    controller.snapshot.queue.map((item) => item.prompt),
    ['queued one', 'queued two'],
  );
  const settled = new Promise<void>((resolve) => {
    const off = controller.subscribe((state) => {
      // `run.finished` announces the end before the transcript is re-read: waiting for `loading` to clear is
      // waiting for the read that brings the finished run's own turn back into the state.
      if (!state.running && !state.loading && state.status === 'completed') {
        off();
        resolve();
      }
    });
  });
  release();
  assert.equal((await running).status, 'completed');
  await settled;
  const done = controller.snapshot;
  assert.equal(done.queue.length, 0, 'the queued input was delivered, not left behind');
  assert.deepEqual(
    done.messages
      .filter((message) => message.role === 'assistant')
      .map((message) => message.content),
    ['first', 'second', 'third'],
    'the frames of the run it adopted are in the transcript',
  );
});
