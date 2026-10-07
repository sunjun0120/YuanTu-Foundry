/**
 * The framing rules this bridge refuses to guess at.
 *
 * The handshake case is the standard's own example (`RFC 6455` §1.3), which is the one accept token every
 * implementation is expected to reproduce; the rest pin the properties a browser's own WebSocket client relies
 * on and the ones a hostile or broken client must be refused for. A real client is exercised by
 * `tests/web.smoke.mjs` — these cases are the ones a real client would only hit on a bad day.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  FrameDecoder,
  MessageAssembler,
  OPCODE,
  WebSocketProtocolError,
  acceptKey,
  encodeClose,
  encodeFrame,
  encodeText,
} from '../apps/web/websocket.ts';

/** A masked client frame, built the way a browser builds one. */
function clientFrame(
  opcode: number,
  payload: Buffer,
  options: { fin?: boolean; mask?: boolean } = {},
) {
  const fin = options.fin ?? true;
  const masked = options.mask ?? true;
  const mask = Buffer.from([0x37, 0xfa, 0x21, 0x3d]);
  const length = payload.length;
  const header =
    length < 126
      ? Buffer.from([(fin ? 0x80 : 0) | opcode, (masked ? 0x80 : 0) | length])
      : length < 65_536
        ? (() => {
            const head = Buffer.alloc(4);
            head[0] = (fin ? 0x80 : 0) | opcode;
            head[1] = (masked ? 0x80 : 0) | 126;
            head.writeUInt16BE(length, 2);
            return head;
          })()
        : (() => {
            const head = Buffer.alloc(10);
            head[0] = (fin ? 0x80 : 0) | opcode;
            head[1] = (masked ? 0x80 : 0) | 127;
            head.writeBigUInt64BE(BigInt(length), 2);
            return head;
          })();
  if (!masked) return Buffer.concat([header, payload]);
  const body = Buffer.allocUnsafe(length);
  for (let index = 0; index < length; index++)
    body[index] = (payload[index] ?? 0) ^ (mask[index % 4] ?? 0);
  return Buffer.concat([header, mask, body]);
}
const messageOf = (frames: ReturnType<FrameDecoder['push']>, assembler = new MessageAssembler()) =>
  frames.flatMap((frame) => assembler.push(frame));

