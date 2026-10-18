import { createInterface, type Interface } from 'node:readline';
import { createServer, isIP, type Socket } from 'node:net';
import { timingSafeEqual } from 'node:crypto';
import { PassThrough, type Readable, type Writable } from 'node:stream';
import { parseListen } from '../shared/args.ts';
import { hostAuthTokenProblem } from '../../packages/protocol/host-auth.ts';
import { MAX_INPUT_BYTES } from '../../packages/protocol/images.ts';
import { lineFramer } from '../../packages/client/host-transport.ts';
import { HOST_RESPONSE_FRAME_BYTES } from '../../packages/protocol/host-wire.ts';

export interface HostCarrierOptions {
  /** `[host:]port` to serve on, or undefined to serve the protocol on stdin/stdout. */
  listen?: string;
  /** Trusted launch credential. Required only for TCP; never load this from the workspace. */
  authToken?: string;
  /**
   * Whether the Host is shutting down.
   *
   * Read at the moment a message is dropped or a socket closes, and read through a callback rather than a copy
   * because the answer changes under the carrier: a carrier that went away ends the read loop, and the shutdown
   * that follows is not a lost carrier.
   */
  isClosing: () => boolean;
  /**
   * The byte stream a stdio carrier reads.
   *
   * Defaults to `process.stdin`, which is what the CLI and the desktop use. The option exists because the framing
   * rules are the same on any stream, and a stream a test owns is the only way to exercise them without a real
   * pipe: an embedder that hosts this protocol on a duplex of its own has the same shape.
   */
  stdioInput?: Readable;
  /** The corresponding reply stream; defaults to process.stdout. */
  stdioOutput?: Writable;
}

/**
 * How much this Host will keep handing to a carrier that is not reading it.
 *
 * A synchronous protocol cannot throttle its callers. Bound the writable queue, including writes below its
 * high water mark. Allow one maximum client frame and its delimiter.
 */
const MAX_UNSENT_BYTES = HOST_RESPONSE_FRAME_BYTES + 1; // Include one frame's newline delimiter.
/** How long a shutting-down Host waits for its socket peer to take the last answers. See `HostCarrier.drain`. */
const SOCKET_DRAIN_MS = 2_000;

/** Validate before opening storage or listening, also for embedders constructing a carrier directly. */
export function validateHostListener(
  listen: string | undefined,
  authToken: string | undefined,
): void {
  if (listen === undefined) return;
  const { host } = parseListen(listen);
  if (isIP(host) !== 4 || !host.startsWith('127.'))
    throw new Error('--listen requires a literal IPv4 loopback address (127.x.x.x)');
  const problem = hostAuthTokenProblem(authToken);
  if (problem) throw new Error(problem);
}

/**
 * Where this Host's carrier is, once one is attached.
 *
 * The Host was written as "something that owns stdin/stdout", which is a statement about a *desktop* carrier
 * rather than about an agent host: a browser cannot spawn a process or pipe into one, so a second carrier
 * needs the same protocol over a link it can actually open. Nothing above this line changes — the dispatch
 * table, the run loop, the store and the protocol version are identical — because only the carrier moves.
 *
 * The JSONL framing is the contract, and this class is the only thing that writes it: every frame on the wire
 * comes from `send`, except for the two lines that belong to a carrier rather than to the protocol — the
 * `--help` text (`cli.ts`) and the listening banner, which a client has no other way to learn the bound port
 * from. A client fails on any other non-JSON stdout line, so a third writer is a broken client rather than a
 * chatty Host.
 */
export class HostCarrier {
  private readonly listen: string | undefined;
  private readonly isClosing: () => boolean;
  private readonly authToken: string | undefined;
  /** Where this carrier reads when it serves stdio: `process.stdin` unless somebody handed it another stream. */
  private readonly stdioInput: Readable;
  private readonly stdioOutput: Writable;
  /** Unlike normal shutdown, a non-reading peer must never receive another queued byte. */
  private outputDropped = false;
  /** Where a frame goes, once there is somewhere to put it. */
  private output: ((line: string) => void) | null = null;
  private input: Interface | null = null;
  private socket: Socket | null = null;
  private server: ReturnType<typeof createServer> | null = null;
  private ingress: PassThrough | null = null;
  private pending = new Set<Socket>();
  private cancelAccept: (() => void) | null = null;
  private closed = false;

