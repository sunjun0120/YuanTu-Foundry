import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { TestContext } from 'node:test';

export interface McpOAuthFixture {
  /** MCP resource server endpoint; it answers 401 until a valid bearer token is presented. */
  mcpUrl: string;
  /** Authorization server origin, deliberately a different origin from the MCP server. */
  issuer: string;
  /** Ordered `METHOD path` log for both servers. */
  log: string[];
  accessTokens: string[];
}

async function body(request: IncomingMessage): Promise<string> {
  let text = '';
  for await (const chunk of request) text += chunk;
  return text;
}

function json(response: ServerResponse, status: number, value: unknown, headers = {}): void {
  response.writeHead(status, { 'content-type': 'application/json', ...headers });
  response.end(JSON.stringify(value));
}

function listen(server: ReturnType<typeof createServer>): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('No address');
      resolve(address.port);
    });
  });
}

/**
 * Minimal MCP server plus a separate-origin OAuth 2.1 authorization server. Because the two live
 * on different ports, exercising this fixture proves the client learns the authorization-server
 * origin from protected-resource metadata rather than trusting arbitrary hosts.
 */
export async function mcpOAuthFixture(
  t: TestContext,
  options: { scopesSupported?: string[] } = {},
): Promise<McpOAuthFixture> {
  const log: string[] = [];
  const accessTokens: string[] = [];
  const usedCodes = new Set<string>();
  let issuer = '';
  let resourceOrigin = '';

  const resource = createServer(async (request, response) => {
    const address = new URL(request.url ?? '/', 'http://127.0.0.1');
    log.push(`${request.method} ${address.pathname}`);
    if (request.method === 'GET') {
      if (address.pathname.includes('oauth-protected-resource'))
        return json(response, 200, {
          resource: resourceOrigin,
          authorization_servers: [issuer],
          ...(options.scopesSupported ? { scopes_supported: options.scopesSupported } : {}),
        });
      response.writeHead(405);
      response.end();
      return;
    }
    const authorization = String(request.headers.authorization ?? '');
    const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
    if (!token || !accessTokens.includes(token)) {
      response.writeHead(401, {
        'www-authenticate': `Bearer resource_metadata="${resourceOrigin}/.well-known/oauth-protected-resource"`,
      });
      response.end();
      return;
    }
    let message: any;
    try {
      message = JSON.parse(await body(request));
    } catch {
      response.writeHead(400);
      response.end();
      return;
    }
    if (message.id === undefined) {
      response.writeHead(202);
      response.end();
      return;
    }
    const result =
      message.method === 'initialize'
        ? {
            protocolVersion: '2025-03-26',
            capabilities: { tools: {}, resources: {}, prompts: {} },
            serverInfo: { name: 'oauth-fixture', version: '1' },
          }
        : message.method === 'tools/list'
          ? {
              tools: [
                {
                  name: 'echo',
                  inputSchema: {
                    type: 'object',
                    properties: { text: { type: 'string' } },
                    required: ['text'],
                  },
                },
              ],
            }
          : message.method === 'resources/list'
            ? { resources: [{ uri: 'fixture://oauth', name: 'oauth' }] }
            : message.method === 'resources/templates/list'
              ? { resourceTemplates: [] }
              : message.method === 'prompts/list'
                ? { prompts: [{ name: 'greet' }] }
                : message.method === 'resources/read'
                  ? { contents: [{ uri: message.params.uri, text: 'oauth resource body' }] }
                  : message.method === 'prompts/get'
                    ? {
                        messages: [
                          { role: 'user', content: { type: 'text', text: 'oauth prompt' } },
                        ],
                      }
                    : { content: [{ type: 'text', text: message.params.arguments.text }] };
    json(response, 200, { jsonrpc: '2.0', id: message.id, result });
  });

  const authorization = createServer(async (request, response) => {
    const address = new URL(request.url ?? '/', issuer);
    log.push(`issuer ${request.method} ${address.pathname}`);
    if (request.method === 'GET' && address.pathname.includes('.well-known'))
      return json(response, 200, {
        issuer,
        authorization_endpoint: issuer + '/authorize',
        token_endpoint: issuer + '/token',
        registration_endpoint: issuer + '/register',
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
      });
    if (request.method === 'POST' && address.pathname === '/register') {
      const metadata = JSON.parse(await body(request));
      return json(response, 201, {
        client_id: 'fixture-client',
        redirect_uris: metadata.redirect_uris,
        token_endpoint_auth_method: 'none',
      });
    }
    if (request.method === 'GET' && address.pathname === '/authorize') {
      const redirect = address.searchParams.get('redirect_uri');
      const state = address.searchParams.get('state');
      if (!redirect) {
        response.writeHead(400);
        response.end();
        return;
      }
      const code = randomUUID();
      usedCodes.add(code);
      const target = new URL(redirect);
      target.searchParams.set('code', code);
      if (state) target.searchParams.set('state', state);
      response.writeHead(302, { location: target.href });
      response.end();
      return;
    }
    if (request.method === 'POST' && address.pathname === '/token') {
      const params = new URLSearchParams(await body(request));
      const grant = params.get('grant_type');
      if (grant === 'authorization_code' && !usedCodes.has(params.get('code') ?? '')) {
        response.writeHead(400);
        response.end(JSON.stringify({ error: 'invalid_grant' }));
        return;
      }
      if (grant === 'authorization_code') usedCodes.delete(params.get('code')!);
      if (grant === 'refresh_token' && params.get('refresh_token') !== 'fixture-refresh') {
        response.writeHead(400);
        response.end(JSON.stringify({ error: 'invalid_grant' }));
        return;
      }
      const token = 'fixture-access-' + accessTokens.length;
      accessTokens.push(token);
      return json(response, 200, {
        access_token: token,
        token_type: 'Bearer',
        expires_in: 3600,
        refresh_token: 'fixture-refresh',
        ...(params.get('scope') ? { scope: params.get('scope') } : {}),
      });
    }
    response.writeHead(404);
    response.end();
  });

  const issuerPort = await listen(authorization);
  issuer = `http://127.0.0.1:${issuerPort}`;
  const resourcePort = await listen(resource);
  resourceOrigin = `http://127.0.0.1:${resourcePort}`;
  t.after(async () => {
    for (const server of [resource, authorization]) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
  return {
    mcpUrl: `http://127.0.0.1:${resourcePort}/mcp`,
    issuer,
    log,
    accessTokens,
  };
}
