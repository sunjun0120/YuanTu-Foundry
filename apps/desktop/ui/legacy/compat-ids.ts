/**
 * The migration's transitional id table, closing record.
 *
 * While a region was moving into React it could keep rendering an id the desktop smoke suites still read, so the same
 * assertion did not have to move in the same commit as the component. That table is empty now: every region React
 * owns renders its own host ids, and `tests/compat-ids.test.ts` keeps it that way.
 *
 * Kept in the tree rather than deleted because the completion rule needs a place to live: an entry added after
 * `MIGRATION_COMPLETE` is a leftover, not a transition, and a reintroduced `compatId()` call is the same mistake by
 * another name.
 */
export interface CompatId {
  /** The DOM id React renders while an old assertion still reads it. */
  readonly id: string;
  /** The task that owns the region, e.g. `T14`. */
  readonly region: string;
  /** The test and assertion that still read the id. */
  readonly reason: string;
  /** What deletes this entry: the assertion that replaces it. */
  readonly removal: string;
}

/** Empty: no region needs a transitional id any more. */
export const COMPAT_IDS: readonly CompatId[] = [];

/** Set when the old DOM was gone; the table above must stay empty from here on. */
export const MIGRATION_COMPLETE = true;
