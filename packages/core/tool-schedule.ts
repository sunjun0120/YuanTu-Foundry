import type { ToolCall } from '../protocol/index.ts';
/**
 * Which sibling calls may overlap, and how many at once. Overlap is the tool's statement
 * (`Tool.isConcurrencySafe`); this module turns it into a dispatch order without knowing about
 * tools.
 */
export type ExecutionMode = 'parallel' | 'exclusive';
/**
 * Consecutive parallel-safe calls form one group; each exclusive call is a group of one and an
 * ordering barrier. Groups run in model order:
 *
 *   [read(A), read(B), write(A), read(C)]  ->  [read(A), read(B)], [write(A)], [read(C)]
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
/** What happened to one item, in input order. `skipped` means never started, not failed. */
export type BoundedOutcome<T> =
  | { status: 'fulfilled'; value: T }
  | { status: 'rejected'; reason: unknown }
  | { status: 'skipped' };
/**
 * Runs items with at most `limit` in flight, as a rolling pool.
 *
 * - Quiescence: every started item is awaited before returning, even after a rejection or a stop.
 * - Order: outcomes are positional.
 *
 * `start` runs synchronously in order. `shouldStop` is checked just before each start (with the
 * index), so a stop is never reported for a call that began.
 */
export async function runBounded<T, R>(
  items: readonly T[],
  limit: number,
  start: (item: T, index: number) => Promise<R>,
  shouldStop?: (index: number) => boolean,
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
      if (!stopped && shouldStop?.(next)) stopped = true;
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
