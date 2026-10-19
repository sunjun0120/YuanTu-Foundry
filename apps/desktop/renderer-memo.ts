/**
 * The last value computed from a list of inputs, recomputed only when one of them is a different object.
 *
 * The views below decide whether to redraw by comparing a serialized key of what they show. The preload keeps a
 * section that did not change as the same object (`SnapshotMirror`), so serializing it again on every render — the
 * whole sidebar, every task, every file change — only proved that nothing moved. Comparing the inputs first makes
 * the common case free, and a changed input still goes through the same key as before.
 */
export function memo<T>(): (inputs: readonly unknown[], compute: () => T) => T {
  let last: readonly unknown[] | undefined;
  let value: T;
  return (inputs, compute) => {
    if (
      !last ||
      last.length !== inputs.length ||
      inputs.some((input, index) => !Object.is(input, last![index]))
    ) {
      value = compute();
      last = inputs;
    }
    return value;
  };
}
