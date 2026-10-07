#!/usr/bin/env node
import { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { ndJsonStream } from '@agentclientprotocol/sdk';
import { connectAcp } from '../../packages/sdk/acp.ts';
import { parseArgs } from '../shared/args.ts';
import { resolveWorkspace, safeError } from '../shared/runtime.ts';

async function main() {
  const { options } = parseArgs(process.argv.slice(2));
  const workspace = resolveWorkspace(options.workspace ?? process.cwd());
  const extension = import.meta.url.endsWith('.ts') ? 'ts' : 'js';
  const adapter = connectAcp(
    ndJsonStream(
      Writable.toWeb(process.stdout),
      Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>,
      {
        maxMessageBytes: 16_000_000,
      },
    ),
    {
      nodePath: process.execPath,
      hostPath: fileURLToPath(new URL(`../agent-host/main.${extension}`, import.meta.url)),
      workspace,
    },
  );
  const stop = () => adapter.connection.close();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    await adapter.connection.closed;
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    await adapter.close();
  }
}
main().catch((error: unknown) => {
  process.stderr.write(safeError(error) + '\n');
  process.exitCode = 1;
});
