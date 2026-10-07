import type { ChildProcess } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { localExecutionEnvironment } from '../tools/execution-environment.ts';
import {
  executionPolicy,
  snapshotExecutionPolicy,
  currentExecutionPolicy,
} from '../tools/execution-policy.ts';
import { resolveSandboxConfig } from '../tools/sandbox.ts';
import type { ExecutionPolicy } from '../protocol/execution.ts';
import {
  MessageDecoder,
  encodeMessage,
  pathToUri,
  severityName,
  toDisplayRange,
  uriToKey,
  uriToPath,
  type JsonRpcMessage,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type LspPosition,
  type LspRange,
} from './protocol.ts';
import type { LspServerDefinition } from './servers.ts';

const INITIALIZE_TIMEOUT_MS = 20_000;
const REQUEST_TIMEOUT_MS = 15_000;
export const DIAGNOSTIC_TIMEOUT_MS = 3_000;
const SHUTDOWN_TIMEOUT_MS = 2_000;
const MAX_STDERR_BYTES = 8_000;
const MAX_DIAGNOSTICS_PER_FILE = 200;
const MAX_DOCUMENT_BYTES = 2_000_000;
/**
 * How many documents this client keeps open at the server, and cached here, at once.
 *
 * Both sides used to keep every file the session had ever synchronised: two hundred documents open at the server
 * and two hundred full texts in this process, for the rest of the run. The bound is a working set rather than a
 * target — the newest synchronised documents are the ones a session keeps coming back to, and a set larger than
 * this is a workspace-wide sweep, which reads the files again anyway. What falls out is *closed* rather than
 * merely forgotten, so the server can release it too; a later query about it re-opens it, which costs one file
 * read and is the correct sequence.
 */
const MAX_OPEN_DOCUMENTS = 32;

export interface LspDiagnostic {
  path: string;
  severity: string;
  line: number;
  character: number;
  endLine: number;
  endCharacter: number;
  code?: string;
  source?: string;
  message: string;
}
export interface DiagnosticsResult {
  diagnostics: LspDiagnostic[];
  settled: boolean;
  documents: number;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

export class LspClient {
  readonly definition: LspServerDefinition;
  readonly root: string;
  private child?: ChildProcess;
  readonly policy: ExecutionPolicy;
  private managed?: Awaited<
    ReturnType<Awaited<ReturnType<typeof localExecutionEnvironment>>['processes']['start']>
  >;
  private cleanup?: Promise<void>;
  private stopPromise?: Promise<void>;
  private decoder = new MessageDecoder();
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private versions = new Map<string, number>();
  private generations = new Map<string, number>();
  private sentText = new Map<string, string>();
  /**
   * The URI each open document was announced with.
   *
   * Kept beside the cache key because the key is a *path* (lower-cased on Windows) while a server is told the
   * original URI: reconstructing one from the other would close a different document on exactly the platform
   * where the difference exists.
   */
  private openUris = new Map<string, string>();
  private published = new Map<string, { generation: number; diagnostics: LspDiagnostic[] }>();
  private waiters = new Map<string, Set<() => void>>();
  private stderr = '';
  private failure?: string;
  private stopping = false;
  private capabilities: Record<string, unknown> = {};

  constructor(
    definition: LspServerDefinition,
    root: string,
    policy = currentExecutionPolicy() ??
      executionPolicy(resolveSandboxConfig().mode, resolveSandboxConfig()),
  ) {
    this.definition = definition;
    this.root = root;
    this.policy = snapshotExecutionPolicy(policy);
  }

  assertPolicy(): void {
    const current =
      currentExecutionPolicy() ??
      executionPolicy(resolveSandboxConfig().mode, resolveSandboxConfig());
    if (JSON.stringify(current) !== JSON.stringify(this.policy))
      throw new Error(
        'Language server creation policy differs from this call; stop it and start a new server',
      );
  }

