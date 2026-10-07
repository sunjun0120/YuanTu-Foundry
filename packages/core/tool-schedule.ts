import type { ToolCall } from '../protocol/index.ts';
/**
 * Which calls may overlap their siblings, and how many may do it at once.
 *
 * Sibling calls in one assistant message are independent as far as the model is concerned — it asked for all
 * of them at once — but they are not independent as far as the workspace is concerned. Which calls may
 * overlap is therefore the *tool's* statement (`Tool.isConcurrencySafe`), and this module is the part that
 * turns those statements into an order of dispatch without knowing anything about tools.
 */
export type ExecutionMode = 'parallel' | 'exclusive';
/**
 * Consecutive parallel-safe calls form one group; every exclusive call is a group of one and therefore an
 * ordering barrier. Groups run in model order, so a write between two reads still happens between them:
 *
 *   [read(A), read(B), write(A), read(C)]  →  [read(A), read(B)], [write(A)], [read(C)]
 *
 * Grouping is by adjacency rather than by partitioning all the calls, because reordering a call past another
 * call the model wrote between them would be a change to what the model asked for. A barrier is not a penalty
 * the loop invented; it is the model's own order, preserved.
 */
export function groupToolCalls(
  calls: readonly ToolCall[],
  mode: (call: ToolCall) => ExecutionMode,
): ToolCall[][] {
  const groups: ToolCall[][] = [];
  let parallel = false;
  for (const call of calls) {
    const next = mode(call) === 'parallel';
    if (next && parallel) groups.at(-1)!.push(call);
    else groups.push([call]);
    parallel = next;
  }
  return groups;
}
/**
 * What happened to one item, in input order.
 *
 * `skipped` is not a failure: it is "this one was never started", which is the honest answer for a call the
 * loop decided not to dispatch (a steer arrived, the run was cancelled). A caller that conflated it with
 * `rejected` would report an effect that never happened.
 */
export type BoundedOutcome<T> =
  | { status: 'fulfilled'; value: T }
  | { status: 'rejected'; reason: unknown }
  | { status: 'skipped' };
/**
 * Runs items with at most `limit` in flight, starting them in order and starting another whenever one
 * settles — a rolling pool, not fixed windows.
 *
 * Two properties are the whole point:
 *
 * - **Quiescence.** Every started item is awaited before this returns, including when one of them rejects or
 *   when `shouldStop` starts refusing new starts. A scheduler that returned early would leave a tool running
 *   while the loop that owns it moved on.
 * - **Order.** Outcomes come back positionally, so a fast call that finished first cannot jump ahead of a
 *   slow sibling in the caller's bookkeeping.
 *
 * `start` is invoked synchronously in start order, which is what makes the first `limit` items begin in model
 * order; `shouldStop` is consulted immediately before every start, never after, so a stop is never reported
 * for a call that did begin.
 */
export async function runBounded<T, R>(
  items: readonly T[],
  limit: number,
  start: (item: T, index: number) => Promise<R>,
  shouldStop?: () => boolean,
): Promise<BoundedOutcome<R>[]> {
  const outcomes: BoundedOutcome<R>[] = new Array(items.length);
  const inFlight = new Map<number, Promise<number>>();
  let next = 0;
  let stopped = false;
  const launch = (index: number): void => {
    inFlight.set(
      index,
      (async () => {
        try {
          outcomes[index] = { status: 'fulfilled', value: await start(items[index]!, index) };
        } catch (reason) {
          outcomes[index] = { status: 'rejected', reason };
        }
        return index;
      })(),
    );
  };
  while (next < items.length || inFlight.size) {
    while (next < items.length && inFlight.size < Math.max(1, limit)) {
      if (!stopped && shouldStop?.()) stopped = true;
      if (stopped) break;
      launch(next++);
    }
    if (stopped) {
      // Nothing new starts, but everything already started is still awaited below.
      for (let index = next; index < items.length; index++) outcomes[index] = { status: 'skipped' };
      next = items.length;
    }
    if (!inFlight.size) break;
    const settled = await Promise.race(inFlight.values());
    inFlight.delete(settled);
  }
  return outcomes;
}
