/**
 * Freeze a value and everything under it, stopping at subtrees that are already frozen.
 *
 * The stop is what makes structural sharing cheap: a view built from parts frozen earlier (the messages a
 * previous snapshot already handed out) only walks what is new.
 */
export function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
