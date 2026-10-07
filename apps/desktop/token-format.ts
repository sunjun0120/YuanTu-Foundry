/**
 * How a token count is written down, in one place.
 *
 * Two surfaces print tokens — the composer's usage pill and the sub-agent catalog — and a session's total
 * that reads `93.7M` in one of them and `93700000` in the other is two answers to one question. The compact
 * form is DSH's: whole numbers from a hundred up, one decimal below that, `K` and `M` as the only units.
 */

/**
 * Compact token count: 517 / 12.2K / 517K / 1.2M.
 * @param value - non-negative token count.
 * @returns display string without a unit.
 */
export function formatTokens(value: number): string {
  const scaled = (candidate: number): string =>
    candidate >= 100 ? String(Math.round(candidate)) : String(Math.round(candidate * 10) / 10);
  if (value < 1_000) return String(value);
  if (value < 1_000_000) return scaled(value / 1_000) + 'K';
  return scaled(value / 1_000_000) + 'M';
}

/**
 * Exact integer token count with digit grouping: 93,693,927.
 * @param value - non-negative safe integer token count.
 * @returns an unrounded display string.
 */
export function formatExactTokens(value: number): string {
  const digits = String(value);
  const groups: string[] = [];
  for (let end = digits.length; end > 0; end -= 3)
    groups.unshift(digits.slice(Math.max(0, end - 3), end));
  return groups.join(',');
}
