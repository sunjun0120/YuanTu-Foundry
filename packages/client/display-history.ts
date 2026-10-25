import type { Message } from '../protocol/index.ts';
import type { SessionStatistics } from '../protocol/statistics.ts';
import type { AgentHostClient } from './host-client.ts';

/** Read the UI transcript without transporting opaque model continuation state. */
export async function readDisplayHistory(
  client: AgentHostClient,
  sessionId: string,
  maxMessages = Infinity,
  startOffset = 0,
  window: { tail?: number; endOffset?: number } = {},
): Promise<{
  messages: Message[];
  providerDegraded?: boolean;
  statistics?: SessionStatistics;
  truncated: boolean;
  nextOffset: number;
  startOffset: number;
  /**
   * The run the session had active when its transcript was read, when the Host says.
   *
   * It travels with the history because it is part of the same answer — a reader that learns the transcript
   * and the run identity from two different moments can put a run's beginning next to another run's middle.
   * `undefined` for a Host that answers without session info; `null` for a session nobody is running.
   */
  activeRun?: string | null;
}> {
  const messages: Message[] = [];
  const parts: string[] = [];
  let offset = startOffset;
  let first = true;
  let resolvedStart = startOffset;
  let endOffset = window.endOffset;
  let chunkOffset: number | undefined;
  let statistics: SessionStatistics | undefined;
  let providerDegraded: boolean | undefined;
  let activeRun: string | null | undefined;
  for (;;) {
    const page = await client.request('session.get', {
      sessionId,
      offset,
      view: 'display',
      ...(first && window.tail !== undefined ? { tail: window.tail } : {}),
      ...(endOffset === undefined ? {} : { endOffset }),
      ...(chunkOffset === undefined ? {} : { chunkOffset }),
    });
    if (first) {
      if (page.offset !== undefined) {
        if (!Number.isSafeInteger(page.offset) || page.offset < 0)
          throw new Error('Invalid history window offset');
        offset = page.offset;
      }
      resolvedStart = offset;
      if (window.tail !== undefined && page.totalMessages !== undefined)
        endOffset = page.totalMessages;
      providerDegraded = page.providerDegraded;
      statistics = page.statistics;
      activeRun = page.session?.activeRun;
      first = false;
    }
    const previousCount = messages.length;
    if (page.messageChunk) {
      const chunk = page.messageChunk;
      if (page.messages.length || chunk.index !== offset || !chunk.part)
        throw new Error('Invalid history message chunk');
      parts.push(chunk.part);
      if (chunk.nextChunkOffset !== undefined) {
        if (
          !Number.isSafeInteger(chunk.nextChunkOffset) ||
          chunk.nextChunkOffset <= (chunkOffset ?? 0)
        )
          throw new Error('Invalid history chunk offset');
        chunkOffset = chunk.nextChunkOffset;
        continue;
      }
      const value: unknown = JSON.parse(parts.join(''));
      if (
        !value ||
        typeof value !== 'object' ||
        !('role' in value) ||
        !('content' in value) ||
        typeof value.content !== 'string'
      )
        throw new Error('Invalid history message');
      messages.push(value as Message);
      parts.length = 0;
      chunkOffset = undefined;
    } else {
      if (chunkOffset !== undefined) throw new Error('Incomplete history message chunk');
      messages.push(...page.messages);
    }
    if (messages.length >= maxMessages) {
      const unreadInPage = messages.length > maxMessages;
      return {
        messages: messages.slice(0, maxMessages),
        startOffset: resolvedStart,
        statistics,
        activeRun,
        providerDegraded,
        truncated: unreadInPage || page.nextOffset !== undefined,
        nextOffset: unreadInPage
          ? offset + (maxMessages - previousCount)
          : (page.nextOffset ?? offset + (page.messageChunk ? 1 : page.messages.length)),
      };
    }
    if (page.nextOffset === undefined)
      return {
        messages,
        startOffset: resolvedStart,
        statistics,
        activeRun,
        providerDegraded,
        truncated: false,
        nextOffset: offset + (page.messageChunk ? 1 : page.messages.length),
      };
    if (!Number.isSafeInteger(page.nextOffset) || page.nextOffset <= offset)
      throw new Error('Invalid history pagination');
    offset = page.nextOffset;
  }
}
