import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import type { Socket } from 'node:net';
import { createBrowserBridge } from '../apps/web/bridge-client.ts';
import { startBridge } from '../apps/web/main.ts';
import { httpFixture, frames, sendFrames } from './http-fixture.ts';
import {
  acceptKey,
  encodeClose,
  encodeText,
  FrameDecoder,
  MessageAssembler,
} from '../apps/web/websocket.ts';

test(
  'concurrent browser startup requests deliver each real Host delta once',
  { timeout: 15_000 },
  async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), 'yuantu-browser-startup-'));
    let bridge: Awaited<ReturnType<typeof startBridge>> | undefined;
    t.after(async () => {
      await bridge?.close();
      await rm(root, { recursive: true, force: true });
    });
    const url = await httpFixture(t, (_body, response) =>
      sendFrames(response, frames('single chunk')),
    );
    bridge = await startBridge({
      workspace: root,
      port: 0,
      token: 'browser-fixture',
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
    const browser = createBrowserBridge({
      url: bridge.url.replace('http://', 'ws://').replace('/?', '/ws?'),
      storage: { getItem: () => null, setItem() {} },
    });
    let received = '';
    let resolveDelta: (() => void) | undefined;
    const deltaReceived = new Promise<void>((resolve) => {
      resolveDelta = resolve;
    });
    browser.subscribeDelta((delta) => {
      if (!delta.reset) {
        received += delta.text;
        resolveDelta?.();
      }
    });
    const startup = await Promise.all([
      browser.invoke({ type: 'snapshot' }),
      browser.invoke({ type: 'snapshot' }),
    ]);
    assert(startup.every((reply) => reply.ok));
    assert((await browser.invoke({ type: 'send', prompt: 'fixture browser turn' })).ok);
    await deltaReceived;
    assert.equal(received, 'single chunk');
  },
);

test(
  'a dropped browser request settles and concurrent reconnect requests share one event stream',
  { timeout: 10_000 },
  async (t) => {
    const server = createServer();
    const sockets = new Set<Socket>();
    let requests = 0;
    let connections = 0;
    server.on('upgrade', (request, socket: Socket) => {
      connections++;
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      socket.on('error', () => {});
      socket.write(
        `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptKey(String(request.headers['sec-websocket-key']))}\r\n\r\n`,
      );
      const decoder = new FrameDecoder();
      const assembler = new MessageAssembler();
      let deltaSent = false;
      socket.on('data', (bytes: Buffer) => {
        for (const frame of decoder.push(bytes))
          for (const message of assembler.push(frame)) {
            if (message.kind !== 'text') continue;
            const body = JSON.parse(message.text) as { id: number; command: { type: string } };
            assert.equal(body.command.type, 'snapshot');
            if (++requests === 1) {
              socket.destroy();
              return;
            }
            socket.write(
              encodeText(JSON.stringify({ kind: 'reply', id: body.id, ok: true, value: {} })),
            );
            if (!deltaSent) {
              deltaSent = true;
              socket.write(
                encodeText(JSON.stringify({ kind: 'delta', delta: { text: 'resumed' } })),
              );
            }
          }
      });
    });
    t.after(async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert(address && typeof address !== 'string');
    const browser = createBrowserBridge({
      url: `ws://127.0.0.1:${address.port}/ws`,
      storage: { getItem: () => null, setItem() {} },
    });
    const first = await browser.invoke({ type: 'snapshot' });
    assert.equal(first.ok, false);
    let received = '';
    let resolveDelta: (() => void) | undefined;
    const deltaReceived = new Promise<void>((resolve) => {
      resolveDelta = resolve;
    });
    browser.subscribeDelta((delta) => {
      received += delta.text;
      resolveDelta?.();
    });
    const replies = await Promise.all([
      browser.invoke({ type: 'snapshot' }),
      browser.invoke({ type: 'snapshot' }),
    ]);
    assert(replies.every((reply) => reply.ok));
    await deltaReceived;
    assert.equal(received, 'resumed');
    assert.equal(connections, 2);
  },
);

test(
  'reconnecting during a close handshake settles the old request without rejecting the new one',
  { timeout: 10_000 },
  async (t) => {
    const clients = new Set<WebSocket>();
    const nativeSend = WebSocket.prototype.send;
    t.mock.method(
      WebSocket.prototype,
      'send',
      function (this: WebSocket, data: Parameters<WebSocket['send']>[0]) {
        clients.add(this);
        nativeSend.call(this, data);
      },
    );
    const server = createServer();
    const peers = new Set<Socket>();
    let oldPeer: Socket | undefined;
    let connections = 0;
    server.on('upgrade', (request, socket: Socket) => {
      const first = ++connections === 1;
      if (first) oldPeer = socket;
      peers.add(socket);
      socket.on('close', () => peers.delete(socket));
      socket.on('error', () => {});
      socket.write(
        `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptKey(String(request.headers['sec-websocket-key']))}\r\n\r\n`,
      );
      const decoder = new FrameDecoder();
      const assembler = new MessageAssembler();
      socket.on('data', (bytes: Buffer) => {
        for (const frame of decoder.push(bytes))
          for (const message of assembler.push(frame)) {
            if (message.kind !== 'text') continue;
            const body = JSON.parse(message.text) as { id: number };
            if (first) socket.write(encodeClose(1000, 'closing'));
            else
              socket.write(
                encodeText(JSON.stringify({ kind: 'reply', id: body.id, ok: true, value: {} })),
              );
          }
      });
    });
    t.after(async () => {
      for (const peer of peers) peer.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert(address && typeof address !== 'string');
    const browser = createBrowserBridge({
      url: `ws://127.0.0.1:${address.port}/ws`,
      storage: { getItem: () => null, setItem() {} },
    });
    let oldSettled = false;
    const oldRequest = browser.invoke({ type: 'snapshot' }).then((reply) => {
      oldSettled = true;
      return reply;
    });
    const deadline = Date.now() + 3000;
    while (
      (!clients.size || [...clients][0]!.readyState !== WebSocket.CLOSING) &&
      Date.now() < deadline
    )
      await new Promise((resolve) => setTimeout(resolve, 10));
    const oldClient = [...clients][0];
    assert(oldClient && oldPeer);
    assert.equal(oldClient.readyState, WebSocket.CLOSING);
    const newReply = await browser.invoke({ type: 'snapshot' });
    assert.equal(newReply.ok, true);
    oldPeer.destroy();
    while (Number(oldClient.readyState) !== WebSocket.CLOSED && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(oldClient.readyState, WebSocket.CLOSED);
    assert.equal(oldSettled, true, 'the closed connection must not leave its request pending');
    assert.equal((await oldRequest).ok, false);
  },
);