  get running(): boolean {
    return Boolean(this.child) && this.child?.exitCode === null && !this.failure && !this.stopping;
  }
  get documents(): number {
    return this.sentText.size;
  }
  get lastError(): string | undefined {
    return this.failure ?? (this.stderr.trim() ? this.stderr.trim().slice(-600) : undefined);
  }
  get serverCapabilities(): Record<string, unknown> {
    return this.capabilities;
  }
  /** Every diagnostic the server has published, across all files it analysed. */
  allDiagnostics(): LspDiagnostic[] {
    return [...this.published.values()].flatMap((entry) => entry.diagnostics);
  }
  /** Published diagnostics for one file, without synchronising it again. */
  cachedDiagnostics(file: string): LspDiagnostic[] {
    return this.published.get(uriToKey(pathToUri(file)))?.diagnostics ?? [];
  }

  private describeSpawnError(error: NodeJS.ErrnoException): Error {
    if (error.code === 'ENOENT')
      return new Error(
        `Language server "${this.definition.command}" was not found on PATH for ${this.definition.language}.` +
          (this.definition.install ? ` Install it with: ${this.definition.install}` : ''),
      );
    return new Error(
      `Language server "${this.definition.command}" could not start: ${error.message}`,
    );
  }

  async start(signal: AbortSignal): Promise<void> {
    if (this.running) {
      this.assertPolicy();
      return;
    }
    if (this.child)
      throw new Error(`Language server is not running: ${this.lastError ?? 'stopped'}`);
    signal.throwIfAborted();
    if (this.policy.mode !== 'host' && this.policy.mode !== 'windows')
      throw new Error('Language server backend unsupported; disabled outside host or Windows mode');
    const environment = await localExecutionEnvironment(this.root, this.policy);
    signal.throwIfAborted();
    const startup = new AbortController();
    const abort = () => startup.abort(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    let managed: NonNullable<LspClient['managed']>;
    try {
      managed = await environment.processes.start(
        this.definition.command,
        this.definition.args,
        '.',
        startup.signal,
        this.definition.env,
      );
    } catch (error) {
      signal.removeEventListener('abort', abort);
      throw error;
    }
    this.managed = managed;
    const child = managed.child;
    this.child = child;
    this.failure = undefined;
    this.stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => this.receive(chunk));
    child.stderr?.on('data', (chunk: Buffer) => {
      this.stderr = (this.stderr + chunk.toString('utf8')).slice(-MAX_STDERR_BYTES);
    });
    child.on('error', (error: NodeJS.ErrnoException) => this.fail(this.describeSpawnError(error)));
    child.on('close', (code, signalName) => {
      if (this.stopping) return;
      // Servers explain install problems on stderr; dropping it turns a precise,
      // actionable failure ("Unknown binary ... in official toolchain") into a
      // useless "exited with code 1". Node emits close after stdio has drained,
      // so the buffer is complete here.
      const detail = this.stderr.trim();
      this.fail(
        new Error(
          `Language server exited unexpectedly (code ${code ?? 'null'}${signalName ? `, signal ${signalName}` : ''})` +
            (detail ? `: ${detail.slice(-600)}` : ''),
        ),
      );
    });
    // initialize reports a spawn/transport error through pending requests as well.
    void managed.closed.catch((error) =>
      this.fail(error instanceof Error ? error : new Error(String(error))),
    );
    try {
      await this.initialize(signal);
    } catch (error) {
      // The server never finished the handshake, so it is useless to the caller. Leaving it running
      // would leak a process that keeps holding the workspace. stop() performs the shutdown/exit
      // handshake and then kills the tree, and also sets `stopping` so the kill is not reported as
      // an unexpected exit.
      await this.stop();
      throw error;
    } finally {
      signal.removeEventListener('abort', abort);
    }
  }

