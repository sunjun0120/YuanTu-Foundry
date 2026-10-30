import test from 'node:test';
import assert from 'node:assert/strict';
import type { CarrierSnapshot } from '../packages/carrier/contract.ts';
import type { Message, ToolCall } from '../packages/protocol/index.ts';
import type { PresentedFile } from '../packages/protocol/deliverables.ts';
import {
  transcriptModel,
  transcriptRows,
} from '../apps/desktop/ui/conversation/transcript-model.ts';
import { buildProcessSections } from '../apps/desktop/ui/conversation/process-sections.ts';

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

test('the outer process groups MCP cards and reasoning in order, leaving answers and file cards outside', () => {
  const model = transcriptModel(
    snapshot(),
    [
      message({
        reasoning: 'before',
        toolCalls: [{ id: 'one', name: 'scan_query', arguments: {} }],
      }),
      { role: 'tool', toolCallId: 'one', content: 'result', isError: false },
      message({
        reasoning: 'between',
        toolCalls: [{ id: 'two', name: 'scan_report', arguments: {} }],
      }),
      { role: 'tool', toolCallId: 'two', content: 'report', isError: false },
      message({ content: 'answer' }),
    ],
    0,
    new Map([[4, {}]]),
  );
  const { sections } = buildProcessSections(model.segments);
  assert.deepEqual(
    sections.map((section) => section.kind),
    ['process', 'message', 'card'],
  );
  const process = sections[0];
  assert.deepEqual(
    process?.kind === 'process' ? process.segments.map((segment) => segment.kind) : [],
    ['group', 'mcp', 'group', 'mcp'],
  );
});

test('local-only process groups keep their original rendering and shape', () => {
  const model = transcriptModel(snapshot(), [message({ reasoning: 'local only' })], 0);
  const { sections } = buildProcessSections(model.segments);
  assert.deepEqual(sections, model.segments);
  assert.equal(sections[0], model.segments[0]);
});

test('adding earlier reasoning keeps the outer process key anchored to its existing MCP card', () => {
  const messages = [message({ toolCalls: [{ id: 'one', name: 'scan_query', arguments: {} }] })];
  const before = transcriptModel(snapshot(), messages, 3);
  const previous = buildProcessSections(before.segments);
  const after = transcriptModel(
    snapshot(),
    [message({ reasoning: 'older' }), ...messages],
    2,
    new Map(),
    before.groupKeys,
  );
  const next = buildProcessSections(after.segments, previous.keys);
  assert.equal(next.sections[0]?.key, previous.sections[0]?.key);
});

test('turn deliverables follow their answer before the next question and coexist with change cards', () => {
  const files = new Map<number, PresentedFile[]>([
    [1, []],
    [3, []],
  ]);
  const model = transcriptModel(
    snapshot(),
    [
      message({ role: 'user', content: 'first' }),
      message({ content: 'first answer' }),
      message({ role: 'user', content: 'second' }),
      message({ content: 'second answer' }),
    ],
    0,
    new Map([[1, {}]]),
    new Map(),
    files,
  );
  assert.deepEqual(
    model.segments.map((segment) => segment.kind),
    ['message', 'message', 'card', 'deliverables', 'message', 'message', 'deliverables'],
  );
});

test('deliverables outside loaded history stay out of the transcript', () => {
  const model = transcriptModel(
    snapshot(),
    [message({ content: 'loaded' })],
    10,
    new Map(),
    new Map(),
    new Map([
      [2, []],
      [10, []],
      [12, []],
    ]),
  );
  assert.deepEqual(
    model.segments.map((segment) => segment.kind),
    ['message', 'deliverables'],
  );
});

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

const call = (id: string, name: string, args: Record<string, unknown> = {}): ToolCall => ({
  id,
  name,
  arguments: args,
});
const toolResult = (toolCallId: string, content = 'result', isError = false): Message => ({
  role: 'tool',
  toolCallId,
  content,
  isError,
});

