// packages/builtin-services/service-request.ts
/**
 * The one way out to the built-in service.
 *
 * The MCP transport, the source upload and the report download all build their requests here, so a rule about what
 * may be sent — the origin, no redirects, and in phase two the user's token — is written once. A request that names
 * another origin is refused before anything leaves the process.
 */
import type { BuiltinServiceManifest } from './manifest.ts';

export class ServiceRequester {
  readonly manifest: BuiltinServiceManifest;
  readonly origin: string;
  constructor(manifest: BuiltinServiceManifest) {
    this.manifest = manifest;
    this.origin = new URL(manifest.baseUrl).origin;
  }
  url(pathname: string): string {
    return this.manifest.baseUrl + pathname;
  }
  /**
   * Headers every request carries. Phase one has none. Phase two injects `Authorization` here — which makes the
   * method async, because the token is fetched over the carrier — and leaves the 401 refresh/retry to the client.
   */
  headers(): Record<string, string> {
    return {};
  }
  sameOrigin(value: string): boolean {
    try {
      return new URL(value).origin === this.origin;
    } catch {
      return false;
    }
  }
  readonly fetch: typeof fetch = async (input, init) => {
    const target =
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!this.sameOrigin(target)) throw new Error('Built-in service request left its origin');
    const headers = new Headers(init?.headers);
    for (const [name, value] of Object.entries(this.headers())) headers.set(name, value);
    return fetch(input, { ...init, headers, redirect: 'error' });
  };
}
