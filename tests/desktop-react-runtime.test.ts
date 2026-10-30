import test from 'node:test';
import assert from 'node:assert/strict';
import { createDesktopActions, type DesktopActionError } from '../apps/desktop/ui/actions.ts';
import { createDesktopRuntime } from '../apps/desktop/ui/runtime.ts';
import { createPendingOperations } from '../apps/desktop/ui/ui-state.ts';
import type { CarrierCommand, CarrierSnapshot } from '../packages/carrier/contract.ts';
import type { DesktopBridge, DesktopReply } from '../apps/desktop/contract.ts';

/**
 * The runtime is the one owner of the bridge, so the tests are about the promises its interface makes: one
 * subscription, a stable snapshot per unchanged section, a projection that does not rewrite the object the preload
 * reuses, and an initial request that cannot move the view backwards. The bridge below is a hand-written double on
 * purpose — a fake that imported the real mirror would agree with the runtime by construction.
 */
type Sections = Record<string, unknown>;
const snapshot = (sections: Sections): CarrierSnapshot => sections as unknown as CarrierSnapshot;

function fakeBridge() {
  let listener:
    ((state: CarrierSnapshot, changed: readonly (keyof CarrierSnapshot)[]) => void) | undefined;
  let replier: ((command: unknown) => Promise<DesktopReply>) | undefined;
  let subscriptions = 0;
  let unsubscriptions = 0;
  const bridge = {
    subscribe(next: NonNullable<typeof listener>) {
      subscriptions += 1;
      listener = next;
      return () => {
        unsubscriptions += 1;
        listener = undefined;
      };
    },
    async invoke(command: unknown) {
      if (!replier) throw new Error(`no reply configured for ${JSON.stringify(command)}`);
      return replier(command);
    },
  } as unknown as DesktopBridge;
  return {
    bridge,
    /** Publish a snapshot; no `changed` list means "anything may have changed", like an older preload. */
    push(state: CarrierSnapshot, changed?: readonly (keyof CarrierSnapshot)[]) {
      listener?.(state, changed ?? []);
    },
    reply(next: (command: unknown) => Promise<DesktopReply>) {
      replier = next;
    },
    subscriptions: () => subscriptions,
    unsubscriptions: () => unsubscriptions,
  };
}

const ready: DesktopReply = {
  ok: true,
  state: snapshot({ workspace: '/w', session: { sessionId: 'a' }, sessions: [] }),
};

test('starting twice subscribes once, and disposing twice unsubscribes once', async () => {
  const fake = fakeBridge();
  fake.reply(async () => ready);
  const runtime = createDesktopRuntime(fake.bridge);
  await runtime.start();
  await runtime.start();
  assert.equal(fake.subscriptions(), 1);
  runtime.dispose();
  runtime.dispose();
  assert.equal(fake.unsubscriptions(), 1);
});

test('an unchanged section keeps its reference and does not notify', async () => {
  const fake = fakeBridge();
  const sessions = [{ id: 's1' }];
  fake.reply(async () => ({ ok: true, state: snapshot({ workspace: '/w', sessions }) }));
  const runtime = createDesktopRuntime(fake.bridge);
  await runtime.start();
  const store = runtime.section('sessions');
  let notified = 0;
  store.subscribe(() => (notified += 1));
  const before = store.getSnapshot();
  assert.equal(before, sessions);
  fake.push(snapshot({ workspace: '/w', sessions, session: { sessionId: 'a' } }), ['session']);
  assert.equal(notified, 0);
  assert.equal(store.getSnapshot(), before);
  const nextSessions = [{ id: 's2' }];
  fake.push(snapshot({ workspace: '/w', sessions: nextSessions, session: { sessionId: 'a' } }), [
    'sessions',
  ]);
  assert.equal(notified, 1);
  assert.equal(store.getSnapshot(), nextSessions);
});

test('a bridge without a changed list is a full refresh, including sections that disappeared', async () => {
  const fake = fakeBridge();
  fake.reply(async () => ({
    ok: true,
    state: snapshot({ workspace: '/w', sessions: [], recovery: { attempts: 1, pid: 2 } }),
  }));
  const runtime = createDesktopRuntime(fake.bridge);
  await runtime.start();
  const sessionsStore = runtime.section('sessions');
  const recoveryStore = runtime.section('recovery');
  let sessionsNotified = 0;
  sessionsStore.subscribe(() => (sessionsNotified += 1));
  assert.deepEqual(recoveryStore.getSnapshot(), { attempts: 1, pid: 2 });
  fake.push(snapshot({ workspace: '/w', sessions: [{ id: 's2' }] }));
  assert.equal(sessionsNotified, 1);
  assert.equal(recoveryStore.getSnapshot(), undefined);
});

