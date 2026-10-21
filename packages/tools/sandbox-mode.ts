import type { ExecutionMode } from '../protocol/execution.ts';

export const SANDBOX_MODES = ['host', 'native', 'windows', 'windows-account', 'seatbelt'] as const;

/** One parser for environment settings, wire requests, and desktop choices. */
export function parseSandboxMode(value: unknown, name = 'sandbox mode'): ExecutionMode {
  if (value === 'docker' || value === 'sbx')
    throw new Error(
      `${value} sandbox was removed; select native for OS isolation or explicitly select host for full access`,
    );
  if (typeof value !== 'string' || !(SANDBOX_MODES as readonly string[]).includes(value))
    throw new Error(`Invalid ${name}; use host, native, windows, windows-account, or seatbelt`);
  return value as ExecutionMode;
}

let windowsAccountReady = false;
/**
 * Recorded by the account backend whenever it learns its status (Host start, initialization, uninstall).
 *
 * `native` stays a synchronous choice: it reads this answer rather than asking the helper on every call.
 */
export function setWindowsAccountReady(ready: boolean): void {
  windowsAccountReady = ready;
}

/**
 * The platform backend `native` stands for.
 *
 * On Windows that is the sandbox account backend once it is initialized and verified, otherwise the restricted
 * token backend — the weaker boundary, kept so an uninitialized machine still confines writes.
 */
export function nativeSandboxBackend(
  platform: NodeJS.Platform = process.platform,
): 'windows' | 'windows-account' | 'seatbelt' {
  if (platform === 'win32') return windowsAccountReady ? 'windows-account' : 'windows';
  if (platform === 'darwin') return 'seatbelt';
  throw new Error(`Native sandbox is unavailable on ${platform}; no host fallback is allowed`);
}