  private async initialize(signal: AbortSignal): Promise<void> {
    const rootUri = pathToUri(this.root);
    const result = await this.request(
      'initialize',
      {
        processId: process.pid,
        clientInfo: { name: 'yuantu-agent', version: '0.1.0' },
        rootUri,
        workspaceFolders: [{ uri: rootUri, name: path.basename(this.root) || 'workspace' }],
        capabilities: {
          workspace: { workspaceFolders: true, configuration: true, symbol: {} },
          textDocument: {
            synchronization: { dynamicRegistration: false },
            publishDiagnostics: { relatedInformation: false, versionSupport: true },
            hover: { contentFormat: ['markdown', 'plaintext'] },
            definition: { linkSupport: false },
            references: {},
            documentSymbol: { hierarchicalDocumentSymbolSupport: true },
            rename: { prepareSupport: false },
            codeAction: {
              codeActionLiteralSupport: {
                codeActionKind: {
                  valueSet: [
                    '',
                    'quickfix',
                    'refactor',
                    'refactor.extract',
                    'refactor.inline',
                    'refactor.rewrite',
                    'source',
                    'source.organizeImports',
                    'source.fixAll',
                  ],
                },
              },
              isPreferredSupport: true,
              // Without this the server must inline the edit instead of asking
              // for codeAction/resolve, which this client does not implement.
              dataSupport: false,
            },
          },
        },
      },
      signal,
      INITIALIZE_TIMEOUT_MS,
    );
    this.capabilities =
      result && typeof result === 'object'
        ? ((result as { capabilities?: Record<string, unknown> }).capabilities ?? {})
        : {};
    this.notify('initialized', {});
  }

