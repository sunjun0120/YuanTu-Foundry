import { parentPort, workerData } from 'node:worker_threads';
import { McpSettingsStore } from './mcp-settings.ts';
import type { McpServer } from './mcp-contract.ts';

const input = workerData as { root: string; server: McpServer; revision: string };

void new McpSettingsStore(input.root)
  .test(input.server, AbortSignal.timeout(15000), input.revision)
  .then((result) => parentPort!.postMessage({ ok: true, result }))
  .catch((error: unknown) =>
    parentPort!.postMessage({
      ok: false,
      error: error instanceof Error ? error.message : 'MCP connection test failed',
    }),
  );
