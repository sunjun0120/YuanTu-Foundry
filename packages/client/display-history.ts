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
  statistics?: SessionStatistics;
  truncated: boolean;
  nextOffset: number;
  startOffset: number;
}> {
  const messages: Message[] = [];
  const parts: string[] = [];
  let offset = startOffset;
  let first = true;
  let resolvedStart = startOffset;
  let endOffset = window.endOffset;
  let chunkOffset: number | undefined;
  let statistics: SessionStatistics | undefined;
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
      statistics = page.statistics;
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
        truncated: false,
        nextOffset: offset + (page.messageChunk ? 1 : page.messages.length),
      };
    if (!Number.isSafeInteger(page.nextOffset) || page.nextOffset <= offset)
      throw new Error('Invalid history pagination');
    offset = page.nextOffset;
  }
}
