import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { HostDisconnectedError } from '../packages/client/host-client.ts';
import { lineFramer } from '../packages/client/host-transport.ts';
import { SessionStore } from '../packages/storage/sqlite.ts';
import { frames, httpFixture, sendFrames } from './http-fixture.ts';
import { connectClient, startHost } from './host-process-fixture.ts';
import { tempRoot } from './temp-fixture.ts';

// ---- a carrier that did not start the Host ----
//
// The client was "spawn a child and pipe JSONL through its stdio", which welded process supervision, byte
// framing and the request protocol into one thing. These tests pin the split — the same client class, the same
// protocol version, the same framing, over a link to a Host somebody else started — and that stdio is the only
// carrier the Host serves.

const hostPath = path.resolve('apps/agent-host/main.ts');

test('the Host serves only stdio and refuses a listening address', async (t) => {
  const root = await tempRoot(t, 'yuantu-carrier-listen-');
  const child = spawn(
    process.execPath,
    [hostPath, '--workspace', root, '--listen', '127.0.0.1:0'],
    {
      cwd: root,
      env: { ...process.env, YUANTU_WORKFLOWS: 'false' },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let stderr = '';
  child.stderr!.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
  const code = await new Promise<number | null>((resolve) =>
    child.once('exit', (value) => resolve(value)),
  );
  assert.notEqual(code, 0);
  assert.match(stderr, /Unknown option: --listen/);
});

test('a client that did not start the Host drives it over the link it was handed', async (t) => {
  const url = await httpFixture(t, (_, res) => sendFrames(res, frames('ready')));
  const host = await startHost(t, { YUANTU_BASE_URL: url });
  const { client } = await connectClient(host);
  t.after(() => client.stop().catch(() => {}));
  const info = await client.start();
  assert.equal(info.runtime, 'yuantu');
  assert.equal(info.protocolVersion, 1);
  assert.equal(info.workspace, host.root);
  // The process belongs to whoever started it: this client reports its pid but will not restart it.
  assert.equal(client.pid, host.child.pid);
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

test('live events reach a carrier that did not start the Host', async (t) => {
  const url = await httpFixture(t, (_, res) => sendFrames(res, frames('done')));
  const host = await startHost(t, { YUANTU_BASE_URL: url });
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

test('a large reply is framed as one line without mojibake', async (t) => {
  const url = await httpFixture(t, (_, res) => sendFrames(res, frames('ok')));
  // The transcript is seeded before the Host starts, because the Host owns the database once it is up.
  const seeded: string[] = [];
  const host = await startHost(t, { YUANTU_BASE_URL: url }, (dbPath) => {
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

test('a Host that disappears settles pending work as a disconnection', async (t) => {
  const host = await startHost(t, {});
  const { client } = await connectClient(host);
  await client.start();
  const pending = client.request('session.list', {});
  host.child.kill('SIGKILL');
  await assert.rejects(pending, (error: unknown) => {
    assert.ok(error instanceof HostDisconnectedError, String(error));
    return true;
  });
  assert.equal(client.status, 'failed');
  assert.equal(
    client.recoverable,
    false,
    'a client that did not start the Host does not restart it',
  );
});

test('stopping the carrier stops the Host with it', async (t) => {
  const host = await startHost(t, {});
  const { client } = await connectClient(host);
  await client.start();
  const exited = new Promise<number | null>((resolve) =>
    host.child.once('exit', (code) => resolve(code)),
  );
  await client.stop();
  assert.equal(client.status, 'stopped');
  // A Host is owned by the carrier that attached to it: stdin EOF means the process goes away on its own rather
  // than lingering unowned.
  assert.equal(await exited, 0);
});

test('a Host started elsewhere is a real Host: the same dispatch answers on it', async (t) => {
  const host = await startHost(t, {});
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
