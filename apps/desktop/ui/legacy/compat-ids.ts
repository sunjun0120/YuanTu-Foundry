/**
 * The transitional id table: the one place a rendered id may exist in both the old DOM and the React tree.
 *
 * The migration replaces one region at a time, and the desktop smoke suites read ids (`#session-search`,
 * `#permission-trigger`, …). A region that moves to React would normally have to rewrite every smoke assertion in
 * the same commit, which makes a region look larger than it is and invites weakening an assertion to get it green.
 * This table is the agreed alternative: React may keep rendering a listed id while the smoke still reads it, and
 * both sides are deleted in the same commit once the assertion moves to a role, a label, or a visible value.
 *
 * The rules the test enforces:
 *
 * - an id is registered exactly once, carries the region that owns it, says which assertion still reads it, and
 *   says what removes it;
 * - a registered id is actually rendered through `compatId()` under `ui/`, so the table cannot hold stale entries;
 * - a registered id is still referenced by at least one test, so it cannot outlive the assertion that needed it;
 * - when `MIGRATION_COMPLETE` is set (T24), the table must be empty.
 *
 * `compatId()` itself does nothing to the value. The enforcement lives in the test because a missing registration
 * must be a red build, not a render-time throw in a shipped window.
 */
export interface CompatId {
  /** The DOM id React renders while the old assertion still reads it. */
  readonly id: string;
  /** The task that owns the region, e.g. `T14`. */
  readonly region: string;
  /** The test and assertion that still read the id. */
  readonly reason: string;
  /** What deletes this entry — the assertion that replaces it. */
  readonly removal: string;
}

/**
 * Empty at the start of the migration: no region has moved yet, so every id still belongs to the old DOM alone.
 * A region task adds its entries when it starts rendering the id, and removes them when its assertion moves.
 */
export const COMPAT_IDS: readonly CompatId[] = [];

/** Set by T24 when the old DOM is gone; a non-empty table after that point is a leftover, not a transition. */
export const MIGRATION_COMPLETE = false;

/** Render a listed id from a component. The value is the id itself; the table and the test do the enforcing. */
export function compatId(id: string): string {
  return id;
}

/**
 * The ids a source file renders through `compatId()`, for the test that compares render sites with the table.
 *
 * Kept here rather than in the test so the rule has one owner: a new call shape (`compatId( "x" )`, a template)
 * is either covered by this pattern or the table and the render sites disagree.
 */
export function compatIdUsages(source: string): readonly string[] {
  return [...source.matchAll(/compatId\(\s*'([^']+)'\s*\)/g)].map((match) => match[1]!);
}
