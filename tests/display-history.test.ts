import test from 'node:test';
import assert from 'node:assert/strict';
import { readDisplayHistory } from '../packages/client/display-history.ts';
import type { AgentHostClient } from '../packages/client/host-client.ts';
import type { HostMethods } from '../packages/protocol/rpc.ts';
import type { Message } from '../packages/protocol/index.ts';

type Page = HostMethods['session.get']['result'];
const message = (index: number): Message => ({ role: 'user', content: String(index) });
const client = (pages: Partial<Page>[]) =>
  ({
    async request(method: string) {
      assert.equal(method, 'session.get');
      const page = pages.shift();
      assert(page, 'unexpected history request');
      return { messages: [], ...page };
    },
  }) as unknown as AgentHostClient;

for (const morePages of [true, false]) {
  test(`limited history resumes at the first unconsumed message (more pages: ${morePages})`, async () => {
    const result = await readDisplayHistory(
      client([
        { messages: [message(0), message(1)], nextOffset: 2 },
        { messages: [message(2), message(3)], ...(morePages ? { nextOffset: 4 } : {}) },
      ]),
      'session',
      3,
    );
    assert.deepEqual(
      result.messages.map((entry) => entry.content),
      ['0', '1', '2'],
    );
    assert.equal(result.nextOffset, 3);
    assert.equal(result.truncated, true);
  });
}

test('limited tail history uses the absolute offset and does not skip the rest of its last page', async () => {
  const result = await readDisplayHistory(
    client([{ offset: 96, totalMessages: 100, messages: [96, 97, 98, 99].map(message) }]),
    'session',
    2,
    0,
    { tail: 4 },
  );
  assert.equal(result.startOffset, 96);
  assert.equal(result.nextOffset, 98);
  assert.equal(result.truncated, true);
});

for (const chunkLast of [true, false]) {
  test(`chunked history consumes complete messages before applying its limit (chunk last: ${chunkLast})`, async () => {
    const serialized = JSON.stringify(message(10));
    const result = await readDisplayHistory(
      client([
        {
          offset: 10,
          messages: [],
          messageChunk: { index: 10, part: serialized.slice(0, 12), nextChunkOffset: 12 },
        },
        {
          messages: [],
          messageChunk: { index: 10, part: serialized.slice(12) },
          ...(chunkLast ? {} : { nextOffset: 11 }),
        },
        ...(!chunkLast ? [{ messages: [message(11), message(12)] }] : []),
      ]),
      'session',
      chunkLast ? 1 : 2,
      10,
    );
    assert.equal(result.nextOffset, chunkLast ? 11 : 12);
    assert.equal(result.truncated, !chunkLast);
    assert.deepEqual(
      result.messages.map((entry) => entry.content),
      chunkLast ? ['10'] : ['10', '11'],
    );
  });
}

test('a limit at the exact terminal boundary is not truncated', async () => {
  const result = await readDisplayHistory(
    client([{ messages: [message(0), message(1)] }]),
    'session',
    2,
  );
  assert.equal(result.nextOffset, 2);
  assert.equal(result.truncated, false);
});

test('unlimited history still reads all pages', async () => {
  const result = await readDisplayHistory(
    client([{ messages: [message(0)], nextOffset: 1 }, { messages: [message(1)] }]),
    'session',
  );
  assert.equal(result.messages.length, 2);
  assert.equal(result.nextOffset, 2);
  assert.equal(result.truncated, false);
});
