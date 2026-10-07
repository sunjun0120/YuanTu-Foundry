/**
 * The little of RFC 6455 a browser needs from a server, written here rather than depended on.
 *
 * The web carrier needs exactly one thing from the WebSocket protocol: a text message in each direction, on a
 * link a page can open. Everything else the standard offers — extensions, compression, binary payloads,
 * subprotocol negotiation — is surface this bridge would have to refuse anyway, and the repository's position on
 * such mechanisms is to own the small load-bearing part (`packages/client/host-transport.ts`'s `lineFramer`
 * frames JSONL for the same reason) rather than add the project's first networking dependency for it.
 *
 * What is implemented, and what is not:
 *
 * - **Handshake**: `Sec-WebSocket-Key` → `Sec-WebSocket-Accept`, per the standard's own example.
 * - **Frames**: text, continuation, close, ping and pong; masked client frames (the standard requires masking,
 *   so an unmasked client frame is a protocol error rather than something to tolerate); 7-bit, 16-bit and
 *   64-bit payload lengths, so a snapshot carrying an image is not a special case.
 * - **Refusals**: RSV bits set (an extension we did not negotiate), binary frames (this bridge speaks text),
 *   unknown opcodes, and control frames that are fragmented or oversized. Each closes the connection with a
 *   reason instead of being ignored — a bridge that silently dropped half a message would look like a Host bug.
 */
import { createHash } from 'node:crypto';
export const WEBSOCKET_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
/** The accept token a server must answer a client's key with. Exported so a test can pin the RFC's own example. */
export function acceptKey(secWebSocketKey: string): string {
  return createHash('sha1')
    .update(secWebSocketKey + WEBSOCKET_GUID)
    .digest('base64');
}
export const OPCODE = {
  continuation: 0x0,
  text: 0x1,
  binary: 0x2,
  close: 0x8,
  ping: 0x9,
  pong: 0xa,
} as const;
/** The largest control frame the standard allows. A close reason that exceeds it is a protocol error. */
const MAX_CONTROL_PAYLOAD = 125;
export class WebSocketProtocolError extends Error {}
/** One frame as it arrived, still fragmented and not yet interpreted. */
export interface RawFrame {
  readonly fin: boolean;
  readonly opcode: number;
  readonly payload: Buffer;
}
function masked(payload: Buffer, mask: Buffer): Buffer {
  const out = Buffer.allocUnsafe(payload.length);
  for (let index = 0; index < payload.length; index++)
    out[index] = (payload[index] ?? 0) ^ (mask[index % 4] ?? 0);
  return out;
}
/**
 * Decode frames out of a byte stream.
 *
 * TCP delivers whatever it delivers, so a frame can arrive in pieces or several can arrive at once; the decoder
 * keeps the remainder between calls. It understands framing only — fragmentation and opcode rules are the
 * assembler's business below.
 */
export class FrameDecoder {
  private buffer: Buffer = Buffer.alloc(0);
  push(chunk: Buffer): RawFrame[] {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    const frames: RawFrame[] = [];
    for (;;) {
      const frame = this.next();
      if (!frame) return frames;
      frames.push(frame);
    }
  }
  private next(): RawFrame | undefined {
    const buffer = this.buffer;
    if (buffer.length < 2) return undefined;
    const first = buffer[0] ?? 0;
    const second = buffer[1] ?? 0;
    const fin = (first & 0x80) !== 0;
    const rsv = first & 0x70;
    if (rsv !== 0)
      throw new WebSocketProtocolError('reserved bits set without a negotiated extension');
    const opcode = first & 0x0f;
    const isMasked = (second & 0x80) !== 0;
    if (!isMasked) throw new WebSocketProtocolError('client frames must be masked');
    let length = second & 0x7f;
    let offset = 2;
    if (length === 126) {
      if (buffer.length < offset + 2) return undefined;
      length = buffer.readUInt16BE(offset);
      offset += 2;
    } else if (length === 127) {
      if (buffer.length < offset + 8) return undefined;
      const wide = buffer.readBigUInt64BE(offset);
      // A length beyond what a Buffer can hold is refused here rather than throwing out of `allocUnsafe` later.
      if (wide > BigInt(Number.MAX_SAFE_INTEGER))
        throw new WebSocketProtocolError('frame payload length is not addressable');
      length = Number(wide);
      offset += 8;
    }
    const isControl = (opcode & 0x8) !== 0;
    if (isControl && (!fin || length > MAX_CONTROL_PAYLOAD))
      throw new WebSocketProtocolError('control frames must be final and at most 125 bytes');
    if (buffer.length < offset + 4 + length) return undefined;
    const mask = buffer.subarray(offset, offset + 4);
    offset += 4;
    const payload = masked(buffer.subarray(offset, offset + length), mask);
    this.buffer = buffer.subarray(offset + length);
    return { fin, opcode, payload };
  }
}
/** A whole message: what a caller gets after fragmentation has been undone. */
export type AssembledMessage =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'close'; readonly code: number; readonly reason: string }
  | { readonly kind: 'ping'; readonly payload: Buffer }
  | { readonly kind: 'pong'; readonly payload: Buffer };
