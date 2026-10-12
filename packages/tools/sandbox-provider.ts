/**
 * The sandbox *seam*: what a backend is, and who decides which one a command gets.
 *
 * Providers declare capabilities and own their prepared resources. Hooks inherit live call policy;
 * an explicit category override selects a backend without discarding file or network requirements.
 */
import path from 'node:path';
import { currentExecutionPolicy } from './execution-policy.ts';
import type {
  ExecutionCapabilities,
  FileEffect,
  NetworkEffect,
  ExecutionMode,
} from '../protocol/execution.ts';
import { parseSandboxMode } from './sandbox-mode.ts';
import { registerExecutionCapabilities } from './execution-capabilities.ts';
/** The backends this project ships. A mode is also the value the setting accepts. */
export type SandboxMode = ExecutionMode;
/**
 * What a sandbox decision is *about*.
 *
 * Two categories, not four: `command` is everything that spawns a shell for the run (foreground commands,
 * background commands, acceptance checks), and `hook` is the external-hook bridge. Adding a category means
 * adding a real second reader for it — a category nothing asks about is a knob with no wire.
 */
export type SandboxCategory = 'command' | 'hook';
export interface SandboxConfig {
  mode: SandboxMode;
  image: string;
  /** Workspace file effects, independent of the backend identity. Omission preserves legacy behavior. */
  files?: FileEffect;
  network?: NetworkEffect;
}
export interface SandboxPlan {
  /** Kernel containment or group termination; group termination cannot reap a detached descendant. */
  processTree?: 'contained' | 'process-group';
  executable: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  windowsVerbatimArguments: boolean;
  /** Backend label for serialized workers; original plans retain their preparing provider privately. */
  backend?: SandboxMode;
  cleanupPath?: string;
}
export interface SandboxRequest {
  root: string;
  cwd: string;
  command: string;
  /** Set when the caller already has an argv (no shell quoting to do); `command` is then the program. */
  argv?: readonly string[];
  config: SandboxConfig;
  /** Trusted consumer configuration, never guest-controlled process flags. */
  env?: NodeJS.ProcessEnv;
}
export interface SandboxProvider {
  mode: SandboxMode;
  /** One line for an operator deciding which backend to pick: what it confines, and what it costs. */
  description: string;
  /** Trusted declaration, not proof of availability. Execution must still verify this backend can run. */
  capabilities?(config: SandboxConfig): ExecutionCapabilities;
  /**
   * Why this backend cannot run here, or `null` when it can.
   *
   * Resolves with a message instead of throwing: "native runner is unavailable" is an answer for a person, not an
   * exception for a caller that only wanted to know.
   */
  available(env?: NodeJS.ProcessEnv): Promise<string | null>;
  prepare(request: SandboxRequest): Promise<SandboxPlan>;
  /** Records possible guest execution on the original owner plan before a spawn or worker handoff. */
  started?(plan: SandboxPlan): void;
  /** Cooperatively stop a contained runner before generic host process termination. */
  stop?(plan: SandboxPlan): Promise<void>;
  /**
   * Undo whatever `prepare` created — the provider's own business, which is why the caller no longer needs to
   * know how the command was wrapped. Called more than once on the same plan (kill-then-verify), so it must be
   * idempotent.
   */
  cleanup(plan: SandboxPlan): Promise<void>;
}
const registry = new Map<SandboxMode, SandboxProvider>();
/**
 * The workspace-relative path of a command's working directory, refusing anything outside the workspace.
 *
 * All providers refuse an outside cwd. The caller canonicalizes paths before this textual comparison.
 */
export function insideWorkspace(root: string, cwd: string): string {
  const relative = path.relative(root, cwd);
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative))
    throw new Error('Sandbox cwd is outside workspace');
  return relative;
}
/** Registers a backend, replacing any previous one for that mode — the hook an embedder needs to add a runner. */
export function registerSandboxProvider(provider: SandboxProvider): void {
  registerExecutionCapabilities(provider.mode, provider.capabilities?.bind(provider));
  registry.set(provider.mode, provider);
}
export function sandboxProvider(mode: SandboxMode): SandboxProvider {
  const provider = registry.get(mode);
  if (!provider) throw new Error(`No sandbox provider registered for mode ${mode}`);
  return provider;
}
/** Every registered backend, in registration order (the three built-ins first, then whatever was added). */
export function sandboxProviders(): SandboxProvider[] {
  return [...registry.values()];
}
/** The setting each category reads. `command` is what `YUANTU_SANDBOX` has always meant. */
const CATEGORY_KEYS: Record<SandboxCategory, string> = {
  command: 'YUANTU_SANDBOX',
  hook: 'YUANTU_SANDBOX_HOOK',
};
/**
 * The mode an in-process caller switched to at runtime, or `undefined` when nobody has.
 *
 * `resolveSandboxConfig` is read *per command*, which is what makes a session-scoped choice possible at all.
 * Until this existed the only way to move the sandbox was to restart the process with a different
 * `YUANTU_SANDBOX` — the desktop did exactly that, stopping the carrier and starting a new one — because the
 * value looked like it was only read at startup. It is not: the enforcement points (git, terminal, MCP, LSP,
 * validation) each ask at call time, so a switch made in the interface takes effect on the next command and
 * disturbs neither the process nor the session nor a running terminal.
 *
 * It outranks the environment on purpose. `YUANTU_SANDBOX` is the *default* a deployment starts from — which
 * mode new sessions begin in — while a switch made in the interface is the more recent, more specific
 * statement, and a default that could not be moved from the UI was the thing this replaced.
 *
 * It applies to the `command` category only. The hook bridge answers a different question ("where may a hook
 * run"), it is loaded once per run, and the interface offers no control for it.
 */
let runtimeCommandMode: SandboxMode | undefined;
/** Switch the mode commands are confined by, from inside the process that runs them. */
export function setSandboxMode(mode: SandboxMode | undefined): void {
  if (mode !== undefined) parseSandboxMode(mode);
  runtimeCommandMode = mode;
}
/** The mode a runtime switch put in force, or `undefined` while the environment still decides. */
export function sandboxModeOverride(): SandboxMode | undefined {
  return runtimeCommandMode;
}
/**
 * Which sandbox a category uses: its own setting when set, the global `YUANTU_SANDBOX` otherwise.
 *
 * File and network requirements remain independent of the category's backend selection.
 */
export function resolveSandboxConfig(
  env: NodeJS.ProcessEnv = process.env,
  category: SandboxCategory = 'command',
): SandboxConfig {
  const key = CATEGORY_KEYS[category];
  const configured = env[key] ?? env.YUANTU_SANDBOX ?? 'host';
  const fixed = currentExecutionPolicy();
  const mode =
    category === 'hook' && env[key] !== undefined
      ? configured
      : (fixed?.mode ?? (category === 'command' ? (runtimeCommandMode ?? configured) : configured));
  const parsedMode = parseSandboxMode(mode, key);
  const files = fixed?.files ?? env.YUANTU_SANDBOX_FILES;
  const network = fixed?.requestedNetwork ?? env.YUANTU_SANDBOX_NETWORK;
  if (files !== undefined && files !== 'read-only' && files !== 'workspace-write')
    throw new Error('Invalid sandbox file policy');
  if (network !== undefined && network !== 'denied' && network !== 'unrestricted')
    throw new Error('Invalid sandbox network policy');
  return {
    mode: parsedMode,
    image: fixed?.image ?? 'native',
    ...(files ? { files } : {}),
    ...(network ? { network } : {}),
  };
}
