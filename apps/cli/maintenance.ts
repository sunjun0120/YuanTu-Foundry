import { userInfo } from 'node:os';
import { SESSION_DATABASE_POLICY, SessionStore } from '../../packages/storage/sqlite.ts';
import {
  backupDatabase,
  inspectDatabase,
  restoreDatabase,
  recoverDatabase,
  compactDatabase,
} from '../../packages/storage/database-maintenance.ts';
import { discoverModels, readConfig } from '../../packages/providers/index.ts';
import {
  credentialsPath,
  readCredentials,
  saveCredential,
} from '../../packages/providers/credentials.ts';
import {
  ENVIRONMENT,
  isCredentialSetting,
  settingShape,
} from '../../packages/protocol/settings.ts';
import { loadInstructions } from '../../packages/tools/instructions.ts';
import { discoverSkills } from '../../packages/resources/skills.ts';
import { builtinServiceConfigured } from '../../packages/builtin-services/manifest.ts';
import { extensionTools } from '../../packages/resources/extensions.ts';
import { readMcpConfigs } from '../../packages/mcp/config.ts';
import {
  McpOAuthTokenStore,
  authorizeMcpServer,
  readMcpOAuthStatus,
  revokeMcpAuthorization,
} from '../../packages/mcp/oauth.ts';
import type { Options } from '../shared/args.ts';
import { resolveWorkspace } from '../shared/runtime.ts';
import { acquireMaintenanceGate, hostLockHolders } from '../../packages/platform/host-lock.ts';
import { repositoryIdentity, runWorkspaceGit } from '../../packages/workspaces/git.ts';
import { WorkspaceManager } from '../../packages/workspaces/manager.ts';
import { inventorySnapshots, sweepAbandonedStaging } from '../../packages/workspaces/snapshot.ts';
import { readStandardInput } from './terminal.ts';
import {
  inspectWindowsSandboxLeases,
  recoverWindowsSandboxLeases,
} from '../../packages/sandbox/windows-sandbox-recovery.ts';

/**
 * The commands that open no session store: database maintenance, workspace resources, settings, the model
 * catalogue, credentials and MCP authorization.
 *
 * The commands that run no agent: database maintenance, an operator's session recovery, workspace resources,
 * settings, the model catalogue, credentials and MCP authorization.
 *
 * Returns whether `command` was one of them, so the caller only opens the store for the rest.
 */
