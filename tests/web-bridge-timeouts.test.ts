import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createBrowserBridge, type BrowserBridgeOptions } from '../apps/web/bridge-client.ts';
import type { CarrierCommand } from '../packages/carrier/contract.ts';

class FixtureSocket extends EventTarget {
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: FixtureSocket[] = [];
  static autoOpen = true;
  readyState = FixtureSocket.CONNECTING;
  sent: Array<{ id: number }> = [];
  throwOnSend = false;
  constructor() {
    super();
    FixtureSocket.instances.push(this);
    if (FixtureSocket.autoOpen) queueMicrotask(() => this.open());
  }
  open() {
    if (this.readyState !== FixtureSocket.CONNECTING) return;
    this.readyState = FixtureSocket.OPEN;
    this.dispatchEvent(new Event('open'));
  }
  send(text: string) {
    if (this.throwOnSend) throw new Error('fixture send failure');
    this.sent.push(JSON.parse(text));
  }
  close() {
    this.readyState = FixtureSocket.CLOSED;
    this.dispatchEvent(new Event('close'));
  }
  reply(id: number, marker = 'current') {
    this.dispatchEvent(
      new MessageEvent('message', {
        data: JSON.stringify({ kind: 'reply', id, ok: true, value: { marker } }),
      }),
    );
  }
}

function fixture(t: TestContext, autoOpen = true, requestTimeoutMs: number | null = 30) {
  FixtureSocket.instances = [];
  FixtureSocket.autoOpen = autoOpen;
  const original = globalThis.WebSocket;
  globalThis.WebSocket = FixtureSocket as unknown as typeof WebSocket;
  t.after(() => {
    for (const socket of FixtureSocket.instances) socket.close();
    globalThis.WebSocket = original;
  });
  const options: BrowserBridgeOptions = {
    url: 'ws://fixture',
    storage: { getItem: () => null, setItem() {} },
    connectionTimeoutMs: 20,
    ...(requestTimeoutMs === null ? {} : { requestTimeoutMs }),
  };
  return createBrowserBridge(options);
}
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

test('default deadlines preserve commands that await long runs and approval waits', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const browser = fixture(t, true, null);
  const commands: CarrierCommand[] = [
    { type: 'send', prompt: 'long task' },
    { type: 'goal', prompt: 'draft' },
    { type: 'plan', prompt: 'plan' },
    { type: 'planExecute', planId: 'p' },
    { type: 'taskStart', taskId: 't' },
    { type: 'taskPropose', taskId: 't' },
    { type: 'taskRetry', taskId: 't' },
    { type: 'taskVerify', taskId: 't' },
    { type: 'taskConfirm', taskId: 't', indices: [], expectedUpdatedAt: 'fixture' },
    { type: 'compact' },
  ];
  let settled = 0;
  const replies = commands.map((command) =>
    browser.invoke(command).then((reply) => {
      settled++;
      return reply;
    }),
  );
  const ordinary = browser.invoke({ type: 'snapshot' });
  const file = browser.files({ type: 'read', path: 'a.txt' });
  await flush();
  t.mock.timers.tick(120_001);
  await flush();
  assert.equal(
    settled,
    0,
    'a live long operation must not restore the submitted prompt as a failed send',
  );
  assert.equal(
    (await ordinary).ok,
    false,
    'ordinary requests still have a finite default deadline',
  );
  assert.equal((await file).ok, false, 'file requests keep the same bounded deadline');
  const live = FixtureSocket.instances[0]!;
  for (const request of live.sent) live.reply(request.id);
  assert((await Promise.all(replies)).every((reply) => reply.ok));
});

test(
  'a stalled handshake expires and a subsequent request opens a fresh connection',
  { timeout: 500 },
  async (t) => {
    const browser = fixture(t, false);
    const replies = await Promise.all([
      browser.invoke({ type: 'snapshot' }),
      browser.invoke({ type: 'snapshot' }),
    ]);
    assert(replies.every((reply) => !reply.ok && /连接.*超时/.test(reply.error)));
    assert.equal(FixtureSocket.instances.length, 1);
    assert.equal(FixtureSocket.instances[0]!.readyState, FixtureSocket.CLOSED);
    FixtureSocket.autoOpen = true;
    const next = browser.invoke({ type: 'snapshot' });
    await flush();
    const live = FixtureSocket.instances[1]!;
    live.reply(live.sent[0]!.id);
    assert.equal((await next).ok, true);
  },
);

