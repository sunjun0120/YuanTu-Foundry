import type { ExecutionMode } from '../protocol/execution.ts';

export const SANDBOX_MODES = ['host', 'native', 'windows', 'seatbelt'] as const;

/** One parser for environment settings, wire requests, and desktop choices. */
export function parseSandboxMode(value: unknown, name = 'sandbox mode'): ExecutionMode {
  if (value === 'docker' || value === 'sbx')
    throw new Error(
      `${value} sandbox was removed; select native for OS isolation or explicitly select host for full access`,
    );
  if (typeof value !== 'string' || !(SANDBOX_MODES as readonly string[]).includes(value))
    throw new Error(`Invalid ${name}; use host, native, windows, or seatbelt`);
  return value as ExecutionMode;
}

export function nativeSandboxBackend(
  platform: NodeJS.Platform = process.platform,
): 'windows' | 'seatbelt' {
  if (platform === 'win32') return 'windows';
  if (platform === 'darwin') return 'seatbelt';
  throw new Error(`Native sandbox is unavailable on ${platform}; no host fallback is allowed`);
}
