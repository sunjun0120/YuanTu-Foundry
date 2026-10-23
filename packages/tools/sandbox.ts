import type { ChildProcess } from 'node:child_process';
import { toolEnvironment } from './environment.ts';
import path from 'node:path';
import { killOrphans, killTree } from './process.ts';
import {
  registerSandboxProvider,
  resolveSandboxConfig,
  sandboxProvider,
  type SandboxCategory,
  type SandboxConfig,
  type SandboxMode,
  type SandboxPlan,
  type SandboxProvider,
  type SandboxRequest,
  type TerminalSize,
} from './sandbox-provider.ts';
import { windowsSandboxProvider } from './sandbox-windows.ts';
import { windowsAccountSandboxProvider } from './sandbox-account.ts';
import { seatbeltSandboxProvider } from './sandbox-seatbelt.ts';
import { nativeSandboxBackend } from './sandbox-mode.ts';
import { executionPolicy, requireExecutionCapabilities } from './execution-policy.ts';
import { HOST_CAPABILITIES } from './execution-capabilities.ts';
import { windowsShell, windowsShellArgs } from './windows-shell.ts';

// A registry entry can be replaced while a process runs. Resource ownership
// must remain attached to the original plan and provider, not its mutable tag.
const owners = new WeakMap<SandboxPlan, SandboxProvider>();

async function prepareOwned(
  provider: SandboxProvider,
  request: SandboxRequest,
): Promise<SandboxPlan> {
  const plan = await provider.prepare(request);
  if (!owners.has(plan)) owners.set(plan, provider);
  return plan;
}

function planOwner(plan: SandboxPlan): SandboxProvider {
  return owners.get(plan) ?? sandboxProvider(plan.backend ?? 'host');
}

export {
  registerSandboxProvider,
  resolveSandboxConfig,
  sandboxModeOverride,
  sandboxProvider,
  sandboxProviders,
  setSandboxMode,
} from './sandbox-provider.ts';
export { nativeSandboxBackend, parseSandboxMode } from './sandbox-mode.ts';
export type {
  SandboxCategory,
  SandboxConfig,
  SandboxMode,
  SandboxPlan,
  SandboxProvider,
  SandboxRequest,
} from './sandbox-provider.ts';

export async function checkSandboxAvailability(
  mode: SandboxMode,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  return sandboxProvider(mode).available(env);
}

async function hostPrepare(request: SandboxRequest): Promise<SandboxPlan> {
  const win = process.platform === 'win32';
  const { command, argv, cwd } = request;
  const shell = win && !argv ? windowsShell() : undefined;
  return {
    executable: argv ? command : shell ? shell.path : '/bin/sh',
    args: argv ? [...argv] : shell ? windowsShellArgs(shell, command) : ['-c', command],
    cwd,
    env: { ...toolEnvironment(), ...(request.env ?? {}) },
    // cmd's `/s /c "…"` form must reach it unquoted; PowerShell takes ordinary C-runtime arguments.
    windowsVerbatimArguments: shell?.kind === 'cmd',
  };
}

export async function prepareSandbox(
  root: string,
  cwd: string,
  command: string,
  argv?: readonly string[],
  config?: SandboxConfig,
  category: SandboxCategory = 'command',
  env?: NodeJS.ProcessEnv,
  terminal?: TerminalSize,
): Promise<SandboxPlan> {
  const resolved = config ?? resolveSandboxConfig(process.env, category);
  const policy = executionPolicy(resolved.mode, resolved);
  if (policy.files === 'read-only')
    requireExecutionCapabilities(policy, { processFiles: 'read-only' });
  return prepareOwned(sandboxProvider(resolved.mode), {
    root,
    cwd,
    command,
    argv,
    config: resolved,
    env,
    terminal,
  });
}

export async function cleanupSandbox(plan: SandboxPlan): Promise<void> {
  await planOwner(plan).cleanup(plan);
}

/** Guest execution may begin after this point; only the owning provider may release its resources. */
export function markSandboxStarted(plan: SandboxPlan): void {
  planOwner(plan).started?.(plan);
}

