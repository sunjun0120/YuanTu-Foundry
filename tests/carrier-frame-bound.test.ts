import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
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
