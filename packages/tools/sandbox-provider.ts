/**
 * The sandbox *seam*: what a backend is, and who decides which one a command gets.
 *
 * This used to be a chain of `if` branches on `YUANTU_SANDBOX` inside `prepareSandbox`, and teardown lived in a
 * single `cleanupSandbox` that reconstructed a container-removal command from the *execution* argv it had just
 * produced (`plan.args.slice(0, 4)` — the docker client's `--config`/`--host` prefix). Two costs came with that
 * shape, and they are what this file removes: a backend cannot be added without editing the dispatcher, and
 * "how do I tear this down" is knowledge that leaks out of the backend that created it.
 *
 * The provider is the mechanism; the *category* is the policy, and the two are separate on purpose. A run may
 * confine its commands to a container while its hooks run on the host (`YUANTU_SANDBOX_HOOK`): a hook is one
 * command per event and cannot pay for a container each time, and a hook *inside* the run's container was never
 * possible either (the container is created per command and torn down with it). Before this seam the only way
 * to say "commands confined, hooks on the host" was to turn the sandbox off for everything at once.
 */
import path from 'node:path';
import { currentExecutionPolicy } from './execution-policy.ts';
/** The backends this project ships. A mode is also the value the setting accepts. */
export type SandboxMode = 'host' | 'docker' | 'sbx' | 'windows';
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
}
export interface SandboxPlan {
  executable: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  windowsVerbatimArguments: boolean;
  containerName?: string;
  /** Which provider produced this plan; `cleanupSandbox` dispatches on it, and nothing else reads it. */
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
  /**
   * Why this backend cannot run here, or `null` when it can.
   *
   * Resolves with a message instead of throwing: "docker is not installed" is an answer for a person, not an
   * exception for a caller that only wanted to know.
   */
  available(env?: NodeJS.ProcessEnv): Promise<string | null>;
  prepare(request: SandboxRequest): Promise<SandboxPlan>;
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
 * Two invariants, one home. It used to live in `sandbox.ts`, which is where the container backends needed it —
 * but a backend that only *grants* the workspace (the Windows one grants an ACL) must refuse an outside `cwd`
 * for the same reason a container must not mount it, and a second copy of this check is a second answer to
 * "what counts as inside" that drifts the first time one of them is fixed. The comparison is textual on
 * purpose: `..` segments are the attack this catches, and the caller resolves real paths before asking.
 */
export function insideWorkspace(root: string, cwd: string): string {
  const relative = path.relative(root, cwd);
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative))
    throw new Error('Sandbox cwd is outside workspace');
  return relative;
}
/** Registers a backend, replacing any previous one for that mode — the hook an embedder needs to add a runner. */
export function registerSandboxProvider(provider: SandboxProvider): void {
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
  if (
    mode !== undefined &&
    mode !== 'host' &&
    mode !== 'docker' &&
    mode !== 'sbx' &&
    mode !== 'windows'
  )
    throw new Error('Invalid sandbox mode; use host, docker, sbx, or windows');
  runtimeCommandMode = mode;
}
/** The mode a runtime switch put in force, or `undefined` while the environment still decides. */
export function sandboxModeOverride(): SandboxMode | undefined {
  return runtimeCommandMode;
}
/**
 * Which sandbox a category uses: its own setting when set, the global `YUANTU_SANDBOX` otherwise.
 *
 * The image stays global: it answers "which container", and the two categories that ask differ in *whether*
 * there is a container, not in which one.
 */
export function resolveSandboxConfig(
  env: NodeJS.ProcessEnv = process.env,
  category: SandboxCategory = 'command',
): SandboxConfig {
  const key = CATEGORY_KEYS[category];
  const configured = env[key] ?? env.YUANTU_SANDBOX ?? 'host';
  const fixed = category === 'command' ? currentExecutionPolicy() : undefined;
  const mode =
    category === 'command' ? (fixed?.mode ?? runtimeCommandMode ?? configured) : configured;
  const image = fixed?.image ?? env.YUANTU_SANDBOX_IMAGE ?? 'node:24-bookworm-slim';
  if (mode !== 'host' && mode !== 'docker' && mode !== 'sbx' && mode !== 'windows')
    throw new Error(`Invalid ${key}; use host, docker, sbx, or windows`);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]{0,255}$/.test(image))
    throw new Error('Invalid sandbox image');
  return { mode, image };
}
