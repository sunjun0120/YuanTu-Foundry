import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHostState } from '../apps/agent-host/state.ts';
import type { HostServices } from '../apps/agent-host/services.ts';
import { createDispatcher } from '../apps/agent-host/dispatch.ts';
import { HookRegistry } from '../packages/tools/hooks.ts';
import { SessionStore } from '../packages/storage/sqlite.ts';
import { listeningHost, connectClient } from './listening-host-fixture.ts';
import { httpFixture, frames, sendFrames } from './http-fixture.ts';
import { loadHookDeclarations } from '../packages/resources/hook-config.ts';
import { hookTrustFile, trustWorkspaceHooks } from '../packages/resources/hook-trust.ts';

async function state(t: test.TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-lifecycle-policy-'));
  const store = new SessionStore(path.join(root, 'sessions.sqlite'));
  const hooks = new HookRegistry();
  t.after(async () => {
    await hooks.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const seen: { kind: string; readOnly: boolean | undefined }[] = [];
  hooks.register({
    sessionStart: (context) => {
      seen.push({ kind: 'start', readOnly: context.readOnly });
    },
    sessionEnd: (context) => {
      seen.push({ kind: 'end', readOnly: context.readOnly });
    },
  });
  const ctx = createHostState(
    {
      options: { json: false, allowWrite: false, allowCommand: false, help: false },
      workspace: root,
      launchSandbox: { mode: 'host', image: 'node:24' },
      permissionPolicy: undefined,
    },
    {
      store,
      hooks,
      background: { async close() {} },
      terminals: { async closeAllAndWait() {} },
      invariants: {
        async run() {
          return [];
        },
      },
    } as unknown as HostServices,
  );
  const session = store.create(root);
  return { ctx, store, sessionId: session.id, seen, dispatch: createDispatcher(ctx) };
}

test('cold planning sessions pass read-only context to start and delete hooks', async (t) => {
  const h = await state(t);
  h.store.createPlan(h.sessionId);
  await h.ctx.announceSession(h.sessionId, true);
  await h.dispatch('session.delete', { sessionId: h.sessionId });
  assert.deepEqual(h.seen, [
    { kind: 'start', readOnly: true },
    { kind: 'end', readOnly: true },
  ]);
});

test('a submitted planning run stays read-only for its lifecycle end', async (t) => {
  const h = await state(t);
  await h.ctx.announceSession(h.sessionId, true, true);
  const plan = h.store.createPlan(h.sessionId);
  h.store.submitPlan(h.sessionId, plan.id, { title: 'Inspect', steps: ['Read only'] });
  assert.equal(
    h.store.planMode(h.sessionId),
    null,
    'the plan is proposed rather than still planning',
  );
  await h.dispatch('session.delete', { sessionId: h.sessionId });
  assert.deepEqual(h.seen, [
    { kind: 'start', readOnly: true },
    { kind: 'end', readOnly: true },
  ]);
});

test('a later ordinary run updates lifecycle context without announcing twice', async (t) => {
  const h = await state(t);
  await h.ctx.announceSession(h.sessionId, true, true);
  await h.ctx.announceSession(h.sessionId, true, false);
  await h.dispatch('session.delete', { sessionId: h.sessionId });
  assert.deepEqual(h.seen, [
    { kind: 'start', readOnly: true },
    { kind: 'end', readOnly: false },
  ]);
});

test('lifecycle end reads the current file policy rather than the startup policy', async (t) => {
  const h = await state(t);
  await h.ctx.announceSession(h.sessionId, false);
  h.ctx.sessionSandboxFiles.set(h.sessionId, 'read-only');
  await h.dispatch('session.delete', { sessionId: h.sessionId });
  assert.deepEqual(h.seen, [
    { kind: 'start', readOnly: false },
    { kind: 'end', readOnly: true },
  ]);
});

for (const cancelled of [false, true])
  test(`an in-run approval releases the planning lifecycle restriction after ${cancelled ? 'cancellation' : 'completion'}`, async (t) => {
    const h = await state(t);
    await h.ctx.announceSession(h.sessionId, true, true);
    let externalStops = 0;
    h.ctx.hooks.register({
      stop() {
        externalStops++;
      },
    });
    const controller = new AbortController();
    if (cancelled) controller.abort(new Error('Run cancelled'));
    await h.ctx.hooks.stop(
      {
        sessionId: h.sessionId,
        runId: 'approved-run',
        status: cancelled ? 'cancelled' : 'completed',
        text: 'Approved',
        readOnly: false,
      },
      controller.signal,
    );
    assert.equal(externalStops, cancelled ? 0 : 1);
    await h.dispatch('session.delete', { sessionId: h.sessionId });
    assert.deepEqual(h.seen, [
      { kind: 'start', readOnly: true },
      { kind: 'end', readOnly: false },
    ]);
  });

test('real Host planning lifecycle never launches workspace hooks, including shutdown after submission', async (t) => {
  let nextPlan = 0;
  const url = await httpFixture(t, (body, response) => {
    if (
      Array.isArray(body.tools) &&
      body.tools.some((tool: { name?: string }) => tool.name === 'submit_plan')
    )
      sendFrames(
        response,
        frames('', [
          {
            id: `plan-${++nextPlan}`,
            name: 'submit_plan',
            input: { title: 'Inspect', steps: ['Read only'] },
          },
        ]),
      );
    else sendFrames(response, frames('Ready'));
  });
  let continuedId = '',
    explicitId = '';
  // Trust is read from the user state directory, so the Host gets its own, outside the workspace.
  const state = await mkdtemp(path.join(tmpdir(), 'yuantu-hook-trust-'));
  t.after(() => rm(state, { recursive: true, force: true }));
  const host = await listeningHost(
    t,
    {
      YUANTU_SANDBOX: 'host',
      YUANTU_HOOK_BRIDGE: '1',
      YUANTU_BASE_URL: url,
      YUANTU_STATE_DIR: state,
    },
    (dbPath) => {
      const store = new SessionStore(dbPath);
      try {
        continuedId = store.create(path.dirname(dbPath)).id;
        store.createPlan(continuedId);
        explicitId = store.create(path.dirname(dbPath)).id;
      } finally {
        store.close();
      }
    },
  );
  await mkdir(path.join(host.root, '.claude'));
  const script = path.join(host.root, 'lifecycle.mjs');
  await writeFile(
    script,
    String.raw`
import { appendFileSync } from 'node:fs';
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
appendFileSync('lifecycle.jsonl', Buffer.concat(chunks).toString('utf8') + '\n');
`,
  );
  const command = `"${process.execPath}" "${script}"`;
  await writeFile(
    path.join(host.root, '.claude/settings.json'),
    JSON.stringify({
      hooks: {
        SessionStart: [{ hooks: [{ type: 'command', command }] }],
        SessionEnd: [{ hooks: [{ type: 'command', command }] }],
      },
    }),
  );
  trustWorkspaceHooks(
    host.root,
    loadHookDeclarations(host.root),
    hookTrustFile({ YUANTU_STATE_DIR: state }),
  );
  const { client } = await connectClient(host);
  let normalId = '';
  try {
    await client.start();
    const warmup = await client.request('session.create', {});
    assert.equal((await client.run(warmup.id, 'Load the workspace hooks')).status, 'completed');
    assert.equal(
      (await client.request('run.start', { sessionId: continuedId, prompt: 'Continue planning' }))
        .status,
      'completed',
    );
    assert.equal(
      (
        await client.request('run.start', {
          sessionId: explicitId,
          prompt: 'Start planning',
          phase: 'plan',
        })
      ).status,
      'completed',
    );
    normalId = (await client.request('session.create', {})).id;
  } finally {
    await client.stop();
  }
  // A connected client owns only its socket; the independently launched Host finishes hooks afterwards.
  if (host.child.exitCode === null)
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('Host did not finish lifecycle shutdown')),
        10000,
      );
      host.child.once('exit', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(`Host exited with ${String(code)}: ${host.stderr()}`));
      });
    });
  assert.equal(host.child.exitCode, 0);
  const lines = (await readFile(path.join(host.root, 'lifecycle.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as { session_id: string; hook_event_name: string });
  assert.deepEqual(
    lines.filter((entry) => [continuedId, explicitId].includes(entry.session_id)),
    [],
    'planning start and end must not write files',
  );
  assert.deepEqual(
    lines.filter((entry) => entry.session_id === normalId).map((entry) => entry.hook_event_name),
    ['SessionStart', 'SessionEnd'],
    'ordinary lifecycle hooks remain active',
  );
  assert.equal(nextPlan, 2, 'both planning runs submitted their plans');
});
