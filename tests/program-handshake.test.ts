import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import * as program from '../packages/tools/code-process.ts';

async function peer(t: test.TestContext, output: string, stay = true) {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-handshake-'));
  const marker = path.join(root, 'started.json');
  const child = spawn(
    process.execPath,
    [
      '-e',
      `
    const fs = require('node:fs');
    process.stdin.on('data', chunk => fs.writeFileSync(${JSON.stringify(marker)}, chunk));
    process.stdout.write(${JSON.stringify(output)});
    ${stay ? '' : 'process.exit(0);'}
  `,
    ],
    { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
  );
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    },
  );
  void closed.catch(() => {});
  let stops = 0;
  const running = {
    child,
    closed,
    async stop() {
      stops++;
      child.kill();
      await closed;
    },
  };
  t.after(async () => {
    child.kill();
    await closed;
    await rm(root, { recursive: true, force: true });
  });
  return { running, marker, stops: () => stops };
}

const data = { code: 'return 42;', names: [] };
const ready = JSON.stringify({ type: 'ready', protocol: 1, nodeMajor: 24 }) + '\n';

function memoryPeer(t: test.TestContext, output: string) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = { stdin, stdout, stderr, pid: undefined };
  let finish!: () => void;
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    finish = () => resolve({ code: 0, signal: null });
  });
  let sent = '';
  stdin.on('data', (chunk) => {
    sent += String(chunk);
  });
  const running = {
    child,
    closed,
    async stop() {
      finish();
    },
  };
  t.after(running.stop);
  setImmediate(() => stdout.write(output));
  return { running, sent: () => sent };
}

for (const partial of [
  '{"type":"ready","protocol":1,"nodeMajor":24}',
  '{"type":"call","id":1,"name":"read_file","args":{}}',
])
  test(
    'partial second frame cannot bypass handshake before script transmission: ' + partial,
    async (t) => {
      const p = memoryPeer(t, ready + partial);
      await assert.rejects(
        program.connectCodeProcess(data, p.running, new AbortController().signal),
        /before script start/,
      );
      assert.equal(p.sent(), '');
    },
  );

test('oversized initial script frame rejects the connection instead of losing the error', async (t) => {
  const p = memoryPeer(t, ready);
  await assert.rejects(
    program.connectCodeProcess(
      { ...data, code: '\0'.repeat(200000) },
      p.running,
      new AbortController().signal,
    ),
    /input limit/,
  );
  assert.equal(p.sent(), '');
});

test('initial stdin write failure rejects startup and waits for cleanup', async (t) => {
  const p = memoryPeer(t, ready);
  const stdin = new Writable({
    write(_chunk, _encoding, callback) {
      callback(new Error('fixture stdin failure'));
    },
  });
  Object.assign(p.running.child, { stdin });
  await assert.rejects(
    program.connectCodeProcess(data, p.running, new AbortController().signal),
    /fixture stdin failure/,
  );
});

test('failed startup cleanup preserves the cleanup-error contract and both causes', async (t) => {
  const p = memoryPeer(t, '{broken}\n');
  p.running.stop = async () => {
    throw new Error('fixture cleanup failure');
  };
  await assert.rejects(
    program.connectCodeProcess(data, p.running, new AbortController().signal),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.name, 'ToolCleanupError');
      assert.equal(error.errors.length, 2);
      assert.match(String(error.errors[1]), /fixture cleanup failure/);
      return true;
    },
  );
});

test('cancellation interrupts a pending initial write', async (t) => {
  const p = memoryPeer(t, ready);
  Object.assign(p.running.child, {
    stdin: new Writable({
      write() {
        /* fixture deliberately never acknowledges */
      },
    }),
  });
  const controller = new AbortController();
  const connecting = program.connectCodeProcess(data, p.running, controller.signal);
  setTimeout(() => controller.abort(new Error('cancel initial write')), 30);
  await assert.rejects(connecting, /cancel initial write/);
});

test(
  'an immediate result during the initial write is retained until caller subscription',
  { timeout: 2000 },
  async (t) => {
    const p = memoryPeer(t, ready);
    p.running.child.stdin!.on('data', () =>
      p.running.child.stdout!.emit(
        'data',
        Buffer.from('{"type":"result","value":"42","logs":[]}\n'),
      ),
    );
    const channel = await program.connectCodeProcess(data, p.running, new AbortController().signal);
    const message = await new Promise<{ value: string }>((resolve, reject) => {
      channel.once('message', resolve);
      channel.once('error', reject);
    });
    assert.equal(message.value, '42');
    await channel.terminate();
  },
);

test('termination before deferred delivery discards buffered tool calls', async (t) => {
  const p = memoryPeer(t, ready);
  p.running.child.stdin.on('data', () =>
    p.running.child.stdout.emit(
      'data',
      Buffer.from('{"type":"call","id":1,"name":"read_file","args":{}}\n'),
    ),
  );
  const channel = await program.connectCodeProcess(
    { ...data, names: ['read_file'] },
    p.running,
    new AbortController().signal,
  );
  let calls = 0;
  channel.on('message', () => calls++);
  await channel.terminate();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(calls, 0);
});

test('runner readiness validates protocol and minimum Node version', () => {
  program.validateCodeReady({ type: 'ready', protocol: 1, nodeMajor: 24 });
  program.validateCodeReady({ type: 'ready', protocol: 1, nodeMajor: 25 });
  for (const value of [
    null,
    [],
    { type: 'ready', protocol: 2, nodeMajor: 24 },
    { type: 'ready', protocol: 1, nodeMajor: 23 },
    { type: 'ready', protocol: 1, nodeMajor: '24' },
  ])
    assert.throws(() => program.validateCodeReady(value), /runner handshake/);
});

for (const [name, output] of [
  ['old protocol', JSON.stringify({ type: 'ready', protocol: 0, nodeMajor: 24 }) + '\n'],
  ['RPC before ready', JSON.stringify({ type: 'call', id: 1, name: 'read_file', args: {} }) + '\n'],
  ['duplicate ready', ready + ready],
  ['malformed frame', '{broken}\n'],
] as const)
  test(`${name} refuses script transmission and waits for process exit`, async (t) => {
    const p = await peer(t, output);
    await assert.rejects(program.connectCodeProcess(data, p.running, new AbortController().signal));
    await assert.rejects(readFile(p.marker), /ENOENT/);
    assert.equal(p.stops(), 1);
    assert.notEqual(p.running.child.exitCode ?? p.running.child.signalCode, null);
  });

test('startup disconnect has an unknown-result error and no transmitted script', async (t) => {
  const p = await peer(t, '', false);
  await assert.rejects(
    program.connectCodeProcess(data, p.running, new AbortController().signal),
    /disconnected.*unknown/,
  );
  await assert.rejects(readFile(p.marker), /ENOENT/);
});

test('cancellation during a silent handshake stops the process before returning', async (t) => {
  const p = await peer(t, '');
  const controller = new AbortController();
  const connecting = program.connectCodeProcess(data, p.running, controller.signal);
  setTimeout(() => controller.abort(new Error('cancel handshake')), 50);
  await assert.rejects(connecting, /cancel handshake/);
  await assert.rejects(readFile(p.marker), /ENOENT/);
  assert.equal(p.stops(), 1);
});

test('a silent handshake times out and stops without transmitting the script', async (t) => {
  const p = await peer(t, '');
  await assert.rejects(
    program.connectCodeProcess(data, p.running, new AbortController().signal),
    /handshake timed out/,
  );
  await assert.rejects(readFile(p.marker), /ENOENT/);
  assert.equal(p.stops(), 1);
});
