// packages/builtin-services/manifest.ts
/**
 * The built-in analysis service, as this build knows it.
 *
 * The manifest lives in code rather than in a workspace file: a repository being analysed must not be able to add,
 * replace or switch off the service it is analysed by. Only the address can change, and only in a development
 * build — an installed app reads `PRODUCTION_BASE_URL` and nothing else. `YUANTU_BUILTIN_SERVICES=0` is the
 * operator's own off switch, not something a workspace file can set either.
 */
import { parseSetting } from '../protocol/settings.ts';

export interface BuiltinServiceManifest {
  id: string;
  /** Origin plus optional path prefix, without a trailing slash. */
  baseUrl: string;
  mcpPath: string;
  uploadPath: string;
  /** Prefix of the native tool names, e.g. `scan_license_analyze`. */
  toolPrefix: string;
  callTimeoutMs: number;
  maxTools: number;
  maxUploadBytes: number;
  maxResultChars: number;
  maxReportBytes: number;
  /**
   * Total bytes of backend tool schemas this build will register.
   *
   * The service is said to be a primary feature, so its tools stay in the catalog instead of a deferred group —
   * which means one bad or oversized schema set is paid for by every request. The per-tool bound (64 KiB, from the
   * MCP schema check) and this total are what keep that bounded.
   */
  maxSchemaBytes: number;
  /** Backend tools that answer for asynchronous tasks; reached through `job_*`, never registered as tools. */
  taskTools: { status: string; result: string; cancel: string };
}

/** The production address; `undefined` until the backend publishes one, which registers no service at all. */
export const PRODUCTION_BASE_URL: string | undefined = undefined;

const DEFAULTS: Omit<BuiltinServiceManifest, 'baseUrl'> = {
  id: 'yuantu_analysis',
  mcpPath: '/mcp',
  uploadPath: '/upload',
  toolPrefix: 'scan',
  callTimeoutMs: 300_000,
  maxTools: 64,
  maxUploadBytes: 200 * 1024 * 1024,
  maxResultChars: 8 * 1024 * 1024,
  maxReportBytes: 50 * 1024 * 1024,
  maxSchemaBytes: 256 * 1024,
  taskTools: { status: 'task_status', result: 'task_result', cancel: 'task_cancel' },
};

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

export function resolveBuiltinService(
  env: NodeJS.ProcessEnv = process.env,
): BuiltinServiceManifest | undefined {
  // The switch comes first: `0` must mean exactly "the general agent", with no cache read and no connection, so
  // that non-product entry points (the test isolation, the docs facts, the benchmarks) stay hermetic.
  if (parseSetting(env, 'YUANTU_BUILTIN_SERVICES') === false) return undefined;
  const packaged = parseSetting(env, 'YUANTU_PACKAGED') === true;
  const override = parseSetting(env, 'YUANTU_BUILTIN_SERVICES_URL') as string | undefined;
  const raw = (!packaged && override) || PRODUCTION_BASE_URL;
  if (!raw) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('Built-in service URL is not a valid URL');
  }
  if (url.username || url.password || url.search || url.hash)
    throw new Error('Built-in service URL must not carry credentials, a query or a fragment');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK.has(url.hostname)))
    throw new Error('Built-in service URL must use HTTPS (http only on loopback)');
  return { ...DEFAULTS, baseUrl: url.origin + url.pathname.replace(/\/+$/, '') };
}