test(
  'a silent bridge expires commands without replay and ignores late replies',
  { timeout: 500 },
  async (t) => {
    const browser = fixture(t);
    const expired = await browser.invoke({ type: 'send', prompt: 'may have run' });
    assert(!expired.ok);
    assert.match(expired.error, /超时.*执行结果.*未知/);
    const live = FixtureSocket.instances[0]!;
    assert.equal(live.sent.length, 1, 'side effects must never be automatically replayed');
    const current = browser.invoke({ type: 'snapshot' });
    await flush();
    let settled = false;
    void current.then(() => {
      settled = true;
    });
    live.reply(live.sent[0]!.id, 'late');
    await flush();
    assert.equal(settled, false);
    live.reply(live.sent[1]!.id);
    assert.equal((await current).ok, true);
  },
);

test('a synchronous send failure settles and later requests still work', async (t) => {
  const browser = fixture(t);
  const warmup = browser.invoke({ type: 'snapshot' });
  await flush();
  const live = FixtureSocket.instances[0]!;
  live.reply(live.sent[0]!.id);
  assert((await warmup).ok);
  live.throwOnSend = true;
  const failed = await browser.invoke({ type: 'snapshot' });
  assert(!failed.ok && /执行结果.*未知/.test(failed.error));
  live.throwOnSend = false;
  const current = browser.invoke({ type: 'snapshot' });
  await flush();
  live.reply(live.sent[1]!.id);
  assert((await current).ok);
});

test(
  'connection errors release concurrent callers and permit a fresh attempt',
  { timeout: 500 },
  async (t) => {
    const browser = fixture(t, false);
    const first = browser.invoke({ type: 'snapshot' });
    FixtureSocket.instances[0]!.dispatchEvent(new Event('error'));
    assert.equal((await first).ok, false);
    FixtureSocket.autoOpen = true;
    const current = browser.invoke({ type: 'snapshot' });
    await flush();
    assert.equal(FixtureSocket.instances.length, 2);
    const live = FixtureSocket.instances[1]!;
    live.reply(live.sent[0]!.id);
    assert((await current).ok);
  },
);

for (const terminal of [
  'reply',
  'close',
  'refused',
  'send failure',
  'invalid JSON',
  'null frame',
] as const) {
  test(`bridge timers are removed after ${terminal}`, async (t) => {
    const browser = fixture(t);
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const set = globalThis.setTimeout;
    const clear = globalThis.clearTimeout;
    t.mock.method(globalThis, 'setTimeout', ((callback: () => void, delay: number) => {
      const timer = set(callback, delay);
      timers.add(timer);
      return timer;
    }) as typeof setTimeout);
    t.mock.method(globalThis, 'clearTimeout', (timer: ReturnType<typeof setTimeout>) => {
      timers.delete(timer);
      clear(timer);
    });
    const request = browser.files({ type: 'read', path: 'a.txt' });
    const live = FixtureSocket.instances[0]!;
    if (terminal === 'send failure') live.throwOnSend = true;
    await flush();
    if (terminal === 'reply')
      live.dispatchEvent(
        new MessageEvent('message', {
          data: JSON.stringify({
            kind: 'reply',
            id: live.sent[0]!.id,
            ok: true,
            value: { ok: true },
          }),
        }),
      );
    else if (terminal === 'close') live.close();
    else if (terminal === 'refused')
      live.dispatchEvent(
        new MessageEvent('message', {
          data: JSON.stringify({ kind: 'refused', reason: 'fixture refusal' }),
        }),
      );
    else if (terminal === 'invalid JSON')
      live.dispatchEvent(new MessageEvent('message', { data: '{' }));
    else if (terminal === 'null frame')
      live.dispatchEvent(new MessageEvent('message', { data: 'null' }));
    const reply = await request;
    assert.equal(reply.ok, terminal === 'reply');
    assert.equal(timers.size, 0, 'settled requests and handshakes must not retain deadlines');
  });
}
