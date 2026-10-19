import type { ChildProcess } from 'node:child_process';
import { toolEnvironment } from './environment.ts';
import { killTree } from './process.ts';
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
} from './sandbox-provider.ts';
import { windowsSandboxProvider } from './sandbox-windows.ts';
import { seatbeltSandboxProvider } from './sandbox-seatbelt.ts';
import { nativeSandboxBackend } from './sandbox-mode.ts';
import { executionPolicy, requireExecutionCapabilities } from './execution-policy.ts';
import { HOST_CAPABILITIES } from './execution-capabilities.ts';

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
  return {
    executable: argv ? command : win ? (process.env.ComSpec ?? 'cmd.exe') : '/bin/sh',
    args: argv ? [...argv] : win ? ['/d', '/s', '/c', '"' + command + '"'] : ['-c', command],
    cwd,
    env: { ...toolEnvironment(), ...(request.env ?? {}) },
    windowsVerbatimArguments: win && !argv,
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
      if (process.platform === 'win32') await killTree(child.pid);
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
registerSandboxProvider(seatbeltSandboxProvider);
registerSandboxProvider({
  mode: 'native',
  description:
    'Native operating-system sandbox: Windows restricted token or macOS Seatbelt; unavailable policies fail closed.',
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
