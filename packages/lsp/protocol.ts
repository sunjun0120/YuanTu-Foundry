import { fileURLToPath, pathToFileURL } from 'node:url';

const HEADER_SEPARATOR = '\r\n\r\n';
const MAX_HEADER_BYTES = 8 * 1024;
const MAX_MESSAGE_BYTES = 32 * 1024 * 1024;

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: unknown;
}
export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}
export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}
export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

export function encodeMessage(message: JsonRpcMessage): Buffer {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body]);
}

/**
 * Incremental `Content-Length` framing decoder. A single chunk may carry several
 * messages or half of one, so the decoder keeps a remainder buffer between pushes.
 */
export class MessageDecoder {
  private buffer: Buffer = Buffer.alloc(0);
  push(chunk: Buffer): JsonRpcMessage[] {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    const messages: JsonRpcMessage[] = [];
    for (;;) {
      const headerEnd = this.buffer.indexOf(HEADER_SEPARATOR);
      if (headerEnd < 0) {
        if (this.buffer.length > MAX_HEADER_BYTES)
          throw new Error('LSP header exceeded the 8KB bound');
        break;
      }
      if (headerEnd > MAX_HEADER_BYTES) throw new Error('LSP header exceeded the 8KB bound');
      const header = this.buffer.subarray(0, headerEnd).toString('ascii');
      const match = /(?:^|\r\n)content-length:\s*(\d+)\s*$/im.exec(header);
      if (!match) throw new Error('LSP message is missing a Content-Length header');
      const length = Number(match[1]);
      if (!Number.isSafeInteger(length) || length < 0 || length > MAX_MESSAGE_BYTES)
        throw new Error('LSP message length is out of bounds');
      const bodyStart = headerEnd + HEADER_SEPARATOR.length;
      if (this.buffer.length < bodyStart + length) break;
      const body = this.buffer.subarray(bodyStart, bodyStart + length).toString('utf8');
      this.buffer = this.buffer.subarray(bodyStart + length);
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        throw new Error('LSP message body is not valid JSON');
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
        throw new Error('LSP message must be a JSON object');
      messages.push(parsed as JsonRpcMessage);
    }
    return messages;
  }
  get pending(): number {
    return this.buffer.length;
  }
}

export function pathToUri(file: string): string {
  return pathToFileURL(file).href;
}
/** Map a server-supplied URI onto a stable cache key (case-insensitive on Windows). */
export function uriToKey(uri: string): string {
  try {
    const file = fileURLToPath(uri);
    return process.platform === 'win32' ? file.toLowerCase() : file;
  } catch {
    return uri;
  }
}
export function uriToPath(uri: string): string | undefined {
  try {
    return fileURLToPath(uri);
  } catch {
    return undefined;
  }
}

export interface LspPosition {
  line: number;
  character: number;
}
export interface LspRange {
  start: LspPosition;
  end: LspPosition;
}

/** JavaScript string indices are UTF-16 code units, which is exactly what LSP counts. */
export function offsetAt(text: string, position: LspPosition): number {
  let offset = 0;
  for (let line = 0; line < position.line; line++) {
    const next = text.indexOf('\n', offset);
    if (next < 0) return text.length;
    offset = next + 1;
  }
  return Math.min(offset + Math.max(position.character, 0), text.length);
}
export function applyTextEdits(
  text: string,
  edits: readonly { range: LspRange; newText: string }[],
): string {
  const resolved = edits
    .map((edit) => ({
      start: offsetAt(text, edit.range.start),
      end: offsetAt(text, edit.range.end),
      newText: edit.newText,
    }))
    .sort((a, b) => b.start - a.start);
  let result = text;
  for (const edit of resolved) {
    if (edit.end < edit.start) throw new Error('LSP edit range is inverted');
    result = result.slice(0, edit.start) + edit.newText + result.slice(edit.end);
  }
  return result;
}

/** Tools take 1-based lines and characters; the protocol is 0-based. */
export function toProtocolPosition(line: unknown, character: unknown): LspPosition {
  const l = Number(line);
  const c = Number(character);
  if (!Number.isSafeInteger(l) || l < 1) throw new Error('line must be a 1-based integer >= 1');
  if (!Number.isSafeInteger(c) || c < 1)
    throw new Error('character must be a 1-based integer >= 1');
  return { line: l - 1, character: c - 1 };
}
export function toDisplayRange(range: LspRange): {
  line: number;
  character: number;
  endLine: number;
  endCharacter: number;
} {
  return {
    line: range.start.line + 1,
    character: range.start.character + 1,
    endLine: range.end.line + 1,
    endCharacter: range.end.character + 1,
  };
}

export const SEVERITY_NAMES = ['error', 'warning', 'information', 'hint'] as const;
export function severityName(severity: unknown): string {
  const index = Number(severity) - 1;
  return SEVERITY_NAMES[index] ?? 'unknown';
}
