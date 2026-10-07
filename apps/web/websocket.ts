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
import { isUtf8 } from 'node:buffer';
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
/** Match the Host transport's maximum JSONL message size. */
export const MAX_WEBSOCKET_MESSAGE_BYTES = 64_000_000;
export class WebSocketProtocolError extends Error {
  readonly closeCode: number;
  constructor(message: string, closeCode = 1002) {
    super(message);
    this.closeCode = closeCode;
  }
}
function checkedLimit(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > MAX_WEBSOCKET_MESSAGE_BYTES)
    throw new RangeError('WebSocket byte limit must be between 0 and 64000000');
  return limit;
}
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
  private buffer: Buffer = Buffer.alloc(14);
  private buffered = 0;
  private expectedBytes = 2;
  private readonly maxPayloadBytes: number;
  constructor(maxPayloadBytes = MAX_WEBSOCKET_MESSAGE_BYTES) {
    this.maxPayloadBytes = checkedLimit(maxPayloadBytes);
  }
  push(chunk: Buffer): RawFrame[] {
    const frames: RawFrame[] = [];
    let cursor = 0;
    while (cursor < chunk.length) {
      // Read and validate the header before reserving any space for its payload.
      const count = Math.min(chunk.length - cursor, this.expectedBytes - this.buffered);
      const required = this.buffered + count;
      if (required > this.buffer.length) {
        const capacity = Math.min(
          this.maxPayloadBytes + 14,
          Math.max(required, this.buffer.length * 2),
        );
        const grown = Buffer.allocUnsafe(capacity);
        this.buffer.copy(grown, 0, 0, this.buffered);
        this.buffer = grown;
      }
      chunk.copy(this.buffer, this.buffered, cursor, cursor + count);
      this.buffered += count;
      cursor += count;
      const frame = this.next();
      if (frame) frames.push(frame);
    }
    return frames;
  }
  private next(): RawFrame | undefined {
    const buffer = this.buffer;
    if (this.buffered < 2) return undefined;
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
      if (this.buffered < offset + 2) {
        this.expectedBytes = offset + 2;
        return undefined;
      }
      length = buffer.readUInt16BE(offset);
      if (length < 126)
        throw new WebSocketProtocolError('frame length must use its minimum encoding');
      offset += 2;
    } else if (length === 127) {
      if (this.buffered < offset + 8) {
        this.expectedBytes = offset + 8;
        return undefined;
      }
      const wide = buffer.readBigUInt64BE(offset);
      // A length beyond what a Buffer can hold is refused here rather than throwing out of `allocUnsafe` later.
      if (wide > BigInt(Number.MAX_SAFE_INTEGER))
        throw new WebSocketProtocolError('frame payload length is not addressable');
      length = Number(wide);
      if (length < 65_536)
        throw new WebSocketProtocolError('frame length must use its minimum encoding');
      offset += 8;
    }
    const isControl = (opcode & 0x8) !== 0;
    if (isControl && (!fin || length > MAX_CONTROL_PAYLOAD))
      throw new WebSocketProtocolError('control frames must be final and at most 125 bytes');
    if (length > this.maxPayloadBytes)
      throw new WebSocketProtocolError('frame payload exceeds byte limit', 1009);
    this.expectedBytes = offset + 4 + length;
    if (this.buffered < this.expectedBytes) return undefined;
    const mask = buffer.subarray(offset, offset + 4);
    offset += 4;
    const payload = masked(buffer.subarray(offset, offset + length), mask);
    this.buffered = 0;
    this.expectedBytes = 2;
    // Do not retain a large allocation for the lifetime of an otherwise idle page.
    if (this.buffer.length > 65_536) this.buffer = Buffer.alloc(14);
    return { fin, opcode, payload };
  }
}
/** A whole message: what a caller gets after fragmentation has been undone. */
export type AssembledMessage =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'close'; readonly code: number; readonly reason: string }
  | { readonly kind: 'ping'; readonly payload: Buffer }
  | { readonly kind: 'pong'; readonly payload: Buffer };
