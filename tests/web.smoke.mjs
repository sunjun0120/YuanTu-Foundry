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
import { tmpdir } from 'node:os';
import path from 'node:path';
import { connect } from 'node:net';
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
  'an oversized frame header closes only its page with code 1009',
  { timeout: 15_000 },
  async (t) => {
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
          const header = Buffer.alloc(14);
          header[0] = 0x81;
          header[1] = 0xff;
          header.writeBigUInt64BE(1024n * 1024n * 1024n, 2);
          socket.write(header);
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
    assert.equal(closeCode, 1009);
    const health = await fetch(new URL('/health', bridge.url), {
      signal: AbortSignal.timeout(3000),
    });
    assert.deepEqual(await health.json(), { ok: true });
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
