import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareContext } from '../packages/core/context.ts';
import { projectToolResults } from '../packages/core/context-tool-results.ts';
import { TokenCalibration } from '../packages/core/calibration.ts';
import { SessionStore } from '../packages/storage/sqlite.ts';
import type { Message } from '../packages/protocol/index.ts';
import { storeFixture } from './temp-fixture.ts';

const history = (): Message[] => [
  { role: 'user', content: 'Inspect the output' },
  { role: 'assistant', content: '', toolCalls: [{ id: 'old', name: 'read_file', arguments: {} }] },
  { role: 'tool', toolCallId: 'old', content: 'x'.repeat(80_000), isError: false },
  { role: 'assistant', content: '', toolCalls: [{ id: 'new', name: 'read_file', arguments: {} }] },
  { role: 'tool', toolCallId: 'new', content: 'fresh result', isError: false },
];

for (const mode of ['prune', 'shrink'] as const) {
  test(`${mode} keeps old tool results stable across pressure changes and reopening`, async (t) => {
    const { store, session, db } = await storeFixture(t);
    const original = history();
    for (const message of original) store.append(session.id, message);
    let spills = 0;
    const prepare = (owner: SessionStore, factor: number) =>
      prepareContext({
        store: owner,
        sessionId: session.id,
        system: 'stable',
        tools: [],
        provider: {
          complete: async () => {
            throw new Error('Unexpected summary request');
          },
        },
        limit: 10_000_000,
        signal: new AbortController().signal,
        maxOutputTokens: 1000,
        maxContextTokens: 100_000,
        summaryTimeoutMs: 1000,
        calibration: TokenCalibration.from({ route: 'fixture', factor, samples: 1 }, 'fixture'),
        ...(mode === 'prune'
          ? {
              prune: {
                policy: { thresholdChars: 1000, headChars: 400, tailChars: 200 },
                keepRecent: 0,
              },
              prunePercent: 50,
            }
          : {
              shrink: {
                policy: { tokens: 1000, keepRecent: 0 },
                measure: (text: string) => text.length * factor,
                spill: () => {
                  spills++;
                  return { path: 'full.txt', bytes: 80_000, lines: 1 };
                },
              },
              shrinkPercent: 50,
            }),
        onUsage() {},
        onCompaction() {},
      });
    const first = await prepare(store, 1);
    const projected = first.messages[2]!.content;
    assert.ok(projected.length < 2000);
    assert.equal(first.messages[4]!.content, 'fresh result');
    assert.equal(
      (await prepare(store, 0.5)).messages[2]!.content,
      projected,
      'falling pressure must not restore the original tool output',
    );
    assert.equal((await prepare(store, 1)).messages[2]!.content, projected);
    assert.deepEqual(
      store.messages(session.id),
      original,
      'the transcript keeps the full original',
    );
    const reopened = new SessionStore(db);
    try {
      assert.equal((await prepare(reopened, 0.5)).messages[2]!.content, projected);
      assert.deepEqual(reopened.messages(session.id), original);
    } finally {
      reopened.close();
    }
    if (mode === 'shrink')
      assert.equal(spills, 1, 'replay must not spill or recut the same result');
  });
}

test('tool projections follow original message positions through compaction and reject changed sources', async (t) => {
  const { store, session } = await storeFixture(t);
  const original = history();
  for (const message of original) store.append(session.id, message);
  const first = projectToolResults(store, session.id, original, 0);
  first.remember(
    first.messages.map((message, index) =>
      index === 2 ? { ...message, content: 'stable cut' } : message,
    ),
  );
  const tail = projectToolResults(store, session.id, original, 1);
  assert.equal(
    tail.messages[0]!.content,
    'Inspect the output',
    'preserve the user anchor after a cut',
  );
  assert.equal(tail.messages[2]!.content, 'stable cut');
  tail.remember(
    tail.messages.map((message, index) =>
      index === 4 ? { ...message, content: 'new cut' } : message,
    ),
  );
  const saved = store.newestPayload(session.id, 'context.tool-results.projected');
  assert.deepEqual(
    (saved!.views as { index: number }[]).map((view) => view.index),
    [2, 4],
  );
  const edited = original.map((message, index) =>
    index === 2 ? { ...message, content: 'edited result' } : message,
  );
  const changed = projectToolResults(store, session.id, edited, 0);
  assert.equal(
    changed.messages[2]!.content,
    'edited result',
    'a stale cut cannot hide edited content',
  );
  const compacted = projectToolResults(store, session.id, original, 3);
  assert.equal(compacted.messages[0]!.content, 'Inspect the output');
  assert.equal(compacted.messages[2]!.content, 'new cut');
  compacted.remember(compacted.messages);
  assert.deepEqual(
    (
      store.newestPayload(session.id, 'context.tool-results.projected')!.views as {
        index: number;
      }[]
    ).map((view) => view.index),
    [4],
  );
  assert.deepEqual(store.messages(session.id), original);
});

test('tool projections cannot change the context owned by another run', async (t) => {
  const { store, session } = await storeFixture(t);
  const original = history();
  for (const message of original) store.append(session.id, message);
  const runId = store.beginRun(session.id);
  const projection = projectToolResults(store, session.id, original, 0);
  const cut = projection.messages.map((message, index) =>
    index === 2 ? { ...message, content: 'cut' } : message,
  );
  assert.throws(() => projection.remember(cut), /another run is writing/i);
  assert.equal(store.newestPayload(session.id, 'context.tool-results.projected'), undefined);
  const owner = projectToolResults(store, session.id, original, 0, runId);
  owner.remember(
    owner.messages.map((message, index) =>
      index === 2 ? { ...message, content: 'owner cut' } : message,
    ),
  );
  assert.equal(
    projectToolResults(store, session.id, original, 0).messages[2]!.content,
    'owner cut',
  );
  store.releaseLease(session.id, runId);
});