  private write(message: JsonRpcMessage): void {
    const stdin = this.child?.stdin;
    if (!stdin || stdin.destroyed) throw new Error('Language server stdin is not writable');
    stdin.write(encodeMessage(message));
  }
  private notify(method: string, params: unknown): void {
    this.write({ jsonrpc: '2.0', method, params } as JsonRpcNotification);
  }
  /**
   * Tell the server to stop working on a request nobody is waiting for any more.
   *
   * `$/cancelRequest` is the protocol's own cancellation and it is a notification, so it needs no answer and no
   * pending entry. It matters because the requests this client sends are the expensive ones — a workspace-wide
   * `references`, a `rename` a server computes before answering — and without it a Stop or a timeout abandoned
   * the answer while the server kept computing it, on a process that a run's cancellation is supposed to quiet.
   *
   * Best-effort by construction: the caller is being told about its own cancellation, so a server whose stdin is
   * already gone must not turn that into a second, unrelated failure.
   */
  private cancelRequest(id: number): void {
    try {
      this.notify('$/cancelRequest', { id });
    } catch {
      /* Nothing to cancel on a server we can no longer write to. */
    }
  }
  private request(
    method: string,
    params: unknown,
    signal: AbortSignal,
    timeoutMs = REQUEST_TIMEOUT_MS,
  ): Promise<unknown> {
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      let timer: NodeJS.Timeout;
      const settle = (run: () => void) => {
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        this.pending.delete(id);
        run();
      };
      /**
       * Give up on the answer *and* on the work behind it.
       *
       * The two ways of stopping are one thing here: an aborted signal and an expired timeout both mean this
       * request will never be read, and a server left computing an unread answer is work a Stop was supposed to
       * end.
       */
      const abandon = (error: Error) =>
        settle(() => {
          this.cancelRequest(id);
          reject(error);
        });
      const abort = () => abandon(signal.reason ?? new Error('aborted'));
      timer = setTimeout(
        () => abandon(new Error(`Language server did not answer ${method} within ${timeoutMs}ms`)),
        timeoutMs,
      );
      if (signal.aborted) {
        abort();
        return;
      }
      signal.addEventListener('abort', abort, { once: true });
      this.pending.set(id, {
        resolve: (value) => settle(() => resolve(value)),
        reject: (error) => settle(() => reject(error)),
      });
      try {
        this.write({ jsonrpc: '2.0', id, method, params } as JsonRpcRequest);
      } catch (error) {
        settle(() => reject(error instanceof Error ? error : new Error(String(error))));
      }
    });
  }

  /** Public request used by navigation tools; the server must already be running. */
  send(
    method: string,
    params: unknown,
    signal: AbortSignal,
    timeoutMs = REQUEST_TIMEOUT_MS,
  ): Promise<unknown> {
    this.assertRunning();
    return this.request(method, params, signal, timeoutMs);
  }

  private receive(chunk: Buffer): void {
    let messages: JsonRpcMessage[];
    try {
      messages = this.decoder.push(chunk);
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    for (const message of messages) this.handle(message);
  }

  private handle(message: JsonRpcMessage): void {
    const method = (message as JsonRpcRequest).method;
    const id = (message as JsonRpcResponse).id;
    if (typeof method === 'string') {
      if (id !== undefined && id !== null) this.answer(message as JsonRpcRequest);
      else this.observe(message as JsonRpcNotification);
      return;
    }
    if (id === undefined || id === null) return;
    const entry = this.pending.get(Number(id));
    if (!entry) return;
    this.pending.delete(Number(id));
    const response = message as JsonRpcResponse;
    if (response.error)
      entry.reject(
        new Error(`Language server error ${response.error.code}: ${response.error.message}`),
      );
    else entry.resolve(response.result);
  }

  /**
   * Servers block on these, so every request is answered: known methods with a
   * usable result and anything else with MethodNotFound.
   */
  private answer(request: JsonRpcRequest): void {
    let result: unknown = null;
    let error: { code: number; message: string } | undefined;
    switch (request.method) {
      case 'workspace/configuration': {
        const items = (request.params as { items?: unknown[] } | undefined)?.items;
        result = Array.isArray(items) ? items.map(() => null) : [];
        break;
      }
      case 'workspace/workspaceFolders':
        result = [{ uri: pathToUri(this.root), name: path.basename(this.root) || 'workspace' }];
        break;
      case 'client/registerCapability':
      case 'client/unregisterCapability':
      case 'window/workDoneProgress/create':
      case 'window/showMessageRequest':
        result = null;
        break;
      default:
        error = { code: -32601, message: `Unsupported request: ${request.method}` };
    }
    try {
      this.write(
        error
          ? { jsonrpc: '2.0', id: request.id, error }
          : { jsonrpc: '2.0', id: request.id, result },
      );
    } catch {
      // The connection is already gone; the failure path reports it.
    }
  }

  private observe(message: JsonRpcNotification): void {
    if (message.method !== 'textDocument/publishDiagnostics') return;
    const params = message.params as
      { uri?: string; diagnostics?: unknown[]; version?: number | null } | undefined;
    if (!params || typeof params.uri !== 'string') return;
    const key = uriToKey(params.uri);
    const file = uriToPath(params.uri) ?? params.uri;
    const diagnostics = (Array.isArray(params.diagnostics) ? params.diagnostics : [])
      .slice(0, MAX_DIAGNOSTICS_PER_FILE)
      .flatMap((item) => {
        const diagnostic = toDiagnostic(file, item);
        return diagnostic ? [diagnostic] : [];
      });
    this.published.set(key, { generation: this.generations.get(key) ?? 0, diagnostics });
    for (const resolve of this.waiters.get(key) ?? []) resolve();
    this.waiters.delete(key);
  }

  private fail(error: Error): void {
    if (this.failure) return;
    this.failure = error.message;
    for (const entry of this.pending.values()) entry.reject(error);
    this.pending.clear();
    for (const set of this.waiters.values()) for (const resolve of set) resolve();
    this.waiters.clear();
    /**
     * A failed client gives up its process, because nothing else will.
     *
     * `manager.running()` answers `undefined` for a client with a failure, so the next request for that language
     * builds a *new* client and overwrites the map entry — the failed one is not stopped on the way out, and its
     * child kept running with the workspace open for the life of the host. A server whose bytes this client
     * cannot decode is the case that needs the kill most: it is not a server that will answer a `shutdown` we
     * cannot parse the reply to, so the graceful handshake `stop()` sends is skipped deliberately and the tree is
     * killed instead. `stopping` is left alone so the `close` handler still reports an unexpected exit — which is
     * what this is — except that `failure` is already set, so the first, specific reason is the one that stands.
     */
    this.cleanup ??= this.releaseProcess();
    void this.cleanup.catch(() => {});
  }
  private assertRunning(): void {
    this.assertPolicy();
    if (!this.running)
      throw new Error(
        `Language server for ${this.definition.language} is not running${this.lastError ? `: ${this.lastError}` : ''}`,
      );
  }

  private async readDocument(file: string): Promise<string> {
    const text = await readFile(file, 'utf8');
    if (Buffer.byteLength(text) > MAX_DOCUMENT_BYTES)
      throw new Error('File is too large for language server synchronisation (2MB limit)');
    return text;
  }
  /**
   * Full document sync: send the whole file, and skip the write when it is unchanged.
   *
   * `force` is for the caller that has *reason* to believe the server's copy is stale even though ours is not
   * (an edit made outside this client): it re-sends the text and, because the document is still open, sends it as
   * a change. Without that distinction the refresh below would announce a document the server already has with a
   * second `didOpen`, which is a protocol violation rather than a refresh.
   */
  private async syncDocument(file: string, signal: AbortSignal, force = false): Promise<string> {
    const text = await this.readDocument(file);
    signal.throwIfAborted();
    const uri = pathToUri(file);
    const key = uriToKey(uri);
    if (!force && this.sentText.get(key) === text) return key;
    const version = (this.versions.get(key) ?? 0) + 1;
    this.versions.set(key, version);
    this.generations.set(key, (this.generations.get(key) ?? 0) + 1);
    if (this.sentText.has(key))
      this.notify('textDocument/didChange', {
        textDocument: { uri, version },
        contentChanges: [{ text }],
      });
    else
      this.notify('textDocument/didOpen', {
        textDocument: { uri, languageId: this.definition.language, version, text },
      });
    this.sentText.set(key, text);
    this.openUris.set(key, uri);
    this.releaseBeyond();
    return key;
  }
  /**
   * Close the documents that have fallen out of the working set.
   *
   * A `Map` iterates in insertion order and re-setting a key moves it to the end, so the first key is the least
   * recently synchronised document — which is the one to close. Closing is what lets the server drop the file;
   * forgetting it here is what makes a later query open it again instead of sending a change for a document the
   * server no longer has.
   */
  private releaseBeyond(): void {
    while (this.sentText.size > MAX_OPEN_DOCUMENTS) {
      const oldest = this.sentText.keys().next().value;
      if (oldest === undefined) return;
      this.sentText.delete(oldest);
      const uri = this.openUris.get(oldest);
      this.openUris.delete(oldest);
      this.versions.delete(oldest);
      this.generations.delete(oldest);
      this.published.delete(oldest);
      if (!uri) continue;
      try {
        this.notify('textDocument/didClose', { textDocument: { uri } });
      } catch {
        // A server we can no longer write to is not a reason to keep its documents in this cache.
      }
    }
  }
  /**
   * Re-read a file the server already knows about after an out-of-band change.
   *
   * A change, never a second `didOpen`: the document is still open at the server, and it is this client's own
   * text that is stale. Deleting the cache entry to force a resend is what made this announce an open document
   * twice — the sequence a server is entitled to reject, and one that leaves it holding two copies of the same
   * file.
   */
  async refreshDocument(file: string, signal: AbortSignal): Promise<void> {
    this.assertRunning();
    const key = uriToKey(pathToUri(file));
    if (!this.sentText.has(key)) return;
    await this.syncDocument(file, signal, true);
  }
  /**
   * Push the current text without waiting for diagnostics. A server answers
   * navigation as soon as the document is open, so waiting for a publish here
   * would only add latency to the first query of every file.
   */
  async sync(file: string, signal: AbortSignal): Promise<void> {
    this.assertRunning();
    await this.syncDocument(file, signal);
  }

  private waitForPublish(key: string, ms: number, signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let timer: NodeJS.Timeout;
      const finish = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        this.waiters.get(key)?.delete(finish);
        resolve();
      };
      const abort = () => {
        clearTimeout(timer);
        this.waiters.get(key)?.delete(finish);
        reject(signal.reason ?? new Error('aborted'));
      };
      timer = setTimeout(finish, ms);
      if (signal.aborted) {
        abort();
        return;
      }
      signal.addEventListener('abort', abort, { once: true });
      const set = this.waiters.get(key) ?? new Set<() => void>();
      set.add(finish);
      this.waiters.set(key, set);
    });
  }

  /**
   * Synchronise the file, then wait for a publish that is at least as new as our
   * edit. The wait is always bounded: a still-indexing server must not block the run.
   */
  async diagnostics(
    file: string,
    signal: AbortSignal,
    timeoutMs = DIAGNOSTIC_TIMEOUT_MS,
  ): Promise<DiagnosticsResult> {
    this.assertRunning();
    const key = await this.syncDocument(file, signal);
    const generation = this.generations.get(key) ?? 0;
    const settledNow = this.published.get(key);
    if (settledNow && settledNow.generation >= generation)
      return { diagnostics: settledNow.diagnostics, settled: true, documents: this.documents };
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await this.waitForPublish(key, remaining, signal);
      // A dead server resolves its waiters; report why instead of reporting "no diagnostics".
      if (!this.running) this.assertRunning();
      const entry = this.published.get(key);
      if (entry && entry.generation >= generation)
        return { diagnostics: entry.diagnostics, settled: true, documents: this.documents };
    }
    this.assertRunning();
    return {
      diagnostics: this.published.get(key)?.diagnostics ?? [],
      settled: false,
      documents: this.documents,
    };
  }

  private async releaseProcess(): Promise<void> {
    const managed = this.managed;
    if (!managed) return;
    if (managed.child.exitCode === null && managed.child.signalCode === null) await managed.stop();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        managed.closed,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            const error = new Error('Language server cleanup is unconfirmed');
            error.name = 'ToolCleanupError';
            reject(error);
          }, 5000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    this.child = undefined;
  }
  stop(): Promise<void> {
    return (this.stopPromise ??= this.stopOnce());
  }
  private async stopOnce(): Promise<void> {
    this.stopping = true;
    if (this.cleanup) {
      await this.cleanup;
      return;
    }
    const managed = this.managed;
    if (!managed) return;
    if (this.child && this.child.exitCode === null && !this.failure) {
      try {
        await this.request('shutdown', null, AbortSignal.timeout(SHUTDOWN_TIMEOUT_MS));
        this.notify('exit', null);
      } catch {
        /* A server that ignores shutdown is stopped below. */
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        managed.closed.catch(() => {}),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, 1000);
        }),
      ]);
      clearTimeout(timer);
    }
    this.cleanup ??= this.releaseProcess();
    await this.cleanup;
  }
}

function toDiagnostic(file: string, item: unknown): LspDiagnostic | undefined {
  if (!item || typeof item !== 'object') return undefined;
  const value = item as {
    range?: LspRange;
    severity?: number;
    code?: string | number;
    source?: string;
    message?: string;
  };
  const range = value.range;
  if (!range || typeof range.start?.line !== 'number' || typeof range.start?.character !== 'number')
    return undefined;
  const position = toDisplayRange({
    start: range.start as LspPosition,
    end: {
      line: typeof range.end?.line === 'number' ? range.end.line : range.start.line,
      character:
        typeof range.end?.character === 'number' ? range.end.character : range.start.character,
    },
  });
  return {
    path: file,
    severity: severityName(value.severity),
    ...position,
    ...(value.code === undefined ? {} : { code: String(value.code) }),
    ...(value.source ? { source: String(value.source).slice(0, 80) } : {}),
    message: String(value.message ?? '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 500),
  };
}
