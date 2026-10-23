import type { HostContext } from './state.ts';

/** How often an idle Host gives free database pages back; one bounded batch per tick. */
export const RECLAIM_IDLE_INTERVAL_MS = 60_000;

/**
 * Give one batch of the session database's free pages back to the disk.
 *
 * Called after a delete, which is what frees pages, and on a timer while the Host is idle, which finishes what one
 * batch did not (`SessionStore.reclaimFreePages`). Housekeeping: a failure is reported and changes nothing else.
 */
export function reclaimSpace(ctx: Pick<HostContext, 'store'>): number {
  try {
    return ctx.store.reclaimFreePages();
  } catch (error) {
    process.stderr.write(`[host] reclaiming database space failed: ${(error as Error).message}\n`);
    return 0;
  }
}

/**
 * Reclaim while nothing is running, so the batches never compete with a run for the Host's one thread.
 * Returns the way to stop it.
 */
export function startIdleReclaim(
  ctx: Pick<HostContext, 'store' | 'active' | 'closing'>,
  intervalMs = RECLAIM_IDLE_INTERVAL_MS,
): () => void {
  const timer = setInterval(() => {
    if (ctx.closing || ctx.active.size > 0) return;
    reclaimSpace(ctx);
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