  constructor(options: HostCarrierOptions) {
    validateHostListener(options.listen, options.authToken);
    this.listen = options.listen;
    this.isClosing = options.isClosing;
    this.authToken = options.authToken;
    this.stdioInput = options.stdioInput ?? process.stdin;
    this.stdioOutput = options.stdioOutput ?? process.stdout;
  }

  /** True when the protocol is on stdin/stdout rather than on a socket. */
  get stdio(): boolean {
    return this.listen === undefined;
  }

  /**
   * True while a carrier is attached — which is what a wake waits for.
   *
   * It stops being true the moment the carrier is dropped, even though the output stays usable for the answers
   * shutdown still owes its callers (see `close`). "Is anybody there to receive a frame" is the question a wake
   * asks, and the answer to that is no once the carrier is gone.
   */
  get connected(): boolean {
    return this.output !== null && !this.closed;
  }

  /** Open the carrier this Host was asked for and return the line reader the serve loop drains. */
  async attach(): Promise<AsyncIterable<string>> {
    const listen = this.listen;
    if (listen === undefined) {
      /**
       * stdin is framed exactly the way a socket is.
       *
       * `createInterface({ input: process.stdin })` assembles a line with no upper bound, so a peer that never
       * writes a newline — or writes one enormous line — grows this process's heap for as long as it keeps
       * writing, and the size gate in `dispatch.ts` runs only once the whole line exists, which is the one
       * moment it can no longer help. The framer refuses a frame past `MAX_INPUT_BYTES` while it is still
       * arriving and the carrier is dropped, which is the guarantee the TCP path has had since the
       * authentication work; bytes already read are bounded by the frame plus one chunk.
       */
      const ingress = (this.ingress = new PassThrough());
      const frames = lineFramer({
        maxFrameBytes: MAX_INPUT_BYTES,
        onLine: (line) => {
          if (!ingress.write(line + '\n')) {
            this.stdioInput.pause();
            ingress.once('drain', () => this.stdioInput.resume());
          }
        },
        onError: () => {
          process.stderr.write('[host] request exceeds frame limit; closing the carrier\n');
          this.close();
        },
      });
      this.stdioInput.on('data', (chunk: Buffer) => frames.write(chunk));
      this.stdioInput.on('end', () => ingress.end());
      this.output = (line) => this.writeBounded(this.stdioOutput, line);
      this.input = createInterface({ input: ingress, crlfDelay: Infinity });
      return this.input;
    }
    return await this.accept(listen);
  }

  /**
   * Hand one frame to a carrier that may not be reading it.
   *
   * Write UTF-8 buffers so writableLength counts bytes even with decodeStrings=false. A true write result only
   * means the high water mark was not reached; those pending bytes count too. Reading the current queue also
   * credits partial drains without waiting for an entirely empty buffer.
   */
  private writeBounded(
    target: { write(chunk: Buffer): boolean; readonly writableLength: number },
    line: string,
  ): void {
    if (this.outputDropped) return;
    const bytes = Buffer.byteLength(line);
    if (bytes > MAX_UNSENT_BYTES - target.writableLength) {
      this.outputDropped = true;
      process.stderr.write('[host] carrier is not reading its replies; closing it\n');
      this.close();
      return;
    }
    target.write(Buffer.from(line, 'utf8'));
  }

  /** Write one already-framed line, or say out loud that there was nobody to write it to. */
  send(data: unknown): void {
    if (this.outputDropped) return;
    const line = JSON.stringify(data) + '\n';
    if (this.output) this.output(line);
    // Unreachable while the protocol is request-driven: the scheduler is started only once a carrier is
    // attached, so nothing can emit before there is somewhere to emit to. Said out loud anyway, because a
    // silently dropped event is exactly what a carrier change could introduce.
    else if (!this.isClosing())
      process.stderr.write('[host] dropped a message: no carrier is connected\n');
  }

