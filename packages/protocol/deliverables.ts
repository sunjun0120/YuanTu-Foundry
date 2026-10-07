/**
 * A file the model declares as a finished deliverable.
 *
 * `verify_file_delivery` answers "is this file what it claims to be", and `present` answers a different
 * question: "which of the files I produced are the ones you should look at". Without the second, the answer
 * to a long piece of work is a paragraph of prose naming paths, and the person reading it has to go find
 * them — on a desktop that already knows how to open a workspace file.
 *
 * Two properties shape the shape:
 *
 * 1. **The declaration is a fact about the workspace, recorded once.** Bytes and digest are taken at the
 *    moment of the declaration, because "the file I handed you" is a claim about a specific revision of a
 *    path; a panel that re-hashed the file on every render would show a different file than the one the
 *    model presented, and would silently bless an edit made after the presentation.
 * 2. **One path has one entry.** Presenting the same path twice replaces the earlier declaration in place,
 *    so the list stays the set of deliverables rather than a history of mentions.
 */
export interface PresentedFile {
  /** Workspace-relative, with `/` separators, exactly as the model named it. */
  path: string;
  description?: string;
  bytes: number;
  /** Digest of the file as it was when presented, so a later edit is visible rather than implied. */
  sha256: string;
  /** When the model declared it, which is what the panel sorts and labels by. */
  at: string;
}
/** The list stays usable as a panel; past this the oldest declaration drops off. */
export const MAX_PRESENTED_FILES = 40;
export function isPresentedFile(value: unknown): value is PresentedFile {
  if (!value || typeof value !== 'object') return false;
  const file = value as Record<string, unknown>;
  return (
    typeof file.path === 'string' &&
    file.path.length > 0 &&
    typeof file.bytes === 'number' &&
    Number.isFinite(file.bytes) &&
    typeof file.sha256 === 'string' &&
    typeof file.at === 'string' &&
    (file.description === undefined || typeof file.description === 'string')
  );
}
/**
 * Fold one declaration onto the list a session has so far.
 *
 * Replacement is by path and in place: a reader watching the list must not see an entry jump to the bottom
 * because the model mentioned it again, and the bytes it now reports belong to the same line either way.
 */
export function presentFiles(
  state: readonly PresentedFile[],
  files: readonly PresentedFile[],
): PresentedFile[] {
  const next = [...state];
  for (const file of files) {
    const index = next.findIndex((entry) => entry.path === file.path);
    if (index >= 0) next[index] = file;
    else next.push(file);
  }
  return next.length > MAX_PRESENTED_FILES ? next.slice(next.length - MAX_PRESENTED_FILES) : next;
}
