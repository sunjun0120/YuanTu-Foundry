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

/**
 * The platform backend `native` stands for.
 *
 * On Windows that is always the sandbox account backend. It is never silently replaced by the weaker restricted
 * token backend: `windows` remains an explicit, manual choice for machines where account setup is impossible.
 */
export function nativeSandboxBackend(
  platform: NodeJS.Platform = process.platform,
): 'windows' | 'windows-account' | 'seatbelt' {
  if (platform === 'win32') return 'windows-account';
  if (platform === 'darwin') return 'seatbelt';
  throw new Error(`Native sandbox is unavailable on ${platform}; no host fallback is allowed`);
}
