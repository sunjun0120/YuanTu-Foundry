import path from 'node:path';
import { resourcePath, resourceText } from '../resources/files.ts';
import { statSync } from 'node:fs';

/**
 * OAuth 2.1 settings for one remote MCP server. Presence of this object turns on the
 * authorization-code + PKCE flow for that server; the tokens themselves live outside the
 * workspace in the MCP credential store, never in `.yuantu/mcp.json`.
 */
export interface McpOAuthConfig {
  scopes?: string[];
  clientId?: string;
  clientSecret?: string;
  clientName?: string;
  redirectPort?: number;
}
export interface McpConfig {
  id: string;
  transport: 'stdio' | 'http' | 'sse';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  oauth?: McpOAuthConfig;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid MCP configuration object');
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > 4096 ||
    /[\x00-\x1f]/.test(value)
  )
    throw new Error('Invalid MCP configuration string');
  return value;
}
function dictionary(value: unknown, headers = false): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  const rows = Object.entries(object(value));
  if (rows.length > 32) throw new Error('MCP environment/header limit is 32');
  return Object.fromEntries(
    rows.map(([key, value]) => {
      if (!(headers ? /^[A-Za-z0-9-]+$/ : /^[A-Za-z_][A-Za-z0-9_]*$/).test(key))
        throw new Error('Invalid MCP environment/header name');
      const raw = text(value);
      if (
        /authorization|cookie|key|token|secret|password|credential/i.test(key) &&
        !(
          headers && /^authorization$/i.test(key)
            ? /^(?:(?:Bearer|Basic) )?\$\{[A-Za-z_][A-Za-z0-9_]*\}$/i
            : /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/
        ).test(raw)
      )
        throw new Error('MCP credentials must use an environment placeholder');
      return [key, raw];
    }),
  );
}
function oauth(value: unknown): McpOAuthConfig | undefined {
  if (value === undefined) return undefined;
  const row = object(value);
  const allowed = ['scopes', 'clientId', 'clientSecret', 'clientName', 'redirectPort'];
  if (Object.keys(row).some((key) => !allowed.includes(key)))
    throw new Error('Unknown MCP OAuth configuration field');
  const result: McpOAuthConfig = {};
  if (row.scopes !== undefined) {
    if (!Array.isArray(row.scopes) || !row.scopes.length || row.scopes.length > 16)
      throw new Error('MCP OAuth scopes must be a non-empty list of at most 16 entries');
    const scopes = row.scopes.map((scope) => {
      if (typeof scope !== 'string' || !/^[A-Za-z0-9._:/-]{1,128}$/.test(scope))
        throw new Error('Invalid MCP OAuth scope');
      return scope;
    });
    if (new Set(scopes).size !== scopes.length) throw new Error('Duplicate MCP OAuth scope');
    result.scopes = scopes;
  }
  if (row.clientId !== undefined) result.clientId = text(row.clientId);
  if (row.clientName !== undefined) result.clientName = text(row.clientName);
  if (row.clientSecret !== undefined) {
    const secret = text(row.clientSecret);
    if (!/^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(secret))
      throw new Error('MCP OAuth client secret must use an environment placeholder');
    result.clientSecret = secret;
  }
  if (row.redirectPort !== undefined) {
    const port = row.redirectPort;
    if (!Number.isInteger(port) || (port as number) < 1024 || (port as number) > 65535)
      throw new Error('MCP OAuth redirect port must be an integer between 1024 and 65535');
    result.redirectPort = port as number;
  }
  return result;
}
export function readMcpConfigs(root: string): McpConfig[] {
  let raw: string;
  try {
    raw = resourceText(root, '.yuantu/mcp.json');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return parseMcpConfigs(root, raw);
}
export function parseMcpConfigs(root: string, raw: string, checkCwd = true): McpConfig[] {
  if (Buffer.byteLength(raw, 'utf8') > 32768) throw new Error('MCP configuration exceeds 32KB');
  let parsed: Record<string, unknown>;
  try {
    parsed = object(JSON.parse(raw));
  } catch {
    throw new Error('Invalid .yuantu/mcp.json');
  }
  if (Object.keys(parsed).some((key) => key !== 'servers'))
    throw new Error('Unknown MCP configuration field');
  const servers = Object.entries(object(parsed.servers));
  if (servers.length > 16) throw new Error('At most 16 MCP servers are supported');
  return servers.flatMap<McpConfig>(([id, value]) => {
    if (!/^[a-z][a-z0-9_]{0,31}$/.test(id)) throw new Error('Invalid MCP server name');
    const row = object(value);
    if (row.disabled !== undefined && typeof row.disabled !== 'boolean')
      throw new Error('Invalid MCP disabled setting');
    if (row.disabled === true) return [];
    if (row.transport !== 'stdio' && row.transport !== 'http' && row.transport !== 'sse')
      throw new Error('Invalid MCP transport');
    const allowed =
      row.transport === 'stdio'
        ? ['transport', 'disabled', 'command', 'args', 'env', 'cwd']
        : ['transport', 'disabled', 'url', 'headers', 'oauth'];
    if (Object.keys(row).some((key) => !allowed.includes(key)))
      throw new Error('Unknown MCP server configuration field');
    if (row.transport === 'stdio' && row.oauth !== undefined)
      throw new Error('MCP OAuth requires the http or sse transport');
    if (row.transport === 'stdio') {
      const args = row.args ?? [];
      if (!Array.isArray(args) || args.length > 64) throw new Error('Invalid MCP arguments');
      const cwd = row.cwd === undefined ? '.' : text(row.cwd);
      const relative = path.relative(path.resolve(root), path.resolve(root, cwd));
      if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative))
        throw new Error('MCP cwd must stay within workspace');
      if (checkCwd && !statSync(resourcePath(root, cwd)).isDirectory())
        throw new Error('MCP cwd must be a workspace directory');
      return [
        {
          id,
          transport: 'stdio' as const,
          command: text(row.command),
          args: args.map(text),
          env: dictionary(row.env),
          cwd,
        },
      ];
    }
    const url = new URL(text(row.url));
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.protocol !== 'https:' &&
        !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
    )
      throw new Error(
        'MCP URL requires HTTPS (HTTP allowed for loopback), no credentials/query/fragment',
      );
    const oauthConfig = oauth(row.oauth);
    const headers = dictionary(row.headers, true);
    if (oauthConfig && Object.keys(headers ?? {}).some((name) => /^authorization$/i.test(name)))
      throw new Error('MCP OAuth cannot be combined with a static Authorization header');
    return [
      {
        id,
        transport: row.transport,
        url: url.href,
        headers,
        ...(oauthConfig ? { oauth: oauthConfig } : {}),
      },
    ];
  });
}

/**
 * Resolves `${VAR}` references in OAuth settings through the process environment, recording
 * every resolved value so callers can redact it. Values are never written back to the config.
 */
export function resolveOAuthEnvironment(
  config: McpOAuthConfig | undefined,
  secrets: Set<string>,
): McpOAuthConfig | undefined {
  if (!config) return undefined;
  const resolved = { ...config };
  for (const key of ['clientId', 'clientSecret', 'clientName'] as const) {
    const raw = resolved[key];
    if (raw === undefined) continue;
    resolved[key] = raw.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => {
      const value = process.env[name];
      if (!value) throw new Error(`Missing MCP environment variable: ${name}`);
      secrets.add(value);
      return value;
    });
  }
  return resolved;
}

export function resolveEnvironment(
  values: Record<string, string> | undefined,
  secrets: Set<string>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values ?? {}).map(([key, raw]) => [
      key,
      raw.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => {
        const value = process.env[name];
        if (!value) throw new Error(`Missing MCP environment variable: ${name}`);
        secrets.add(value);
        return value;
      }),
    ]),
  );
}
