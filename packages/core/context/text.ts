/**
 * How long a piece of text is, in the unit a budget is stated in.
 *
 * Not `.length`: that counts UTF-16 code units, so an emoji or any character outside the basic plane counts as
 * two, and a cut placed on an odd count splits the surrogate pair and produces a lone half that every encoder then
 * has to decide what to do with. `prune.ts` and `shrink.ts` both keep a head and a tail within a budget expressed
 * in characters, and both have to count — and cut — in the same unit they state the budget in.
 *
 * It lives on its own rather than in either of those two because both need it and they already depend on each
 * other in one direction (`prune` reads `recentStart` from `shrink`); a measure shared by two policy modules is
 * not owned by either, and giving it a home here is what keeps the import graph acyclic.
 */
export function codePointLength(text: string): number {
  return [...text].length;
}
