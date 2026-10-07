/**
 * The web carrier, end to end, over a real WebSocket and a real Host.
 *
 * What this exercises is the whole claim of S4, with nothing mocked in the middle: a page-shaped client opens a
 * WebSocket to a local bridge, the bridge owns a Host spawned from `apps/agent-host`, a command travels the same
 * `CarrierCommand` vocabulary the desktop's IPC channel carries, and the answer comes back as state and deltas.
 * The client here is Node's own `WebSocket` — a real RFC 6455 peer, which is the part of "a browser" that the
 * bridge can be wrong about — while the DOM half of the page is covered by the desktop smoke, because the page
 * *is* the desktop's own page with a different script tag.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { connect } from 'node:net';
import { chromium } from 'playwright';
import { startBridge } from '../apps/web/main.ts';
import { frames, httpFixture, sendFrames } from './http-fixture.ts';

/** A page-shaped client: one socket, frames in, one promise per request id. */
function pageClient(url) {
  const socket = new WebSocket(url);
  const framesSeen = [];
  const waiters = new Map();
  socket.addEventListener('message', (event) => {
    const frame = JSON.parse(String(event.data));
    framesSeen.push(frame);
    const id = typeof frame.id === 'number' ? frame.id : undefined;
    if (id !== undefined && waiters.has(id)) {
      waiters.get(id)(frame);
      waiters.delete(id);
    }
  });
  const opened = new Promise((resolve, reject) => {
    socket.addEventListener('open', () => resolve(), { once: true });
    socket.addEventListener('error', () => reject(new Error('the bridge refused the socket')), {
      once: true,
    });
  });
  let nextId = 1;
  return {
    socket,
    framesSeen,
    opened,
    /** Send one request and wait for its reply. */
    async request(body) {
      await opened;
      const id = nextId++;
      const reply = new Promise((resolve) => waiters.set(id, resolve));
      socket.send(JSON.stringify({ ...body, id }));
      return reply;
    },
    close() {
      socket.close();
    },
  };
}
/** Wait until a predicate holds over the frames seen so far, or fail with what was seen instead. */
async function until(client, predicate, what, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate(client.framesSeen)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(
    `timed out waiting for ${what}; saw ${JSON.stringify(client.framesSeen).slice(0, 600)}`,
  );
}
const socketUrl = (url) => url.replace('http://', 'ws://').replace('/?', '/ws?');

test(
  'the built page completes a real Chromium turn and restores it after reload',
  {
    timeout: 30_000,
    skip: existsSync(chromium.executablePath())
      ? false
      : 'Chromium is not installed; run npx playwright install chromium',
  },
  async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), 'yuantu-web-page-'));
    let bridge;
    let browser;
    t.after(async () => {
      await browser?.close();
      await bridge?.close();
      await rm(root, { recursive: true, force: true });
    });
    const url = await httpFixture(t, (_body, response) =>
      sendFrames(response, frames('BROWSER_PAGE_REPLY')),
    );
    bridge = await startBridge({
      workspace: root,
      port: 0,
      token: 'page-fixture',
      page: path.resolve('apps/web/dist'),
      env: {
        YUANTU_API_KEY: 'fixture',
        YUANTU_PROTOCOL: 'anthropic',
        YUANTU_MODEL: 'fixture',
        YUANTU_MAX_CONTEXT_TOKENS: '128000',
        YUANTU_BASE_URL: url,
        YUANTU_SESSION_TITLES: '0',
      },
    });
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    page.setDefaultTimeout(10_000);
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    await page.goto(bridge.url);
    await page.waitForFunction(() => !document.querySelector('#prompt').disabled);
    await page.evaluate(() => {
      window.__stream = '';
      window.yuantu.subscribeDelta((delta) => {
        if (!delta.reset) window.__stream += delta.text;
      });
    });
    await page.locator('#prompt').fill('Actual browser fixture turn');
    await page.locator('#send').click();
    await page.waitForFunction(() =>
      document.querySelector('#messages')?.textContent.includes('BROWSER_PAGE_REPLY'),
    );
    assert.equal(await page.evaluate(() => window.__stream), 'BROWSER_PAGE_REPLY');
    assert.equal(await page.locator('#messages .message.assistant').count(), 1);
    await page.reload();
    await page.waitForFunction(() =>
      document.querySelector('#messages')?.textContent.includes('BROWSER_PAGE_REPLY'),
    );
    assert.equal(await page.locator('#messages .message.assistant').count(), 1);
    assert.deepEqual(errors, []);
  },
);

