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
