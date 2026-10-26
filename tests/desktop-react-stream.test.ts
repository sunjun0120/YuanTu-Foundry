import test from 'node:test';
import assert from 'node:assert/strict';
import type { MessageDelta } from '../packages/carrier/contract.ts';
import type { SessionSnapshot } from '../packages/client/session-controller.ts';
import {
  createStreamStore,
  STREAM_PUBLISH_MS,
} from '../apps/desktop/ui/conversation/stream-store.ts';

/**
 * The streamed answer is accumulated in one place and published on a budget. These tests pin the three rules the
 * live bubble depends on: one publish per window with complete text, two channels that never mix, and no stale text
 * surviving a reset, a new message, the end of a run, or dispose.
 */
function delta(
  messageId: string,
  text: string,
  channel: 'text' | 'reasoning' = 'text',
  reset = false,
): MessageDelta {
  return { messageId, channel, text, reset } as MessageDelta;
}
function snapshot(live: { id: string; text: string; reasoning: string } | null): SessionSnapshot {
  return { liveMessage: live } as unknown as SessionSnapshot;
}

test('a hundred slices in one window publish once, complete', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const store = createStreamStore();
  let publications = 0;
  store.view.subscribe(() => {
    publications += 1;
  });
  for (let index = 0; index < 100; index += 1) store.acceptDelta(delta('m1', `${index},`));
  assert.equal(publications, 0, 'nothing is published before the window closes');
  t.mock.timers.tick(STREAM_PUBLISH_MS);
  assert.equal(publications, 1);
  assert.equal(store.view.getSnapshot()?.text.split(',').length, 101);
  t.mock.timers.tick(STREAM_PUBLISH_MS);
  assert.equal(publications, 1, 'a second window with no slices publishes nothing');
});

test('the answer and the thinking are separate buffers', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const store = createStreamStore();
  store.acceptDelta(delta('m1', 'answer '));
  store.acceptDelta(delta('m1', 'thought', 'reasoning'));
  store.acceptDelta(delta('m1', 'continues'));
  t.mock.timers.tick(STREAM_PUBLISH_MS);
  assert.deepEqual(store.view.getSnapshot(), {
    messageId: 'm1',
    text: 'answer continues',
    reasoning: 'thought',
  });
});

test('a reset replaces only its own channel', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const store = createStreamStore();
  store.acceptDelta(delta('m1', 'old '));
  store.acceptDelta(delta('m1', 'old thinking', 'reasoning'));
  store.acceptDelta(delta('m1', 'new', 'reasoning', true));
  store.acceptDelta(delta('m1', 'start', 'text', true));
  t.mock.timers.tick(STREAM_PUBLISH_MS);
  assert.deepEqual(store.view.getSnapshot(), {
    messageId: 'm1',
    text: 'start',
    reasoning: 'new',
  });
});

test('a slice that arrives before its snapshot is not lost', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const store = createStreamStore();
  store.acceptDelta(delta('m1', 'streamed'));
  store.acceptSnapshot(snapshot({ id: 'm1', text: 'stale snapshot', reasoning: '' }));
  t.mock.timers.tick(STREAM_PUBLISH_MS);
  assert.equal(store.view.getSnapshot()?.text, 'streamed');
});

test('a new message starts from its own text and never inherits the previous one', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const store = createStreamStore();
  store.acceptDelta(delta('m1', 'first'));
  t.mock.timers.tick(STREAM_PUBLISH_MS);
  store.acceptSnapshot(snapshot({ id: 'm2', text: 'second', reasoning: '' }));
  t.mock.timers.tick(STREAM_PUBLISH_MS);
  assert.deepEqual(store.view.getSnapshot(), {
    messageId: 'm2',
    text: 'second',
    reasoning: '',
  });
  store.acceptDelta(delta('m2', '!'));
  t.mock.timers.tick(STREAM_PUBLISH_MS);
  assert.equal(store.view.getSnapshot()?.text, 'second!');
});

test('the end of a run clears the published view', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const store = createStreamStore();
  store.acceptDelta(delta('m1', 'done'));
  t.mock.timers.tick(STREAM_PUBLISH_MS);
  store.acceptSnapshot(snapshot(null));
  t.mock.timers.tick(STREAM_PUBLISH_MS);
  assert.equal(store.view.getSnapshot(), null);
});

test('dispose stops the timer and later publications', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const store = createStreamStore();
  let publications = 0;
  store.view.subscribe(() => {
    publications += 1;
  });
  store.acceptDelta(delta('m1', 'text'));
  store.dispose();
  t.mock.timers.tick(STREAM_PUBLISH_MS);
  store.acceptDelta(delta('m2', 'after dispose'));
  t.mock.timers.tick(STREAM_PUBLISH_MS);
  assert.equal(publications, 0);
});