const oversizedHeader = Buffer.alloc(14);
oversizedHeader[0] = 0x81;
oversizedHeader[1] = 0xff;
oversizedHeader.writeBigUInt64BE(1024n * 1024n * 1024n, 2);
for (const [name, input, expectedCode] of [
  ['an oversized frame header', oversizedHeader, 1009],
  [
    'interleaved fragmented messages',
    Buffer.from([1, 129, 0, 0, 0, 0, 120, 129, 129, 0, 0, 0, 0, 121]),
    1002,
  ],
  ['invalid UTF-8 text', Buffer.from([129, 129, 0, 0, 0, 0, 255]), 1007],
]) {
  test(`${name} closes only its page with code ${expectedCode}`, { timeout: 15_000 }, async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), 'yuantu-web-frame-limit-'));
    const bridge = await startBridge({
      workspace: root,
      port: 0,
      token: 'size-fixture',
      page: path.resolve('apps/web/dist'),
    });
    t.after(async () => {
      await bridge.close();
      await rm(root, { recursive: true, force: true });
    });
    const response = await new Promise((resolve, reject) => {
      const socket = connect(Number(new URL(bridge.url).port), '127.0.0.1');
      t.after(() => socket.destroy());
      let received = Buffer.alloc(0);
      let upgraded = false;
      socket.setTimeout(3000, () => socket.destroy(new Error('frame refusal timed out')));
      socket.on('error', reject);
      socket.on('data', (chunk) => {
        received = Buffer.concat([received, chunk]);
        if (!upgraded) {
          const boundary = received.indexOf('\r\n\r\n');
          if (boundary < 0) return;
          assert.match(received.subarray(0, boundary).toString(), /^HTTP\/1\.1 101/);
          received = received.subarray(boundary + 4);
          upgraded = true;
          socket.write(input);
        }
      });
      socket.on('end', () => resolve(received));
      socket.on('connect', () =>
        socket.write(
          'GET /ws?token=size-fixture HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n',
        ),
      );
    });
    let closeCode;
    for (let offset = 0; offset < response.length;) {
      const opcode = response[offset] & 15;
      let length = response[offset + 1] & 127;
      offset += 2;
      if (length === 126) {
        length = response.readUInt16BE(offset);
        offset += 2;
      } else if (length === 127) {
        length = Number(response.readBigUInt64BE(offset));
        offset += 8;
      }
      if (opcode === 8) closeCode = response.readUInt16BE(offset);
      offset += length;
    }
    assert.equal(closeCode, expectedCode);
    const health = await fetch(new URL('/health', bridge.url), {
      signal: AbortSignal.timeout(3000),
    });
    assert.deepEqual(await health.json(), { ok: true });
  });
}

