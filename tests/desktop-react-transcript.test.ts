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

test('a fold that gains older steps above it keeps its group key', () => {
  const tools = (count: number) =>
    Array.from({ length: count }, (_, index) => message({ role: 'tool', content: `r${index}` }));
  const before = transcriptModel(snapshot(), tools(2), 10);
  const group = before.segments[0];
  assert.equal(group?.kind === 'group' ? group.key : '', 'group:10:result');
  // Older history lands above the same interval: the first step changes, but steps 10 and 11 did not.
  const after = transcriptModel(snapshot(), tools(4), 8, new Map(), before.groupKeys);
  assert.equal(after.segments.length, 1);
  assert.equal(after.segments[0]?.kind === 'group' ? after.segments[0].key : '', 'group:10:result');
  assert.deepEqual(
    after.segments[0]?.kind === 'group' ? after.segments[0].steps.map((step) => step.key) : [],
    ['8:result', '9:result', '10:result', '11:result'],
  );
});

test('a boundary revealed inside a fold keeps both groups distinct', () => {
  const tools = (count: number) =>
    Array.from({ length: count }, (_, index) => message({ role: 'tool', content: `r${index}` }));
  const before = transcriptModel(snapshot(), tools(3), 0);
  const after = transcriptModel(
    snapshot(),
    [tools(1)[0]!, message({ role: 'user', content: 'ask' }), tools(1)[0]!],
    0,
    new Map(),
    before.groupKeys,
  );
  const groups = after.segments.flatMap((segment) =>
    segment.kind === 'group' ? [segment.key] : [],
  );
  assert.equal(groups.length, 2);
  assert.equal(new Set(groups).size, 2, `duplicate group keys: ${groups.join(',')}`);
  assert.equal(groups[0], 'group:0:result');
});
