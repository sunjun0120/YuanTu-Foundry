import type { Message } from '../../../packages/protocol/index.ts';
import type { StepRecord } from '../../../packages/protocol/steps.ts';
import { ownedSession, required } from '../params.ts';
import type { Handler } from '../dispatch.ts';

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
      return {
        session,
        messages: history,
        statistics: ctx.store.statistics(id),
        steps: ctx.store.stateOf<readonly StepRecord[]>('steps', id),
      };
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
    let end = offset,
      bytes = 0;
    while (end < endOffset && end - offset < 100) {
      const message = displayMessage(history[end]!);
      const serialized = JSON.stringify(message);
      const size = Buffer.byteLength(serialized);
      if (bytes + size > 15_000_000) {
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
          ...(offset === 0 || params.tail !== undefined
            ? { statistics: ctx.store.statistics(id) }
            : {}),
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
      ...(offset === 0 || params.tail !== undefined
        ? { statistics: ctx.store.statistics(id) }
        : {}),
      // The step record travels with the first page, like the statistics: it describes the session, not the
      // window of history that happens to be loaded.
      ...(offset === 0 || params.tail !== undefined
        ? { steps: ctx.store.stateOf<readonly StepRecord[]>('steps', id) }
        : {}),
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
