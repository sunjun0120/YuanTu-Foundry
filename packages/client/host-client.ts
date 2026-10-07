import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { AgentEvent, RunResult, ImageAttachment } from '../protocol/index.ts';
import { AGENT_EVENT_TYPES } from '../protocol/index.ts';
import { MAX_INPUT_BYTES } from '../protocol/images.ts';
import type { HostInfo, HostMethod, HostMethods } from '../protocol/rpc.ts';
import { redactSecrets } from '../core/errors.ts';
import { stdioTransport, type HostTransport } from './host-transport.ts';
import { HostRequests, type HostPendingRequest } from './host-requests.ts';
import {
  HOST_PROTOCOL_VERSIONS,
  HOST_LONG_REQUESTS,
  validateHostInfo,
  HostRequestError,
} from '../protocol/host-wire.ts';

export type HostStatus = 'stopped' | 'starting' | 'ready' | 'stopping' | 'failed';
/**
 * The Host process went away with requests outstanding.
 *
 * A caller has to be able to tell this apart from an ordinary failure, because the two need different
 * responses: a failed request can be retried against the same Host, while this one means the run that was in
 * flight is over — its outcome is whatever the workspace shows — and the only thing left to do is start a new
 * Host and rebuild the view from the session log. Matching on the message would make that decision depend on
 * wording, so the error carries the fact as a type.
 */
export class HostDisconnectedError extends Error {
  /** The Host's process id when it was started, for the log line that says which process died. */
  readonly pid: number | undefined;
  constructor(message: string, pid?: number) {
    super(message);
    this.name = 'HostDisconnectedError';
    this.pid = pid;
  }
}
interface HostClientLimits {
  /** Carrier restores policy and history before explicitly admitting unattended work. */
  deferAutomatic?: boolean;
  requestTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  maxFrameBytes?: number;
}
/** The desktop/CLI shape: this client owns the Host process and supervises it. */
export interface SpawnedHostOptions extends HostClientLimits {
  nodePath: string;
  hostPath: string;
  workspace: string;
  db?: string;
  env?: NodeJS.ProcessEnv;
}
/**
 * The carrier shape: somebody else produced a link to an already-running Host.
 *
 * A browser cannot spawn a process, so a web carrier connects to a Host that is already up — over a
 * WebSocket bridged to its TCP listener, or over any other duplex link — and hands the client a transport.
 * Everything above the transport (framing, request ids, timeouts, redaction, status) is the same code, which
 * is the point of the split.
 */
export interface ConnectedHostOptions extends HostClientLimits {
  transport: HostTransport;
  env?: NodeJS.ProcessEnv;
}
export type HostClientOptions = SpawnedHostOptions | ConnectedHostOptions;
const isConnected = (options: HostClientOptions): options is ConnectedHostOptions =>
  'transport' in options;
/**
 * Events the client delivers to its subscribers, derived from the protocol list. Delivery is an
 * allow-list, so an omitted type is silently dropped for every consumer rather than surfacing an
 * error: `statistics.updated` and `task.step` were missing, which left the live statistics activity
 * indicator and in-flight task step progress frozen until the run ended. Deriving the set from
 * AGENT_EVENT_TYPES means a new event type cannot be forgotten here.
 */