test('the accept token matches the standard’s own example', () => {
  // RFC 6455 §1.3: this key must produce this accept value, or no browser will talk to the bridge.
  assert.equal(acceptKey('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
});

test('a masked text frame decodes, and a split frame waits for its remainder', () => {
  const decoder = new FrameDecoder();
  const frame = clientFrame(OPCODE.text, Buffer.from('hello'));
  assert.deepEqual(decoder.push(frame.subarray(0, 4)), [], 'a partial header decodes nothing');
  const frames = decoder.push(frame.subarray(4));
  assert.deepEqual(messageOf(frames), [{ kind: 'text', text: 'hello' }]);
});

test('two frames in one chunk both arrive, and a 16-bit length is read', () => {
  const decoder = new FrameDecoder();
  const payload = Buffer.from('x'.repeat(1000));
  const chunk = Buffer.concat([
    clientFrame(OPCODE.text, Buffer.from('first')),
    clientFrame(OPCODE.text, payload),
  ]);
  const messages = messageOf(decoder.push(chunk));
  assert.deepEqual(messages, [
    { kind: 'text', text: 'first' },
    { kind: 'text', text: 'x'.repeat(1000) },
  ]);
});

test('a 64-bit length carries a payload far past the 16-bit boundary', () => {
  const decoder = new FrameDecoder();
  const payload = Buffer.from('y'.repeat(70_000));
  const messages = messageOf(decoder.push(clientFrame(OPCODE.text, payload)));
  assert.equal(messages.length, 1);
  assert.equal((messages[0] as { text: string }).text.length, 70_000);
});

test('a fragmented message is joined, with a ping allowed in between', () => {
  const assembler = new MessageAssembler();
  const decoder = new FrameDecoder();
  const chunk = Buffer.concat([
    clientFrame(OPCODE.text, Buffer.from('one '), { fin: false }),
    clientFrame(OPCODE.ping, Buffer.from('p')),
    clientFrame(OPCODE.continuation, Buffer.from('two')),
  ]);
  const messages = decoder.push(chunk).flatMap((frame) => assembler.push(frame));
  assert.deepEqual(messages, [
    { kind: 'ping', payload: Buffer.from('p') },
    { kind: 'text', text: 'one two' },
  ]);
});

test('a close frame reports its code and reason', () => {
  const decoder = new FrameDecoder();
  const payload = Buffer.alloc(2 + 3);
  payload.writeUInt16BE(1000, 0);
  payload.write('bye', 2);
  assert.deepEqual(messageOf(decoder.push(clientFrame(OPCODE.close, payload))), [
    { kind: 'close', code: 1000, reason: 'bye' },
  ]);
});

test('an unmasked client frame is refused rather than tolerated', () => {
  const decoder = new FrameDecoder();
  const frame = clientFrame(OPCODE.text, Buffer.from('nope'), { mask: false });
  assert.throws(() => decoder.push(frame), WebSocketProtocolError);
});

test('the frames this bridge does not speak are refused with a reason', () => {
  assert.throws(
    () => messageOf(new FrameDecoder().push(clientFrame(OPCODE.binary, Buffer.from('bin')))),
    /text frames only/,
  );
  assert.throws(
    () => messageOf(new FrameDecoder().push(clientFrame(OPCODE.continuation, Buffer.from('x')))),
    /without a started message/,
  );
  const reserved = clientFrame(OPCODE.text, Buffer.from('rsv'));
  reserved[0] = (reserved[0] ?? 0) | 0x40;
  assert.throws(() => new FrameDecoder().push(reserved), /reserved bits/);
  assert.throws(
    () => new FrameDecoder().push(clientFrame(OPCODE.close, Buffer.alloc(200))),
    /at most 125 bytes/,
  );
});

test('what the server writes back is unmasked and bounded', () => {
  const text = encodeText('hi');
  assert.equal(text[0], 0x81, 'FIN + text opcode');
  assert.equal(text[1], 2, 'length with no mask bit');
  assert.equal(text.subarray(2).toString('utf8'), 'hi');
  const long = encodeText('z'.repeat(300));
  assert.equal(long[1], 126, 'a 16-bit length for 300 bytes');
  const close = encodeClose(1000, 'r'.repeat(500));
  assert.equal(close[1], 125, 'a close reason is truncated to the control-frame limit');
  assert.equal(encodeFrame(OPCODE.pong, Buffer.alloc(0)).length, 2);
});

test('oversized frame declarations are refused before waiting for their payload', () => {
  const header = Buffer.alloc(14);
  header[0] = 0x81;
  header[1] = 0xff;
  header.writeBigUInt64BE(1024n * 1024n * 1024n, 2);
  assert.throws(() => new FrameDecoder().push(header), /payload.*limit/i);
  assert.throws(
    () => new FrameDecoder(8).push(clientFrame(OPCODE.text, Buffer.from('123456789'))),
    /payload.*limit/i,
  );
  assert.equal(
    messageOf(new FrameDecoder(8).push(clientFrame(OPCODE.text, Buffer.from('12345678'))))[0]?.kind,
    'text',
  );
});

test('fragmented messages enforce a cumulative byte limit and release it after completion', () => {
  const assembler = new MessageAssembler(8);
  assembler.push({ fin: false, opcode: OPCODE.text, payload: Buffer.from('123456') });
  assembler.push({ fin: true, opcode: OPCODE.ping, payload: Buffer.from('control') });
  assert.throws(
    () => assembler.push({ fin: true, opcode: OPCODE.continuation, payload: Buffer.from('789') }),
    /message.*limit/i,
  );
  const complete = new MessageAssembler(8);
  complete.push({ fin: false, opcode: OPCODE.text, payload: Buffer.from('123456') });
  assert.deepEqual(
    complete.push({ fin: true, opcode: OPCODE.continuation, payload: Buffer.from('78') }),
    [{ kind: 'text', text: '12345678' }],
  );
  assert.deepEqual(
    complete.push({ fin: true, opcode: OPCODE.text, payload: Buffer.from('next') }),
    [{ kind: 'text', text: 'next' }],
  );
  assert.throws(
    () =>
      new MessageAssembler(8).push({
        fin: true,
        opcode: OPCODE.text,
        payload: Buffer.from('123456789'),
      }),
    /message.*limit/i,
  );
});

test('chunked large frames decode correctly with linear buffer copying', (t) => {
  const payload = Buffer.from('x'.repeat(2 * 1024 * 1024));
  const input = clientFrame(OPCODE.text, payload);
  const originalConcat = Buffer.concat;
  const originalCopy = Buffer.prototype.copy;
  let copied = 0;
  t.mock.method(Buffer, 'concat', (list: readonly Uint8Array[], length?: number) => {
    copied += list.reduce((sum, bytes) => sum + bytes.byteLength, 0);
    return originalConcat(list, length);
  });
  t.mock.method(
    Buffer.prototype,
    'copy',
    function (this: Buffer, ...args: Parameters<Buffer['copy']>) {
      const bytes = originalCopy.apply(this, args);
      copied += bytes;
      return bytes;
    },
  );
  const decoder = new FrameDecoder();
  const frames: ReturnType<FrameDecoder['push']> = [];
  for (let offset = 0; offset < input.length; offset += 4096)
    frames.push(...decoder.push(input.subarray(offset, offset + 4096)));
  assert.equal(frames.length, 1);
  assert.deepEqual(frames[0]?.payload, payload);
  assert(copied < input.length * 8, `copied ${copied} bytes for ${input.length} received bytes`);
});

test('many tiny fragments retain bounded memory while preserving their message', () => {
  const moduleUrl = new URL('../apps/web/websocket.ts', import.meta.url).href;
  const result = spawnSync(
    process.execPath,
    [
      '--expose-gc',
      '--input-type=module',
      '-e',
      `
    import assert from 'node:assert/strict';
    import { FrameDecoder, MessageAssembler } from ${JSON.stringify(moduleUrl)};
    const decoder = new FrameDecoder();
    const assembler = new MessageAssembler();
    const accept = (bytes) => decoder.push(bytes).flatMap((frame) => assembler.push(frame));
    const first = Buffer.from([1, 129, 0, 0, 0, 0, 120]);
    const continuation = Buffer.from([0, 129, 0, 0, 0, 0, 120]);
    global.gc();
    const before = process.memoryUsage();
    accept(first);
    for (let index = 0; index < 500000; index++) accept(continuation);
    global.gc();
    const after = process.memoryUsage();
    assert(after.heapUsed - before.heapUsed < 16 * 1024 * 1024,
      'tiny fragments retained ' + (after.heapUsed - before.heapUsed) + ' heap bytes');
    assert(after.external - before.external < 8 * 1024 * 1024,
      'tiny fragments retained oversized external buffers');
    const messages = accept(Buffer.from([128, 128, 0, 0, 0, 0]));
    assert.equal(messages[0].text, 'x'.repeat(500001));
  `,
    ],
    { encoding: 'utf8', timeout: 15000, windowsHide: true },
  );
  assert.equal(result.status, 0, result.stderr || String(result.error));
});
