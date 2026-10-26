import test from 'node:test';
import assert from 'node:assert/strict';
import type { CarrierSnapshot } from '../packages/carrier/contract.ts';
import type { Message } from '../packages/protocol/index.ts';
import {
  transcriptModel,
  transcriptRows,
} from '../apps/desktop/ui/conversation/transcript-model.ts';

/**
 * The transcript's shape: machine context is not a person's message, a provisional answer yields to the later one, and
 * consecutive operations fold while replies keep their place. Every key is derived from the absolute source index, so
 * adding history above a row does not renumber it.
 */
function message(overrides: Partial<Message>): Message {
  return { role: 'assistant', content: '', ...overrides } as Message;
}
function snapshot(endings: unknown[] = []): CarrierSnapshot {
  return { session: { runEndings: endings } } as unknown as CarrierSnapshot;
}

test('runtime context and a superseded provisional answer are not rows', () => {
  const rows = transcriptRows(
    [
      message({ role: 'user', content: 'ask' }),
      message({ content: 'provisional', provisional: true }),
      message({ content: 'final answer' }),
      message({ role: 'user', content: '<runtime-context source="x">state' }),
    ],
    10,
  );
  assert.deepEqual(
    rows.map((row) => [row.index, row.message.content]),
    [
      [10, 'ask'],
      [12, 'final answer'],
    ],
  );
});

test('operations fold together while replies and user turns break the fold', () => {
  const model = transcriptModel(
    snapshot(),
    [
      message({ content: 'working' }),
      message({ role: 'tool', content: 'result' }),
      message({ role: 'user', content: 'next' }),
      message({ content: '', reasoning: 'thinking' }),
      message({ role: 'tool', content: 'result 2' }),
    ],
    0,
  );
  assert.deepEqual(
    model.segments.map((segment) =>
      segment.kind === 'group'
        ? ['group', ...segment.steps.map((step) => step.kind)]
        : [segment.kind],
    ),
    [['message'], ['group', 'result'], ['message'], ['group', 'reasoning', 'result']],
  );
  assert.equal(model.tail, 3);
  assert.deepEqual(
    model.segments[1]?.kind === 'group' ? model.segments[1].steps[0]?.key : '',
    '1:result',
  );
});

test('an assistant with content and calls puts the reply first and the calls after it', () => {
  const model = transcriptModel(
    snapshot(),
    [message({ content: 'answer', toolCalls: [{ name: 'a' }, { name: 'b' }] as never })],
    0,
  );
  assert.deepEqual(
    model.segments.map((segment) => segment.kind),
    ['message', 'group'],
  );
  const group = model.segments[1];
  assert.deepEqual(
    group?.kind === 'group' ? group.steps.map((step) => [step.kind, step.callIndex]) : [],
    [
      ['call', 0],
      ['call', 1],
    ],
  );
});

test('run endings and turn-change cards sit after the index they follow', () => {
  const model = transcriptModel(
    snapshot([{ afterIndex: 1, reason: 'stopped' }]),
    [message({ content: 'one' }), message({ role: 'user', content: 'two' })],
    0,
    new Map([[1, {}]]),
  );
  assert.deepEqual(
    model.segments.map((segment) => [segment.kind, segment.kind === 'group' ? '' : segment.key]),
    [
      ['message', '0:message'],
      ['message', '1:message'],
      ['ending', 'ending:1:1'],
      ['card', 'card:1'],
    ],
  );
});

test('the same messages at a later start index keep their keys tied to the absolute index', () => {
  const model = transcriptModel(snapshot(), [message({ role: 'user', content: 'hello' })], 40);
  const user = model.rows[0];
  assert.equal(user?.index, 40);
  assert.equal(model.messageCount, 41);
});
