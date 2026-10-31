/**
 * A file the model declares as a finished deliverable ("which files should you look at").
 *
 * 1. Bytes and digest are taken at declaration, so later edits are not silently presented.
 * 2. One path has one entry; presenting it again replaces the earlier declaration in place.
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
  /** Display ownership reconstructed from the session log; absent in the session-wide summary. */
  runId?: string;
  /** Absolute transcript index after the run settled; absent while it is running. */
  afterIndex?: number;
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
    (file.description === undefined || typeof file.description === 'string') &&
    (file.runId === undefined || (typeof file.runId === 'string' && file.runId.length > 0)) &&
    (file.afterIndex === undefined ||
      (Number.isSafeInteger(file.afterIndex) && (file.afterIndex as number) >= 0))
  );
}
/** Fold one declaration onto the session's list, replacing by path in place. */
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

/** Replace within a run, retaining earlier turns even when they presented the same path. */
export function presentTurnFiles(
  state: readonly PresentedFile[],
  files: readonly PresentedFile[],
): PresentedFile[] {
  let next = [...state];
  for (const runId of new Set(files.map((file) => file.runId))) {
    const own = presentFiles(
      next.filter((file) => file.runId === runId),
      files.filter((file) => file.runId === runId),
    );
    const other = next.filter((file) => file.runId !== runId);
    next = [...other, ...own];
  }
  return next;
}