test('an object the bridge reuses is projected, so an old snapshot stays what it was', async () => {
  const fake = fakeBridge();
  const published: Sections = { workspace: '/w', session: { sessionId: 'a', title: 'first' } };
  fake.reply(async () => ({ ok: true, state: snapshot(published) }));
  const runtime = createDesktopRuntime(fake.bridge);
  await runtime.start();
  const first = runtime.getSnapshot();
  assert.equal((first?.session as { title?: string } | undefined)?.title, 'first');
  // The preload mirror keeps one object and replaces sections in it: mutate, then publish the same reference.
  published.session = { sessionId: 'a', title: 'second' };
  fake.push(snapshot(published), ['session']);
  assert.equal((first?.session as { title?: string } | undefined)?.title, 'first');
  assert.notEqual(runtime.getSnapshot(), first);
  assert.equal((runtime.getSnapshot()?.session as { title?: string } | undefined)?.title, 'second');
});

test('a push that arrives before the initial reply is not rolled back by it', async () => {
  const fake = fakeBridge();
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => (release = resolve));
  fake.reply(async () => {
    await gate;
    return { ok: true, state: snapshot({ workspace: '/w', session: { sessionId: 'old' } }) };
  });
  const runtime = createDesktopRuntime(fake.bridge);
  const started = runtime.start();
  fake.push(snapshot({ workspace: '/w', session: { sessionId: 'new' } }), ['session']);
  release?.();
  await started;
  assert.equal(
    (runtime.getSnapshot()?.session as { sessionId?: string } | undefined)?.sessionId,
    'new',
  );
});

test('a failed initial request can be retried without a second subscription', async () => {
  const fake = fakeBridge();
  let attempts = 0;
  fake.reply(async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('offline');
    return ready;
  });
  const runtime = createDesktopRuntime(fake.bridge);
  await assert.rejects(runtime.start(), /offline/);
  await runtime.start();
  assert.equal(fake.subscriptions(), 1);
  assert.equal(
    (runtime.getSnapshot()?.session as { sessionId?: string } | undefined)?.sessionId,
    'a',
  );
});

test('a reply that lands after dispose changes nothing and notifies nobody', async () => {
  const fake = fakeBridge();
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => (release = resolve));
  fake.reply(async () => {
    await gate;
    return ready;
  });
  const runtime = createDesktopRuntime(fake.bridge);
  let notified = 0;
  runtime.onSnapshot(() => (notified += 1));
  const started = runtime.start();
  runtime.dispose();
  release?.();
  await started;
  assert.equal(notified, 0);
  assert.equal(runtime.getSnapshot(), null);
});

test('pending ids belong to one operation, so an early end cannot unlock another', () => {
  const pending = createPendingOperations();
  const first = pending.begin();
  const second = pending.begin();
  assert.equal(pending.isOperating(), true);
  pending.end(first);
  assert.equal(pending.isOperating(), true);
  assert.equal(pending.size(), 1);
  pending.end(second);
  assert.equal(pending.isOperating(), false);
  pending.end(second);
  assert.equal(pending.isOperating(), false);
});

function actionFixture(reply: (command: CarrierCommand) => Promise<DesktopReply>) {
  const sent: CarrierCommand[] = [];
  const calls = { renders: 0, focused: 0, cleared: 0, sending: false };
  let error: DesktopActionError | null = null;
  const state: Sections = {
    workspace: '/w',
    session: { sessionId: 'a', running: false, loading: false, messages: [] },
  };
  const pending = createPendingOperations();
  const actions = createDesktopActions({
    bridge: {
      async invoke(command: CarrierCommand) {
        sent.push(command);
        return reply(command);
      },
    } as unknown as DesktopBridge,
    getState: () => snapshot(state),
    setError: (next) => {
      error = next;
    },
    requestRender: () => (calls.renders += 1),
    isSending: () => calls.sending,
    clearComposer: () => (calls.cleared += 1),
    focusPrompt: () => (calls.focused += 1),
    pending,
  });
  return {
    actions,
    sent,
    calls,
    pending,
    error: () => error,
    state,
  };
}

