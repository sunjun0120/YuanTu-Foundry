import type { McpConfig } from '../../packages/mcp/config.ts';
export type McpServer = McpConfig & { disabled?: boolean };
/**
 * A configured server plus its secret-free authorization state. `authorized` only says whether
 * usable tokens exist in the MCP credential store; tokens and client secrets never cross IPC.
 */
export type McpServerView = McpServer & {
  authorized: boolean;
  expiresAt?: string;
  scopes?: string[];
};
export interface McpView {
  workspace: string;
  revision: string;
  servers: McpServerView[];
}
export type McpCommand =
  | { type: 'get' }
  | { type: 'save'; server: McpServer; revision: string }
  | { type: 'delete'; id: string; revision: string }
  | { type: 'test'; server: McpServer; revision: string }
  | { type: 'authorize'; server: McpServer; revision: string }
  | { type: 'revoke'; id: string; revision: string }
  | { type: 'cancel-authorize' };
export type McpReply =
  { ok: true; view?: McpView; message?: string } | { ok: false; error: string };
export function parseMcpCommand(input: unknown): McpCommand {
  const fail = () => {
    throw new Error('Invalid MCP settings command');
  };
  if (!input || typeof input !== 'object' || Array.isArray(input)) return fail();
  const value = input as Record<string, unknown>;
  const fields: Record<string, string[]> = {
    get: ['type'],
    save: ['type', 'server', 'revision'],
    delete: ['type', 'id', 'revision'],
    test: ['type', 'server', 'revision'],
    authorize: ['type', 'server', 'revision'],
    revoke: ['type', 'id', 'revision'],
    'cancel-authorize': ['type'],
  };
  if (
    typeof value.type !== 'string' ||
    !Object.hasOwn(fields, value.type) ||
    Object.keys(value).some((key) => !fields[value.type as string]!.includes(key))
  )
    return fail();
  if (
    value.type === 'save' ||
    value.type === 'delete' ||
    value.type === 'test' ||
    value.type === 'authorize' ||
    value.type === 'revoke'
  )
    if (typeof value.revision !== 'string' || !/^[a-f0-9]{64}$/.test(value.revision)) return fail();
  if (
    (value.type === 'delete' || value.type === 'revoke') &&
    (typeof value.id !== 'string' || !/^[a-z][a-z0-9_]{0,31}$/.test(value.id))
  )
    return fail();
  if (value.type === 'save' || value.type === 'test' || value.type === 'authorize') {
    if (
      !value.server ||
      typeof value.server !== 'object' ||
      Array.isArray(value.server) ||
      JSON.stringify(value.server).length > 32768
    )
      return fail();
    const row = value.server as Record<string, unknown>;
    if (typeof row.id !== 'string' || !/^[a-z][a-z0-9_]{0,31}$/.test(row.id)) return fail();
  }
  return value as McpCommand;
}
