import { appSandboxMode } from '../../packages/sandbox/sandbox-mode.ts';
import type { SandboxMode } from '../../packages/sandbox/sandbox.ts';

/**
 * What the desktop needs to know about the sandbox: which mode a session is in, which image, and whether the
 * backend it names can actually run here.
 *
 * The mode used to be a *desktop* setting with its own file, written by a form, applied by restarting the
 * carrier process. It is a **per-session** choice now (`packages/sandbox/sandbox-provider.ts` reads the mode per
 * command, so the Host can be told to switch without a restart), and what is left for a deployment to say is
 * the default a new session starts from — `YUANTU_SANDBOX` when the launch environment names one, `native`
 * otherwise. That is a fact about how the program was started, not a preference, which is why nothing here
 * writes a file any more.
 */
export type { SandboxMode };

export interface SandboxSettingsView {
  mode: SandboxMode;
  image: string;
  /** Why the backend this mode names cannot run here, or `null` when it can (or nobody has asked yet). */
  availability: string | null;
}
/**
 * The one command this module still parses: a request to *set* the mode.
 *
 * The parser survives the form that used to send it because the rule it enforces is the rule: switching to
 * `host` gives up operating-system isolation, and that takes an explicit acknowledgement. The preset path runs
 * this before anything moves, so a preset cannot become a quieter way to reach the host than the mode selector
 * was.
 */
export type SandboxSettingsCommand = { type: 'set'; mode: SandboxMode; acknowledgeHost?: boolean };
export function parseSandboxSettingsCommand(input: unknown): SandboxSettingsCommand {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error('Invalid sandbox settings request');
  const value = input as Record<string, unknown>;
  if (value.type !== 'set') throw new Error('Invalid sandbox settings request');
  const mode = appSandboxMode(value.mode);
  if (
    value.type !== 'set' ||
    Object.keys(value).some((key) => !['type', 'mode', 'acknowledgeHost'].includes(key)) ||
    (value.acknowledgeHost !== undefined && typeof value.acknowledgeHost !== 'boolean')
  )
    throw new Error('Invalid sandbox settings request');
  if (value.mode === 'host' && value.acknowledgeHost !== true)
    throw new Error('Confirm that host commands have no operating-system isolation');
  return {
    type: 'set',
    mode,
    ...(value.acknowledgeHost !== undefined
      ? { acknowledgeHost: value.acknowledgeHost as boolean }
      : {}),
  };
}
/**
 * The mode a new session starts in.
 *
 * `native` differs from the embedding library's `host` default. A desktop that
 * started unconfined because nobody said otherwise is the failure `applySandboxDefaults` exists to prevent for
 * the CLI and the Host. An operator who wants something else says so once, in the launch environment, and every
 * session starts there.
 */
export function defaultSandboxMode(env: NodeJS.ProcessEnv = process.env): SandboxMode {
  const value = env.YUANTU_SANDBOX;
  return appSandboxMode(value ?? 'native', 'YUANTU_SANDBOX');
}
