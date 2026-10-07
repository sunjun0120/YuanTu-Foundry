import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AgentHostClient, HostDisconnectedError } from '../packages/client/host-client.ts';
import { lineFramer, socketTransport } from '../packages/client/host-transport.ts';
import { SessionStore } from '../packages/storage/sqlite.ts';
import { frames, httpFixture, sendFrames } from './http-fixture.ts';
import { connectClient, listeningHost } from './listening-host-fixture.ts';

// ---- a carrier that cannot spawn a process ----
//
// The client was "spawn a child and pipe JSONL through its stdio", which welded process supervision, byte
// framing and the request protocol into one thing. A browser can do none of the first two: it cannot spawn a
// process, and the Host it needs to reach is already running somewhere. These tests pin the split — the same
// client class, the same protocol version, the same framing, over a link somebody else opened — and the Host's
// side of it (`--listen`), including what it refuses.

const hostPath = path.resolve('apps/agent-host/main.ts');

test('a client with no process of its own drives a Host over a socket', async (t) => {
  const url = await httpFixture(t, (_, res) => sendFrames(res, frames('ready')));
  const host = await listeningHost(t, { YUANTU_BASE_URL: url });
  const { client } = await connectClient(host.port);
  t.after(() => client.stop().catch(() => {}));
  const info = await client.start();
  assert.equal(info.runtime, 'yuantu');
  assert.equal(info.protocolVersion, 1);
  assert.equal(info.workspace, host.root);
  // No child process to name: the pid belongs to whoever started the Host, not to this client.
  assert.equal(client.pid, undefined);
  const session = await client.request('session.create', {});
  assert.ok(session.id);
  const sessions = await client.request('session.list', {});
  assert.deepEqual(
    sessions.map((entry) => entry.id),
    [session.id],
  );
  const result = await client.run(session.id, 'Say ready');
  assert.equal(result.status, 'completed', result.error);
  assert.equal(result.text, 'ready');
});

test('live events reach a socket carrier the same way they reach stdio', async (t) => {
  const url = await httpFixture(t, (_, res) => sendFrames(res, frames('done')));
  const host = await listeningHost(t, { YUANTU_BASE_URL: url });
  const { client } = await connectClient(host.port);
  t.after(() => client.stop().catch(() => {}));
  await client.start();
  const seen: string[] = [];
  const off = client.subscribe((event) => seen.push(event.type));
  t.after(off);
  const session = await client.request('session.create', {});
  await client.run(session.id, 'Do it');
  assert.ok(seen.includes('run.started'), seen.join(','));
  assert.ok(seen.includes('message.finished'), seen.join(','));
  assert.ok(seen.includes('run.finished'), seen.join(','));
});

test('a second carrier is refused rather than sharing one Host', async (t) => {
  const host = await listeningHost(t, {});
  const { client } = await connectClient(host.port);
  t.after(() => client.stop().catch(() => {}));
  await client.start();
  // The Host holds the approvals, the active runs and the workspace lock for the sessions it serves, so a
  // second client is told the truth about that instead of quietly sharing them.
  const second = connect({ host: '127.0.0.1', port: host.port });
  const refusal = await new Promise<string>((resolve) => {
    let buffer = '';
    second.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      if (buffer.includes('\n')) resolve(buffer);
    });
    second.once('close', () => resolve(buffer));
  });
  second.destroy();
  assert.match(refusal, /already has a connected client/);
  // A client that insists anyway settles with the Host's own words rather than a parse error.
  const socket = connect({ host: '127.0.0.1', port: host.port });
  await new Promise<void>((resolve) => socket.once('connect', () => resolve()));
  const rejected = new AgentHostClient({ transport: socketTransport(socket), env: {} });
  await assert.rejects(rejected.start(), /already has a connected client/);
});

