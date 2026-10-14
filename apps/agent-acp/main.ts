#!/usr/bin/env node
import { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { ndJsonStream } from '@agentclientprotocol/sdk';
import { connectAcp } from '../../packages/sdk/acp.ts';
import { parseArgs } from '../shared/args.ts';
import { applySandboxDefaults, resolveWorkspace, safeError } from '../shared/runtime.ts';
import { requireProductEntry } from '../../packages/protocol/product-scope.ts';

// Public ACP delivery is paused; refuse before opening a Host or stdio connection.
requireProductEntry('acp');

/**
 * What this adapter's own `--help` prints.
 *
 * A constant, and this entry's own text rather than the shared CLI's, because it is the one thing this process
 * writes to stdout outside the ACP wire: a carrier reading that stream has to be able to tell the two apart. It
 * names the options *this* program honours — the shared parser accepts a whole kernel's worth of flags this entry
 * never reads, and printing them as its own would advertise a deployment it does not have.
 */
const ACP_HELP = `YuanTu Agent ACP adapter: ACP v1 over stdio, no socket, text prompts only.

Usage:
  yuantu-acp [--workspace <directory>] [--db <file>] [--permission-policy <file>] [--hooks <module>]

Options:
  --workspace <directory>    Existing project directory this adapter's sessions belong to (default: cwd)
  --db <file>                SQLite file the Host records sessions in (default: <workspace>/.yuantu/sessions.sqlite)
  --permission-policy <file> Trusted JSON approval rules, forwarded to the Host
  --hooks <module>           Trusted JS hooks module outside the workspace, forwarded to the Host
  -h, --help                 Print this usage and exit 0

Attachments are refused rather than dropped (the adapter declares text prompts only), and it accepts neither
client MCP servers nor additional workspace roots. No other shared carrier option is part of its interface.
`;
async function main() {
  const { options } = parseArgs(process.argv.slice(2));
  /**
   * `--help` is answered before anything it names is opened.
   *
   * The shared parser sets `options.help` for every entry point, and this one used to ignore it: asking this
   * program *how to run it* started a stdio adapter and waited on a client that was never coming, which reads as
   * work in progress rather than as an answer. The check sits above the workspace resolution and above the Host
   * connection, so a `--workspace` that does not exist cannot fail a request for help — the same ordering the
   * other carriers use.
   */
  if (options.help) {
    process.stdout.write(ACP_HELP);
    return;
  }
  /**
   * The same two lines the other carriers run before they build anything.
   *
   * `--db`, `--permission-policy` and `--hooks` are advertised by this entry's own help, and they used to be
   * parsed and then dropped, which turned "the sandbox I named" and "the policy file I passed" into silent
   * no-ops. Refusing what this adapter cannot honour and forwarding what it can is the difference between a
   * narrower adapter and a lying one.
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
