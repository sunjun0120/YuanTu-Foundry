import type { ExecutionMode } from '../protocol/execution.ts';

export const SANDBOX_MODES = ['host', 'native', 'windows-account', 'seatbelt'] as const;

/** One parser for environment settings, wire requests, and desktop choices. */
export function parseSandboxMode(value: unknown, name = 'sandbox mode'): ExecutionMode {
  if (value === 'docker' || value === 'sbx' || value === 'windows')
    throw new Error(
      `${value} sandbox was removed; select native for OS isolation or explicitly select host for full access`,
    );
  if (typeof value !== 'string' || !(SANDBOX_MODES as readonly string[]).includes(value))
    throw new Error(`Invalid ${name}; use host, native, windows-account, or seatbelt`);
  return value as ExecutionMode;
}

/** Shipped app settings migrate the retired token backend before normal validation. */
export function appSandboxMode(value: unknown, name = 'sandbox mode'): ExecutionMode {
  return value === 'windows' ? 'native' : parseSandboxMode(value, name);
}

/**
 * The platform backend `native` stands for.
 *
 * On Windows that is always the sandbox account backend. It is never silently replaced by the weaker restricted
 * token backend, which has been removed.
 */
export function nativeSandboxBackend(
  platform: NodeJS.Platform = process.platform,
): 'windows-account' | 'seatbelt' {
  if (platform === 'win32') return 'windows-account';
  if (platform === 'darwin') return 'seatbelt';
  throw new Error(
    `Native sandbox is unavailable on ${platform}; no host fallback is allowed. ` +
      'To run commands without OS isolation, start with YUANTU_SANDBOX=host explicitly.',
  );
}
