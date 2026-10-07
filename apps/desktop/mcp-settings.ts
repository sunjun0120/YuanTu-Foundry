import { mkdirSync, writeFileSync, renameSync, unlinkSync, realpathSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { resourcePath, resourceText } from '../../packages/resources/files.ts';
import { parseMcpConfigs } from '../../packages/mcp/config.ts';
import { mcpTools } from '../../packages/mcp/tools.ts';
import {
  McpOAuthTokenStore,
  authorizeMcpServer,
  readMcpOAuthStatus,
  revokeMcpAuthorization,
} from '../../packages/mcp/oauth.ts';
import type { McpServer, McpServerView, McpView } from './mcp-contract.ts';
/**
 * Credentials live outside the workspace. Electron supplies the profile directory so the desktop
 * and the agent host agree on one location; tests pass a temporary store.
 */
export type McpCredentialStore = McpOAuthTokenStore | string;
export class McpSettingsStore {
  private root: string;
  private credentials: McpOAuthTokenStore;
  constructor(root: string, credentials?: McpCredentialStore) {
    this.root = realpathSync(root);
    this.credentials =
      typeof credentials === 'string' || credentials === undefined
        ? new McpOAuthTokenStore(credentials ? { directory: credentials } : {})
        : credentials;
  }
  private read(): string {
    try {
      return resourceText(this.root, '.yuantu/mcp.json');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
      throw error;
    }
  }
  private revision(raw: string): string {
    return createHash('sha256').update(this.root).update('\0').update(raw).digest('hex');
  }
  private validate(server: McpServer, checkCwd = true): McpServer {
    // Authorization status is derived from the credential store and is display-only; dropping it
    // here means a renderer round-trip can never persist it into `.yuantu/mcp.json`.
    const { id, disabled, ...row } = this.persisted(server as McpServerView);
    if (disabled !== undefined && typeof disabled !== 'boolean')
      throw new Error('Invalid MCP disabled setting');
    const parsed = parseMcpConfigs(
      this.root,
      JSON.stringify({ servers: { [id]: row } }),
      checkCwd,
    )[0];
    if (!parsed) throw new Error('Invalid MCP server');
    return { ...parsed, disabled: disabled === true };
  }
  view(): McpView {
    const raw = this.read();
    parseMcpConfigs(this.root, raw || '{"servers":{}}', false);
    const rows = raw ? JSON.parse(raw).servers : {};
    const servers = Object.entries(rows).map(([id, value]) => {
      const parsed = this.validate({ ...(value as McpServer), id }, false);
      const status = readMcpOAuthStatus(parsed, this.credentials);
      return {
        ...parsed,
        authorized: status.authorized,
        ...(status.expiresAt ? { expiresAt: status.expiresAt } : {}),
        ...(status.scopes ? { scopes: status.scopes } : {}),
      };
    });
    return { workspace: this.root, revision: this.revision(raw), servers };
  }
  /**
   * View rows carry the authorization status, which is derived state and must never be persisted
   * into `.yuantu/mcp.json`.
   */
  private persisted(server: McpServerView): McpServer {
    const { authorized, expiresAt, scopes, ...rest } = server;
    return rest;
  }
  private write(servers: McpServer[], revision: string): McpView {
    if (this.revision(this.read()) !== revision)
      throw new Error('MCP configuration changed; reload before saving');
    const raw =
      JSON.stringify(
        { servers: Object.fromEntries(servers.map(({ id, ...row }) => [id, row])) },
        null,
        2,
      ) + '\n';
    parseMcpConfigs(this.root, raw);
    try {
      resourcePath(this.root, '.yuantu');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      mkdirSync(path.join(this.root, '.yuantu'));
    }
    const directory = resourcePath(this.root, '.yuantu');
    try {
      resourcePath(this.root, '.yuantu/mcp.json');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const temporary = path.join(directory, '.mcp-' + randomUUID() + '.tmp');
    try {
      writeFileSync(temporary, raw, { flag: 'wx', mode: 0o600 });
      if (this.revision(this.read()) !== revision)
        throw new Error('MCP configuration changed; reload before saving');
      renameSync(temporary, path.join(directory, 'mcp.json'));
    } finally {
      try {
        unlinkSync(temporary);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    return this.view();
  }
  save(server: McpServer, revision: string): McpView {
    const next = this.validate(server, !server.disabled),
      view = this.view();
    const servers = view.servers
      .filter((row) => row.id !== next.id)
      .map((row) => this.persisted(row));
    servers.push(next);
    return this.write(servers, revision);
  }
  delete(id: string, revision: string): McpView {
    const view = this.view();
    return this.write(
      view.servers.filter((row) => row.id !== id).map((row) => this.persisted(row)),
      revision,
    );
  }
  /**
   * Runs the interactive browser authorization for one remote server. The revision guard keeps a
   * stale editor from authorizing a server whose configuration changed in the meantime.
   */
  async authorize(
    server: McpServer,
    revision: string,
    openUrl: (url: URL) => void | Promise<void>,
    signal: AbortSignal,
  ): Promise<McpView> {
    const next = this.validate(server, !server.disabled);
    if (this.revision(this.read()) !== revision)
      throw new Error('MCP configuration changed; reload before authorizing');
    if (next.transport === 'stdio' || !next.oauth)
      throw new Error('MCP authorization requires a remote server with OAuth settings');
    await authorizeMcpServer({ config: next, store: this.credentials, openUrl, signal });
    return this.view();
  }
  /** Clears stored credentials for a saved server. Servers without OAuth settings are a no-op. */
  async revoke(id: string, revision: string): Promise<McpView> {
    if (this.revision(this.read()) !== revision)
      throw new Error('MCP configuration changed; reload before revoking');
    const saved = this.view().servers.find((server) => server.id === id);
    if (!saved) throw new Error('Unknown MCP server');
    if (saved.oauth) await revokeMcpAuthorization(saved, this.credentials);
    return this.view();
  }
  async test(
    server: McpServer,
    signal: AbortSignal,
    revision?: string,
  ): Promise<{ count: number }> {
    if (revision !== undefined && this.revision(this.read()) !== revision)
      throw new Error('MCP configuration changed; reload before testing');
    const next = this.validate(server);
    const connection = mcpTools(this.root, [next]);
    try {
      const result = await connection.tools[0]!.execute({}, { signal, approve: async () => true });
      if (result.isError) throw new Error(result.content);
      const listed = JSON.parse(result.content);
      return { count: listed.tools.length };
    } finally {
      await connection.close();
    }
  }
}
