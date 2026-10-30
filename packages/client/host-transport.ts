import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { HOST_RESPONSE_FRAME_BYTES } from '../protocol/host-wire.ts';

/**
 * How a carrier reaches an Agent Host.
 *
 * The client began life as "spawn a child and talk JSONL over its stdio", which welded three separate
 * concerns together: process supervision, byte-stream framing, and the request/event protocol. Only the
 * first two are carrier-specific — the desktop spawns and supervises its Host, while a test or an embedder may
 * start the Host itself and only hand over the link. Naming the seam is what makes that a matter of writing
 * one of these rather than a second client.
 *
 * A transport is deliberately dumb: it moves whole lines and reports that the far side is gone. It knows
 * nothing about requests, ids, redaction or status, which is why `AgentHostClient` is unchanged in behaviour
 * whichever transport it holds.
 */
export interface HostTransportExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}
export interface HostTransport {
  /** Named in failure messages: `process 1234`, an in-memory pair. */
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
  /** Ask it to stop gracefully (close stdin). */
  end(): void;
  /** Stop it now, after the graceful path has timed out. */
  kill(): void;
  /**
   * Where a graceful stop that timed out got stuck, for the failure message. A child process reports whether it
   * exited at all, or exited while something still held its output open: the two need opposite fixes.
   */
  shutdownState?(): string;
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
      // A chunk without a newline only extends the current line: searching the whole buffer for one would make
      // V8 flatten the concatenated string on every chunk, which is quadratic in a long line — an oversized
      // frame arriving in 64 KiB socket reads took seconds to be refused.
      if (!decoded.includes('\n')) {
        searchFrom = buffer.length;
        if (bufferedBytes > options.maxFrameBytes) {
          failed = true;
          options.onError(new Error('Agent Host response exceeds frame limit'));
        }
        return;
      }
      // Lines are consumed by offset and the remainder cut once: re-measuring the rest of the buffer after every
      // line made a chunk carrying many small events quadratic in its size.
      let newline: number,
        start = 0;
      while ((newline = buffer.indexOf('\n', searchFrom)) >= 0) {
        const line = buffer.slice(start, newline);
        const lineBytes = Buffer.byteLength(line, 'utf8');
        bufferedBytes -= lineBytes + 1;
        start = searchFrom = newline + 1;
        if (lineBytes > options.maxFrameBytes) {
          failed = true;
          options.onError(new Error('Agent Host response exceeds frame limit'));
          return;
        }
        if (line.trim()) options.onLine(line);
      }
      if (start) buffer = buffer.slice(start);
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
  /** `exit` and `close` are separate: the exit is the process ending, the close is its last pipe closing. */
  private exited: { at: number; code: number | null; signal: NodeJS.Signals | null } | undefined;
  private openOutputs = new Set(['stdout', 'stderr']);
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
    child.once('exit', (code, signal) => {
      this.exited = { at: performance.now(), code, signal };
    });
    child.stdout.once('close', () => this.openOutputs.delete('stdout'));
    child.stderr.once('close', () => this.openOutputs.delete('stderr'));
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
    const pid = this.child.pid;
    if (process.platform !== 'win32' && pid !== undefined) {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch (error) {
        // Already gone, or not a group leader: fall back to the Host itself.
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') this.child.kill('SIGKILL');
      }
    } else this.child.kill('SIGKILL');
    this.child.stdout.destroy();
    this.child.stderr.destroy();
  }
  shutdownState(): string {
    if (!this.exited) return `${this.label} had not exited`;
    const { at, code, signal } = this.exited;
    const ago = Math.round(performance.now() - at);
    const open = [...this.openOutputs];
    // The process is gone but a pipe is not: something it started inherited that end and is still running.
    return open.length
      ? `${this.label} exited ${ago} ms earlier (code=${code}, signal=${signal}) but its ${open.join(' and ')} stayed open`
      : `${this.label} exited ${ago} ms earlier (code=${code}, signal=${signal})`;
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
    // On POSIX the Host leads its own process group, so a forced stop can end everything it started with one
    // signal (the group convention `killTree` uses). Windows has no groups and is unchanged.
    detached: process.platform !== 'win32',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return new StdioTransport(
    child,
    options.maxFrameBytes ?? HOST_RESPONSE_FRAME_BYTES,
    options.onSpawnError,
  );
}
/**
 * A Host process somebody else started, reached through its stdio.
 *
 * The client does not supervise it: there is no restart, and stopping the client ends the link the same way the
 * process's own owner would (closing stdin). A test that needs the Host's stderr or exit, or an embedder that
 * launches the Host its own way, holds the child and hands this to `connectedCarrier`. On POSIX, spawn it
 * `detached` like `stdioTransport` does, so `kill` can end its process group.
 */
export function processTransport(
  child: ChildProcessWithoutNullStreams,
  maxFrameBytes = HOST_RESPONSE_FRAME_BYTES,
): HostTransport {
  return new StdioTransport(child, maxFrameBytes, () => {});
}
