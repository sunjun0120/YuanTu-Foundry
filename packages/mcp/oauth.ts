import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  auth,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
} from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { resolveOAuthEnvironment, type McpConfig, type McpOAuthConfig } from './config.ts';

/** Optional at-rest protection supplied by embedders that own a platform key (for example Electron safeStorage). */
export interface SecretCipher {
  encrypt(text: string): Buffer;
  decrypt(bytes: Buffer): string;
}

export interface McpOAuthRecord {
  version: 1;
  clientInformation?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  codeVerifier?: string;
  state?: string;
  discoveryState?: OAuthDiscoveryState;
  /**
   * Loopback redirect used when the credentials were issued. Runtime connections reuse it so the
   * SDK keeps treating this server as an interactive authorization-code client, and so a token
   * refresh presents the same `redirect_uri` the authorization server already knows.
   */
  redirectUrl?: string;
}

const MAX_RECORD_BYTES = 65_536;
const DEFAULT_AUTHORIZATION_TIMEOUT_MS = 300_000;

/**
 * Raised by the runtime (non-interactive) provider when a server demands authorization. The
 * message is intentionally free of transport or credential detail because it reaches the model.
 */
export class McpAuthorizationRequiredError extends Error {
  readonly serverUrl: string;
  constructor(serverUrl: string) {
    super('MCP authorization required; complete the browser authorization for this server first');
    this.name = 'McpAuthorizationRequiredError';
    this.serverUrl = serverUrl;
  }
}

export function isMcpAuthorizationRequired(error: unknown): boolean {
  return error instanceof McpAuthorizationRequiredError;
}

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}

/**
 * Credential directory. It lives in the user profile rather than the workspace so that a shared
 * or committed project can never carry another user's tokens, and it is overridable for tests.
 */
export function defaultMcpOAuthDirectory(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.YUANTU_MCP_OAUTH_DIR?.trim();
  if (configured) {
    if (!path.isAbsolute(configured))
      throw new Error('YUANTU_MCP_OAUTH_DIR must be an absolute path');
    return path.normalize(configured);
  }
  return path.join(os.homedir(), '.yuantu', 'mcp-oauth');
}

function checkedDirectory(directory: string, create: boolean): string {
  const resolved = path.resolve(directory);
  let stat;
  try {
    stat = lstatSync(resolved);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    if (!create) return resolved;
    mkdirSync(resolved, { recursive: true, mode: 0o700 });
    stat = lstatSync(resolved);
  }
  if (stat.isSymbolicLink()) throw new Error('MCP credential directory cannot be a symbolic link');
  if (!stat.isDirectory()) throw new Error('MCP credential path must be a directory');
  return resolved;
}

function sanitizeRecord(value: unknown): McpOAuthRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid MCP credential file');
  const row = value as Record<string, unknown>;
  if (row.version !== 1) throw new Error('Unsupported MCP credential file version');
  const record: McpOAuthRecord = { version: 1 };
  if (typeof row.codeVerifier === 'string' && row.codeVerifier.length <= 256)
    record.codeVerifier = row.codeVerifier;
  if (typeof row.state === 'string' && row.state.length <= 256) record.state = row.state;
  if (typeof row.redirectUrl === 'string' && row.redirectUrl.length <= 2048) {
    try {
      const redirect = new URL(row.redirectUrl);
      if (redirect.protocol === 'http:' && loopback(redirect.hostname))
        record.redirectUrl = row.redirectUrl;
    } catch {
      // Ignore a damaged redirect URL; runtime connections fall back to the configured port.
    }
  }
  const object = (input: unknown): Record<string, unknown> | undefined =>
    input && typeof input === 'object' && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : undefined;
  const clientInformation = object(row.clientInformation);
  if (clientInformation && typeof clientInformation.client_id === 'string')
    record.clientInformation = clientInformation as OAuthClientInformationMixed;
  const tokens = object(row.tokens);
  if (
    tokens &&
    typeof tokens.access_token === 'string' &&
    typeof tokens.token_type === 'string' &&
    tokens.access_token.length <= 8192 &&
    (tokens.refresh_token === undefined || typeof tokens.refresh_token === 'string') &&
    (tokens.expires_in === undefined || typeof tokens.expires_in === 'number')
  )
    record.tokens = tokens as OAuthTokens;
  const discovery = object(row.discoveryState);
  if (discovery && typeof discovery.authorizationServerUrl === 'string')
    record.discoveryState = discovery as unknown as OAuthDiscoveryState;
  return record;
}