export async function runStandaloneCommand(
  command: string,
  args: string[],
  options: Options,
): Promise<boolean> {
  /**
   * Clearing a lease nothing can prove dead.
   *
   * The store is opened for this one command because the recovery is a store operation, and the reason written to
   * the log says a person asked: nothing else in the runtime force-ends a run whose owner looks alive.
   */
  if (command === 'session-recover') {
    if (args.length !== 1 || !options.db)
      throw new Error('Usage: session-recover <session-id> --db <file> [--json]');
    const store = new SessionStore(options.db);
    try {
      const recovered = store.recoverSession(
        args[0]!,
        'Operator forced recovery from the command line: the owning process could not be confirmed dead',
      );
      process.stdout.write(JSON.stringify(recovered, null, options.json ? undefined : 2) + '\n');
    } finally {
      store.close();
    }
    return true;
  }
  /**
   * The workspace counterpart of `session-recover`: a worktree's operation lease whose owner pid is alive but which
   * no process can prove is its owner — automatic recovery leaves such a lease alone, and every archive, remove,
   * restore and run of that workspace refuses until it is gone. The operator's name and the reason are written to
   * the delegating session's log with the release.
   */
  /**
   * Snapshot housekeeping on demand: what the Host does at start-up, and a report of what it never does on its own.
   *
   * `--dry-run` only reports: every snapshot directory of the repository with its size and owners, which of them
   * predate owners (a person decides about those — nothing deletes them automatically), and the staging an abandoned
   * freeze left. Without it, this database's unused shares are released and abandoned staging is swept, exactly as at
   * a Host start; close the Host first, since a release must not run beside a delegation.
   */
  if (command === 'workspace-gc') {
    if (args.length || !options.db)
      throw new Error('Usage: workspace-gc --db <file> [--workspace dir] [--dry-run] [--json]');
    const root = resolveWorkspace(options.workspace ?? process.cwd());
    if (!options.dryRun) {
      const running = hostLockHolders(root);
      if (running.length)
        throw new Error(
          `A Host is running in this workspace (pid ${running.map((entry) => String(entry.pid)).join(', ')}); close it before workspace-gc`,
        );
    }
    const identity = await repositoryIdentity(root);
    if (!identity) throw new Error(`${root} is not inside a Git working tree`);
    const store = new SessionStore(options.db);
    try {
      const owner = store.snapshotOwner();
      const recorded = new Set(store.workspaceSnapshotIds());
      const signal = new AbortController().signal;
      const outcome = options.dryRun
        ? undefined
        : await (async () => {
            // Re-check under the gate: a Host may have started between the early check and this point, and a Host
            // starting now waits or is refused by the same gate instead of racing the release.
            const gate = acquireMaintenanceGate(root);
            try {
              const running = hostLockHolders(root);
              if (running.length)
                throw new Error(
                  `A Host is running in this workspace (pid ${running.map((entry) => String(entry.pid)).join(', ')}); close it before workspace-gc`,
                );
              const released = await new WorkspaceManager({ store }).releaseUnusedSnapshots(signal);
              // The snapshot directories are metadata; their Git objects are only reclaimed by Git itself.
              const gc = await runWorkspaceGit(['gc', '--auto'], {
                cwd: identity.repositoryRoot,
                signal,
                allowFailure: true,
              });
              return {
                released,
                gc: gc.code === 0 ? ('ok' as const) : (`exit ${String(gc.code)}` as const),
                sweptStaging: await sweepAbandonedStaging(identity.repositoryRoot),
              };
            } finally {
              gate.release();
            }
          })();
      const inventory = await inventorySnapshots(identity.repositoryRoot, signal);
      const report = {
        repositoryRoot: identity.repositoryRoot,
        owner,
        ...(outcome ?? {}),
        snapshots: inventory.snapshots.map((entry) => ({
          ...entry,
          recordedHere: recorded.has(entry.id),
          // Formats before 4 and pre-owner refs are never deleted automatically: these are for a person to decide.
          needsDecision: entry.legacyRef || (entry.owners.length === 0 && entry.format !== 4),
        })),
        staging: inventory.staging,
      };
      process.stdout.write(JSON.stringify(report, null, options.json ? undefined : 2) + '\n');
    } finally {
      store.close();
    }
    return true;
  }
  if (command === 'workspace-lease-recover') {
    if (args.length !== 1 || !options.db)
      throw new Error('Usage: workspace-lease-recover <binding-id> --db <file> [--json]');
    const store = new SessionStore(options.db);
    try {
      const recovered = store.recoverWorkspaceOperation(args[0]!, {
        operator: operatorName(),
        reason:
          'Operator forced lease recovery from the command line: the owning process could not be confirmed dead',
      });
      process.stdout.write(JSON.stringify(recovered, null, options.json ? undefined : 2) + '\n');
    } finally {
      store.close();
    }
    return true;
  }
  /**
   * The Windows sandbox's counterpart of `session-recover`: a lease whose owner process has exited, which refuses
   * every sandboxed command until it is gone. `--dry-run` only reports the state; without it, the journals the dead
   * process left are restored first and its locks removed after. A live or unidentifiable owner is refused, never
   * guessed dead.
   */
  if (command === 'sandbox-recover') {
    if (args.length) throw new Error('Usage: sandbox-recover [--dry-run] [--json]');
    if (process.platform !== 'win32')
      throw new Error('sandbox-recover reconciles the Windows sandbox and only runs on Windows');
    const report = options.dryRun
      ? await inspectWindowsSandboxLeases()
      : await recoverWindowsSandboxLeases();
    process.stdout.write(JSON.stringify(report, null, options.json ? undefined : 2) + '\n');
    return true;
  }
  if (['db-backup', 'db-verify', 'db-restore', 'db-recover', 'db-compact'].includes(command)) {
    const takesFile = command === 'db-verify' || command === 'db-restore';
    if (args.length !== (takesFile ? 1 : 0) || (command !== 'db-verify' && !options.db))
      throw new Error(
        `Usage: ${command}${takesFile ? ' <file>' : ''}${command === 'db-verify' ? '' : ' --db <file>'} [--json]`,
      );
    const result =
      command === 'db-backup'
        ? backupDatabase(options.db!, SESSION_DATABASE_POLICY)
        : command === 'db-verify'
          ? inspectDatabase(args[0]!, SESSION_DATABASE_POLICY)
          : command === 'db-restore'
            ? restoreDatabase(options.db!, args[0]!, SESSION_DATABASE_POLICY)
            : command === 'db-compact'
              ? compactDatabase(options.db!)
              : recoverDatabase(options.db!);
    process.stdout.write(JSON.stringify(result, null, options.json ? undefined : 2) + '\n');
    return true;
  }
  if (command === 'resources') {
    if (args.length) throw new Error('Usage: resources [--workspace directory]');
    const root = resolveWorkspace(options.workspace ?? process.cwd());
    console.log(
      JSON.stringify(
        {
          instructions: loadInstructions(root).files,
          skills: discoverSkills(root, { analysisService: builtinServiceConfigured() }),
          extensions: extensionTools(root).map((t) => t.name),
        },
        null,
        2,
      ),
    );
    return true;
  }
  if (command === 'env') {
    printEnvironment(args, options);
    return true;
  }
  if (command === 'models') {
    await printModels(args, options);
    return true;
  }
  if (command === 'credentials') {
    await runCredentials(args);
    return true;
  }
  if (command === 'mcp') {
    await runMcp(args, options);
    return true;
  }
  return false;
}