test('a running session refuses ordinary commands but not opening another one', async () => {
  const fixture = actionFixture(async () => ready);
  fixture.state.session = { sessionId: 'a', running: true, loading: false, messages: [] };
  assert.equal(await fixture.actions.select({ type: 'send', prompt: 'x' }), null);
  assert.equal(fixture.sent.length, 0);
  const loaded = await fixture.actions.select({ type: 'load', id: 'b' });
  assert.ok(loaded);
  assert.equal(fixture.sent.length, 1);
});

test('history and search preserve focus, conversation commands restore it', async () => {
  const fixture = actionFixture(async () => ready);
  fixture.state.session = {
    sessionId: 'a',
    running: false,
    loading: false,
    messages: [{ role: 'user', content: 'Continue this conversation' }],
  };
  await fixture.actions.select({ type: 'loadOlder' });
  assert.equal(fixture.calls.focused, 0);
  await fixture.actions.select({ type: 'searchSessions', query: 'x' });
  assert.equal(fixture.calls.focused, 0, 'a search is not a command with a result to return to');
  await fixture.actions.select({ type: 'rename', id: 'a', title: 't' });
  assert.equal(fixture.calls.focused, 1);
});

test('creating or loading an empty session does not focus the welcome composer', async () => {
  for (const command of [{ type: 'create' }, { type: 'load', id: 'a' }] as const) {
    const fixture = actionFixture(async () => ready);
    await fixture.actions.select(command);
    assert.equal(fixture.calls.focused, 0, command.type);
  }
});

test('a failed reply is shown as the error and never becomes state', async () => {
  const failure = { ok: false as const, error: 'host refused' };
  const fixture = actionFixture(async () => failure);
  const result = await fixture.actions.select({ type: 'load', id: 'b' });
  assert.equal(result, null);
  assert.deepEqual(fixture.error(), failure);
});

test('a failed command from a previous workspace cannot replace the current error banner', async () => {
  let release!: (reply: DesktopReply) => void;
  const fixture = actionFixture(
    () =>
      new Promise<DesktopReply>((resolve) => {
        release = resolve;
      }),
  );
  const pending = fixture.actions.invoke({ type: 'approve', id: 'same', allow: false });
  fixture.state.workspace = '/b';
  release({ ok: false, error: 'old workspace failure' });
  await pending;
  assert.equal(fixture.error(), null);
});

test('a late session switch reply cannot clear another workspace composer', async () => {
  let release!: (reply: DesktopReply) => void;
  const fixture = actionFixture(
    () =>
      new Promise<DesktopReply>((resolve) => {
        release = resolve;
      }),
  );
  const pending = fixture.actions.select({ type: 'load', id: 'second-in-a' });
  fixture.state.workspace = '/b';
  release({
    ok: true,
    state: snapshot({ workspace: '/w', session: { sessionId: 'second-in-a' } }),
  });
  await pending;
  assert.equal(fixture.calls.cleared, 0);
});

test('a switch to another session clears the draft, a same-session command does not', async () => {
  const fixture = actionFixture(async () => ({
    ok: true,
    state: snapshot({ workspace: '/w', session: { sessionId: 'b' } }),
  }));
  await fixture.actions.select({ type: 'load', id: 'b' });
  assert.equal(fixture.calls.cleared, 1);
  const same = actionFixture(async () => ({
    ok: true,
    state: snapshot({ workspace: '/w', session: { sessionId: 'a' } }),
  }));
  await same.actions.select({ type: 'loadOlder' });
  assert.equal(same.calls.cleared, 0);
});

test('a search clears the previous error and does not hold an operation', async () => {
  let failNext = true;
  const fixture = actionFixture(async () =>
    failNext ? { ok: false as const, error: 'host refused' } : ready,
  );
  await fixture.actions.select({ type: 'rename', id: 'a', title: 't' });
  assert.deepEqual(fixture.error(), { ok: false, error: 'host refused' });
  failNext = false;
  const result = await fixture.actions.select({ type: 'searchSessions', query: 'x' });
  assert.ok(result);
  assert.equal(fixture.error(), null);
  assert.equal(fixture.pending.size(), 0);
  assert.equal(fixture.pending.isOperating(), false);
});
