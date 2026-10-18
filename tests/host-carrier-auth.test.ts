import test from 'node:test';
import assert from 'node:assert/strict';
import { HostCarrier } from '../apps/agent-host/carrier.ts';
import { createServer, type Socket } from 'node:net';
import { StringDecoder } from 'node:string_decoder';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { listeningHost, connectClient, connectSocket } from './listening-host-fixture.ts';
import { MAX_INPUT_BYTES } from '../packages/protocol/images.ts';
import { AgentHostClient } from '../packages/client/host-client.ts';
import { socketTransport } from '../packages/client/host-transport.ts';
import { environmentProblems, isCredentialSetting } from '../packages/protocol/settings.ts';
import { toolEnvironment } from '../packages/tools/environment.ts';
import { tempRoot } from './temp-fixture.ts';

function repliesFrom(
  socket: Socket,
  count: number,
  timeout = 2000,
): Promise<Record<string, unknown>[]> {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const decoder = new StringDecoder('utf8');
    const replies: Record<string, unknown>[] = [];
    const timer = setTimeout(() => finish(new Error('No carrier reply before deadline')), timeout);
    const finish = (error?: Error) => {
      clearTimeout(timer);
      socket.off('data', data);
      socket.off('error', errorEvent);
      socket.off('close', closed);
      if (error) reject(error);
      else resolve(replies);
    };
    const errorEvent = (error: Error) => finish(error);
    const closed = () => finish(new Error('Carrier closed without a reply'));
    const data = (chunk: Buffer) => {
      buffer += decoder.write(chunk);
      let end: number;
      while ((end = buffer.indexOf('\n')) >= 0) {
        try {
          replies.push(JSON.parse(buffer.slice(0, end)));
        } catch (error) {
          finish(error as Error);
          return;
        }
        buffer = buffer.slice(end + 1);
        if (replies.length === count) {
          finish();
          return;
        }
      }
    };
    socket.on('data', data);
    socket.once('error', errorEvent);
    socket.once('close', closed);
  });
}

const replyFrom = (socket: Socket, timeout?: number) =>
  repliesFrom(socket, 1, timeout).then((replies) => replies[0]!);

for (const supplied of ['missing', 'wrong', 'wrong-first-method'] as const) {
  test(`unauthenticated TCP requests cannot create a session (${supplied})`, async (t) => {
    const host = await listeningHost(t, {});
    const socket = await connectSocket(host.port);
    t.after(() => socket.destroy());
    const reply = replyFrom(socket);
    socket.write(
      JSON.stringify({
        id: 'untrusted',
        method: supplied === 'wrong' ? 'host.info' : 'session.create',
        params: {
          ...(supplied === 'wrong' ? { authToken: 'wrong'.repeat(8) } : {}),
          ...(supplied === 'wrong-first-method' ? { authToken: host.authToken } : {}),
        },
      }) + '\n',
    );
    const refused = await reply;
    assert.equal((refused.error as { code?: string })?.code, 'UNAUTHORIZED');
    assert.equal(refused.id, null);
    assert.ok(!JSON.stringify(refused).includes(host.authToken));
    const db = new DatabaseSync(host.dbPath, { readOnly: true });
    try {
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sessions').get()!.n, 0);
    } finally {
      db.close();
    }
    const { client } = await connectClient(host);
    t.after(() => client.stop().catch(() => {}));
    assert.equal((await client.start()).runtime, 'yuantu');
    assert.ok((await client.request('session.create', {})).id);
  });
}

for (const token of [undefined, '', 'too-short', 'a'.repeat(513), `${'a'.repeat(32)} unsafe`]) {
  test(`TCP carrier refuses a missing or malformed credential (${token === undefined ? 'missing' : token.length})`, () => {
    assert.throws(
      () =>
        new HostCarrier({
          listen: '127.0.0.1:0',
          authToken: token,
          isClosing: () => false,
        }),
      /YUANTU_HOST_TOKEN/,
    );
  });
}

for (const host of ['0.0.0.0', '192.0.2.1', 'example.com']) {
  test(`TCP carrier refuses a non-loopback listener (${host})`, () => {
    assert.throws(
      () =>
        new HostCarrier({
          listen: `${host}:0`,
          authToken: 'fixture'.repeat(8),
          isClosing: () => false,
        }),
      /loopback/i,
    );
  });
}

