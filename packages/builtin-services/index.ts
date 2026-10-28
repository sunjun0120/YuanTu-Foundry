// packages/builtin-services/index.ts
/**
 * The built-in analysis service, assembled for one registry.
 *
 * A registry is built synchronously for each run, so the backend tools come from the cached tool list; the Host
 * warms that cache at start and any registry built on a cache older than ten minutes refreshes it in the background.
 * Upload and download do not depend on the list: they are offered wherever the service is configured and the
 * platform has secure path leases.
 */
import type { Tool } from '../protocol/index.ts';
import type { JobRegistry } from '../protocol/jobs.ts';
import { closeAnalysisClients, sharedService } from './client.ts';
import { resolveBuiltinService } from './manifest.ts';
import { PathLease } from './path-lease.ts';
import { remoteTools } from './remote-tools.ts';
import { downloadReportTool } from './report.ts';
import { forgetSharedTasks, sharedTasks } from './tasks.ts';
import { readToolCache, writeToolCache } from './tool-cache.ts';
import { uploadSourceTool } from './upload.ts';

const STALE_MS = 10 * 60_000;
const WARM_TIMEOUT_MS = 30_000;
/** One refresh at a time per service address and state directory; a second caller waits for the first. */
const warming = new Map<string, Promise<void>>();

export function warmToolCache(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  let manifest;
  try {
    manifest = resolveBuiltinService(env);
  } catch {
    return Promise.resolve();
  }
  if (!manifest) return Promise.resolve();
  const key = `${manifest.baseUrl}\0${env.YUANTU_STATE_DIR ?? ''}`;
  const running = warming.get(key);
  if (running) return running;
  const refresh = (async () => {
    try {
      const { client } = sharedService(manifest);
      const tools = await client.listTools(AbortSignal.timeout(WARM_TIMEOUT_MS));
      await writeToolCache(manifest, tools, env);
    } catch (error) {
      process.stderr.write(
        `[builtin-services] tool list refresh failed: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    } finally {
      warming.delete(key);
    }
  })();
  warming.set(key, refresh);
  return refresh;
}

export function builtinServiceTools(
  root: string,
  scope: string,
  jobs: JobRegistry,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Tool[] {
  let manifest;
  try {
    manifest = resolveBuiltinService(env);
  } catch (error) {
    process.stderr.write(
      `[builtin-services] ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return [];
  }
  if (!manifest) return [];
  const { requester, client } = sharedService(manifest);
  const tasks = sharedTasks(root, manifest, client);
  // One producer per registry: `JobRegistry` refuses a second `analysis` producer, and a registry is built once per
  // run (`createTools`), so this can be a plain register. A cache miss means this run has only upload and download;
  // the background warm below is what gives the *next* run the backend's tools.
  jobs.register(tasks.jobProducer());
  const cache = readToolCache(manifest, env);
  if (!cache || Date.now() - Date.parse(cache.savedAt) > STALE_MS) void warmToolCache(env);
  // Upload and download only work under a secure path lease, which fails closed off Windows. Offering them there
  // would hand the model two names that refuse every call; the backend tools still work on a GitHub URL.
  return [
    ...(PathLease.supported(platform)
      ? [uploadSourceTool({ root, requester }), downloadReportTool({ root, requester })]
      : []),
    ...remoteTools({ manifest, client, scope, tasks }, cache?.tools ?? []),
  ];
}

export function closeBuiltinServices(): Promise<void> {
  forgetSharedTasks();
  return closeAnalysisClients();
}
