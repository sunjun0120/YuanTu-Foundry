import { createHash } from 'node:crypto';
import type { Message } from '../protocol/index.ts';
import { isImageReference } from '../protocol/images.ts';
import { isMachineContext } from '../protocol/context.ts';

/**
 * How a message becomes rows: the content address image bytes are stored under, the message shape that
 * is written down, and the title a first user message gives its session.
 *
 * These are the pure halves of an append. The store decides what to write and in which transaction;
 * this module decides what the written shape *is*, which is why it can be read — and tested — without a
 * database. The stored form is also a durability decision: only an image's *address* is written, so the
 * same picture mentioned twice costs one row, not two copies of its base64.
 */

/** One image's bytes, keyed by the sha256 of those bytes. */
export interface QueuedBlob {
  hash: string;
  mimeType: string;
  bytes: Buffer;
  size: number;
}
/** The content address of an image: sha256 over the decoded bytes, the convention `deliverables` also uses. */
export function imageHash(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}
/**
 * The message as it is stored, plus the bytes the stored form refers to.
 *
 * A message with no images comes back unchanged — the bytes written for the ordinary case are exactly what
 * they were before this migration, which is what keeps a text-only session's rows (and every snapshot) stable.
 * An image this store cannot read as bytes is stored as it is rather than refused: refusing would turn an
 * unrecognised image into a failed append, and the reader is where that has to be said.
 */
export function storedMessage(message: Message): { stored: unknown; blobs: QueuedBlob[] } {
  /**
   * The two fields a recorded message may leave out, filled in where the record is written.
   *
   * `Message` requires `toolCalls` on an assistant turn and `isError` on a tool result, and a reader is entitled
   * to index into both, so the shape is settled here — the one place every recorded message passes through —
   * rather than by making every reader tolerate a missing key. A caller that hands over what it has
   * (`store.append`, the queue consumer, a streamed response, a test fixture) therefore records the same shape
   * the run loop does: an assistant turn with nothing to call carries an empty list, and a tool result that is
   * not marked as an error *is* a success, which is what the absence of the flag has always meant.
   */
  const complete =
    message.role === 'assistant' && !Array.isArray((message as { toolCalls?: unknown }).toolCalls)
      ? ({ ...message, toolCalls: [] } as Message)
      : message.role === 'tool' && typeof (message as { isError?: unknown }).isError !== 'boolean'
        ? ({ ...message, isError: false } as Message)
        : message;
  const images = (complete as { images?: unknown }).images;
  if (!Array.isArray(images) || !images.length) return { stored: complete, blobs: [] };
  const blobs: QueuedBlob[] = [];
  const stored = images.map((image) => {
    if (!image || typeof image !== 'object') return image;
    const record = image as Record<string, unknown>;
    const { data, mimeType } = record;
    if (typeof data !== 'string' || typeof mimeType !== 'string') return image;
    const bytes = Buffer.from(data, 'base64');
    const hash = imageHash(bytes);
    blobs.push({ hash, mimeType, bytes, size: bytes.length });
    // The address takes the bytes' place *in the same position*, so hydrating it back reproduces the key order
    // the live message had. Invariant I8 compares the write-through rows with the fold of the log through
    // `JSON.stringify`, and two shapes that differ only in key order would read as two different histories.
    return Object.fromEntries(
      Object.entries(record).map(([key, value]) =>
        key === 'data' ? ['hash', hash] : [key, value],
      ),
    );
  });
  return { stored: { ...complete, images: stored }, blobs };
}
/** Every content address a stored value mentions, for deciding which blobs a deletion orphans. */
export function hashesIn(value: unknown, into: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) hashesIn(item, into);
    return;
  }
  if (!value || typeof value !== 'object') return;
  if (isImageReference(value)) into.add(value.hash);
  for (const child of Object.values(value as Record<string, unknown>)) hashesIn(child, into);
}
/**
 * The title a user message gives a session, with the whitespace a title cannot carry collapsed.
 *
 * `null` for a machine-written message. The first user message is not always a person's — a runtime snapshot or
 * a compaction summary can be there first — and a session named `<runtime-context source="memory"> …` is named
 * by bookkeeping rather than by what anybody asked. Returning `null` leaves the title empty, so the first
 * *person's* message names the session instead (or the model does, through `setGeneratedTitle`).
 */
export function sessionTitle(message: Extract<Message, { role: 'user' }>): string | null {
  const source = message.displayContent ?? message.content;
  if (isMachineContext(source)) return null;
  return source
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}
