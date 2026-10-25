import { createHash } from 'node:crypto';
import { structuredPatch } from 'diff';
import type { FileSnapshot } from '../protocol/index.ts';

/**
 * What one write did to one file, as hashes only.
 *
 * A write that puts a file back the way it already was cannot be recognised after the fact: the state before the
 * *first* edit is gone, and a `FileChange` carries a rendered patch rather than both sides of the bytes. The bytes
 * are still in hand at the write boundary, so the digests are taken there — and only digests leave it. The value
 * rides on the run's in-memory observation and never reaches the model, the request or the session log.
 *
 * Two shapes of "back the way it was" have to be recognisable, because a run may oscillate without ever
 * repeating a whole file: it may revert the file, or it may revert one local block of lines while another part
 * of the same file keeps moving forward.
 */
export interface FileStateDigest {
  path: string;
  /** Content hash, or `null` when the write created the path. */
  before: string | null;
  /** Content hash, or `null` when the write removed the path. */
  after: string | null;
  /**
   * Each changed block of the write, hashed on both sides.
   *
   * Empty for anything this cannot be computed for — binary content, a file over the size bound, or a diff that
   * does not finish inside the time allowed — which leaves the whole-file signal alone rather than guessing.
   * A reversed block is recognised by looking its two hashes up the other way round.
   */
  hunks: readonly FileStateHunk[];
}
export interface FileStateHunk {
  /** Hash of the lines this block removed (empty string's hash when it only added lines). */
  deleted: string;
  /** Hash of the lines this block added (empty string's hash when it only removed lines). */
  added: string;
}
/** The same bound the write paths themselves enforce (`MAX_FILE_BYTES` in `file-mutation.ts`). */
const MAX_TEXT_BYTES = 1_000_000;
const hashBytes = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
/** Every changed block has its lines joined, then hashed — never stored. */
const hashLines = (lines: readonly string[]): string =>
  createHash('sha256')
    .update(lines.map((line) => line.slice(1)).join('\n'))
    .digest('hex');
/**
 * The text a diff can be taken of, or `undefined` for a file that must not be compared line by line.
 *
 * Line endings are the one normalisation applied: `\r\n` and `\n` describe the same lines, and a write that only
 * flipped them would otherwise read as a change of content. Bytes are otherwise left alone — a re-indented line
 * is a different line.
 */
function textOf(bytes: Uint8Array | null): string | undefined {
  if (bytes === null) return '';
  if (bytes.byteLength > MAX_TEXT_BYTES) return undefined;
  const buffer = Buffer.from(bytes);
  const text = buffer.toString('utf8');
  if (text.includes('\0') || !Buffer.from(text).equals(buffer)) return undefined;
  return text.replaceAll('\r\n', '\n');
}
function hunksOf(file: FileSnapshot): FileStateHunk[] {
  const before = textOf(file.before);
  const after = textOf(file.after);
  if (before === undefined || after === undefined) return [];
  // The same diff the change preview is built from, so a block this reports is a block the model was shown.
  const patch = structuredPatch('before', 'after', before, after, '', '', {
    context: 3,
    timeout: 150,
    maxEditLength: 10_000,
  });
  if (!patch) return [];
  return patch.hunks.map((hunk) => ({
    deleted: hashLines(hunk.lines.filter((line) => line.startsWith('-'))),
    added: hashLines(hunk.lines.filter((line) => line.startsWith('+'))),
  }));
}
export function digestFileStates(files: readonly FileSnapshot[]): FileStateDigest[] {
  return files.map((file) => ({
    path: file.path,
    before: file.before === null ? null : hashBytes(file.before),
    after: file.after === null ? null : hashBytes(file.after),
    hunks: hunksOf(file),
  }));
}