test(
  'a close frame prevents subsequent requests from creating a real Host session',
  { timeout: 15_000 },
  async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), 'yuantu-web-close-boundary-'));
    const bridge = await startBridge({
      workspace: root,
      port: 0,
      token: 'close-fixture',
      page: path.resolve('apps/web/dist'),
    });
    t.after(async () => {
      await bridge.close();
      await rm(root, { recursive: true, force: true });
    });
    const deadline = Date.now() + 5000;
    while (!bridge.carrier.snapshot.ready && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(bridge.carrier.snapshot.ready, true);
    const before = bridge.carrier.snapshot;
    const request = Buffer.from(
      JSON.stringify({ id: 1, kind: 'command', command: { type: 'create' } }),
    );
    assert(request.length < 126);
    const input = Buffer.concat([
      Buffer.from([1, 129, 0, 0, 0, 0, 120]),
      Buffer.from([136, 130, 0, 0, 0, 0, 3, 232]),
      Buffer.from([129, 128 | request.length, 0, 0, 0, 0]),
      request,
    ]);
    // Observe dispatch while retaining its real behavior, then verify persisted session effects too.
    const dispatch = bridge.carrier.dispatch.bind(bridge.carrier);
    const effects = [];
    t.mock.method(bridge.carrier, 'dispatch', (command) => {
      const effect = dispatch(command);
      effects.push(effect);
      return effect;
    });
    await new Promise((resolve, reject) => {
      const socket = connect(Number(new URL(bridge.url).port), '127.0.0.1');
      t.after(() => socket.destroy());
      let response = '';
      let upgraded = false;
      socket.setTimeout(3000, () => socket.destroy(new Error('close response timed out')));
      socket.on('error', reject);
      socket.on('data', (chunk) => {
        response += chunk;
        if (!upgraded && response.includes('\r\n\r\n')) {
          assert.match(response, /^HTTP\/1\.1 101/);
          upgraded = true;
          socket.write(input);
        }
      });
      socket.on('end', resolve);
      socket.on('connect', () =>
        socket.write(
          'GET /ws?token=close-fixture HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n',
        ),
      );
    });
    await Promise.all(effects);
    assert.deepEqual(bridge.carrier.snapshot.sessions, before.sessions);
    assert.equal(bridge.carrier.snapshot.session.sessionId, before.session.sessionId);
    assert.equal(effects.length, 0);
  },
);

test('a page drives a real Host through the bridge: handshake, one turn, events', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-web-'));
  const url = await httpFixture(t, (_body, res) =>
    sendFrames(res, frames('Hello from the bridge.')),
  );
  const bridge = await startBridge({
    workspace: root,
    port: 0,
    token: 'smoke-token',
    page: path.resolve('apps/web/dist'),
    env: {
      YUANTU_PROTOCOL: 'anthropic',
      YUANTU_API_KEY: 'web-fixture',
      YUANTU_MODEL: 'fixture',
      YUANTU_MAX_CONTEXT_TOKENS: '128000',
      YUANTU_SESSION_TITLES: '0',
      YUANTU_BASE_URL: url,
    },
  });
  t.after(async () => {
    await bridge.close();
    await rm(root, { recursive: true, force: true });
  });
  const client = pageClient(socketUrl(bridge.url));
  t.after(() => client.close());
  const send = (command) => client.request({ kind: 'command', command });

  // The first frame after the handshake is the state, so a page shows the session without asking for it.
  await until(client, (seen) => seen.some((frame) => frame.kind === 'state'), 'the opening state');
  for (const mode of ['host', 'sbx', 'docker', 'windows']) {
    const refused = await send({ type: 'sandbox', mode });
    assert.equal(refused.ok, false, `the page cannot override the launch sandbox with ${mode}`);
    assert.match(refused.error, /sandbox.*launch|沙箱.*启动/i);
  }
  const created = await send({ type: 'send', prompt: 'hello from the web' });
  assert.equal(created.ok, true, JSON.stringify(created));
  assert.equal(created.value.ready, true);

  // The run's answer arrives as state and as deltas — the same two channels the desktop subscribes to.
  await until(
    client,
    (seen) =>
      seen.some((frame) => frame.kind === 'delta') ||
      seen.some(
        (frame) =>
          frame.kind === 'state' && JSON.stringify(frame.state).includes('Hello from the bridge.'),
      ),
    'the answer',
    30_000,
  );
  await until(
    client,
    (seen) =>
      seen.some(
        (frame) =>
          frame.kind === 'state' && JSON.stringify(frame.state).includes('Hello from the bridge.'),
      ),
    'the answer in a snapshot',
    30_000,
  );

  // The workspace-files channel is the bridge's own, not a carrier command: it answers without a snapshot.
  const listing = await client.request({ kind: 'files', command: { type: 'list', path: '' } });
  assert.equal(listing.ok, true, JSON.stringify(listing));

  // A second page is refused in the Host's own words — approvals and runs are per Host, so this is the honest
  // answer rather than a queue nobody drains.
  const second = pageClient(socketUrl(bridge.url));
  t.after(() => second.close());
  await until(
    second,
    (seen) =>
      seen.some(
        (frame) =>
          frame.kind === 'refused' && String(frame.reason).includes('one connection at a time'),
      ),
    'the second page to be refused',
    10_000,
  );
});