/**
 * Per-server OAuth credential store. Writes are atomic (temporary file plus rename) with 0600
 * permissions; every value is validated on read so a damaged file fails closed instead of
 * feeding arbitrary data into the SDK.
 */
export class McpOAuthTokenStore {
  private readonly directory: string;
  private readonly cipher?: SecretCipher;
  constructor(
    options: { directory?: string; cipher?: SecretCipher; env?: NodeJS.ProcessEnv } = {},
  ) {
    const configured = options.directory?.trim();
    if (configured) {
      if (!path.isAbsolute(configured))
        throw new Error('MCP credential directory must be an absolute path');
      this.directory = path.normalize(configured);
    } else {
      this.directory = defaultMcpOAuthDirectory(options.env ?? process.env);
    }
    this.cipher = options.cipher;
  }
  get location(): string {
    return this.directory;
  }
  private fileFor(serverUrl: string): string {
    return path.join(
      this.directory,
      createHash('sha256').update(serverUrl).digest('hex') + '.json',
    );
  }
  private decode(raw: string): McpOAuthRecord {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (parsed && typeof parsed === 'object' && typeof parsed.payload === 'string') {
      if (!this.cipher)
        throw new Error('MCP credential file is encrypted but no decryptor is available');
      return sanitizeRecord(JSON.parse(this.cipher.decrypt(Buffer.from(parsed.payload, 'base64'))));
    }
    const payload = parsed && typeof parsed === 'object' ? (parsed.payload ?? parsed) : parsed;
    return sanitizeRecord(payload);
  }
  readSync(serverUrl: string): McpOAuthRecord {
    const file = this.fileFor(serverUrl);
    let stat;
    try {
      stat = lstatSync(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1 };
      throw error;
    }
    if (stat.isSymbolicLink() || !stat.isFile())
      throw new Error('MCP credential entry must be a regular file');
    if (stat.size > MAX_RECORD_BYTES) throw new Error('MCP credential entry exceeds 64KB');
    try {
      return this.decode(readFileSync(file, 'utf8'));
    } catch (error) {
      if (error instanceof SyntaxError) throw new Error('Invalid MCP credential file');
      throw error;
    }
  }
  async read(serverUrl: string): Promise<McpOAuthRecord> {
    return this.readSync(serverUrl);
  }
  async write(serverUrl: string, record: McpOAuthRecord): Promise<void> {
    const directory = checkedDirectory(this.directory, true);
    const file = this.fileFor(serverUrl);
    try {
      const stat = lstatSync(file);
      if (stat.isSymbolicLink() || !stat.isFile())
        throw new Error('MCP credential entry must be a regular file');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const payload = JSON.stringify(sanitizeRecord(record));
    const body = this.cipher
      ? JSON.stringify({ version: 1, payload: this.cipher.encrypt(payload).toString('base64') })
      : JSON.stringify({ version: 1, payload: JSON.parse(payload) });
    if (Buffer.byteLength(body, 'utf8') > MAX_RECORD_BYTES)
      throw new Error('MCP credential entry exceeds 64KB');
    const temporary = path.join(directory, '.' + path.basename(file) + '.' + randomUUID() + '.tmp');
    if (!inside(directory, temporary))
      throw new Error('MCP credential path is outside its directory');
    try {
      writeFileSync(temporary, body, { flag: 'wx', mode: 0o600 });
      renameSync(temporary, file);
    } finally {
      try {
        unlinkSync(temporary);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
  }
  async remove(serverUrl: string): Promise<void> {
    const file = this.fileFor(serverUrl);
    try {
      rmSync(file, { force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}

function loopback(hostname: string): boolean {
  return ['localhost', '127.0.0.1', '[::1]', '::1'].includes(hostname);
}

/**
 * Origin-scoped fetch used for every MCP request. The MCP server origin is trusted up front;
 * authorization-server origins are learned only from metadata that an already-trusted origin
 * served (RFC 9728 resource metadata or a `WWW-Authenticate` challenge), so a compromised
 * server cannot redirect credentials to an unrelated host.
 */
export class McpFetchPolicy {
  readonly fetch: typeof fetch;
  private readonly origins = new Set<string>();
  constructor(serverUrl: string, allowed: string[] = []) {
    this.add(serverUrl);
    for (const value of allowed) this.add(value);
    this.fetch = (input, init) => this.send(input, init);
  }
  private add(value: string): void {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return;
    }
    if (url.username || url.password) return;
    if (url.protocol === 'https:' || (url.protocol === 'http:' && loopback(url.hostname)))
      this.origins.add(url.origin);
  }
  allows(value: string): boolean {
    try {
      return this.origins.has(new URL(value).origin);
    } catch {
      return false;
    }
  }
  private async send(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const target =
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const address = new URL(target);
    if (address.username || address.password)
      throw new Error('MCP transport cannot send credentials in the URL');
    if (!this.origins.has(address.origin)) throw new Error('MCP transport cannot change origin');
    const response = await fetch(input, { ...init, redirect: 'error' });
    await this.observe(address, response);
    return response;
  }
  /**
   * Learns authorization-server origins from metadata that an already-trusted origin served.
   * This must complete before the response is handed back, otherwise the caller could race ahead
   * and request the authorization server before its origin is trusted.
   */
  private async observe(address: URL, response: Response): Promise<void> {
    const challenge = response.headers.get('www-authenticate');
    if (challenge) {
      const match = challenge.match(/resource_metadata\s*=\s*"([^"]{1,2048})"/i);
      if (match) this.add(match[1]!);
    }
    if (response.status !== 200) return;
    if (!address.pathname.includes('/.well-known/')) return;
    if (!(response.headers.get('content-type') ?? '').includes('json')) return;
    try {
      const body = (await response.clone().json()) as unknown;
      const rows =
        body && typeof body === 'object' && !Array.isArray(body)
          ? (body as Record<string, unknown>)
          : {};
      const servers = rows.authorization_servers;
      if (Array.isArray(servers))
        for (const server of servers) if (typeof server === 'string') this.add(server);
    } catch {
      // Malformed metadata is not fatal here; the SDK reports the real discovery failure.
    }
  }
}

function clientMetadata(
  oauth: McpOAuthConfig,
  redirectUrl: string,
  scope?: string,
): OAuthClientMetadata {
  return {
    client_name: oauth.clientName ?? 'YuanTu Agent',
    redirect_uris: [redirectUrl],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: oauth.clientSecret ? 'client_secret_post' : 'none',
    ...(scope ? { scope } : {}),
  } as OAuthClientMetadata;
}

export interface McpOAuthProviderOptions {
  store: McpOAuthTokenStore;
  serverUrl: string;
  metadata: OAuthClientMetadata;
  redirectUrl?: string;
  clientInformation?: OAuthClientInformationMixed;
  /** Interactive providers open a browser; runtime providers surface an actionable error instead. */
  interactive: boolean;
  onRedirect?: (url: URL) => void | Promise<void>;
  record?: McpOAuthRecord;
}

/** Bridges the MCP SDK's OAuth contract to the credential store. */
export class McpOAuthProvider implements OAuthClientProvider {
  private readonly store: McpOAuthTokenStore;
  private readonly serverUrl: string;
  private readonly metadata: OAuthClientMetadata;
  private readonly redirect?: string;
  private readonly staticClient?: OAuthClientInformationMixed;
  private readonly interactive: boolean;
  private onRedirect?: (url: URL) => void | Promise<void>;
  private record: McpOAuthRecord;
  private pending?: URL;
  constructor(options: McpOAuthProviderOptions) {
    this.store = options.store;
    this.serverUrl = options.serverUrl;
    this.metadata = options.metadata;
    this.redirect = options.redirectUrl;
    this.staticClient = options.clientInformation;
    this.interactive = options.interactive;
    this.onRedirect = options.onRedirect;
    this.record = options.record ?? { version: 1 };
    if (this.staticClient && !this.record.clientInformation)
      this.record.clientInformation = this.staticClient;
  }
  static async open(options: McpOAuthProviderOptions): Promise<McpOAuthProvider> {
    const provider = new McpOAuthProvider(options);
    provider.record = options.record ?? (await options.store.read(options.serverUrl));
    if (provider.staticClient) provider.record.clientInformation ??= provider.staticClient;
    return provider;
  }
  get redirectUrl(): string | URL | undefined {
    return this.redirect;
  }
  get clientMetadata(): OAuthClientMetadata {
    return this.metadata;
  }
  /** Authorization URL handed to the browser during the most recent interactive attempt. */
  get authorizationUrl(): URL | undefined {
    return this.pending;
  }
  private async persist(): Promise<void> {
    await this.store.write(this.serverUrl, this.record);
  }
  async state(): Promise<string> {
    this.record.state ??= randomBytes(32).toString('base64url');
    await this.persist();
    return this.record.state;
  }
  clientInformation(): OAuthClientInformationMixed | undefined {
    return this.record.clientInformation;
  }
  async saveClientInformation(clientInformation: OAuthClientInformationMixed): Promise<void> {
    this.record.clientInformation = clientInformation;
    await this.persist();
  }
  tokens(): OAuthTokens | undefined {
    return this.record.tokens;
  }
  async saveTokens(tokens: OAuthTokens): Promise<void> {
    this.record.tokens = tokens;
    await this.persist();
  }
  async redirectToAuthorization(url: URL): Promise<void> {
    this.pending = url;
    if (!this.interactive) throw new McpAuthorizationRequiredError(this.serverUrl);
    if (this.onRedirect) await this.onRedirect(url);
  }
  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    this.record.codeVerifier = codeVerifier;
    await this.persist();
  }
  codeVerifier(): string {
    const verifier = this.record.codeVerifier;
    if (!verifier)
      throw new Error('MCP authorization state is missing; restart the authorization flow');
    return verifier;
  }
  discoveryState(): OAuthDiscoveryState | undefined {
    return this.record.discoveryState;
  }
  async saveDiscoveryState(state: OAuthDiscoveryState): Promise<void> {
    this.record.discoveryState = state;
    await this.persist();
  }
  async invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery') {
    if (scope === 'client' || scope === 'all') delete this.record.clientInformation;
    if (scope === 'tokens' || scope === 'all') delete this.record.tokens;
    if (scope === 'verifier' || scope === 'all') delete this.record.codeVerifier;
    if (scope === 'discovery' || scope === 'all') delete this.record.discoveryState;
    await this.persist();
  }
}

export interface McpOAuthStatus {
  configured: boolean;
  authorized: boolean;
  expiresAt?: string;
  scopes?: string[];
}

function expiresAt(tokens: OAuthTokens | undefined): string | undefined {
  if (!tokens?.expires_in) return undefined;
  return new Date(Date.now() + tokens.expires_in * 1000).toISOString();
}

export function readMcpOAuthStatus(config: McpConfig, store: McpOAuthTokenStore): McpOAuthStatus {
  if (!config.oauth || config.transport === 'stdio')
    return { configured: false, authorized: false };
  const record = store.readSync(config.url!);
  return {
    configured: true,
    authorized: Boolean(record.tokens?.access_token),
    ...(expiresAt(record.tokens) ? { expiresAt: expiresAt(record.tokens)! } : {}),
    ...(config.oauth.scopes ? { scopes: [...config.oauth.scopes] } : {}),
  };
}

/**
 * Drops the tokens and PKCE verifier while keeping the registered client and discovery state, so
 * re-authorizing does not create a new dynamic client registration on every revocation.
 */
export async function revokeMcpAuthorization(
  config: McpConfig,
  store: McpOAuthTokenStore,
): Promise<void> {
  if (!config.url) return;
  const record = store.readSync(config.url);
  delete record.tokens;
  delete record.codeVerifier;
  delete record.state;
  await store.write(config.url, record);
}

export interface McpAuthorizeOptions {
  config: McpConfig;
  store: McpOAuthTokenStore;
  /** Opens the authorization URL in the user's browser. Rejections abort the flow. */
  openUrl: (url: URL) => void | Promise<void>;
  signal: AbortSignal;
  timeoutMs?: number;
  secrets?: Set<string>;
}

interface Loopback {
  redirectUrl: string;
  code(expected: string, signal: AbortSignal, timeoutMs: number): Promise<string>;
  close(): Promise<void>;
}

function callbackPage(title: string, detail: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:system-ui,sans-serif;margin:12vh auto;max-width:32rem;text-align:center;color:#111}</style>
</head><body><h1>${title}</h1><p>${detail}</p></body></html>`;
}

/**
 * Single-use loopback listener (RFC 8252 section 7.3). It only answers `/callback` on 127.0.0.1,
 * accepts exactly one authorization response, verifies the `state` parameter, and never echoes
 * request data back to the page.
 */
async function startLoopback(port: number): Promise<Loopback> {
  let settle: ((response: { code: string; state: string }) => void) | undefined;
  let fail: ((error: Error) => void) | undefined;
  let responded = false;
  const received = new Promise<{ code: string; state: string }>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });
  const server = createServer((request, response) => {
    const address = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (address.pathname !== '/callback') {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('Not found');
      return;
    }
    if (responded) {
      response.writeHead(409, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('Authorization already received');
      return;
    }
    responded = true;
    const error = address.searchParams.get('error');
    const code = address.searchParams.get('code');
    const state = address.searchParams.get('state');
    if (error) {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(
        callbackPage('Authorization failed', 'You can close this window and try again.'),
      );
      fail?.(new Error('MCP authorization was denied or failed'));
      return;
    }
    if (!code || code.length > 4096 || !state || state.length > 256) {
      response.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('Invalid authorization response');
      fail?.(new Error('Invalid MCP authorization response'));
      return;
    }
    response.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
    });
    response.end(callbackPage('Authorization complete', 'You can close this window.'));
    settle?.({ code, state });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port }, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('MCP authorization callback listener failed to bind');
  }
  const redirectUrl = `http://127.0.0.1:${address.port}/callback`;
  return {
    redirectUrl,
    code: (expected, signal, timeoutMs) =>
      new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => {
          cleanup();
          reject(new Error('MCP authorization timed out; no browser response was received'));
        }, timeoutMs);
        const abort = () => {
          cleanup();
          reject(signal.reason ?? new Error('MCP authorization cancelled'));
        };
        const cleanup = () => {
          clearTimeout(timer);
          signal.removeEventListener('abort', abort);
        };
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) return abort();
        received.then(
          (response) => {
            cleanup();
            if (response.state !== expected) {
              reject(new Error('Invalid MCP authorization response'));
              return;
            }
            resolve(response.code);
          },
          (error: Error) => {
            cleanup();
            reject(error);
          },
        );
      }),
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function remoteOAuth(config: McpConfig): { url: string; oauth: McpOAuthConfig } {
  if (config.transport === 'stdio' || !config.url || !config.oauth)
    throw new Error('Invalid MCP: OAuth requires a remote server with an oauth block');
  return { url: config.url, oauth: config.oauth };
}

/**
 * Redirect URI a runtime connection hands to the SDK. It is never opened; it exists so the SDK
 * treats the client as an interactive authorization-code client. A recorded value from a previous
 * authorization wins so token refreshes keep the `redirect_uri` the server already registered.
 */
export function mcpOAuthRedirectUrl(config: McpConfig, store: McpOAuthTokenStore): string {
  if (config.url) {
    const recorded = store.readSync(config.url).redirectUrl;
    if (recorded) return recorded;
  }
  const port = config.oauth?.redirectPort;
  return port ? `http://127.0.0.1:${port}/callback` : 'http://127.0.0.1/callback';
}

/**
 * Runs the full authorization-code + PKCE flow: discovery, dynamic client registration when no
 * client id is configured, browser authorization through a loopback callback, and token exchange.
 * Credentials are persisted only after the exchange succeeds.
 */
export async function authorizeMcpServer(
  options: McpAuthorizeOptions,
): Promise<{ redirectUrl: string }> {
  const { url, oauth } = remoteOAuth(options.config);
  options.signal.throwIfAborted();
  const resolved = resolveOAuthEnvironment(oauth, options.secrets ?? new Set<string>())!;
  const scope = resolved.scopes?.join(' ');
  const loopback = await startLoopback(resolved.redirectPort ?? 0);
  try {
    const cached = options.store.readSync(url);
    // Record the exact loopback URI before the flow starts so a later runtime connection and any
    // future token refresh reuse it.
    cached.redirectUrl = loopback.redirectUrl;
    await options.store.write(url, cached);
    const policy = new McpFetchPolicy(url, [
      ...(cached.discoveryState?.authorizationServerUrl
        ? [cached.discoveryState.authorizationServerUrl]
        : []),
    ]);
    const provider = await McpOAuthProvider.open({
      store: options.store,
      serverUrl: url,
      redirectUrl: loopback.redirectUrl,
      metadata: clientMetadata(resolved, loopback.redirectUrl, scope),
      interactive: true,
      onRedirect: options.openUrl,
      record: cached,
      ...(resolved.clientId
        ? {
            clientInformation: {
              client_id: resolved.clientId,
              ...(resolved.clientSecret ? { client_secret: resolved.clientSecret } : {}),
            },
          }
        : {}),
    });
    const serverUrl = new URL(url);
    const first = await auth(provider, {
      serverUrl,
      ...(scope ? { scope } : {}),
      fetchFn: policy.fetch,
    });
    if (first !== 'AUTHORIZED') {
      const expected = await provider.state();
      const code = await loopback.code(
        expected,
        options.signal,
        options.timeoutMs ?? DEFAULT_AUTHORIZATION_TIMEOUT_MS,
      );
      const second = await auth(provider, {
        serverUrl,
        authorizationCode: code,
        ...(scope ? { scope } : {}),
        fetchFn: policy.fetch,
      });
      if (second !== 'AUTHORIZED') throw new Error('MCP authorization did not complete');
    }
    if (!readMcpOAuthStatus(options.config, options.store).authorized)
      throw new Error('MCP authorization did not return an access token');
    return { redirectUrl: loopback.redirectUrl };
  } finally {
    await loopback.close().catch(() => undefined);
  }
}
