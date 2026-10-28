import { createInterface, type Interface } from 'node:readline';
import { PassThrough, type Readable, type Writable } from 'node:stream';
import { MAX_INPUT_BYTES } from '../../packages/protocol/images.ts';
import { lineFramer } from '../../packages/client/host-transport.ts';
import { HOST_RESPONSE_FRAME_BYTES } from '../../packages/protocol/host-wire.ts';

export interface HostCarrierOptions {
  /**
   * Whether the Host is shutting down.
   *
   * Read at the moment a message is dropped, and read through a callback rather than a copy
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
/**
 * The Host's carrier: the JSONL protocol on stdin/stdout.
 *
 * The desktop and the CLI start a Host as a child process and own it through its pipes; when the carrier goes
 * away (stdin EOF) the Host shuts down, because a Host is owned by the carrier that started it.
 *
 * The JSONL framing is the contract, and this class is the only thing that writes it: every frame on the wire
 * comes from `send`, except for the `--help` text (`cli.ts`), which is answered before a carrier is attached.
 * A client fails on any other non-JSON stdout line, so a second writer is a broken client rather than a chatty
 * Host.
 */
export class HostCarrier {
  private readonly isClosing: () => boolean;
  /** Where this carrier reads: `process.stdin` unless somebody handed it another stream. */
  private readonly stdioInput: Readable;
  private readonly stdioOutput: Writable;
  /** Unlike normal shutdown, a non-reading peer must never receive another queued byte. */
  private outputDropped = false;
  /** Where a frame goes, once there is somewhere to put it. */
  private output: ((line: string) => void) | null = null;
  private input: Interface | null = null;
  private ingress: PassThrough | null = null;
  private closed = false;

  constructor(options: HostCarrierOptions) {
    this.isClosing = options.isClosing;
    this.stdioInput = options.stdioInput ?? process.stdin;
    this.stdioOutput = options.stdioOutput ?? process.stdout;
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

  /**
   * Open the carrier and return the line reader the serve loop drains.
   *
   * `createInterface({ input: process.stdin })` assembles a line with no upper bound, so a peer that never
   * writes a newline — or writes one enormous line — grows this process's heap for as long as it keeps
   * writing, and the size gate in `dispatch.ts` runs only once the whole line exists, which is the one
   * moment it can no longer help. The framer refuses a frame past `MAX_INPUT_BYTES` while it is still
   * arriving and the carrier is dropped; bytes already read are bounded by the frame plus one chunk.
   */
  attach(): AsyncIterable<string> {
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
   * The *output* deliberately survives this call. Shutdown aborts the live runs and closes the carrier in the same
   * synchronous turn (`lifecycle.ts`), and a run answers its caller when its own abort unwinds — asynchronously,
   * afterwards. Nulling the output here dropped exactly those answers: the process exited cleanly with requests
   * still pending, which the client reports as "Host exited; requests were not replayed" instead of the cancelled
   * run it asked to stop. Stdout is still open at that point, and the process exit closes it after Node has
   * flushed it.
   */
  close(): void {
    this.closed = true;
    this.input?.close();
    this.ingress?.destroy();
    this.stdioInput.destroy();
  }
}