test('the bridge refuses a wrong token, and serves the page and its health check', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-web-auth-'));
  const bridge = await startBridge({
    workspace: root,
    port: 0,
    token: 'right-token',
    page: path.resolve('apps/web/dist'),
  });
  t.after(async () => {
    await bridge.close();
    await rm(root, { recursive: true, force: true });
  });
  // A wrong token is refused at the handshake, so the socket never opens.
  const denied = new WebSocket(`${socketUrl(bridge.url)}wrong`);
  const outcome = await new Promise((resolve) => {
    denied.addEventListener('open', () => resolve('opened'));
    denied.addEventListener('error', () => resolve('refused'));
    denied.addEventListener('close', () => resolve('refused'));
  });
  assert.equal(outcome, 'refused');
  // The page the bridge serves is the desktop's own page, wired to the web bundle.
  const page = await fetch(bridge.url);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /<script type="module" src="\.\/app\.js"><\/script>/);
  assert(html.includes(`connect-src ${new URL(socketUrl(bridge.url)).origin};`));
  const health = await fetch(new URL('/health', bridge.url));
  assert.deepEqual(await health.json(), { ok: true });
  // The bundle really is the renderer: it asks for the bridge, which only the desktop renderer does.
  const bundle = await fetch(new URL('/app.js', bridge.url));
  assert.equal(bundle.status, 200);
  assert.match(await bundle.text(), /yuantu/);
});

test(
  'malformed asset URLs are refused without terminating the bridge',
  { timeout: 15_000 },
  async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), 'yuantu-web-malformed-url-'));
    const bridge = await startBridge({
      workspace: root,
      port: 0,
      token: 'url-fixture',
      page: path.resolve('apps/web/dist'),
    });
    t.after(async () => {
      await bridge.close();
      await rm(root, { recursive: true, force: true });
    });
    for (const asset of ['/%ZZ', '/%', '/%E0%A4%A']) {
      const response = await fetch(new URL(asset, bridge.url), {
        signal: AbortSignal.timeout(3000),
      });
      assert.equal(response.status, 400, asset);
      await response.text();
      const health = await fetch(new URL('/health', bridge.url), {
        signal: AbortSignal.timeout(3000),
      });
      assert.deepEqual(await health.json(), { ok: true });
    }
    const traversal = await fetch(new URL('/%2e%2e%2fpackage.json', bridge.url));
    assert.equal(traversal.status, 403);
    const missing = await fetch(new URL('/missing-asset.js', bridge.url));
    assert.equal(missing.status, 404);
  },
);

test(
  'malformed upgrade URLs are refused without terminating the bridge',
  { timeout: 15_000 },
  async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), 'yuantu-web-malformed-upgrade-'));
    const bridge = await startBridge({
      workspace: root,
      port: 0,
      token: 'upgrade-fixture',
      page: path.resolve('apps/web/dist'),
    });
    t.after(async () => {
      await bridge.close();
      await rm(root, { recursive: true, force: true });
    });
    const port = Number(new URL(bridge.url).port);
    const response = await new Promise((resolve, reject) => {
      const socket = connect(port, '127.0.0.1');
      t.after(() => socket.destroy());
      let data = '';
      socket.setTimeout(3000, () => socket.destroy(new Error('upgrade response timed out')));
      socket.on('error', reject);
      socket.on('data', (bytes) => {
        data += bytes;
      });
      socket.on('end', () => resolve(data));
      socket.on('connect', () =>
        socket.write(
          'GET //%ZZ HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n',
        ),
      );
    });
    assert.match(response, /^HTTP\/1\.1 400 Bad Request/);
    const health = await fetch(new URL('/health', bridge.url), {
      signal: AbortSignal.timeout(3000),
    });
    assert.deepEqual(await health.json(), { ok: true });
  },
);
