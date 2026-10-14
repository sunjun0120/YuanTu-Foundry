/**
 * The one machine-readable line a text listing ends with.
 *
 * `list_files` and `repo_map` answer in prose, and prose cannot say whether the list is the whole scope or the
 * part of it the budget allowed. That question is the point of this round of work, so the answer is appended as
 * a single `Retrieval metadata:` line carrying the coverage, the version behind it, the cursor to continue from
 * and how current the index is.
 *
 * Two details make it work rather than merely exist.
 *
 * - **The body is bounded first.** Appending after the body means the body has to leave room, or a long listing
 *   would push the sentence saying "this list was cut" off the end of the result — the marker would be the first
 *   casualty of the truncation it exists to report.
 * - **The line is itself bounded.** A pathological coverage object must not be able to spend the whole output
 *   budget on metadata; a caller that needs more than this reads the structured payload.
 */
import { MAX_TOOL_OUTPUT, TRUNCATION_MARKER, bounded } from './registry.ts';

/** How much of a result the metadata line may take. */
export const METADATA_BUDGET = 512;

export function withRetrievalMetadata(body: string, metadata: Record<string, unknown>): string {
  let line = `Retrieval metadata: ${JSON.stringify(metadata)}`;
  if (line.length > METADATA_BUDGET) line = line.slice(0, METADATA_BUDGET);
  // Room for the line, its newline, and `bounded`'s marker, so a cut body cannot push the metadata off the end.
  const room = Math.max(0, MAX_TOOL_OUTPUT - line.length - 1 - TRUNCATION_MARKER.length);
  return `${bounded(body, room)}\n${line}`;
}
