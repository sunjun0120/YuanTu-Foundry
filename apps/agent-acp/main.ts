#!/usr/bin/env node
import { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { ndJsonStream } from '@agentclientprotocol/sdk';
import { connectAcp } from '../../packages/sdk/acp.ts';
import { parseArgs } from '../shared/args.ts';
import { applySandboxDefaults, resolveWorkspace, safeError } from '../shared/runtime.ts';

async function main() {
  const { options } = parseArgs(process.argv.slice(2));
  /**
   * The same two lines the other carriers run before they build anything.
   *
   * The entry's help is the shared one, so an operator reads `--db`, `--permission-policy` and `--hooks` as
   * options of *this* program; they were parsed and then dropped, which turned "the sandbox I named" and
   * "the policy file I passed" into silent no-ops. Refusing what this adapter cannot honour and forwarding
   * what it can is the difference between a narrower adapter and a lying one.
   */
  applySandboxDefaults();
  const workspace = resolveWorkspace(options.workspace ?? process.cwd());
  if (options.images?.length)
    throw new Error(
      'The ACP adapter does not accept attachments; it declares text prompts only (promptCapabilities.image is false)',
    );
  const extension = import.meta.url.endsWith('.ts') ? 'ts' : 'js';
  /**
   * The policy file and the hooks module travel as the environment names the Host already reads.
   *
   * They are forwarded rather than re-implemented: the Host owns both readers (it validates the policy file
   * and it refuses a hooks module that resolves inside the workspace), so a second copy here would be a
   * second answer to "is this trusted code". Only names the operator actually set are written, so the
   * child's own preflight still sees exactly what this process saw.
   */
  const env = { ...process.env };
  if (options.permissionPolicy) env.YUANTU_PERMISSION_POLICY = options.permissionPolicy;
  if (options.hooks) env.YUANTU_HOOKS_MODULE = options.hooks;
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
      ...(options.db ? { db: options.db } : {}),
      env,
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