const eventTypes = new Set<string>(AGENT_EVENT_TYPES);
export class AgentHostClient {
  private options: HostClientOptions;
  private transport: HostTransport | null = null;
  private previousPid: number | undefined;
  private currentStatus: HostStatus = 'stopped';
  private pending = new HostRequests();
  private listeners = new Set<(event: AgentEvent) => void>();
  private statusListeners = new Set<(status: HostStatus) => void>();
  private starting: Promise<HostInfo> | null = null;
  private stopping: Promise<void> | null = null;
  private info: HostInfo | null = null;
  private closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }> = Promise.resolve(
    { code: 0, signal: null },
  );
  private generation = 0;
  /**
   * The highest log position this client has seen per session.
   *
   * Kept here rather than in a consumer because it is a fact about the link: every frame the client received
   * carried it (`AgentEvent.seq`), and the one thing a client can do with it is compare it against the log.
   * A frame that arrives out of order — or for a session this client has not loaded — still only ever moves
   * the mark forward, so the value can never claim to have seen more than it did.
   */
  private cursors = new Map<string, number>();
  /** Bounded local tail for classifying startup failures; never returned verbatim. */
  private stderrTail = '';
  private startupDiagnosis(): string {
    const tail = this.stderrTail;
    // A database written by a newer build is not corruption, and it is the one startup failure whose message
    // already says everything: the store refuses a shape it cannot know rather than guessing at it. Naming the
    // version is what turns "the Host died" into "this workspace was opened by a newer build", and the backup
    // is the recovery that keeps the data (see README 「会话数据库版本与备份」).
    const newerDatabase = /Unsupported session database version: (\d+)/.exec(tail);
    if (newerDatabase)
      return `DATABASE_VERSION: session database is v${newerDatabase[1]}, written by a newer build; back up .yuantu/sessions.sqlite and reopen the workspace with that build, or restore a backup`;
    if (/ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND/.test(tail))
      return 'ERR_MODULE_NOT_FOUND: Host dependency is missing; rebuild or reinstall the desktop runtime';
    if (/SQLITE_CORRUPT|SQLITE_NOTADB/.test(tail))
      return 'SQLITE_CORRUPT: session database needs repair from a backup';
    if (/SQLITE_CANTOPEN/.test(tail))
      return 'SQLITE_CANTOPEN: check session database path and permissions';
    if (/\bEACCES\b|\bEPERM\b/.test(tail))
      return 'EACCES: Host cannot access a required file or directory';
    if (/\bENOENT\b/.test(tail)) return 'ENOENT: Host entry or required path is missing';
    return '';
  }
  constructor(options: HostClientOptions) {
    if (!isConnected(options)) {
      for (const key of ['nodePath', 'hostPath', 'workspace'] as const)
        if (!path.isAbsolute(options[key])) throw new Error(`${key} must be an absolute path`);
    }
    for (const [key, value] of Object.entries({
      requestTimeoutMs: options.requestTimeoutMs ?? 10_000,
      shutdownTimeoutMs: options.shutdownTimeoutMs ?? 10_000,
      maxFrameBytes: options.maxFrameBytes ?? 64_000_000,
    })) {
      if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid ${key}`);
    }
    this.options = options;
  }
  get status(): HostStatus {
    return this.currentStatus;
  }
  /**
   * The Host process's id, while one is running.
   *
   * Exposed for supervision rather than convenience: the process that dies in a failure report has to be
   * nameable (a desktop logs it, an operator correlates it), and a test that has to reproduce a crash needs a
   * handle on the process it is crashing rather than a private field.
   */
  get pid(): number | undefined {
    return this.transport?.pid;
  }
  /**
   * The id of the last Host this client started, whether or not it is still running.
   *
   * `pid` is gone the moment the process is, which is exactly when something wants to say *which* process died;
   * the failure report and the error the crash produces both name it, so it outlives the child handle.
   */
  get lastPid(): number | undefined {
    return this.previousPid;
  }
  /**
   * Whether a Host that failed can be started again.
   *
   * True only after an abnormal end: a stop the caller asked for leaves the client in `stopped`, and starting
   * again is ordinary use rather than recovery.
   */
  /**
   * Whether a Host that failed can be started again.
   *
   * True only after an abnormal end: a stop the caller asked for leaves the client in `stopped`, and starting
   * again is ordinary use rather than recovery. A connected client never answers true, because it does not own
   * the Host it is talking to — restarting one is not something it can do, and the transport it holds points at
   * the Host that just went away. Reconnecting is the *carrier's* job: it is the side that knows how to reach a
   * Host, so it decides whether to open a new link and hand over a new client.
   */
  get recoverable(): boolean {
    return (
      !isConnected(this.options) &&
      this.currentStatus === 'failed' &&
      this.transport === null &&
      !this.stopping
    );
  }
  subscribe(listener: (event: AgentEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  /**
   * The log position this client has reached for a session: the newest `AgentEvent.seq` it has received.
   *
   * Zero means "nothing seen" — a session this client has only read, not watched. That is not the same as
   * being at the start of the log, which is why the read that rebuilds a session also records where the log
   * ended (`noteCursor`): a client that has re-read a session is level with it, even though it watched none
   * of it.
   */
  cursorOf(sessionId: string): number {
    return this.cursors.get(sessionId) ?? 0;
  }
  /** Record a position learned some other way than by receiving a frame — a replay, or a re-read. */
  noteCursor(sessionId: string, seq: number): void {
    if (!Number.isSafeInteger(seq) || seq < 0) return;
    if (seq > this.cursorOf(sessionId)) this.cursors.set(sessionId, seq);
  }
  /** Whether the Host this client is talking to advertised a capability. */
  supports(capability: string): boolean {
    return this.info?.capabilities.includes(capability) === true;
  }
  subscribeStatus(listener: (status: HostStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }
  private setStatus(status: HostStatus): void {
    this.currentStatus = status;
    for (const listener of this.statusListeners) {
      try {
        listener(status);
      } catch {
        /* A UI listener must not break process cleanup. */
      }
    }
  }
  start(): Promise<HostInfo> {
    if (this.currentStatus === 'ready' && this.info) return Promise.resolve(this.info);
    if (this.starting) return this.starting;
    if (this.transport || this.stopping)
      return Promise.reject(new Error('Host is still stopping; await stop() before restarting'));
    this.starting = this.launch().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }
  private async launch(): Promise<HostInfo> {
    this.setStatus('starting');
    this.stderrTail = '';
    const generation = ++this.generation;
    const transport = this.openTransport(generation);
    this.transport = transport;
    this.previousPid = transport.pid;
    try {
      // Host startup includes loading the runtime and workspace; a short ordinary RPC deadline
      // must not make the handshake fail before a long-running task can start.
      const info = await this.invoke(
        'host.info',
        { protocolVersions: [...HOST_PROTOCOL_VERSIONS] },
        Math.max(this.options.requestTimeoutMs ?? 10_000, 10_000),
      );
      validateHostInfo(info);
      if (this.currentStatus !== 'starting') throw new Error('Agent Host stopped during startup');
      this.info = info;
      if (info.capabilities.includes('runtime.ready') && !this.options.deferAutomatic)
        await this.invoke('runtime.ready', {}, 10_000);
      this.setStatus('ready');
      return info;
    } catch (error) {
      const diagnosis = this.startupDiagnosis();
      await this.stop().catch(() => {});
      this.setStatus('failed');
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(this.redact(diagnosis ? message + '; ' + diagnosis : message));
    }
  }
  /**
   * The link for this generation, however this carrier reaches the Host.
   *
   * A spawned Host is a child process this client supervises; a connected one already exists and the caller
   * supplied the link. Wiring is identical afterwards, which is what keeps the second carrier honest: the
   * protocol, the framing and the failure classification do not fork per carrier.
   */
  private openTransport(generation: number): HostTransport {
    if (isConnected(this.options)) return this.wireTransport(this.options.transport, generation);
    const options = this.options;
    const args = ['--workspace', options.workspace];
    if (options.db) args.push('--db', options.db);
    return this.wireTransport(
      stdioTransport({
        nodePath: options.nodePath,
        hostPath: options.hostPath,
        workspace: options.workspace,
        args,
        env: options.env,
        maxFrameBytes: options.maxFrameBytes,
        onSpawnError: () =>
          this.fail(new Error('Unable to spawn Agent Host; check Node executable and Host entry')),
      }),
      generation,
    );
  }
  private wireTransport(transport: HostTransport, generation: number): HostTransport {
    this.closed = new Promise((resolve) => {
      transport.onExit((exit) => {
        // An older generation's exit settles its own promise but must not touch current state: the child it
        // belonged to is already gone as far as this client is concerned.
        if (generation === this.generation) {
          this.transport = null;
          this.info = null;
          this.rejectPending(
            new HostDisconnectedError(
              `Agent Host exited (code=${exit.code}, signal=${exit.signal}); requests were not replayed`,
              this.previousPid,
            ),
          );
          if (this.currentStatus !== 'stopping' && this.currentStatus !== 'failed')
            this.setStatus('failed');
        }
        resolve(exit);
      });
    });
    transport.onError((error) => {
      if (generation === this.generation) this.fail(error);
    });
    transport.onDiagnostic((chunk) => {
      if (generation === this.generation) this.stderrTail = (this.stderrTail + chunk).slice(-4096);
    });
    transport.onLine((line) => {
      if (generation !== this.generation || this.currentStatus === 'failed') return;
      this.receive(line);
    });
    return transport;
  }
  private fail(error: Error): void {
    if (this.currentStatus === 'stopping') return;
    this.setStatus('failed');
    this.rejectPending(error);
    this.transport?.end();
  }
  private rejectPending(error: Error): void {
    this.pending.rejectAll(error);
  }
  private receive(line: string): void {
    let packet: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
      packet = parsed as Record<string, unknown>;
    } catch {
      this.fail(new Error('Invalid JSONL from Agent Host'));
      return;
    }
    if (packet.event) {
      const event = packet.event as AgentEvent;
      if (
        typeof event.type !== 'string' ||
        typeof event.sessionId !== 'string' ||
        typeof event.runId !== 'string' ||
        !event.data ||
        typeof event.data !== 'object' ||
        Array.isArray(event.data)
      ) {
        this.fail(new Error('Invalid Host event'));
        return;
      }
      if (event.type === 'run.finished')
        event.data = { ...event.data, result: this.cleanResult(event.data.result) };
      // The frame's cursor is recorded before delivery, so a listener that throws cannot cost the client its
      // place: what the client has *received* is what the cursor means, not what a consumer managed to use.
      // A Host that predates cursors sends none, and the mark simply stays where it was.
      if (Number.isSafeInteger(event.seq) && event.seq > 0)
        this.noteCursor(event.sessionId, event.seq);
      if (eventTypes.has(event.type))
        for (const listener of this.listeners) {
          try {
            listener(event);
          } catch {
            /* Isolate consumers from protocol dispatch. */
          }
        }
      return;
    }
    // An error with no id is the far side refusing the *link* rather than answering a request — the shape a
    // Host uses to turn a second connection away, or a bridge uses to report that it cannot serve this
    // client. Settling the client with the far side's own words beats parsing it as a malformed response.
    if (typeof packet.id !== 'string' && packet.error) {
      const message = (packet.error as { message?: unknown }).message;
      this.fail(
        new Error(
          this.redact(typeof message === 'string' ? message : 'Host refused the connection'),
        ),
      );
      return;
    }
    if (typeof packet.id !== 'string') {
      this.fail(new Error('Invalid Host response ID'));
      return;
    }
    const entry = this.pending.take(packet.id);
    if (!entry) return; // A timed-out response must not resolve a newer request.
    if (packet.error) {
      const message = (packet.error as { message?: unknown }).message;
      const code = (packet.error as { code?: unknown }).code;
      entry.reject(
        new HostRequestError(
          this.redact(typeof message === 'string' ? message : 'Host request failed'),
          entry.method,
          typeof code === 'string' ? code : undefined,
        ),
      );
    } else if ('result' in packet)
      entry.resolve(entry.method === 'run.start' ? this.cleanResult(packet.result) : packet.result);
    else entry.reject(new Error('Invalid Host response'));
  }
  private redact(message: string): string {
    return redactSecrets(message, { ...process.env, ...this.options.env });
  }
  private cleanResult(value: unknown): unknown {
    if (!value || typeof value !== 'object') return value;
    const result = value as Record<string, unknown>;
    return typeof result.error === 'string'
      ? { ...result, error: this.redact(result.error) }
      : result;
  }
  request<M extends HostMethod>(
    method: M,
    params: HostMethods[M]['params'],
  ): Promise<HostMethods[M]['result']> {
    if (this.currentStatus !== 'ready') return Promise.reject(new Error('Agent Host is not ready'));
    return this.invoke(
      method,
      params,
      HOST_LONG_REQUESTS.has(method) ? 0 : (this.options.requestTimeoutMs ?? 10_000),
    );
  }
  private invoke<M extends HostMethod>(
    method: M,
    params: HostMethods[M]['params'],
    timeoutMs: number,
  ): Promise<HostMethods[M]['result']> {
    const transport = this.transport;
    if (!transport?.writable) return Promise.reject(new Error('Agent Host is disconnected'));
    const id = randomUUID(),
      line = JSON.stringify({ id, method, params }) + '\n';
    if (Buffer.byteLength(line) > MAX_INPUT_BYTES)
      return Promise.reject(new Error('Host request exceeds 16MB limit'));
    return new Promise((resolve, reject) => {
      const entry: HostPendingRequest = {
        method,
        resolve: (value) => resolve(value as HostMethods[M]['result']),
        reject,
      };
      this.pending.add(id, entry, timeoutMs);
      // A refused write (`false`) is backpressure, not failure: the transport buffers. A write that really
      // fails surfaces on the transport's error channel and settles every pending entry, this one included.
      try {
        transport.send(line);
      } catch (error) {
        this.pending.take(id);
        reject(new HostRequestError(this.redact(String(error)), method, 'TRANSPORT_ERROR', true));
      }
    });
  }
  async run(
    sessionId: string,
    prompt: string,
    options: {
      signal?: AbortSignal;
      images?: ImageAttachment[];
      taskId?: string;
      /** Read-only planning phase. */
      phase?: 'plan';
      /** Execute an already-approved plan. */
      planId?: string;
    } = {},
  ): Promise<RunResult> {
    options.signal?.throwIfAborted();
    const pending = this.request('run.start', {
      sessionId,
      prompt,
      ...(options.images?.length ? { images: options.images } : {}),
      ...(options.taskId ? { taskId: options.taskId } : {}),
      ...(options.phase ? { phase: options.phase } : {}),
      ...(options.planId ? { planId: options.planId } : {}),
    });
    const abort = () => {
      void this.request('run.cancel', { sessionId }).catch(() => this.stop().catch(() => {}));
    };
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    try {
      return await pending;
    } finally {
      options.signal?.removeEventListener('abort', abort);
    }
  }
  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.stopping = this.close().finally(() => {
      this.stopping = null;
    });
    return this.stopping;
  }
  private async close(): Promise<void> {
    const transport = this.transport;
    if (!transport) {
      this.setStatus('stopped');
      return;
    }
    this.setStatus('stopping');
    transport.end();
    let timer: NodeJS.Timeout | undefined;
    const exit = await Promise.race([
      this.closed,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), this.options.shutdownTimeoutMs ?? 10_000);
      }),
    ]);
    if (timer) clearTimeout(timer);
    if (!exit) {
      transport.kill();
      this.rejectPending(
        new Error('Agent Host did not shut down gracefully; execution outcome is unknown'),
      );
      this.setStatus('failed');
      throw new Error('Agent Host shutdown timed out; descendant cleanup could not be confirmed');
    }
    if (exit.code !== 0 || exit.signal) {
      this.setStatus('failed');
      throw new Error(
        `Agent Host exited abnormally during shutdown (code=${exit.code}, signal=${exit.signal}); cleanup is unconfirmed`,
      );
    }
    this.transport = null;
    this.info = null;
    this.setStatus('stopped');
  }
}