test('a large reply is framed on a socket exactly as it is on stdio', async (t) => {
  const url = await httpFixture(t, (_, res) => sendFrames(res, frames('ok')));
  // The transcript is seeded before the Host starts, because the Host owns the database once it is up.
  const seeded: string[] = [];
  const host = await listeningHost(t, { YUANTU_BASE_URL: url }, (dbPath) => {
    const store = new SessionStore(dbPath);
    try {
      const session = store.create(path.dirname(dbPath));
      seeded.push(session.id);
      // ~8 KB per message: the reply is one JSONL line of well over a megabyte, with multi-byte characters on
      // both sides of the 64 KB boundaries the reader sees. A wrong framer shows up as mojibake or a truncated
      // frame rather than as a missing entry.
      const body = ('中文🙂' + 'x'.repeat(4000)).repeat(2);
      for (let index = 0; index < 200; index++)
        store.append(session.id, { role: 'user', content: `${index}: ${body}` });
    } finally {
      store.close();
    }
  });
  const { client } = await connectClient(host.port);
  t.after(() => client.stop().catch(() => {}));
  await client.start();
  // No offset means the whole history: one reply, one JSONL line, and a carrier that framed it wrongly would
  // truncate it or turn its multi-byte characters into mojibake rather than lose an entry.
  const page = await client.request('session.get', { sessionId: seeded[0]! });
  assert.equal(page.messages.length, 200);
  const serialized = JSON.stringify(page);
  assert.ok(serialized.length > 1_000_000, `the reply really was large: ${serialized.length}`);
  assert.match(serialized, /中文🙂/);
  assert.match(serialized, /199: /);
});

test('a carrier that disappears settles pending work as a disconnection', async (t) => {
  const host = await listeningHost(t, {});
  const { client, socket } = await connectClient(host.port);
  await client.start();
  const pending = client.request('session.list', {});
  socket.destroy();
  await assert.rejects(pending, (error: unknown) => {
    assert.ok(error instanceof HostDisconnectedError, String(error));
    return true;
  });
  assert.equal(client.status, 'failed');
  assert.equal(client.recoverable, false, 'a socket client has no process to restart');
});

test('stopping a socket carrier stops the Host with it', async (t) => {
  const host = await listeningHost(t, {});
  const { client } = await connectClient(host.port);
  await client.start();
  const exited = new Promise<number | null>((resolve) =>
    host.child.once('exit', (code) => resolve(code)),
  );
  await client.stop();
  assert.equal(client.status, 'stopped');
  // A Host is owned by the carrier that attached to it: the connection ending is the same event as stdin
  // EOF, so the process is expected to go away on its own rather than linger unowned.
  assert.equal(await exited, 0);
});

test('a Host that only listens is a real Host: the same dispatch answers on it', async (t) => {
  const host = await listeningHost(t, {});
  const { client } = await connectClient(host.port);
  t.after(() => client.stop().catch(() => {}));
  await client.start();
  const invariants = await client.request('invariants.list', {});
  assert.ok(invariants.invariants.length > 0, 'the process registered its invariants');
  await assert.rejects(client.request('session.rename', { sessionId: 'nope', title: 'x' }));
});

test('the Host refuses an address it cannot parse before it serves anything', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-carrier-bad-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const child = spawn(process.execPath, [hostPath, '--workspace', root, '--listen', 'not-a-port'], {
    cwd: root,
    env: { ...process.env, YUANTU_WORKFLOWS: 'false' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr!.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
  const code = await new Promise<number | null>((resolve) =>
    child.once('exit', (value) => resolve(value)),
  );
  assert.notEqual(code, 0);
  assert.match(stderr, /--listen must be \[host:\]port/);
});

test('the framing helper is shared, bounded, and survives split characters', async () => {
  const lines: string[] = [];
  const errors: Error[] = [];
  const framer = lineFramer({
    maxFrameBytes: 1024,
    onLine: (line) => lines.push(line),
    onError: (error) => errors.push(error),
  });
  const payload = Buffer.from('{"a":"中文🙂"}\n{"b":2}\n');
  // One byte at a time: every multi-byte character is split across chunks at some point.
  for (const byte of payload) framer.write(Buffer.from([byte]));
  assert.deepEqual(lines, ['{"a":"中文🙂"}', '{"b":2}']);
  assert.deepEqual(errors, []);
  // The bound is per frame rather than per chunk, and one violation ends the link: the old inline scanner
  // called `fail()` on the first oversized frame, which stopped reading, so later writes report nothing.
  const bounded: Error[] = [];
  const big = lineFramer({
    maxFrameBytes: 16,
    onLine: () => assert.fail('an oversized frame must not be delivered'),
    onError: (error) => bounded.push(error),
  });
  big.write(Buffer.from('x'.repeat(64) + '\n'));
  big.write(Buffer.from('y'.repeat(64) + '\n'));
  assert.equal(bounded.length, 1);
  assert.match(bounded[0]!.message, /exceeds frame limit/);
});
