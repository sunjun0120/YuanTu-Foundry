// packages/builtin-services/tool-cache.ts
/**
 * The last tool list the service answered, kept so a run can register the tools without waiting on the network.
 *
 * A registry is built synchronously for every run, so it reads this file; the Host refreshes it in the background.
 * A cache saved for another address is ignored rather than trusted.
 */
import { readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { atomicWriteFile } from '../platform/write-all.ts';
import { userStateDirectory } from '../platform/user-state.ts';
import type { RemoteTool } from './client.ts';
import type { BuiltinServiceManifest } from './manifest.ts';

export interface ToolCache {
  savedAt: string;
  tools: RemoteTool[];
}

function cacheFile(manifest: BuiltinServiceManifest, env: NodeJS.ProcessEnv): string {
  return path.join(userStateDirectory(env), 'builtin-services', `${manifest.id}.tools.json`);
}

export function readToolCache(
  manifest: BuiltinServiceManifest,
  env: NodeJS.ProcessEnv = process.env,
): ToolCache | undefined {
  try {
    const parsed = JSON.parse(readFileSync(cacheFile(manifest, env), 'utf8'));
    const savedAt = parsed?.savedAt;
    // A timestamp that cannot be parsed makes "is this stale?" unanswerable, and `Date.parse(undefined-ish)` is
    // `NaN`, whose comparison with the staleness bound is false — which would keep the bad cache current forever.
    if (
      parsed?.baseUrl !== manifest.baseUrl ||
      typeof savedAt !== 'string' ||
      !Number.isFinite(Date.parse(savedAt)) ||
      !Array.isArray(parsed.tools)
    )
      return undefined;
    return { savedAt, tools: parsed.tools };
  } catch {
    return undefined;
  }
}

export async function writeToolCache(
  manifest: BuiltinServiceManifest,
  tools: RemoteTool[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const file = cacheFile(manifest, env);
  await mkdir(path.dirname(file), { recursive: true });
  const body = { baseUrl: manifest.baseUrl, savedAt: new Date().toISOString(), tools };
  await atomicWriteFile(file, Buffer.from(JSON.stringify(body)));
}
