import type { ToolContext } from '../protocol/index.ts';

/**
 * Applies run-owned bookkeeping a result implies, once the result is the model's.
 *
 * A call started early (`Tool.earlyStart`) can still be discarded, so its context collects the effect and the run
 * applies it on adoption; every other call has already been delivered by the time it returns, and the effect
 * runs now. Tools call this instead of branching on `deferEffect` themselves, so the two paths cannot drift.
 */
export function afterDelivery(context: Pick<ToolContext, 'deferEffect'>, effect: () => void): void {
  if (context.deferEffect) context.deferEffect(effect);
  else effect();
}
