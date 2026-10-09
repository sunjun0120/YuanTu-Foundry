import type { PermissionPolicy } from '../../packages/core/permissions.ts';
import { readPermissionPolicy } from '../../packages/core/permissions.ts';
import { assertEnvironment } from '../../packages/protocol/settings.ts';
import { resolveSandboxConfig, type SandboxConfig } from '../../packages/tools/sandbox.ts';
import { parseArgs, type Options } from '../shared/args.ts';
import { applySandboxDefaults, resolveWorkspace } from '../shared/runtime.ts';

/**
 * The Host's `--help` text, on stdout.
 *
 * Spelled as a constant because it is the one line this process writes to stdout outside the JSONL protocol, and a
 * carrier that reads stdout as a protocol stream has to be able to tell the two apart (see `carrier.ts`).
 */
export const HOST_HELP_LINE =
  'YuanTu Agent Host: JSONL stdin/stdout. Options: --workspace <dir> --db <file> --listen [host:]port.\n';

/**
 * Everything the Host decides before it opens anything.
 *
 * These values are read once, from `argv` and the environment, and are then immutable for the life of the process:
 * the workspace a session must belong to, the sandbox image a run is launched in, and the permission policy a
 * tool call is judged by. Deciding them in one place is what lets the rest of the Host treat them as facts rather
 * than as things to re-derive — and a re-derived workspace root is how a session ends up refused by its own Host.
 */
export interface HostLaunch {
  options: Options;
  workspace: string;
  launchSandbox: SandboxConfig;
  /** Undefined when neither `--permission-policy` nor `YUANTU_PERMISSION_POLICY` named a file. */
  permissionPolicy: PermissionPolicy | undefined;
}

/**
 * Parse the command line and settle the process-wide defaults, or return null when `--help` was asked for.
 *
 * The ordering is deliberate and load-bearing. The environment is validated first, so a mistyped `YUANTU_*` name
 * fails the process instead of being silently ignored and leaving a run to use a budget nobody asked for. The
 * sandbox default is applied next, before anything reads it, so the fallback is a real backend rather than "no
 * isolation" — a carrier that passes `YUANTU_SANDBOX` explicitly, as the desktop does, keeps its own choice.
 * `--help` is answered last of the three but still *before* a carrier is opened, so asking for help prints one
 * line and exits 0 rather than becoming a Host that is waiting for a client.
 */
export function resolveLaunch(argv: string[]): HostLaunch | null {
  // The Host is the process that owns the run's limits, so it is also the process that refuses to start on a
  // mistyped YUANTU_* name — silently ignoring one is how a run ends up using a budget nobody asked for.
  assertEnvironment();
  // The command sandbox is chosen from the platform before anything reads it, so the default is a real backend
  // rather than "no isolation" (see `applySandboxDefaults`). A carrier that passes `YUANTU_SANDBOX` explicitly
  // — the desktop does — keeps its own choice.
  applySandboxDefaults();
  const { options, positionals } = parseArgs(argv);
  if (options.help) {
    process.stdout.write(HOST_HELP_LINE);
    return null;
  }
  if (positionals.length) throw new Error('Agent Host accepts options only');
  const workspace = resolveWorkspace(options.workspace ?? process.cwd());
  const launchSandbox = resolveSandboxConfig();
  const permissionPolicy = readPermissionPolicy(
    options.permissionPolicy ?? process.env.YUANTU_PERMISSION_POLICY,
  );
  return { options, workspace, launchSandbox, permissionPolicy };
}
