import { createInterface, type Interface } from 'node:readline';
import { createServer, type Socket } from 'node:net';

export interface HostCarrierOptions {
  /** `[host:]port` to serve on, or undefined to serve the protocol on stdin/stdout. */
  listen?: string;
  /**
   * Whether the Host is shutting down.
   *
   * Read at the moment a message is dropped or a socket closes, and read through a callback rather than a copy
   * because the answer changes under the carrier: a carrier that went away ends the read loop, and the shutdown
   * that follows is not a lost carrier.
   */
  isClosing: () => boolean;
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
  /** Where a frame goes, once there is somewhere to put it. */
  private output: ((line: string) => void) | null = null;
  private input: Interface | null = null;
  private socket: Socket | null = null;
  private server: ReturnType<typeof createServer> | null = null;

  constructor(options: HostCarrierOptions) {
    this.listen = options.listen;
    this.isClosing = options.isClosing;
  }

  /** True when the protocol is on stdin/stdout rather than on a socket. */
  get stdio(): boolean {
    return this.listen === undefined;
  }

  /** True once there is somewhere to write a frame — which is what a wake waits for. */
  get connected(): boolean {
    return this.output !== null;
  }

  /** Open the carrier this Host was asked for and return the line reader the serve loop drains. */
  async attach(): Promise<Interface> {
    const listen = this.listen;
    if (listen === undefined) {
      this.input = createInterface({ input: process.stdin, crlfDelay: Infinity });
      this.output = (line) => process.stdout.write(line);
      return this.input;
    }
    return await this.accept(listen);
  }

  /** Write one already-framed line, or say out loud that there was nobody to write it to. */
  send(data: unknown): void {
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
   */
  close(): void {
    this.input?.close();
    if (this.stdio) process.stdin.destroy();
    else {
      this.socket?.destroy();
      this.server?.close();
    }
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
  private async accept(listen: string): Promise<Interface> {
    const separator = listen.lastIndexOf(':');
    const host = separator > 0 ? listen.slice(0, separator) : '127.0.0.1';
    const port = Number(separator > 0 ? listen.slice(separator + 1) : listen);
    return await new Promise<Interface>((resolve, reject) => {
      this.server = createServer((candidate) => {
        if (this.socket) {
          candidate.write(
            JSON.stringify({
              id: null,
              error: {
                message:
                  'Agent Host already has a connected client; one connection at a time (the approvals, runs and workspace lock are per Host)',
              },
            }) + '\n',
          );
          candidate.end();
          return;
        }
        this.socket = candidate;
        this.output = (line) => candidate.write(line);
        const lines = createInterface({ input: candidate, crlfDelay: Infinity });
        lines.once('close', () => {
          // A carrier that went away ends the read loop, which runs the same shutdown path stdin EOF does.
          if (this.isClosing()) return;
          void lines.close();
        });
        process.stderr.write(
          `[host] carrier connected from ${candidate.remoteAddress ?? 'local'}\n`,
        );
        this.input = lines;
        resolve(lines);
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