test('stdio needs no TCP credential and does not inspect an unused one', () => {
  assert.doesNotThrow(() => new HostCarrier({ isClosing: () => false }));
});

test('an oversized unfinished authentication frame is refused without consuming the Host', async (t) => {
  const host = await listeningHost(t, {});
  const socket = await connectSocket(host.port);
  t.after(() => socket.destroy());
  const reply = replyFrom(socket);
  socket.write('x'.repeat(4097));
  assert.equal(((await reply).error as { code: string }).code, 'UNAUTHORIZED');
  const { client } = await connectClient(host);
  t.after(() => client.stop().catch(() => {}));
  assert.equal((await client.start()).runtime, 'yuantu');
});

test('an idle authentication attempt expires while another authenticated client can still attach', async (t) => {
  const host = await listeningHost(t, {});
  const socket = await connectSocket(host.port);
  t.after(() => socket.destroy());
  const expired = replyFrom(socket, 8000);
  const { client } = await connectClient(host);
  t.after(() => client.stop().catch(() => {}));
  await client.start();
  assert.equal(((await expired).error as { code: string }).code, 'UNAUTHORIZED');
  assert.equal((await client.request('host.info', {})).runtime, 'yuantu');
});

test('authentication and larger pipelined UTF-8 RPCs are delivered once without losing early frames', async (t) => {
  const host = await listeningHost(t, {});
  const socket = await connectSocket(host.port);
  t.after(() => socket.destroy());
  const replies = repliesFrom(socket, 3);
  const packet = [
    { id: '握手🙂', method: 'host.info', params: { authToken: host.authToken } },
    { id: 'created', method: 'session.create', params: {} },
    { id: 'large', method: 'host.info', params: { padding: '中文🙂'.repeat(1500) } },
  ]
    .map((request) => JSON.stringify(request) + '\n')
    .join('');
  const bytes = Buffer.from(packet);
  // Split one of the handshake id's UTF-8 characters across writes.
  const split = bytes.indexOf(Buffer.from('握')) + 1;
  socket.write(bytes.subarray(0, split));
  socket.write(bytes.subarray(split));
  const received = await replies;
  assert.deepEqual(received.map((reply) => reply.id).sort(), ['created', 'large', '握手🙂'].sort());
  assert.equal(
    (received.find((reply) => reply.id === 'large')!.result as { runtime: string }).runtime,
    'yuantu',
  );
  assert.ok((received.find((reply) => reply.id === 'created')!.result as { id: string }).id);
});

test('an authenticated oversized frame is rejected before JSON parsing even without a newline', async (t) => {
  const host = await listeningHost(t, {});
  const { client, socket } = await connectClient(host);
  t.after(() => client.stop().catch(() => {}));
  await client.start();
  const reply = replyFrom(socket);
  socket.write(Buffer.alloc(MAX_INPUT_BYTES + 1, 120));
  assert.equal(((await reply).error as { code: string }).code, 'FRAME_TOO_LARGE');
});

test('resetting refused peers never crashes the Host or takes the authenticated connection', async (t) => {
  const host = await listeningHost(t, {});
  const { client } = await connectClient(host);
  t.after(() => client.stop().catch(() => {}));
  await client.start();
  for (let index = 0; index < 8; index++) {
    const refused = await connectSocket(host.port);
    refused.on('error', () => {});
    refused.resetAndDestroy();
  }
  assert.deepEqual(await client.request('session.list', {}), []);
  assert.equal((await client.request('host.info', {})).runtime, 'yuantu');
});

test('the number of idle authentication connections is bounded', async (t) => {
  const host = await listeningHost(t, {});
  const pending: Socket[] = [];
  t.after(() => {
    for (const socket of pending) socket.destroy();
  });
  for (let index = 0; index < 8; index++) pending.push(await connectSocket(host.port));
  const extra = await connectSocket(host.port);
  t.after(() => extra.destroy());
  const reply = replyFrom(extra);
  assert.equal(((await reply).error as { code: string }).code, 'HOST_BUSY');
});