/** Used by execution workers: resources belong to the process that prepared the plan. */
export async function stopSandboxProcess(child: ChildProcess): Promise<void> {
  let failure: unknown;
  // On POSIX a detached process group can still contain children after its leader exited.
  if (child.pid && process.platform !== 'win32') await killTree(child.pid);
  if (child.pid && child.exitCode === null && child.signalCode === null) {
    try {
      if (process.platform === 'win32') {
        await killTree(child.pid);
        // A PowerShell host killed mid-start can leave the program it was starting behind (see `killOrphans`).
        if (/^(?:pwsh|powershell)(?:\.exe)?$/i.test(path.win32.basename(child.spawnfile ?? '')))
          await sweepOrphans(child, child.pid);
      }
      if (child.exitCode === null && child.signalCode === null)
        await new Promise<void>((resolve, reject) => {
          const closed = () => {
            clearTimeout(timer);
            resolve();
          };
          const timer = setTimeout(() => {
            child.removeListener('close', closed);
            reject(new Error('Process exit was not observed after tree termination'));
          }, 5000);
          child.once('close', closed);
        });
    } catch (error) {
      if (child.exitCode === null && child.signalCode === null) failure = error;
    }
  }
  if (failure) {
    const error = new Error(String(failure));
    error.name = 'ToolCleanupError';
    throw error;
  }
}

/**
 * Sweeps a killed shell's orphans until nothing holds its output open.
 *
 * One sweep right after `taskkill` is not enough under load: the program the shell was starting can finish being
 * created after it. The shell's pipes close only once every process holding them has exited, so that is the signal
 * the sweep runs until, for at most five seconds; a shell started without pipes has no such signal and is swept
 * three times over three quarters of a second.
 */
async function sweepOrphans(child: ChildProcess, pid: number): Promise<void> {
  const streams = [child.stdout, child.stderr].filter((stream) => stream !== null);
  const open = () => streams.some((stream) => !stream.destroyed && !stream.readableEnded);
  const deadline = Date.now() + 5000;
  for (let sweep = 0; ; sweep++) {
    await killOrphans(pid);
    if (streams.length ? !open() || Date.now() >= deadline : sweep >= 2) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/** The process tree owns its scratch until termination has actually been observed. */
export async function stopSandbox(child: ChildProcess, plan: SandboxPlan): Promise<void> {
  try {
    await planOwner(plan).stop?.(plan);
    await stopSandboxProcess(child);
    await cleanupSandbox(plan);
  } catch (cause) {
    if (cause instanceof Error && cause.name === 'ToolCleanupError') throw cause;
    const error = new Error(String(cause));
    error.name = 'ToolCleanupError';
    throw error;
  }
}

registerSandboxProvider({
  mode: 'host',
  capabilities: () => HOST_CAPABILITIES,
  description: 'No isolation: command runs on the host with a sanitized environment.',
  available: async () => null,
  prepare: hostPrepare,
  cleanup: async () => {},
});
registerSandboxProvider(windowsSandboxProvider);
registerSandboxProvider(windowsAccountSandboxProvider);
registerSandboxProvider(seatbeltSandboxProvider);
registerSandboxProvider({
  mode: 'native',
  description:
    'Native operating-system sandbox: Windows sandbox accounts or macOS Seatbelt; initialization and policy failures stop execution without fallback.',
  capabilities: (config) =>
    sandboxProvider(nativeSandboxBackend()).capabilities?.(config) ?? HOST_CAPABILITIES,
  available: async (env) => {
    try {
      return await sandboxProvider(nativeSandboxBackend()).available(env);
    } catch (error) {
      return String(error);
    }
  },
  blocked: async () => sandboxProvider(nativeSandboxBackend()).blocked?.(),
  prepare: (request) => prepareOwned(sandboxProvider(nativeSandboxBackend()), request),
  cleanup: async () => {
    throw new Error('A native plan must name the platform backend that owns its resources');
  },
});