  /**
   * Drop the carrier, the way the Host drops it on stdin EOF.
   *
   * A pty is not involved, but a socket is: closing it is what tells the far side this Host is gone, and closing
   * the server is what stops a reconnect from being accepted into a process that is already unwinding.
   *
   * The *output* deliberately survives this call. Shutdown aborts the live runs and closes the carrier in the same
   * synchronous turn (`lifecycle.ts`), and a run answers its caller when its own abort unwinds — asynchronously,
   * afterwards. Nulling the output here dropped exactly those answers: the process exited cleanly with requests
   * still pending, which the client reports as "Host exited; requests were not replayed" instead of the cancelled
   * run it asked to stop. Stdout is still open at that point, which is why writing after `close` works at all.
   */
  close(): void {
    this.closed = true;
    this.cancelAccept?.();
    this.cancelAccept = null;
    this.input?.close();
    this.ingress?.destroy();
    if (this.stdio) this.stdioInput.destroy();
    else {
      // The connected socket stops *reading* here and keeps writing, for the same reason stdout does above: the
      // answers to the runs this shutdown aborted arrive afterwards. `drain` ends it once they have been written.
      this.socket?.pause();
      if (this.outputDropped) this.socket?.destroy();
      for (const candidate of this.pending) candidate.destroy();
      this.server?.close();
    }
  }

  /**
   * End the socket after the last answers were handed to it, within `timeoutMs`.
   *
   * Called by the lifecycle once every in-flight request has settled. `end` flushes what is queued and half-closes,
   * which is what lets a client read the cancelled run it asked about rather than "Host exited"; a peer that does
   * not read its replies cannot hold the process open past the bound. Stdio needs nothing: the process exit closes
   * stdout after Node has flushed it.
   */
  async drain(timeoutMs = SOCKET_DRAIN_MS): Promise<void> {
    const socket = this.socket;
    if (this.stdio || !socket || socket.destroyed) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        socket.destroy();
        resolve();
      }, timeoutMs);
      timer.unref();
      socket.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
      socket.end(() => {
        clearTimeout(timer);
        socket.destroy();
        resolve();
      });
    });
  }

  /**
   * Serve the same protocol on a socket, and wait for the one carrier this Host serves.
   *
   * One connection at a time is a deliberate limit rather than an implementation detail: the Host holds the
   * approvals, the active runs, the question map and the workspace lock for the sessions it serves, and two
   * clients on one Host would share every one of those. A second connection is told so and closed instead of
   * being silently accepted into a state it does not own. When the carrier goes away the Host shuts down,
   * exactly as it does on stdin EOF: a Host is owned by the carrier that started it.
   */
  private async accept(listen: string): Promise<AsyncIterable<string>> {
    // The same parse the command line validated with (see `parseListen`). Re-deriving it here is exactly what
    // let the documented host-less `:8080` through the front door and into `Number(':8080')`.
    const { host, port } = parseListen(listen);
    return await new Promise<AsyncIterable<string>>((resolve, reject) => {
      // A signal while waiting for authentication ends the same way as stdin EOF.
      this.cancelAccept = () => resolve({ async *[Symbol.asyncIterator]() {} });
      this.server = createServer((candidate) => {
        // Even a refused peer may reset during a write. It must never become an uncaught socket error.
        candidate.on('error', () => candidate.destroy());
        if (this.closed || this.isClosing()) {
          candidate.destroy();
          return;
        }
        if (this.socket || this.pending.size >= 8) {
          refuse(
            candidate,
            'HOST_BUSY',
            this.socket
              ? 'Agent Host already has a connected client; one connection at a time'
              : 'Agent Host has too many pending authentication attempts',
          );
          return;
        }
        this.pending.add(candidate);
        let authenticated = false,
          rejected = false,
          prefixBytes = 0;
        const prefix: Buffer[] = [];
        let ingress: PassThrough | undefined;
        const timer = setTimeout(() => {
          rejected = true;
          refuse(candidate, 'UNAUTHORIZED', 'Agent Host authentication timed out');
        }, 5000);
        candidate.once('close', () => {
          clearTimeout(timer);
          this.pending.delete(candidate);
          ingress?.end();
        });
        candidate.once('end', () => ingress?.end());
        let backpressured = false;
        const forward = (line: string) => {
          if (rejected || !ingress) return;
          if (!ingress.write(line + '\n') && !backpressured) {
            backpressured = true;
            candidate.pause();
            ingress.once('drain', () => {
              backpressured = false;
              if (!candidate.destroyed) candidate.resume();
            });
          }
        };
        const frames = lineFramer({
          maxFrameBytes: MAX_INPUT_BYTES,
          onLine: forward,
          onError: () => {
            rejected = true;
            refuse(candidate, 'FRAME_TOO_LARGE', 'Agent Host request exceeds frame limit');
          },
        });
        candidate.on('data', (chunk: Buffer) => {
          if (rejected || this.closed) return;
          if (authenticated) {
            frames.write(chunk);
            return;
          }
          const end = chunk.indexOf(10);
          const head = end < 0 ? chunk : chunk.subarray(0, end);
          prefixBytes += head.length;
          if (prefixBytes > 4096) {
            rejected = true;
            refuse(candidate, 'UNAUTHORIZED', 'Agent Host authentication frame exceeds limit');
            return;
          }
          prefix.push(head);
          if (end < 0) return;
          const request = authenticatedRequest(
            Buffer.concat(prefix, prefixBytes).toString('utf8'),
            this.authToken!,
          );
          if (!request) {
            rejected = true;
            refuse(candidate, 'UNAUTHORIZED', 'Agent Host authentication failed');
            return;
          }
          // Peers may have entered the pending set before the first carrier authenticated.
          if (this.socket) {
            rejected = true;
            refuse(
              candidate,
              'HOST_BUSY',
              'Agent Host already has a connected client; one connection at a time',
            );
            return;
          }
          authenticated = true;
          clearTimeout(timer);
          this.pending.delete(candidate);
          this.socket = candidate;
          this.output = (line) => this.writeBounded(candidate, line);
          ingress = this.ingress = new PassThrough();
          const lines = (this.input = createInterface({ input: ingress, crlfDelay: Infinity }));
          // Subscribe before replaying the handshake or accepting pipelined RPCs; otherwise early lines are lost.
          const iterator = lines[Symbol.asyncIterator]();
          this.cancelAccept = null;
          resolve(iterator);
          process.stderr.write(
            `[host] authenticated carrier connected from ${candidate.remoteAddress ?? 'local'}\n`,
          );
          forward(JSON.stringify(request));
          frames.write(chunk.subarray(end + 1));
        });
      });
      this.server.on('error', (error) => reject(error));
      this.server.listen(port, host, () => {
        const address = this.server?.address();
        const bound = typeof address === 'object' && address ? address.port : port;
        // The port is reported on stdout because port 0 is a legitimate request ("any free port") and the
        // carrier has no other way to learn what it got.
        process.stdout.write(
          `YuanTu Agent Host listening on ${host}:${bound} (JSONL, one client at a time).\n`,
        );
      });
    });
  }
}

