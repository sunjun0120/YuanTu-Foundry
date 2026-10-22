import type { Isolation } from './environment.mjs';
export function installProcessProbe(
  config: object,
  violate: (rule: string, message: string) => never,
): void;
export function windowsSandboxStateDirectory(root: string): string;
export function readIsolationViolations(isolation: Isolation): Array<Record<string, unknown>>;
export function settleProcesses(
  isolation: Isolation,
  options?: { terminate?: (pid: number) => Promise<void> | void; timeoutMs?: number },
): Promise<{
  clean: boolean;
  remaining: number[];
  verified: number[];
  terminated: number[];
  records: Array<Record<string, unknown>>;
}>;
