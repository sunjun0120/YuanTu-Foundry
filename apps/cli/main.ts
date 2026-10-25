#!/usr/bin/env node
import { requireProductEntry } from '../../packages/protocol/product-scope.ts';
import { readPermissionPolicy } from '../../packages/core/permissions.ts';
import { assertEnvironment } from '../../packages/protocol/settings.ts';
import { parseArgs } from '../shared/args.ts';
import {
  openStore,
  resolveWorkspace,
  safeError,
  display,
  applySandboxDefaults,
} from '../shared/runtime.ts';
import { assertSessionCommand } from './arguments.ts';
import { HELP } from './help.ts';
import { runStandaloneCommand } from './maintenance.ts';
import { runAgentCommand } from './run.ts';
import { runRecordCommand } from './task-commands.ts';
import { createApprover, createQuestioner } from './terminal.ts';
import { excludeRuntimeState } from '../../packages/workspaces/runtime-exclude.ts';

// The product-scope guard must run before arguments are parsed or workspace state is opened: whether this
// entry point exists is a product decision, not a startup option. The CLI is enabled today, so this is a no-op.
requireProductEntry('cli');

async function main(): Promise<void> {
  // The environment is checked before anything is read from it: a mistyped YUANTU_* name is refused with the
  // name it probably meant, instead of being ignored while the run quietly uses a different budget.
  assertEnvironment();
  // ...and the command sandbox is chosen before anything reads it, so the default is this platform's real
  // backend rather than "no isolation" (see `applySandboxDefaults`).
  applySandboxDefaults();
  // Said once at start rather than discovered at the first command: this platform has no native backend, and
  // the default stays fail-closed until the user chooses host themselves.
  if (
    process.env.YUANTU_SANDBOX === 'native' &&
    process.platform !== 'win32' &&
    process.platform !== 'darwin'
  )
    process.stderr.write(
      `Note: no native command sandbox on ${process.platform}; commands will be refused. ` +
        'Set YUANTU_SANDBOX=host to run them without OS isolation.\n',
    );
  const { positionals, options } = parseArgs(process.argv.slice(2));
  if (options.help || !positionals.length) {
    process.stdout.write(HELP);
    return;
  }
  const [command, ...args] = positionals as [string, ...string[]];
  // Refused rather than ignored: the CLI is a carrier, not a Host — it runs the kernel in-process and never
  // serves a socket (the desktop is the carrier that spawns a Host) — so `--listen` could only ever be a
  // mistake about which program serves one. Silently accepting it would look like the CLI was reachable over
  // the network when it is not.
  if (options.listen !== undefined)
    throw new Error(
      'The CLI does not serve a socket; start the Agent Host with --listen [host:]port instead',
    );
  if (await runStandaloneCommand(command, args, options)) return;
  assertSessionCommand(command, args);
  const permissionPolicy = readPermissionPolicy(
    options.permissionPolicy ?? process.env.YUANTU_PERMISSION_POLICY,
  );
  const store = openStore(options);
  try {
    const workspace = resolveWorkspace(options.workspace ?? process.cwd());
    // Keep the runtime's `.yuantu` out of the user's `git status`; best effort, never a reason to fail a command.
    await excludeRuntimeState(workspace).catch(() => undefined);
    // A sub-agent session is hidden from the session list and has no tasks, so a `running` run an
    // earlier crashed invocation left behind would never be looked at again — by anything. The Host does
    // this at startup; the CLI is one-shot, so it converges its workspace on every invocation instead.
    store.reconcileChildRuns(workspace);
    // The same convergence for ordinary sessions, which is also what makes `sessions`, `--json` and delete
    // usable after a crash rather than showing a conversation that is stuck "in flight" forever.
    store.reconcileInterruptedRuns(workspace);
    store.recoverInterruptedTasks(workspace);
    store.recoverInterruptedStreams(workspace);
    const approve = createApprover(options, permissionPolicy);
    if (await runRecordCommand(store, command, args, options, approve)) return;
    await runAgentCommand(
      store,
      command,
      args,
      options,
      permissionPolicy,
      approve,
      createQuestioner(options),
    );
  } finally {
    store.close();
  }
}
await main().catch((error) => {
  process.stderr.write(display(safeError(error)) + '\n');
  process.exitCode = 1;
});
