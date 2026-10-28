/**
 * The desktop's own way out of a dead sandbox lease.
 *
 * The Windows backend grants workspace permissions to a sandbox identity and journals the change so it can put
 * them back. A Host that exits in the middle keeps the grant and leaves a journal, and from then on every command
 * is refused before approval — correctly, because nobody can tell whether the grant is still in use. The only
 * remedy shipped with the desktop used to be an English sentence naming `yuantu-agent sandbox-recover`, a CLI
 * that the desktop installer deliberately does not contain, so a person who ran only the desktop had no way out
 * of a state the product itself created.
 *
 * This module is the main-process half of the remedy: read the same lease directory the backend reads, and let a
 * person trigger the same restore the CLI does. It returns codes and paths rather than sentences — the words a
 * person reads belong to the renderer's dictionary, and the main process has no locale of its own until settings
 * are loaded.
 */
import {
  inspectWindowsSandboxLeases,
  recoverWindowsSandboxLeases,
  type WindowsSandboxLeaseReport,
  type WindowsSandboxLeaseState,
} from '../../packages/sandbox/windows-sandbox-recovery.ts';

export type SandboxRecoveryCommand = { type: 'status' } | { type: 'recover' };
export interface SandboxRecoveryView {
  /** False off Windows: there is no ACL lease to reconcile. */
  supported: boolean;
  state: WindowsSandboxLeaseState;
  /** Whether `recover` would do something now. `held`/`unreadable` are refusals, not repairs. */
  recoverable: boolean;
  restored: string[];
  removed: string[];
}
export type SandboxRecoveryReply =
  { ok: true; view: SandboxRecoveryView } | { ok: false; error: string; detail?: string };
export interface SandboxRecoveryDeps {
  platform?: NodeJS.Platform;
  inspect?: () => Promise<WindowsSandboxLeaseReport>;
  recover?: () => Promise<WindowsSandboxLeaseReport & { restored: string[]; removed: string[] }>;
}
const unsupported: SandboxRecoveryView = {
  supported: false,
  state: 'clear',
  recoverable: false,
  restored: [],
  removed: [],
};
function viewOf(
  report: WindowsSandboxLeaseReport,
  restored: string[] = [],
  removed: string[] = [],
): SandboxRecoveryView {
  return {
    supported: true,
    state: report.state,
    recoverable: report.state === 'stale' || report.state === 'needs-restore',
    restored,
    removed,
  };
}
/** Read-only: what the lease directory says, without restoring anything. */
export async function inspectSandboxRecovery(
  deps: SandboxRecoveryDeps = {},
): Promise<SandboxRecoveryView> {
  if ((deps.platform ?? process.platform) !== 'win32') return unsupported;
  return viewOf(await (deps.inspect ?? inspectWindowsSandboxLeases)());
}
/**
 * Restore every journaled workspace and release the dead owner's locks.
 *
 * Refuses (by throwing the backend's `EnvironmentBlockedError`) while an owner is alive or unidentifiable, which
 * is the same rule the CLI applies: this never decides that a running process is gone.
 */
export async function recoverSandboxLease(
  deps: SandboxRecoveryDeps = {},
): Promise<SandboxRecoveryView> {
  if ((deps.platform ?? process.platform) !== 'win32') return unsupported;
  const report = await (deps.recover ?? recoverWindowsSandboxLeases)();
  return viewOf(report, report.restored, report.removed);
}
export function parseSandboxRecoveryCommand(input: unknown): SandboxRecoveryCommand {
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    const value = input as Record<string, unknown>;
    if (value.type === 'status' && Object.keys(value).length === 1) return { type: 'status' };
    if (value.type === 'recover' && Object.keys(value).length === 1) return { type: 'recover' };
  }
  throw new Error('Invalid sandbox recovery request');
}