test('an already-pending peer cannot replace the carrier that authenticated first', async (t) => {
  const host = await listeningHost(t, {});
  const pending: Socket[] = [];
  t.after(() => {
    for (const socket of pending) socket.destroy();
  });
  for (let index = 0; index < 8; index++) pending.push(await connectSocket(host.port));
  const extra = await connectSocket(host.port);
  t.after(() => extra.destroy());
  // The cap response proves all eight are in the Host's pending set before either authenticates.
  const busy = replyFrom(extra);
  assert.equal(((await busy).error as { code: string }).code, 'HOST_BUSY');
  const owner = pending[0]!;
  const first = replyFrom(owner);
  owner.write(
    JSON.stringify({ id: 'first', method: 'host.info', params: { authToken: host.authToken } }) +
      '\n',
  );
  assert.equal((await first).id, 'first');
  const contender = pending[1]!;
  const refused = replyFrom(contender);
  contender.write(
    JSON.stringify({ id: 'second', method: 'host.info', params: { authToken: host.authToken } }) +
      '\n',
  );
  assert.equal(((await refused).error as { code?: string })?.code, 'HOST_BUSY');
  const ownReply = replyFrom(owner);
  owner.write(JSON.stringify({ id: 'still-owned', method: 'session.create', params: {} }) + '\n');
  assert.equal((await ownReply).id, 'still-owned');
});

test('closing a carrier while it awaits authentication releases attach and its listening server', async () => {
  let closing = false;
  const carrier = new HostCarrier({
    listen: '127.0.0.1:0',
    authToken: 'fixture'.repeat(8),
    isClosing: () => closing,
  });
  const attaching = carrier.attach();
  await new Promise<void>((resolve) => setImmediate(resolve));
  closing = true;
  carrier.close();
  let timer: NodeJS.Timeout | undefined;
  try {
    const input = await Promise.race([
      attaching,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('attach did not settle after close')), 1000);
      }),
    ]);
    let delivered = 0;
    for await (const _line of input) delivered++;
    assert.equal(delivered, 0);
    assert.equal(carrier.connected, false);
  } finally {
    clearTimeout(timer);
    carrier.close();
  }
});

test('a client redacts its explicit TCP credential from an untrusted peer error', async (t) => {
  const authToken = randomBytes(32).toString('hex');
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.once('data', () =>
      socket.end(JSON.stringify({ id: null, error: { message: `Refused ${authToken}` } }) + '\n'),
    );
    socket.once('close', () => sockets.delete(socket));
  });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const socket = await connectSocket(port);
  const client = new AgentHostClient({ transport: socketTransport(socket), authToken, env: {} });
  t.after(() => client.stop().catch(() => {}));
  await assert.rejects(client.start(), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.ok(
      !error.message.includes(authToken),
      'a peer cannot echo a configured credential into a client diagnostic',
    );
    assert.match(error.message, /\[redacted\]/);
    return true;
  });
});

for (const configuration of ['missing-token', 'malformed-token', 'non-loopback'] as const) {
  test(`the Host rejects ${configuration} before opening its database`, async (t) => {
    const root = await tempRoot(t, 'yuantu-host-auth-startup-');
    const db = path.join(root, 'must-not-open.sqlite');
    const credential =
      configuration === 'missing-token'
        ? ''
        : configuration === 'malformed-token'
          ? 'fixture-private invalid token'
          : randomBytes(32).toString('hex');
    const child = spawnSync(
      process.execPath,
      [
        path.resolve('apps/agent-host/main.ts'),
        '--workspace',
        root,
        '--db',
        db,
        '--listen',
        configuration === 'non-loopback' ? '0.0.0.0:0' : '127.0.0.1:0',
      ],
      {
        cwd: root,
        env: { ...process.env, YUANTU_HOST_TOKEN: credential },
        encoding: 'utf8',
        // This bounds cold Host startup; rejection semantics below remain mandatory.
        timeout: 20000,
        windowsHide: true,
      },
    );
    assert.equal(child.error, undefined);
    assert.notEqual(child.status, 0);
    assert.match(child.stderr, /YUANTU_HOST_TOKEN|loopback/);
    if (credential) assert.ok(!child.stderr.includes(credential));
    assert.doesNotMatch(child.stdout, /listening on/);
    await assert.rejects(access(db));
  });
}

test('TCP credentials are registered secrets, excluded from guest environments and never echoed in validation', () => {
  const credential = 'private invalid fixture credential';
  assert.equal(isCredentialSetting('YUANTU_HOST_TOKEN'), true);
  assert.equal(toolEnvironment({ YUANTU_HOST_TOKEN: credential }).YUANTU_HOST_TOKEN, undefined);
  const problems = environmentProblems({ YUANTU_HOST_TOKEN: credential });
  assert.equal(problems.length, 1);
  assert.ok(!JSON.stringify(problems).includes(credential));
});