/**
 * Every setting this program reads, from the table the program itself uses.
 *
 * The help text carries a hand-picked handful of names, and the full list lived only in the generated README
 * table — so the answer to "which `YUANTU_*` variables exist, and what does this one do?" was outside the
 * program that reads them. This prints `ENVIRONMENT` itself, with the shape the parser enforces and the value
 * in this process, so a name that exists cannot be missing here and a name that does not exist cannot appear.
 *
 * The descriptions are the code's own strings, which are Chinese, exactly as the generated settings table in
 * the README prints them. Translating them is a separate decision (the desktop's settings UI is where that
 * matters), and inventing an English paraphrase here would be a second description to keep in step.
 */
function printEnvironment(args: string[], options: Options): void {
  if (args.length) throw new Error('Usage: env [--json]');
  /**
   * A credential is reported as present or absent, never as itself.
   *
   * The same rule `credentials list` follows, and for the same reason: a command that can print a secret puts it
   * in scrollback, in the shell's history and in whatever collects a terminal's output. The rule itself lives in
   * `isCredentialSetting`, shared with the desktop's settings page, because two readers showing values must not
   * disagree about which ones are secrets.
   */
  const rows = Object.entries(ENVIRONMENT).map(([name, spec]) => ({
    name,
    shape: settingShape(spec),
    value:
      process.env[name] === undefined
        ? null
        : isCredentialSetting(name)
          ? '[redacted]'
          : process.env[name]!,
    description: spec.description,
  }));
  if (options.json) {
    process.stdout.write(`${JSON.stringify(rows)}\n`);
    return;
  }
  process.stdout.write(`${rows.length} setting(s) this program reads:\n`);
  for (const row of rows)
    process.stdout.write(
      `  ${row.name}\n    ${row.shape}${row.value === null ? ' · unset' : ` · now: ${row.value}`}\n    ${row.description}\n`,
    );
}

/**
 * What the endpoint says its models can take.
 *
 * The point of this command is the number a run needs and this runtime refuses to invent: the context
 * window. It is an operator action rather than a startup step because it is a network call, and a run must
 * still work when the catalogue endpoint is unreachable — in that case the operator declares the window by
 * hand. Requires neither a model id nor a workspace: choosing the model is what this answers.
 */