test('MCP cards separate mixed calls without changing local steps or duplicating results', () => {
  const model = transcriptModel(
    snapshot(),
    [
      message({
        toolCalls: [
          call('a', 'scan_linux_cve_query'),
          call('b', 'read_file', { path: 'note.txt' }),
          call('c', 'mcp_docs_call_tool', { name: 'search', arguments: { q: 'kernel' } }),
        ],
      }),
      toolResult('c', 'remote result'),
      toolResult('a', 'scan result'),
      toolResult('b', 'file result'),
      message({ content: 'answer' }),
    ],
    0,
  );
  assert.deepEqual(
    model.segments.map((s) => s.kind),
    ['mcp', 'group', 'mcp', 'group', 'message'],
  );
  const mcp = model.segments.flatMap((s) => (s.kind === 'mcp' ? s.calls : []));
  assert.deepEqual(
    mcp.map((item) => [item.call.id, item.target.tool, item.resultIndex, item.status]),
    [
      ['a', 'linux_cve_query', 2, 'succeeded'],
      ['c', 'search', 1, 'succeeded'],
    ],
  );
  const local = model.segments.flatMap((s) => (s.kind === 'group' ? s.steps : []));
  assert.deepEqual(
    local.map((step) => [step.kind, step.index, step.callIndex]),
    [
      ['call', 0, 1],
      ['result', 3, 0],
    ],
  );
});

test('consecutive MCP calls share a card and late results retain the card and row keys', () => {
  const messages = [message({ toolCalls: [call('a', 'scan_one'), call('b', 'scan_two')] })];
  const running = { session: { running: true, runEndings: [] } } as unknown as CarrierSnapshot;
  const before = transcriptModel(running, messages, 10);
  const after = transcriptModel(
    running,
    [...messages, toolResult('b', 'failed', true)],
    10,
    new Map(),
    before.groupKeys,
  );
  assert.equal(after.segments.length, 1);
  const first = before.segments[0];
  const updated = after.segments[0];
  assert.equal(first?.kind, 'mcp');
  assert.equal(updated?.kind, 'mcp');
  if (first?.kind !== 'mcp' || updated?.kind !== 'mcp') return;
  assert.equal(first.key, updated.key);
  assert.deepEqual(
    first.calls.map((item) => item.key),
    updated.calls.map((item) => item.key),
  );
  assert.deepEqual(
    updated.calls.map((item) => item.status),
    ['running', 'failed'],
  );
  assert.equal(after.tail, null, 'live reasoning must not join the MCP card');
});

test('an old unanswered MCP call stays unfinished when a new turn is running', () => {
  const running = { session: { running: true, runEndings: [] } } as unknown as CarrierSnapshot;
  const messages = [
    message({ role: 'user', content: 'old question' }),
    message({ toolCalls: [call('old', 'scan_one')] }),
    message({ role: 'user', content: 'new question' }),
    message({ toolCalls: [call('new', 'scan_two')] }),
  ];
  const model = transcriptModel(running, messages, 0);
  assert.deepEqual(
    model.segments.flatMap((s) => (s.kind === 'mcp' ? s.calls.map((item) => item.status) : [])),
    ['interrupted', 'running'],
  );
  const stopped = transcriptModel(snapshot(), messages, 0);
  assert.deepEqual(
    stopped.segments.flatMap((s) => (s.kind === 'mcp' ? s.calls.map((item) => item.status) : [])),
    ['interrupted', 'interrupted'],
  );
});

test('a run ending prevents an unanswered call from reading as running during continuation', () => {
  const state = {
    session: { running: true, runEndings: [{ afterIndex: 0 }] },
  } as unknown as CarrierSnapshot;
  const model = transcriptModel(state, [message({ toolCalls: [call('old', 'scan_one')] })], 0);
  assert.deepEqual(
    model.segments.flatMap((s) => (s.kind === 'mcp' ? s.calls.map((item) => item.status) : [])),
    ['interrupted'],
  );
});

test('a paginated result whose MCP call is outside loaded history remains visible', () => {
  const model = transcriptModel(snapshot(), [toolResult('unloaded', 'important result')], 50);
  assert.deepEqual(
    model.segments.map((s) => s.kind),
    ['group'],
  );
  const group = model.segments[0];
  assert.equal(group?.kind === 'group' ? group.steps[0]?.index : null, 50);
});

