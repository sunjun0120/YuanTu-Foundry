import { resolveSandboxConfig } from '../sandbox/sandbox.ts';
import { executionPolicy, currentExecutionPolicy } from '../sandbox/execution-policy.ts';
import { LspClient } from './client.ts';
import {
  languageForFile,
  resolveServerCommand,
  resolveServers,
  type LspServerDefinition,
} from './servers.ts';

export interface LspServerStatus {
  backend?: LspClient['policy']['mode'];
  language: string;
  command: string;
  args: string[];
  extensions: string[];
  running: boolean;
  /** True when the command was found on PATH or in node_modules/.bin; it is not proof it runs. */
  available: boolean;
  executable?: string;
  /** How the command was resolved: a local package entry, node_modules/.bin, or PATH. */
  via?: string;
  documents?: number;
  install?: string;
  notes?: string;
  error?: string;
}

/**
 * Owns one language server connection per language for a single workspace.
 *
 * A session's manager is pooled across its runs and closed when idle, when the session is deleted, or with the Host
 * (`../catalog/resource-pool.ts`); a registry outside a session owns one for its own lifetime.
 */
/** How many times a crashed server is restarted before it is left for an explicit start. */
const MAX_RESTARTS = 3;
const RESTART_TIMEOUT_MS = 30_000;

export class LspManager {
  private readonly root: string;
  private servers?: LspServerDefinition[];
  private problems: string[] = [];
  private clients = new Map<string, LspClient>();
  private starting = new Map<string, Promise<LspClient>>();
  private closing = false;
  /** How many times each language's server was restarted after it died on its own; see `revive`. */
  private restarts = new Map<string, number>();

  constructor(root: string) {
    this.root = root;
  }

  static enabled(): boolean {
    const mode = resolveSandboxConfig().mode;
    return ['host', 'native', 'windows', 'windows-account', 'seatbelt'].includes(mode);
  }
  private assertEnabled(): void {
    if (!LspManager.enabled()) throw new Error('Language server backend unsupported');
  }

  async catalog(): Promise<{ servers: LspServerDefinition[]; problems: string[] }> {
    if (!this.servers) {
      const resolved = await resolveServers(this.root);
      this.servers = resolved.servers;
      this.problems = resolved.problems;
    }
    return { servers: this.servers, problems: this.problems };
  }
  async definitionFor(language: string): Promise<LspServerDefinition | undefined> {
    const { servers } = await this.catalog();
    return servers.find((server) => server.language === language);
  }
  async definitionForFile(file: string): Promise<LspServerDefinition | undefined> {
    const { servers } = await this.catalog();
    return languageForFile(file, servers);
  }
  running(language: string): LspClient | undefined {
    const client = this.clients.get(language);
    if (client?.running) {
      client.assertPolicy();
      return client;
    }
    return undefined;
  }
  runningLanguages(): string[] {
    return [...this.clients.entries()]
      .filter(([, client]) => {
        if (!client.running) return false;
        client.assertPolicy();
        return true;
      })
      .map(([language]) => language);
  }
  /**
   * Only ever returns a client that was started on purpose; editing never starts a server.
   *
   * A server that was started and then died on its own is restarted here (`revive`), within its limit: that is a
   * server somebody already approved, not a new one.
   */
  async runningForFile(file: string): Promise<LspClient | undefined> {
    if (!LspManager.enabled()) return undefined;
    const definition = await this.definitionForFile(file);
    if (!definition) return undefined;
    return this.running(definition.language) ?? (await this.revive(definition.language));
  }

