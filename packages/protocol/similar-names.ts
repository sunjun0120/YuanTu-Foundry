/** Levenshtein distance. Callers bound the inputs: every use compares short identifiers. */
export function editDistance(a: string, b: string): number {
  const rows = Array.from({ length: a.length + 1 }, (_, index) => [
    index,
    ...Array(b.length).fill(0),
  ]);
  for (let column = 1; column <= b.length; column++) rows[0]![column] = column;
  for (let row = 1; row <= a.length; row++)
    for (let column = 1; column <= b.length; column++)
      rows[row]![column] = Math.min(
        rows[row - 1]![column]! + 1,
        rows[row]![column - 1]! + 1,
        rows[row - 1]![column - 1]! + (a[row - 1] === b[column - 1] ? 0 : 1),
      );
  return rows[a.length]![b.length]!;
}

/** Names longer than this are not identifiers a model misspelt, and comparing them would cost for nothing. */
const MAX_COMPARED = 128;
const key = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * The candidates close enough to `wanted` to be worth suggesting, best first.
 *
 * Compared case- and separator-insensitively, because `readFile`, `read-file` and `read_file` are one name to the
 * model that wrote them. A candidate that ends with the wanted name (or the reverse) also counts: that is a name
 * written without its MCP server prefix, or with a prefix the tool does not have, and an edit distance as long as
 * the prefix would otherwise rule out the one suggestion that is right.
 */
export function similarNames(wanted: string, candidates: Iterable<string>, limit = 3): string[] {
  const target = key(wanted);
  if (!target || wanted.length > MAX_COMPARED) return [];
  const threshold = Math.max(2, Math.floor(target.length / 3));
  const ranked: { name: string; score: number }[] = [];
  for (const name of candidates) {
    const candidate = key(name);
    if (!candidate || name.length > MAX_COMPARED || name === wanted) continue;
    const affix =
      Math.min(target.length, candidate.length) >= 4 &&
      (candidate.endsWith(target) || target.endsWith(candidate));
    const score = affix ? 1 : editDistance(target, candidate);
    if (score <= threshold) ranked.push({ name, score });
  }
  return ranked
    .sort((a, b) => a.score - b.score || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .slice(0, limit)
    .map(({ name }) => name);
}