function utf8Text(payload: Buffer): string {
  if (!isUtf8(payload)) throw new WebSocketProtocolError('invalid UTF-8 text', 1007);
  return payload.toString('utf8');
}
/**
 * Turn frames into messages: continuation frames are joined, control frames may arrive between them, and a
 * sequence the standard does not allow is an error.
 */
export class MessageAssembler {
  private fragments: Buffer = Buffer.alloc(0);
  private fragmentedOpcode: number | undefined;
  private fragmentBytes = 0;
  private readonly maxMessageBytes: number;
  constructor(maxMessageBytes = MAX_WEBSOCKET_MESSAGE_BYTES) {
    this.maxMessageBytes = checkedLimit(maxMessageBytes);
  }
  private append(payload: Buffer): void {
    const required = this.fragmentBytes + payload.length;
    if (required > this.maxMessageBytes)
      throw new WebSocketProtocolError('message exceeds byte limit', 1009);
    if (required > this.fragments.length) {
      const capacity = Math.min(
        this.maxMessageBytes,
        Math.max(required, this.fragments.length * 2, 1024),
      );
      const grown = Buffer.allocUnsafe(capacity);
      this.fragments.copy(grown, 0, 0, this.fragmentBytes);
      this.fragments = grown;
    }
    payload.copy(this.fragments, this.fragmentBytes);
    this.fragmentBytes = required;
  }
  push(frame: RawFrame): AssembledMessage[] {
    if (frame.opcode === OPCODE.close) {
      if (frame.payload.length === 1)
        throw new WebSocketProtocolError('close payload must contain a complete status code');
      const code = frame.payload.length >= 2 ? frame.payload.readUInt16BE(0) : 1005;
      if (
        frame.payload.length >= 2 &&
        !(
          (code >= 1000 && code <= 1014 && ![1004, 1005, 1006].includes(code)) ||
          (code >= 3000 && code <= 4999)
        )
      )
        throw new WebSocketProtocolError('invalid close status code');
      const reason = utf8Text(frame.payload.subarray(2));
      this.fragments = Buffer.alloc(0);
      this.fragmentedOpcode = undefined;
      this.fragmentBytes = 0;
      return [{ kind: 'close', code, reason }];
    }
    if (frame.opcode === OPCODE.ping) return [{ kind: 'ping', payload: frame.payload }];
    if (frame.opcode === OPCODE.pong) return [{ kind: 'pong', payload: frame.payload }];
    if (frame.opcode === OPCODE.binary)
      throw new WebSocketProtocolError('this bridge speaks text frames only');
    if (frame.opcode === OPCODE.continuation) {
      if (this.fragmentedOpcode === undefined)
        throw new WebSocketProtocolError('continuation frame without a started message');
      this.append(frame.payload);
      if (!frame.fin) return [];
      const text = utf8Text(this.fragments.subarray(0, this.fragmentBytes));
      this.fragments = Buffer.alloc(0);
      this.fragmentedOpcode = undefined;
      this.fragmentBytes = 0;
      return [{ kind: 'text', text }];
    }
    if (frame.opcode !== OPCODE.text)
      throw new WebSocketProtocolError(`unknown opcode ${String(frame.opcode)}`);
    if (this.fragmentedOpcode !== undefined)
      throw new WebSocketProtocolError('new data message before fragmented message completed');
    if (frame.payload.length > this.maxMessageBytes)
      throw new WebSocketProtocolError('message exceeds byte limit', 1009);
    if (frame.fin) return [{ kind: 'text', text: utf8Text(frame.payload) }];
    this.fragmentedOpcode = frame.opcode;
    this.fragments = Buffer.alloc(0);
    this.fragmentBytes = 0;
    this.append(frame.payload);
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
  const bytes = Buffer.from(reason, 'utf8');
  let end = Math.min(bytes.length, MAX_CONTROL_PAYLOAD - 2);
  // An excluded continuation byte means the preceding code point is only partly included.
  while (end < bytes.length && ((bytes[end] ?? 0) & 0xc0) === 0x80) end--;
  const text = bytes.subarray(0, end);
  const payload = Buffer.alloc(2 + text.length);
  payload.writeUInt16BE(code, 0);
  text.copy(payload, 2);
  return encodeFrame(OPCODE.close, payload);
}