  /**
   * Starts again a server that crashed, at most `MAX_RESTARTS` times until it is started on purpose again.
   *
   * A manager now lives for a whole session, so a server that exits — an out-of-memory kill, a crash on one file —
   * would otherwise stay dead for the rest of it, and every request would answer "not running" until the model
   * thought to start it again, so a crashed server is restarted, a bounded number of times. A restart
   * reuses the approval the first start had only while the execution policy is the one it was approved under —
   * after a policy change the crashed server is left for an explicit `lsp_start`.
   */
  private async revive(language: string): Promise<LspClient | undefined> {
    const crashed = this.clients.get(language);
    if (!crashed || crashed.running || this.closing) return undefined;
    const restarts = this.restarts.get(language) ?? 0;
    if (restarts >= MAX_RESTARTS) return undefined;
    try {
      crashed.assertPolicy();
    } catch {
      return undefined;
    }
    this.restarts.set(language, restarts + 1);
    try {
      return await this.start(language, AbortSignal.timeout(RESTART_TIMEOUT_MS), true);
    } catch {
      return undefined;
    }
  }

  async start(language: string, signal: AbortSignal, revival = false): Promise<LspClient> {
    // A start asked for on purpose gives the server its full restart allowance again.
    if (!revival) this.restarts.delete(language);
    if (this.closing) throw new Error('Language server manager is closing');
    this.assertEnabled();
    signal.throwIfAborted();
    const existing = this.running(language);
    if (existing) return existing;
    const pending = this.starting.get(language);
    if (pending) {
      const client = await pending;
      client.assertPolicy();
      return client;
    }
    const policy =
      currentExecutionPolicy() ??
      executionPolicy(resolveSandboxConfig().mode, resolveSandboxConfig());
    const started = (async () => {
      const previous = this.clients.get(language);
      if (previous) await previous.stop();
      const definition = await this.definitionFor(language);
      if (!definition)
        throw new Error(
          'No language server is configured for "' +
            language +
            '"; declare one in .yuantu/lsp.json',
        );
      const resolved = await resolveServerCommand(this.root, definition);
      if (!resolved)
        throw new Error(
          '"' +
            definition.command +
            '" was not found for ' +
            language +
            '.' +
            (definition.install ? ' Install it with: ' + definition.install : ''),
        );
      signal.throwIfAborted();
      const client = new LspClient(
        { ...definition, command: resolved.command, args: resolved.args },
        this.root,
        policy,
      );
      this.clients.set(language, client);
      try {
        await client.start(signal);
        return client;
      } catch (error) {
        await client.stop();
        this.clients.delete(language);
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(
          definition.install && !message.includes(definition.install)
            ? message + '\nInstall or repair it with: ' + definition.install
            : message,
        );
      }
    })().finally(() => {
      this.starting.delete(language);
    });
    this.starting.set(language, started);
    return started;
  }
  async stop(language: string): Promise<boolean> {
    await this.starting.get(language)?.catch(() => undefined);
    const client = this.clients.get(language);
    if (!client) return false;
    await client.stop();
    this.clients.delete(language);
    return true;
  }
  async status(): Promise<{ servers: LspServerStatus[]; problems: string[] }> {
    const { servers, problems } = await this.catalog();
    const enabled = LspManager.enabled();
    const rows: LspServerStatus[] = [];
    for (const definition of servers) {
      const resolved = await resolveServerCommand(this.root, definition);
      const client = this.clients.get(definition.language);
      const running = Boolean(client?.running);
      rows.push({
        language: definition.language,
        command: definition.command,
        args: definition.args,
        extensions: definition.extensions,
        running,
        available: Boolean(resolved) && enabled,
        ...(resolved ? { executable: resolved.command, via: resolved.via } : {}),
        ...(running && client ? { documents: client.documents } : {}),
        ...(definition.install ? { install: definition.install } : {}),
        ...(definition.notes ? { notes: definition.notes } : {}),
        ...(running && client?.lastError ? { error: client.lastError } : {}),
        ...(client ? { backend: client.policy.mode } : {}),
        ...(enabled ? {} : { error: 'disabled outside host or Windows sandbox mode' }),
      });
    }
    return { servers: rows, problems };
  }

  async close(): Promise<void> {
    this.closing = true;
    await Promise.allSettled([...this.starting.values()]);
    const clients = [...this.clients.values()];
    this.clients.clear();
    this.starting.clear();
    const results = await Promise.allSettled(clients.map((client) => client.stop()));
    const failure = results.find((result) => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
  }
}
