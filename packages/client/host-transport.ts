import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import type { Socket } from 'node:net';

/**
 * How a carrier reaches an Agent Host.
 *
 * The client began life as "spawn a child and talk JSONL over its stdio", which welded three separate
 * concerns together: process supervision, byte-stream framing, and the request/event protocol. Only the
 * first two are carrier-specific — a desktop loads a Host as a child process, while a browser cannot spawn
 * anything and has to reach an already-running Host over a socket. Naming the seam is what makes the second
 * carrier a matter of writing one of these rather than a second client.
 *
 * A transport is deliberately dumb: it moves whole lines and reports that the far side is gone. It knows
 * nothing about requests, ids, redaction or status, which is why `AgentHostClient` is unchanged in behaviour
 * whether it holds a child process or a socket.
 */
export interface HostTransportExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}
export interface HostTransport {
  /** Named in failure messages: `process 1234`, `127.0.0.1:43121`, an in-memory pair. */
  readonly label: string;
  /** The OS process behind the link, when there is one. Supervision names the process that died. */
  readonly pid: number | undefined;
  /** False once a line can no longer be sent. */
  readonly writable: boolean;
  /** Send one framed JSONL line. Returns false when the far side is not accepting it. */
  send(line: string): boolean;
  /** Whole lines from the far side. Returns an unsubscribe function. */
  onLine(listener: (line: string) => void): () => void;
  /** Diagnostic text (a child's stderr). Bounded by the consumer and never returned verbatim. */
  onDiagnostic(listener: (chunk: string) => void): () => void;
  /** A broken link or a framing violation — not a protocol error the far side reported. */
  onError(listener: (error: Error) => void): () => void;
  /** The far side is gone. Fires once. */
  onExit(listener: (exit: HostTransportExit) => void): () => void;
  /** Ask it to stop gracefully (close stdin, half-close a socket). */
  end(): void;
  /** Stop it now, after the graceful path has timed out. */
  kill(): void;
}
/**
 * Split a byte stream into lines, once, for every transport that carries one.
 *
 * This is the part that was easy to get wrong and expensive to duplicate: a history reply is a single
 * multi-megabyte line, so the scanner searches only the appended suffix and counts bytes incrementally
 * instead of rescanning the buffer on every chunk. Decoding goes through `StringDecoder` so a UTF-8
 * character split across two chunks is reassembled rather than replaced by a replacement character.
 */