async function printModels(args: string[], options: Options): Promise<void> {
  if (args.length) throw new Error('Usage: models [--json]');
  const config = readConfig(process.env, { model: 'optional' });
  const discovered = await discoverModels(config);
  if (options.json) {
    process.stdout.write(`${JSON.stringify(discovered)}\n`);
    return;
  }
  process.stdout.write(
    `${discovered.endpoint} (${discovered.protocol}) lists ${discovered.models.length} model(s):\n`,
  );
  for (const model of discovered.models) {
    const window =
      model.contextWindow === undefined ? 'window not declared' : `window ${model.contextWindow}`;
    const output =
      model.maxOutputTokens === undefined ? '' : `, max output ${model.maxOutputTokens}`;
    const active = config.model && model.id === config.model ? '   ← YUANTU_MODEL' : '';
    process.stdout.write(`  ${model.id}  (${window}${output})${active}\n`);
  }
  process.stdout.write(
    '\nDeclare the window with --max-context-tokens <n> or YUANTU_MAX_CONTEXT_TOKENS; a run without one is refused.\n',
  );
}

/**
 * The key is read from standard input, never from an argument.
 *
 * An argument is visible to every process on the machine (`ps`, the shell's own history, a container's
 * inspect output), so a command that took a secret as one would be a command that leaks it to whoever can
 * look at the process table. Standard input is the one channel this program already owns.
 *
 * `set` writes; `list` says which protocols have a key and never the key itself, because a command that can
 * print a secret is a command that puts it in scrollback and in whatever collects that.
 */
async function runCredentials(args: string[]): Promise<void> {
  const [action, protocol] = args;
  const file = credentialsPath(process.env);
  if (action === 'list') {
    if (protocol) throw new Error('Usage: credentials list');
    const stored = Object.keys(readCredentials(process.env)).sort();
    process.stdout.write(
      `${file}\n${stored.length ? stored.map((name) => `  ${name}\n`).join('') : '  (no stored credentials)\n'}`,
    );
    return;
  }
  if (action !== 'set') throw new Error(`Unknown credentials action: ${action ?? '(none)'}`);
  if (!protocol || args.length !== 2) throw new Error('Usage: credentials set <protocol>');
  const key = (await readStandardInput()).trim();
  if (!key) throw new Error('No key on standard input');
  saveCredential(protocol, key, process.env);
  process.stderr.write(`Stored a key for ${protocol} in ${file}\n`);
}

async function runMcp(args: string[], options: Options): Promise<void> {
  const root = resolveWorkspace(options.workspace ?? process.cwd());
  const configs = readMcpConfigs(root);
  const store = new McpOAuthTokenStore();
  const [action, id] = args;
  if (!action || action === 'list') {
    if (id) throw new Error('Usage: mcp list [--workspace directory]');
    const rows = configs.map((config) => ({
      id: config.id,
      transport: config.transport,
      ...(config.url ? { url: config.url } : {}),
      ...(config.oauth ? { oauth: readMcpOAuthStatus(config, store) } : {}),
    }));
    process.stdout.write(JSON.stringify(rows, null, options.json ? undefined : 2) + '\n');
    return;
  }
  if (action !== 'authorize' && action !== 'revoke')
    throw new Error(`Unknown mcp action: ${action}`);
  if (!id || args.length !== 2)
    throw new Error(`Usage: mcp ${action} <server-id> [--workspace directory]`);
  const config = configs.find((candidate) => candidate.id === id);
  if (!config) throw new Error(`Unknown MCP server: ${id}`);
  if (action === 'revoke') {
    await revokeMcpAuthorization(config, store);
    process.stderr.write(`MCP authorization for ${id} was removed.\n`);
    return;
  }
  if (!config.oauth) throw new Error(`MCP server ${id} has no oauth block in .yuantu/mcp.json`);
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.on('SIGINT', abort);
  process.on('SIGTERM', abort);
  try {
    await authorizeMcpServer({
      config,
      store,
      signal: controller.signal,
      openUrl: (url) => {
        process.stderr.write(
          `Open this URL in a browser to authorize MCP server ${id}:\n${url.href}\n`,
        );
      },
    });
    process.stderr.write(`MCP server ${id} is authorized.\n`);
  } finally {
    process.off('SIGINT', abort);
    process.off('SIGTERM', abort);
  }
}

/** Who ran a maintenance command, as the operating system names them; the record says "unknown" rather than fail. */
function operatorName(): string {
  try {
    return userInfo().username || 'unknown';
  } catch {
    return 'unknown';
  }
}