/**
 * Turn frames into messages: continuation frames are joined, control frames may arrive between them, and a
 * sequence the standard does not allow is an error.
 */
export class MessageAssembler {
  private fragments: Buffer[] = [];
  private fragmentedOpcode: number | undefined;
  push(frame: RawFrame): AssembledMessage[] {
    if (frame.opcode === OPCODE.close) {
      const code = frame.payload.length >= 2 ? frame.payload.readUInt16BE(0) : 1005;
      return [{ kind: 'close', code, reason: frame.payload.subarray(2).toString('utf8') }];
    }
    if (frame.opcode === OPCODE.ping) return [{ kind: 'ping', payload: frame.payload }];
    if (frame.opcode === OPCODE.pong) return [{ kind: 'pong', payload: frame.payload }];
    if (frame.opcode === OPCODE.binary)
      throw new WebSocketProtocolError('this bridge speaks text frames only');
    if (frame.opcode === OPCODE.continuation) {
      if (this.fragmentedOpcode === undefined)
        throw new WebSocketProtocolError('continuation frame without a started message');
      this.fragments.push(frame.payload);
      if (!frame.fin) return [];
      const text = Buffer.concat(this.fragments).toString('utf8');
      this.fragments = [];
      this.fragmentedOpcode = undefined;
      return [{ kind: 'text', text }];
    }
    if (frame.opcode !== OPCODE.text)
      throw new WebSocketProtocolError(`unknown opcode ${String(frame.opcode)}`);
    if (frame.fin) return [{ kind: 'text', text: frame.payload.toString('utf8') }];
    this.fragmentedOpcode = frame.opcode;
    this.fragments = [frame.payload];
    return [];
  }
}
/** Server frames are never masked. */
export function encodeFrame(opcode: number, payload: Buffer = Buffer.alloc(0)): Buffer {
  const length = payload.length;
  const header =
    length < 126
      ? Buffer.from([0x80 | opcode, length])
      : length < 65_536
        ? (() => {
            const head = Buffer.alloc(4);
            head[0] = 0x80 | opcode;
            head[1] = 126;
            head.writeUInt16BE(length, 2);
            return head;
          })()
        : (() => {
            const head = Buffer.alloc(10);
            head[0] = 0x80 | opcode;
            head[1] = 127;
            head.writeBigUInt64BE(BigInt(length), 2);
            return head;
          })();
  return Buffer.concat([header, payload]);
}
export const encodeText = (text: string): Buffer =>
  encodeFrame(OPCODE.text, Buffer.from(text, 'utf8'));
export const encodePong = (payload: Buffer): Buffer => encodeFrame(OPCODE.pong, payload);
/** A close frame with a code and a reason, bounded to what a control frame may carry. */
export function encodeClose(code: number, reason = ''): Buffer {
  const text = Buffer.from(reason, 'utf8').subarray(0, MAX_CONTROL_PAYLOAD - 2);
  const payload = Buffer.alloc(2 + text.length);
  payload.writeUInt16BE(code, 0);
  text.copy(payload, 2);
  return encodeFrame(OPCODE.close, payload);
}
