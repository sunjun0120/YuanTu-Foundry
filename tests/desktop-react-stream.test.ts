import test from 'node:test';
import assert from 'node:assert/strict';
import type { MessageDelta } from '../packages/carrier/contract.ts';
import type { SessionSnapshot } from '../packages/client/session-controller.ts';
import { format, t as uiText } from '../apps/desktop/i18n.ts';
import {
  LIVE_TAIL_CHARS,
  liveBodyText,
  liveReasoningPreview,
  type LiveMessageView,
} from '../apps/desktop/ui/conversation/live-model.ts';
import {
  createStreamStore,
  STREAM_PUBLISH_MS,
} from '../apps/desktop/ui/conversation/stream-store.ts';

/**
 * The streamed answer is accumulated in one place and published on a budget. These tests pin the three rules the
 * live bubble depends on: one publish per window with complete text, two channels that never mix, and no stale text
 * surviving a reset, a new message, the end of a run, or dispose.
 *
 * The last group pins the copy rules that moved from the renderer into the React projection: the message-presence
 * distinction, the phase placeholder, the long-answer tail and the folded thought's one-line preview.
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

const noLive = (): LiveMessageView => ({
  present: false,
  text: '',
  reasoning: '',
  phase: undefined,
});

test('the live body is empty without a message and the phase placeholder without text', () => {
  assert.equal(
    liveBodyText({ ...noLive(), text: 'the previous answer' }),
    '',
    'a stopped run must not keep the last tokens in the bubble',
  );
  assert.equal(
    liveBodyText({ ...noLive(), present: true, phase: 'reasoning' }),
    uiText('ui.modelReasoning'),
  );
  assert.equal(
    liveBodyText({ ...noLive(), present: true, phase: 'tool_call' }),
    uiText('ui.modelToolCall'),
  );
  assert.equal(liveBodyText({ ...noLive(), present: true, phase: 'text' }), uiText('ui.thinking'));
  assert.equal(
    liveBodyText({ ...noLive(), present: true, text: 'It is there.', phase: 'text' }),
    'It is there.',
  );
});

test('a live answer over the display cap shows a note and its last 120k characters', () => {
  const text = `${'a'.repeat(LIVE_TAIL_CHARS)}TAIL`;
  const body = liveBodyText({ ...noLive(), present: true, text, phase: 'text' });
  assert.equal(
    body,
    `${format(uiText('ui.liveTail'), { count: text.length })}\n\n${text.slice(-LIVE_TAIL_CHARS)}`,
  );
  assert.ok(body.endsWith('TAIL'), 'the newest characters are the ones kept');
  assert.equal(
    liveBodyText({ ...noLive(), present: true, text: 'a'.repeat(LIVE_TAIL_CHARS), phase: 'text' })
      .length,
    LIVE_TAIL_CHARS,
    'an answer exactly at the cap is shown whole',
  );
});

test('the fold preview collapses whitespace and never grows past one line', () => {
  // Collapsing runs to one space is the legacy rule: the edges are left as the model wrote them.
  assert.equal(liveReasoningPreview('  first\n\nsecond   third '), ' first second third ');
  assert.equal(liveReasoningPreview('x'.repeat(500)).length, 240);
});
