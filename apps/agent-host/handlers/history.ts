import type { Message } from '../../../packages/protocol/index.ts';
import type { StepRecord } from '../../../packages/protocol/steps.ts';
import { ownedSession, required } from '../params.ts';
import type { Handler } from '../dispatch.ts';
import { HOST_RESPONSE_FRAME_BYTES } from '../../../packages/protocol/host-wire.ts';

/**
 * The paged read side of a session's log: its messages, its audit trail, and its raw events.
 *
 * All three are cursors rather than snapshots, and all three are honest about where the cursor is: `session.audit`
 * reports the last record it *returned* so that a client stopping here continues from exactly here, while
 * `session.events` reads one page more than it was asked for, so "is there more?" is answered by the read itself
 * rather than by a second query.
 *
 * History is the one reply big enough to need a transport bound of its own, and the bound is on the *serialized*
 * form, so a page that fits is a page that fits the wire.
 */
/**
 * How much one history reply may serialize to, in bytes.
 *
 * The bound is on the *serialized* form, so a reply that fits is a reply that fits the wire. It applies to every
 * shape this module can answer with: a page, a chunk of an oversized message, and — since the compatibility reply
 * was the one path that could still build a frame nothing would carry — the unpaged reply too.
 */
const HISTORY_PAGE_BYTES = 15_000_000;
/**
 * How much the *unpaged* reply may serialize to, in bytes.
 *
 * The unpaged shape is the compatibility one — callers written before history was paged, and the desktop's own
 * loader, which asks for a window and then walks older ones. It cannot simply take the page budget: a session
 * whose transcript is larger than one page is exactly what that path is used with, and
 * `large-response.test.ts` pins a 16 MB turn coming back through it. What it can take is the ceiling of the
 * transport that has to carry the reply: `packages/client/host-transport.ts` refuses an incoming frame larger
 * than 64 MB, so a reply past this could not have been delivered to any client this repository ships. The point
 * of the bound is that the Host no longer *builds* one — it used to assemble whatever the store held, and the
 * refusal only happened later, on the far side, after the memory had been spent.
 */
export function assertHistoryFrameBytes(bytes: number): void {
  if (bytes > HOST_RESPONSE_FRAME_BYTES)
    throw new Error(
      'Session history is larger than one frame; read it with view, offset and endOffset instead',
    );
}

