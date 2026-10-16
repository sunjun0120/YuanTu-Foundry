import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { historyHandlers } from '../apps/agent-host/handlers/history.ts';
import type { HostContext } from '../apps/agent-host/state.ts';

/**
 * The unpaged `session.get` reply, which is the one history shape that had no bound at all.
 *
 * It exists for callers written before history was paged, and it returned whatever the store held — so a session
 * whose transcript is larger than the transport's own frame could be assembled here and only refused later, on
 * the far side, after the memory had been spent. The bound is that frame ceiling rather than the page budget,
 * because a 16 MB turn coming back through this path is a contract an existing caller relies on; the third case
 * below is the one that keeps this a tightening rather than a break.
 */
const MESSAGE_BYTES = 1_000_000;
const FRAME_BYTES = 64_000_000;
async function fixture(t: test.TestContext, messages: number) {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-history-bound-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const history = Array.from({ length: messages }, (_, index) => ({
    id: `m${index}`,
    role: 'assistant',
    content: 'x'.repeat(MESSAGE_BYTES),
  }));
  const store = {
    get: () => ({ id: 'session-1', workspace: root, title: 'fixture' }),
    messages: () => history,
    statistics: () => ({ inputTokens: 1, outputTokens: 2 }),
    stateOf: () => [],
  };
  const ctx = { store, workspace: root } as unknown as HostContext;
  return { ctx, history };
}
const get = (ctx: HostContext, params: Record<string, unknown>): Promise<unknown> =>
  historyHandlers['session.get']!(ctx, params);

test('an unpaged reply larger than the transport frame is refused, naming the way to read it', async (t) => {
  const { ctx } = await fixture(t, FRAME_BYTES / MESSAGE_BYTES + 4);
  await assert.rejects(
    () => get(ctx, { sessionId: 'session-1' }),
    /larger than one frame; read it with view, offset and endOffset/,
  );
});

test('the same session still reads one page at a time', async (t) => {
  const { ctx } = await fixture(t, 20);
  const page = (await get(ctx, {
    sessionId: 'session-1',
    view: 'display',
    offset: 0,
    endOffset: 20,
  })) as {
    messages: unknown[];
    offset: number;
    totalMessages: number;
  };
  assert.ok(
    page.messages.length > 0 && page.messages.length < 20,
    `a page is a window rather than the transcript, saw ${page.messages.length}`,
  );
  assert.equal(page.totalMessages, 20);
  assert.equal(page.offset, 0);
});

test('a transcript that fits one page is still returned whole, as the compatibility reply always did', async (t) => {
  const { ctx } = await fixture(t, 3);
  const all = (await get(ctx, { sessionId: 'session-1' })) as {
    messages: unknown[];
    statistics: unknown;
    steps: unknown;
  };
  assert.equal(all.messages.length, 3);
  assert.deepEqual(all.statistics, { inputTokens: 1, outputTokens: 2 });
  assert.deepEqual(all.steps, []);
});

test('a 16 MB turn still comes back through the unpaged read, which callers rely on', async (t) => {
  // The bound is the transport's own frame ceiling rather than the page budget precisely so this stays true:
  // `large-response.test.ts` pins a 16 MB turn through the unpaged path, and a page-sized bound would break it.
  const { ctx } = await fixture(t, 16);
  const all = (await get(ctx, { sessionId: 'session-1' })) as { messages: unknown[] };
  assert.equal(all.messages.length, 16);
});