export function lineFramer(options: {
  maxFrameBytes: number;
  onLine: (line: string) => void;
  onError: (error: Error) => void;
}): { write(chunk: Buffer): void; buffered(): boolean } {
  const decoder = new StringDecoder('utf8');
  let buffer = '',
    bufferedBytes = 0,
    searchFrom = 0,
    failed = false;
  return {
    write(chunk: Buffer): void {
      if (failed) return;
      const decoded = decoder.write(chunk);
      buffer += decoded;
      bufferedBytes += Buffer.byteLength(decoded, 'utf8');
      let newline: number;
      while ((newline = buffer.indexOf('\n', searchFrom)) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        bufferedBytes = Buffer.byteLength(buffer, 'utf8');
        searchFrom = 0;
        if (Buffer.byteLength(line) > options.maxFrameBytes) {
          failed = true;
          options.onError(new Error('Agent Host response exceeds frame limit'));
          return;
        }
        if (line.trim()) options.onLine(line);
      }
      searchFrom = buffer.length;
      if (bufferedBytes > options.maxFrameBytes) {
        failed = true;
        options.onError(new Error('Agent Host response exceeds frame limit'));
      }
    },
    buffered: () => bufferedBytes > 0,
  };
}
class TransportBase {
  protected lineListeners = new Set<(line: string) => void>();
  protected diagnosticListeners = new Set<(chunk: string) => void>();
  protected errorListeners = new Set<(error: Error) => void>();
  protected exitListeners = new Set<(exit: HostTransportExit) => void>();
  onLine(listener: (line: string) => void): () => void {
    this.lineListeners.add(listener);
    return () => this.lineListeners.delete(listener);
  }
  onDiagnostic(listener: (chunk: string) => void): () => void {
    this.diagnosticListeners.add(listener);
    return () => this.diagnosticListeners.delete(listener);
  }
  onError(listener: (error: Error) => void): () => void {
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }
  onExit(listener: (exit: HostTransportExit) => void): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }
  protected announceExit(exit: HostTransportExit): void {
    for (const listener of [...this.exitListeners]) {
      try {
        listener(exit);
      } catch {
        /* A consumer must not break transport teardown. */
      }
    }
    this.exitListeners.clear();
  }
  protected announceError(error: Error): void {
    for (const listener of [...this.errorListeners]) listener(error);
  }
  protected announceLine(line: string): void {
    for (const listener of [...this.lineListeners]) listener(line);
  }
  protected announceDiagnostic(chunk: string): void {
    for (const listener of [...this.diagnosticListeners]) listener(chunk);
  }
}
class StdioTransport extends TransportBase implements HostTransport {
  private child: ChildProcessWithoutNullStreams;
  private framer: ReturnType<typeof lineFramer>;
  constructor(
    child: ChildProcessWithoutNullStreams,
    maxFrameBytes: number,
    onSpawnError: (error: Error) => void,
  ) {
    super();
    this.child = child;
    this.framer = lineFramer({
      maxFrameBytes,
      onLine: (line) => this.announceLine(line),
      onError: (error) => this.announceError(error),
    });
    child.stdout.on('data', (chunk: Buffer) => this.framer.write(chunk));
    // Drain stderr to prevent pipe deadlock; the consumer keeps only a small tail, because arbitrary
    // stderr can contain credentials, paths, prompts or untrusted extension output.
    child.stderr.on('data', (chunk: Buffer) => this.announceDiagnostic(chunk.toString('utf8')));
    child.once('close', (code, signal) => this.announceExit({ code, signal }));
    child.on('error', () => onSpawnError(new Error('Unable to spawn Agent Host')));
    child.stdin.on('error', () => this.announceError(new Error('Agent Host input disconnected')));
  }
  get label(): string {
    return this.child.pid === undefined ? 'Agent Host process' : `process ${this.child.pid}`;
  }
  get pid(): number | undefined {
    return this.child.pid;
  }
  get writable(): boolean {
    return !this.child.stdin.destroyed && !this.child.stdin.writableEnded;
  }
  send(line: string): boolean {
    return this.child.stdin.write(line);
  }
  end(): void {
    this.child.stdin.end();
  }
  kill(): void {
    this.child.kill('SIGKILL');
    this.child.stdout.destroy();
    this.child.stderr.destroy();
  }
}
class SocketTransport extends TransportBase implements HostTransport {
  private socket: Socket;
  private framer: ReturnType<typeof lineFramer>;
  constructor(socket: Socket, maxFrameBytes: number) {
    super();
    this.socket = socket;
    this.framer = lineFramer({
      maxFrameBytes,
      onLine: (line) => this.announceLine(line),
      onError: (error) => this.announceError(error),
    });
    socket.on('data', (chunk: Buffer) => this.framer.write(chunk));
    // A socket has no stderr, but it does have OS-level errors (`ECONNRESET` on a Host that was killed);
    // reporting them as diagnostics keeps one classification path for both carriers.
    socket.on('error', (error: Error) => this.announceDiagnostic(error.message));
    // 'close' rather than 'end': a half-closed peer that never finishes its side must still settle.
    socket.once('close', () => this.announceExit({ code: 0, signal: null }));
  }
  get label(): string {
    return this.socket.remoteAddress
      ? `${this.socket.remoteAddress}:${this.socket.remotePort}`
      : 'Agent Host socket';
  }
  get pid(): undefined {
    return undefined;
  }
  get writable(): boolean {
    return !this.socket.destroyed && this.socket.writable;
  }
  send(line: string): boolean {
    return this.socket.write(line);
  }
  end(): void {
    this.socket.end();
  }
  kill(): void {
    this.socket.destroy();
  }
}
export interface StdioTransportOptions {
  nodePath: string;
  hostPath: string;
  workspace: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  maxFrameBytes?: number;
  /** Called when the child could not be started at all, before any line arrives. */
  onSpawnError: (error: Error) => void;
}
export function stdioTransport(options: StdioTransportOptions): HostTransport {
  const env = { ...process.env, ...options.env };
  delete env.NODE_OPTIONS;
  // A real Node binary must be supplied by Electron callers; do not accidentally spawn another UI.
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(options.nodePath, [options.hostPath, ...(options.args ?? [])], {
    cwd: options.workspace,
    env,
    shell: false,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return new StdioTransport(child, options.maxFrameBytes ?? 64_000_000, options.onSpawnError);
}
/** A connection somebody else accepted — a browser's WebSocket bridge, a TCP socket, a test pair. */
export function socketTransport(socket: Socket, maxFrameBytes = 64_000_000): HostTransport {
  return new SocketTransport(socket, maxFrameBytes);
}
