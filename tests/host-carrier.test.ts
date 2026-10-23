import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { connect, Socket } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AgentHostClient, HostDisconnectedError } from '../packages/client/host-client.ts';
import { lineFramer, socketTransport } from '../packages/client/host-transport.ts';
import { SessionStore } from '../packages/storage/sqlite.ts';
import { frames, httpFixture, sendFrames } from './http-fixture.ts';
import { connectClient, listeningHost } from './listening-host-fixture.ts';
import { tempRoot } from './temp-fixture.ts';

test('socket connection errors reach transport consumers and cannot look like clean exits', async () => {
  const socket = new Socket();
  const transport = socketTransport(socket);
  const failure = new Error('fixture ECONNRESET');
  const errors: Error[] = [];
  transport.onError((error) => errors.push(error));
  const closed = new Promise<{ code: number | null }>((resolve) => transport.onExit(resolve));
  socket.destroy(failure);
  assert.notEqual((await closed).code, 0);
  assert.deepEqual(errors, [failure]);
});

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
  const { client } = await connectClient(host);
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
  const { client } = await connectClient(host);
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
  const { client } = await connectClient(host);
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
  for (let attempt = 0; attempt < 10; attempt++) {
    const socket = connect({ host: '127.0.0.1', port: host.port });
    await new Promise<void>((resolve) => socket.once('connect', () => resolve()));
    const rejected = new AgentHostClient({ transport: socketTransport(socket), env: {} });
    await assert.rejects(rejected.start(), /already has a connected client/);
  }
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
  const { client } = await connectClient(host);
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
  const { client, socket } = await connectClient(host);
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
  const { client } = await connectClient(host);
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
  const { client } = await connectClient(host);
  t.after(() => client.stop().catch(() => {}));
  await client.start();
  const invariants = await client.request('invariants.list', {});
  assert.ok(invariants.invariants.length > 0, 'the process registered its invariants');
  const health = await client.request('host.health', {});
  assert.ok(health.eventLoop, 'the Host watches its event loop');
  assert.equal(health.activeRuns, 0);
  assert.ok(health.maxActiveRuns >= 1);
  await assert.rejects(client.request('session.rename', { sessionId: 'nope', title: 'x' }));
});

test('the Host refuses an address it cannot parse before it serves anything', async (t) => {
  const root = await tempRoot(t, 'yuantu-carrier-bad-');
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

test('the host-less address the parser accepts is one the carrier can actually bind', async (t) => {
  /**
   * `--listen` is documented as `[host:]port`, and the parser accepted `:8080` while the carrier re-derived
   * the port from the same string as `Number(':8080')` — `NaN` — which throws inside `listen()` and took the
   * Host down. An omitted host means loopback; the point of this case is that "accepted on the command line"
   * and "bindable" are now the same statement rather than two independently written ones.
   */
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-carrier-hostless-'));
  const child = spawn(process.execPath, [hostPath, '--workspace', root, '--listen', ':0'], {
    cwd: root,
    env: {
      ...process.env,
      YUANTU_WORKFLOWS: 'false',
      YUANTU_HOST_TOKEN: randomBytes(32).toString('hex'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => {
    // The directory cannot go until the process really has: on Windows a killed child still holds its cwd
    // briefly, and removing first fails with EBUSY rather than cleaning anything up. The liveness check comes
    // first because a Host that died of a bad port — the case this test exists for — has no exit left to wait
    // for, and waiting for one anyway hangs the teardown instead of reporting the failure.
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
      child.kill('SIGKILL');
      await exited;
    }
    await rm(root, { recursive: true, force: true });
  });
  let stdout = '';
  let stderr = '';
  child.stdout!.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
  child.stderr!.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
  for (let i = 0; i < 400 && !stdout.includes('listening on'); i++)
    await new Promise((resolve) => setTimeout(resolve, 25));
  // The chosen port is announced on stdout, so the line is the proof a socket was really bound — port 0 asks
  // the OS, and a `NaN` port dies before the callback ever runs.
  assert.match(stdout, /listening on 127\.0\.0\.1:\d+/, `stdout=${stdout} stderr=${stderr}`);
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

test('the framing helper delivers every line in a chunk, ignores blank lines, and reports a pending prefix', () => {
  const lines: string[] = [];
  const errors: Error[] = [];
  const framer = lineFramer({
    maxFrameBytes: 1024,
    onLine: (line) => lines.push(line),
    onError: (error) => errors.push(error),
  });
  // Several lines in one chunk, and the later ones are *shorter* than the first: taking a line out has to reset
  // where the next scan starts, or the following newline sits behind that position and is never found — the rest
  // of the chunk then rides along inside the next line instead of arriving as its own message.
  framer.write(Buffer.from('first\nx\ny\n'));
  assert.deepEqual(lines, ['first', 'x', 'y']);
  // A blank line separates messages; it is not one.
  framer.write(Buffer.from('\n\nfour\n'));
  assert.deepEqual(lines, ['first', 'x', 'y', 'four']);
  // Half a line is pending, and a caller can ask rather than guess.
  framer.write(Buffer.from('par'));
  assert.equal(framer.buffered(), true);
  assert.deepEqual(lines, ['first', 'x', 'y', 'four']);
  framer.write(Buffer.from('tial\n'));
  assert.equal(framer.buffered(), false);
  assert.deepEqual(lines, ['first', 'x', 'y', 'four', 'partial']);
  assert.deepEqual(errors, []);
  // The bound applies to what has not been framed yet as well: one peer that never sends a newline must not be
  // able to grow the pending buffer without limit.
  const unbounded: Error[] = [];
  const prefix = lineFramer({
    maxFrameBytes: 16,
    onLine: () => assert.fail('a prefix with no newline is not a line'),
    onError: (error) => unbounded.push(error),
  });
  prefix.write(Buffer.from('z'.repeat(64)));
  assert.equal(unbounded.length, 1);
  assert.match(unbounded[0]!.message, /exceeds frame limit/);
});
