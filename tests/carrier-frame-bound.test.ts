import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import { HostCarrier } from '../apps/agent-host/carrier.ts';
import { MAX_INPUT_BYTES } from '../packages/protocol/images.ts';

/**
 * The framing bound on the stdio carrier, which is the carrier the desktop actually uses.
 *
 * `createInterface({ input: process.stdin })` assembles a line with no upper bound, so a peer that never writes a
 * newline grows the Host's heap for as long as it keeps writing; the size gate in `dispatch.ts` runs only once the
 * whole line exists. The socket path has gone through `lineFramer` since the authentication work — this is the
 * same bound on a pipe, and the two cases below are its shape: an unterminated frame ends the carrier, and an
 * ordinary line still arrives.
 */
function carrierWith(input: PassThrough): HostCarrier {
  return new HostCarrier({ isClosing: () => false, stdioInput: input });
}

for (const [highWaterMark, decodeStrings] of [
  [1, true],
  [128_000_000, true],
  [128_000_000, false],
] as const)
  test(`blocked output refuses the overflowing frame and every later reply (watermark ${highWaterMark})`, async (t) => {
    const output = new Writable({ highWaterMark, decodeStrings, write() {} });
    const carrier = new HostCarrier({
      isClosing: () => false,
      stdioInput: new PassThrough(),
      stdioOutput: output,
    });
    t.after(() => {
      carrier.close();
      output.destroy();
    });
    await carrier.attach();
    const reply = { text: decodeStrings ? 'x'.repeat(16_000_000) : '你'.repeat(5_333_333) };
    for (let i = 0; i < 7; i++) carrier.send(reply);
    assert.equal(carrier.connected, false);
    assert.ok(output.writableLength <= 64_000_000, `queued ${output.writableLength} bytes`);
    const queued = output.writableLength;
    output.emit('drain');
    carrier.send({ result: 'still closed' });
    assert.equal(output.writableLength, queued, 'drain cannot reopen a hard-dropped carrier');
  });

test('buffered writes below an ordinary high water mark count toward the ceiling', async (t) => {
  const output = new Writable({ highWaterMark: 65_536, write() {} });
  const carrier = new HostCarrier({
    isClosing: () => false,
    stdioInput: new PassThrough(),
    stdioOutput: output,
  });
  t.after(() => {
    carrier.close();
    output.destroy();
  });
  await carrier.attach();
  carrier.send({ text: 'x'.repeat(60_000) });
  const queued = output.writableLength;
  carrier.send({ text: 'x'.repeat(63_999_988) });
  assert.equal(carrier.connected, false);
  assert.equal(
    output.writableLength,
    queued,
    'a valid large frame cannot exceed the remaining queue budget',
  );
});

test('ordinary close still delivers the final cancellation reply', async (t) => {
  const output = new PassThrough();
  const carrier = new HostCarrier({
    isClosing: () => true,
    stdioInput: new PassThrough(),
    stdioOutput: output,
  });
  t.after(() => {
    carrier.close();
    output.destroy();
  });
  await carrier.attach();
  carrier.close();
  const reply = { id: 'cancelled-run', result: { status: 'cancelled' } };
  carrier.send(reply);
  assert.equal(output.read().toString(), JSON.stringify(reply) + '\n');
});

test('a slow reader that drains receives a fresh output budget', async (t) => {
  let release: (() => void) | undefined;
  const output = new Writable({
    highWaterMark: 1,
    write(_chunk, _encoding, callback) {
      release = callback;
    },
  });
  const carrier = new HostCarrier({
    isClosing: () => false,
    stdioInput: new PassThrough(),
    stdioOutput: output,
  });
  t.after(() => {
    carrier.close();
    output.destroy();
  });
  await carrier.attach();
  const reply = { text: 'x'.repeat(16_000_000) };
  for (let i = 0; i < 3; i++) carrier.send(reply);
  while (output.writableLength) {
    assert.ok(release);
    release();
    await new Promise((resolve) => setImmediate(resolve));
  }
  for (let i = 0; i < 2; i++) carrier.send(reply);
  assert.equal(
    carrier.connected,
    true,
    'bytes sent before the drain do not consume the new budget',
  );
  assert.equal(output.writableLength, 2 * Buffer.byteLength(JSON.stringify(reply) + '\n'));
});

test('a reader can replenish a partially drained queue without being disconnected', async (t) => {
  let release: (() => void) | undefined;
  const output = new Writable({
    highWaterMark: 65_536,
    decodeStrings: false,
    write(_chunk, _encoding, callback) {
      release = callback;
    },
  });
  const carrier = new HostCarrier({
    isClosing: () => false,
    stdioInput: new PassThrough(),
    stdioOutput: output,
  });
  t.after(() => {
    carrier.close();
    output.destroy();
  });
  await carrier.attach();
  const reply = { text: '你'.repeat(5_333_333) };
  for (let i = 0; i < 3; i++) carrier.send(reply);
  for (let i = 0; i < 5; i++) {
    assert.ok(release);
    release();
    await new Promise((resolve) => setImmediate(resolve));
    carrier.send(reply);
    assert.equal(carrier.connected, true, 'a partially drained live queue remains usable');
    assert.ok(output.writableLength < 64_000_000);
  }
});

test('a stdio carrier refuses an unterminated frame instead of buffering it without bound', async (t) => {
  const input = new PassThrough();
  const carrier = carrierWith(input);
  t.after(() => carrier.close());
  const iterator = (await carrier.attach())[Symbol.asyncIterator]();
  const megabyte = Buffer.alloc(1_000_000, 0x61);
  // More than the frame ceiling, and not one newline in it: this is what a peer that never frames a request sends.
  for (let sent = 0; sent < Math.ceil(MAX_INPUT_BYTES / megabyte.length) + 2; sent++) {
    if (input.destroyed) break;
    input.write(megabyte);
    await new Promise((resolve) => setImmediate(resolve));
  }
  const ended = await Promise.race([
    iterator.next().then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 2000)),
  ]);
  assert.equal(ended, true, 'the read loop ends when the frame bound is crossed');
  assert.equal(
    carrier.connected,
    false,
    'the carrier is closed rather than kept alive for a peer that never framed a request',
  );
});

test('an ordinary line still reaches the serve loop through the same framing', async (t) => {
  const input = new PassThrough();
  const carrier = carrierWith(input);
  t.after(() => carrier.close());
  const iterator = (await carrier.attach())[Symbol.asyncIterator]();
  const line = JSON.stringify({ id: 'one', method: 'host.info', params: {} });
  input.write(Buffer.from(line + '\n', 'utf8'));
  const first = await iterator.next();
  assert.equal(first.done, false);
  assert.equal(first.value, line);
  // A second frame, split across two chunks, must be reassembled rather than replaced.
  const second = JSON.stringify({ id: 'two', method: 'session.list', params: {} });
  input.write(Buffer.from(second.slice(0, 10), 'utf8'));
  input.write(Buffer.from(second.slice(10) + '\n', 'utf8'));
  const next = await iterator.next();
  assert.equal(next.value, second);
  assert.equal(carrier.connected, true, 'a framed request does not close the carrier');
});