test('MCP disclosure keys survive runtime context inserted above their call after approval', () => {
  const calls = message({ toolCalls: [call('approved', 'scan_one')] });
  const before = transcriptModel(snapshot(), [calls], 0);
  const after = transcriptModel(
    snapshot(),
    [
      message({
        role: 'user',
        content: '<runtime-context source="permissions">approved</runtime-context>',
      }),
      calls,
      toolResult('approved'),
    ],
    0,
    new Map(),
    before.groupKeys,
  );
  const oldCard = before.segments[0];
  const newCard = after.segments[0];
  assert.equal(oldCard?.kind, 'mcp');
  assert.equal(newCard?.kind, 'mcp');
  if (oldCard?.kind !== 'mcp' || newCard?.kind !== 'mcp') return;
  assert.equal(oldCard.key, newCard.key);
  assert.equal(oldCard.calls[0]?.key, newCard.calls[0]?.key);
  assert.equal(newCard.calls[0]?.resultIndex, 2);
});

test('providers may reuse an ID for a later local call without losing or misassigning either result', () => {
  const model = transcriptModel(
    snapshot(),
    [
      message({ role: 'user', content: 'first' }),
      message({ toolCalls: [call('call_1', 'scan_one')] }),
      toolResult('call_1', 'MCP_RESULT'),
      message({ role: 'user', content: 'second' }),
      message({ toolCalls: [call('call_1', 'read_file')] }),
      toolResult('call_1', 'LOCAL_RESULT'),
    ],
    0,
  );
  const cards = model.segments.flatMap((segment) => (segment.kind === 'mcp' ? segment.calls : []));
  assert.equal(cards[0]?.resultIndex, 2);
  const localResults = model.segments.flatMap((segment) =>
    segment.kind === 'group'
      ? segment.steps.filter((step) => step.kind === 'result').map((step) => step.index)
      : [],
  );
  assert.deepEqual(localResults, [5]);
});

test('reused MCP IDs in consecutive responses retain distinct rows and their own outcomes', () => {
  const model = transcriptModel(
    snapshot(),
    [
      message({ toolCalls: [call('repeat', 'scan_one')] }),
      toolResult('repeat', 'first failed', true),
      message({ toolCalls: [call('repeat', 'scan_two')] }),
      toolResult('repeat', 'retry succeeded'),
    ],
    0,
  );
  const cards = model.segments.flatMap((segment) => (segment.kind === 'mcp' ? segment.calls : []));
  assert.equal(new Set(cards.map((item) => item.key)).size, 2);
  assert.deepEqual(
    cards.map((item) => [item.target.tool, item.resultIndex, item.status]),
    [
      ['one', 1, 'failed'],
      ['two', 3, 'succeeded'],
    ],
  );
});

test('loading older history with reused IDs preserves the existing disclosure identity', () => {
  const current = message({ toolCalls: [call('repeat', 'scan_same', { q: 'same' })] });
  const before = transcriptModel(snapshot(), [current, toolResult('repeat', 'current')], 3);
  const previousCalls = before.segments.flatMap((segment) =>
    segment.kind === 'mcp' ? segment.calls : [],
  );
  const after = transcriptModel(
    snapshot(),
    [
      message({ toolCalls: [call('repeat', 'scan_same', { q: 'same' })] }),
      toolResult('repeat', 'older'),
      message({ role: 'user', content: 'again' }),
      current,
      toolResult('repeat', 'current'),
    ],
    0,
    new Map(),
    before.groupKeys,
    new Map(),
    previousCalls,
  );
  const updated = after.segments.flatMap((segment) =>
    segment.kind === 'mcp' ? segment.calls : [],
  );
  assert.equal(updated.find((item) => item.index === 3)?.key, previousCalls[0]?.key);
  assert.notEqual(updated.find((item) => item.index === 0)?.key, previousCalls[0]?.key);
});
