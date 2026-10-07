import { resolveSandboxConfig } from '../tools/sandbox.ts';
import { executionPolicy, currentExecutionPolicy } from '../tools/execution-policy.ts';
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
 * Owns one language server connection per language for a single workspace. The
 * manager is created per run and closed by the tool registry, matching the
 * browser session lifecycle.
 */
export class LspManager {
  private readonly root: string;
  private servers?: LspServerDefinition[];
  private problems: string[] = [];
  private clients = new Map<string, LspClient>();
  private starting = new Map<string, Promise<LspClient>>();
  private closing = false;

  constructor(root: string) {
    this.root = root;
  }

  static enabled(): boolean {
    const mode = resolveSandboxConfig().mode;
    return mode === 'host' || mode === 'windows';
  }
  private assertEnabled(): void {
    if (!LspManager.enabled())
      throw new Error('Language server backend unsupported; disabled outside host or Windows mode');
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
  /** Only ever returns an already-running client; editing never starts a server. */
  async runningForFile(file: string): Promise<LspClient | undefined> {
    if (!LspManager.enabled()) return undefined;
    const definition = await this.definitionForFile(file);
    return definition ? this.running(definition.language) : undefined;
  }

  async start(language: string, signal: AbortSignal): Promise<LspClient> {
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