export const historyHandlers: Readonly<Record<string, Handler>> = {
  'session.get': async (ctx, params) => {
    const id = required(params, 'sessionId');
    const session = ownedSession(ctx.store, ctx.workspace, id),
      history = ctx.store.messages(id);
    if (params.offset === undefined) {
      if (
        params.view !== undefined ||
        params.chunkOffset !== undefined ||
        params.tail !== undefined ||
        params.endOffset !== undefined
      )
        throw new Error('Paged history requires an offset');
      /**
       * The compatibility reply is bounded by the ceiling of the transport that carries it.
       *
       * It exists for callers written before history was paged, and for every session the wire can carry it
       * returns exactly what it always returned. Past that, *building* the reply is what costs: the client's own
       * framer refuses a frame this large, so the old behaviour was to spend the memory here and fail there. The
       * alternative — returning a silently truncated transcript — would answer a question about the whole session
       * with part of it, so this refuses and names the paged read instead.
       */
      const result = {
        session,
        messages: history,
        statistics: ctx.store.statistics(id),
        steps: ctx.store.stateOf<readonly StepRecord[]>('steps', id),
      };
      // Count metadata and JSON delimiters without serializing the entire transcript at once.
      let bytes = Buffer.byteLength(JSON.stringify({ ...result, messages: [] }));
      assertHistoryFrameBytes(bytes);
      let separator = 0;
      for (const message of history) {
        bytes += separator + Buffer.byteLength(JSON.stringify(message));
        assertHistoryFrameBytes(bytes);
        separator = 1;
      }
      return result;
    }
    if (
      params.tail !== undefined &&
      (params.view !== 'display' ||
        typeof params.tail !== 'number' ||
        !Number.isSafeInteger(params.tail) ||
        params.tail < 1 ||
        params.chunkOffset !== undefined ||
        params.offset !== 0)
    )
      throw new Error('Invalid history tail');
    const endOffset = params.endOffset === undefined ? history.length : params.endOffset;
    if (
      typeof endOffset !== 'number' ||
      !Number.isSafeInteger(endOffset) ||
      endOffset < 0 ||
      endOffset > history.length ||
      (params.endOffset !== undefined && params.view !== 'display')
    )
      throw new Error('Invalid history end offset');
    const offset = params.tail === undefined ? params.offset : Math.max(0, endOffset - params.tail);
    if (
      typeof offset !== 'number' ||
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset > endOffset ||
      (params.view !== undefined && params.view !== 'display') ||
      (params.chunkOffset !== undefined &&
        (params.view !== 'display' ||
          typeof params.chunkOffset !== 'number' ||
          !Number.isSafeInteger(params.chunkOffset) ||
          params.chunkOffset < 0))
    )
      throw new Error('Invalid history offset');
    // Display history never transports opaque Responses continuation state. The full state stays
    // in the durable transcript for the next model call; the UI only needs visible message data.
    const displayMessage = (message: Message): Message => {
      if (params.view !== 'display' || message.role !== 'assistant') return message;
      const { providerState: _providerState, ...visible } = message;
      return visible;
    };
    /**
     * The half of a page that describes the *session* rather than the window of history in it: the statistics
     * and the run's step boundaries.
     *
     * Both travel with the first page, like the offset and the total, because a reader asking for the newest
     * window still has to be told how the session got there. Two pages answer "first" and both mean it: the
     * ordinary first page (`offset === 0`), and a tail page, which is the first page a tail reader sees. A
     * continuation chunk is neither — it is the rest of a message a page already started — so it repeats
     * neither field, and the chunk branch of the oversized-message case below attaches exactly this, which is
     * what keeps one page from promising two different shapes depending on how big its message was.
     */
    const sessionState =
      (offset === 0 || params.tail !== undefined) && params.chunkOffset === undefined
        ? {
            statistics: ctx.store.statistics(id),
            steps: ctx.store.stateOf<readonly StepRecord[]>('steps', id),
          }
        : {};
    let end = offset,
      bytes = 0;
    while (end < endOffset && end - offset < 100) {
      const message = displayMessage(history[end]!);
      const serialized = JSON.stringify(message);
      const size = Buffer.byteLength(serialized);
      if (bytes + size > HISTORY_PAGE_BYTES) {
        if (end !== offset) break;
        if (params.view !== 'display')
          throw new Error('History message exceeds transport page limit');
        const start = params.chunkOffset ?? 0;
        if (start >= serialized.length) throw new Error('Invalid history chunk offset');
        // A chunk is sliced from the serialized message, so every field (including images and
        // tool metadata) survives reconstruction. One million UTF-16 units stay well under the Host
        // frame bound even when JSON escaping expands every character.
        const next = Math.min(serialized.length, start + 1_000_000);
        return {
          session,
          messages: [],
          offset,
          totalMessages: endOffset,
          ...sessionState,
          messageChunk: {
            index: offset,
            part: serialized.slice(start, next),
            ...(next < serialized.length ? { nextChunkOffset: next } : {}),
          },
          ...(next === serialized.length && offset + 1 < endOffset
            ? { nextOffset: offset + 1 }
            : {}),
        };
      }
      if (params.chunkOffset !== undefined) throw new Error('Invalid history chunk offset');
      bytes += size;
      end++;
    }
    return {
      session,
      messages: history.slice(offset, end).map(displayMessage),
      offset,
      totalMessages: endOffset,
      ...sessionState,
      ...(end < endOffset ? { nextOffset: end } : {}),
    };
  },
  'session.audit': async (ctx, params) => {
    const id = required(params, 'sessionId');
    ownedSession(ctx.store, ctx.workspace, id);
    const afterSeq = params.afterSeq ?? 0;
    const limit = params.limit ?? 200;
    if (
      typeof afterSeq !== 'number' ||
      !Number.isSafeInteger(afterSeq) ||
      afterSeq < 0 ||
      typeof limit !== 'number' ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 500
    )
      throw new Error('Invalid audit cursor');
    // The audit types, the cursor and the limit are pushed into the query: this page is a diagnostic read, so
    // it must not load — or fail on — message payloads it was never going to show.
    const entries = ctx.store.auditEvents(id, afterSeq, limit);
    // The cursor is the last record *returned*, not the last one that exists: a client that stops reading
    // here continues from exactly where it stopped, and a page that came back empty does not move it.
    return { entries, nextSeq: entries.at(-1)?.seq ?? afterSeq };
  },
  'completion.current': async (ctx, params) => {
    const id = required(params, 'sessionId');
    ownedSession(ctx.store, ctx.workspace, id);
    return ctx.store.completionCurrent(id);
  },
  'session.events': async (ctx, params) => {
    const id = required(params, 'sessionId');
    ownedSession(ctx.store, ctx.workspace, id);
    const afterSeq = params.afterSeq ?? 0;
    const limit = params.limit ?? 500;
    if (
      typeof afterSeq !== 'number' ||
      !Number.isSafeInteger(afterSeq) ||
      afterSeq < 0 ||
      typeof limit !== 'number' ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 500
    )
      throw new Error('Invalid session cursor');
    // One page more than the client asked for, so "is there more?" is answered by the read itself rather
    // than by a second query: a client that is told `more` keeps reading, and one that is not knows it is
    // level with the log.
    const page = ctx.store.events(id, afterSeq, limit + 1);
    const entries = page.slice(0, limit);
    // `latestSeq` comes from the log's high-water mark, not from the page: a client asking with a cursor at
    // the end must be able to tell "caught up" from "there is more" without reading again.
    return {
      entries,
      nextSeq: entries.at(-1)?.seq ?? afterSeq,
      latestSeq: ctx.store.lastSeq(id),
      more: page.length > limit,
    };
  },
};
