// packages/builtin-services/client.ts
/**
 * One MCP connection to the built-in service, shared by every run in the process.
 *
 * The service is a remote HTTP endpoint with no per-session state on this side, so a session pool would only open
 * the same connection several times. A dropped transport forgets itself and the next call reconnects; a call that
 * merely failed does not take the connection away from the other runs sharing it.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { closeWithin } from '../mcp/tools.ts';
import type { BuiltinServiceManifest } from './manifest.ts';
import { ServiceRequester } from './service-request.ts';

export interface RemoteTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean };
}

const HANDSHAKE_TIMEOUT_MS = 30_000;
const MAX_PAGES = 16;

export class AnalysisClient {
  private client?: Promise<Client>;
  /**
   * Calls in flight on the shared connection.
   *
   * The connection belongs to the process, not to a run, so a failure may only take it down while this call is the
   * only one using it. The first version closed eagerly on every error, which turned one run's cancellation or call
   * timeout into another run's connection reset; the count is what keeps a per-call failure from becoming a
   * cross-run one.
   */
  private active = 0;
  private readonly requester: ServiceRequester;
  constructor(requester: ServiceRequester) {
    this.requester = requester;
  }
  private connect(): Promise<Client> {
    if (this.client) return this.client;
    const pending = (async () => {
      const client = new Client({ name: 'yuantu-agent', version: '1' });
      const transport = new StreamableHTTPClientTransport(
        new URL(this.requester.url(this.requester.manifest.mcpPath)),
        {
          fetch: this.requester.fetch,
          reconnectionOptions: {
            maxRetries: 0,
            initialReconnectionDelay: 1000,
            maxReconnectionDelay: 1000,
            reconnectionDelayGrowFactor: 1,
          },
        },
      );
      await client.connect(transport, { timeout: HANDSHAKE_TIMEOUT_MS });
      // A transport that drops is forgotten rather than reused, so the next call reconnects on its own. This is the
      // one signal that really does mean "the connection is gone", and it needs no judgement about whose call failed.
      client.onclose = () => {
        if (this.client === pending) this.client = undefined;
      };
      return client;
    })();
    this.client = pending;
    pending.catch(() => {
      if (this.client === pending) this.client = undefined;
    });
    return pending;
  }
  private async connectionFor(signal: AbortSignal): Promise<Client> {
    signal.throwIfAborted();
    const pending = this.connect();
    return new Promise<Client>((resolve, reject) => {
      const cleanup = () => signal.removeEventListener('abort', abort);
      const abort = () => {
        cleanup();
        reject(signal.reason);
      };
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) return abort();
      pending.then(
        (client) => {
          cleanup();
          resolve(client);
        },
        (error) => {
          cleanup();
          reject(error);
        },
      );
    });
  }
  private async guard<T>(work: () => Promise<T>): Promise<T> {
    this.active += 1;
    let failed = false;
    try {
      return await work();
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      this.active -= 1;
      // Only the last call out closes the door: while a sibling run is still waiting on this connection, closing it
      // would fail that run's request for a failure that was never its own.
      if (failed && this.active === 0) await this.close().catch(() => undefined);
    }
  }
  async listTools(signal: AbortSignal): Promise<RemoteTool[]> {
    return this.guard(async () => {
      const client = await this.connectionFor(signal);
      const tools: RemoteTool[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < MAX_PAGES; page++) {
        const result = await client.listTools(cursor ? { cursor } : {}, {
          signal,
          timeout: HANDSHAKE_TIMEOUT_MS,
        });
        tools.push(...(result.tools as RemoteTool[]));
        if (!result.nextCursor || tools.length > this.requester.manifest.maxTools) break;
        cursor = result.nextCursor;
      }
      return tools;
    });
  }
  async callTool(
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<CallToolResult> {
    return this.guard(async () => {
      const client = await this.connectionFor(signal);
      return (await client.callTool({ name, arguments: args }, undefined, {
        signal,
        timeout: this.requester.manifest.callTimeoutMs,
      })) as CallToolResult;
    });
  }
  async close(): Promise<void> {
    const pending = this.client;
    this.client = undefined;
    const client = await pending?.catch(() => undefined);
    if (client) await closeWithin(() => client.close(), 5_000);
  }
}

const services = new Map<string, { requester: ServiceRequester; client: AnalysisClient }>();

export function sharedService(manifest: BuiltinServiceManifest): {
  requester: ServiceRequester;
  client: AnalysisClient;
} {
  let entry = services.get(manifest.baseUrl);
  if (!entry) {
    const requester = new ServiceRequester(manifest);
    entry = { requester, client: new AnalysisClient(requester) };
    services.set(manifest.baseUrl, entry);
  }
  return entry;
}

export async function closeAnalysisClients(): Promise<void> {
  const entries = [...services.values()];
  services.clear();
  await Promise.all(entries.map((entry) => entry.client.close()));
}