/** Only the bootstrap request can authenticate; remove its credential before it reaches RPC dispatch. */
function authenticatedRequest(line: string, expected: string): Record<string, unknown> | null {
  try {
    const request = JSON.parse(line);
    if (
      !request ||
      typeof request !== 'object' ||
      Array.isArray(request) ||
      typeof request.id !== 'string' ||
      !request.id ||
      request.method !== 'host.info' ||
      !request.params ||
      typeof request.params !== 'object' ||
      Array.isArray(request.params) ||
      typeof request.params.authToken !== 'string'
    )
      return null;
    const supplied = Buffer.from(request.params.authToken, 'utf8');
    const credential = Buffer.from(expected, 'utf8');
    if (supplied.length !== credential.length || !timingSafeEqual(supplied, credential))
      return null;
    delete request.params.authToken;
    return request;
  } catch {
    return null;
  }
}

function refuse(socket: Socket, code: string, message: string): void {
  if (socket.destroyed) return;
  // Drain a peer's concurrent handshake so closing with unread input cannot reset the
  // connection before the refusal reaches it. Bound peers that never close their side.
  socket.resume();
  const timer = setTimeout(() => socket.destroy(), 5000);
  timer.unref();
  socket.once('close', () => clearTimeout(timer));
  socket.end(JSON.stringify({ id: null, error: { code, message } }) + '\n');
}
