/**
 * The request measurement, checked against the algorithm it replaced.
 *
 * `estimateInputTokens` and `contextBreakdown` cost about six serialisations of the whole conversation per round —
 * the estimator ran twice (raw and calibrated), the breakdown serialised the three parts again, and every caller
 * that asked the same question twice (the two `fits()` in `prepareContext`) paid for it all over again. The
 * intended shape is one traversal that yields the total, the raw total *and* the breakdown together.
 *
 * That is a pure optimisation, so the way to make it is the way this file is written: an **oracle** — the old
 * algorithm, copied here — plus a corpus that exercises every branch of it (dropped keys, image rewriting, nested
 * `images`, CJK, escaping, array separators, a calibrated and an uncalibrated estimate), asserted equal for every
 * case. Byte for byte, because the number decides whether a request is sent, compressed or refused, and because
 * the turn snapshots record the breakdown a run acted on.
 *
 * The oracle is deliberately a copy rather than a call into the product: a differential test whose reference is
 * the code under test proves nothing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  contextBreakdown,
  estimateInputTokens,
  estimateMessageTokens,
  measureRequest,
  type ContextBreakdown,
} from '../packages/core/budget.ts';
import { forecastRequest } from '../packages/core/forecast.ts';
import type { ImageAttachment, Message, ToolSpec } from '../packages/protocol/index.ts';

interface Oracle {
  rawInputTokens: number;
  inputTokens: number;
  breakdown: ContextBreakdown;
}

/** `estimateInputTokens` and `contextBreakdown` exactly as they were, before they became one traversal. */
function oracle(system: string, messages: Message[], tools: ToolSpec[], factor: number): Oracle {
  const estimator = (applied: number): number => {
    let imageTokens = 0;
    const serialized = JSON.stringify({ system, messages, tools }, (key, value) => {
      if (key === 'change') return undefined;
      if (key === 'reasoning') return undefined;
      if (key === 'images' && Array.isArray(value)) {
        imageTokens += value.length * 4096;
        return value.map((image) => ({ mimeType: image.mimeType, name: image.name }));
      }
      return value;
    });
    const text = Math.ceil(Buffer.byteLength(serialized, 'utf8') / 3);
    return Math.max(1, Math.ceil(text * applied)) + 256 + imageTokens;
  };
  const rawInputTokens = estimator(1);
  const total = estimator(factor);
  const bytes = (value: unknown): number =>
    Buffer.byteLength(
      JSON.stringify(value, (key, entry) => {
        if (key === 'change' || key === 'reasoning') return undefined;
        if (key === 'images' && Array.isArray(entry))
          return entry.map((image) => ({ mimeType: image.mimeType, name: image.name }));
        return entry;
      }) ?? '',
      'utf8',
    );
  const systemBytes = bytes(system);
  const toolsBytes = bytes(tools);
  const messagesBytes = bytes(messages);
  const textBytes = Math.max(1, systemBytes + toolsBytes + messagesBytes);
  let images = 0;
  const countImages = (value: unknown): void => {
    if (Array.isArray(value)) for (const entry of value) countImages(entry);
    else if (value && typeof value === 'object')
      for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
        if (key === 'images' && Array.isArray(entry)) images += entry.length;
        else countImages(entry);
      }
  };
  countImages(messages);
  const overhead = Math.max(0, 256 + images * 4096);
  const textTokens = Math.max(0, total - overhead);
  const share = (part: number): number => Math.round((textTokens * part) / textBytes);
  const systemTokens = share(systemBytes);
  const toolsTokens = share(toolsBytes);
  return {
    rawInputTokens,
    inputTokens: total,
    breakdown: {
      system: systemTokens,
      tools: toolsTokens,
      messages: Math.max(0, textTokens - systemTokens - toolsTokens),
      overhead,
      total,
    },
  };
}

const image = (name: string): ImageAttachment => ({
  mimeType: 'image/png',
  data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  name,
});
const spec = (name: string, extra: Partial<ToolSpec> = {}): ToolSpec => ({
  name,
  description: `${name} does a thing`,
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  ...extra,
});
/** Escapes, CJK, dropped keys, a rewritten image list and a nested one: every branch the old code had. */
const conversation = (): Message[] => [
  {
    role: 'user',
    content: 'hello 世界 "quoted" \\ backslash\nnewline 🎉',
    createdAt: '2026-10-03T00:00:00.000Z',
  },
  {
    role: 'assistant',
    content: 'sure',
    toolCalls: [{ id: 'c1', name: 'read_file', arguments: { path: 'a.txt' } }],
    reasoning: 'thinking hard about it',
  },
  {
    role: 'tool',
    toolCallId: 'c1',
    isError: false,
    content: 'file body',
    change: {
      path: 'a.txt',
      kind: 'edit',
      patch: 'Index: a.txt\n',
      added: 1,
      removed: 1,
      truncated: false,
    },
    output: {
      render: 'file-read',
      value: { path: 'a.txt', text: 'body', images: [image('in.png')] },
    },
  },
  { role: 'user', content: 'now with a picture', images: [image('one.png'), image('two.png')] },
];
const long = (count: number): Message[] =>
  Array.from({ length: count }, (_, index) =>
    index % 2 === 0
      ? ({ role: 'user', content: `turn ${index} ${'y'.repeat(400)}` } as Message)
      : ({
          role: 'assistant',
          content: `answer ${index}`,
          toolCalls: [{ id: `c${index}`, name: 'list_files', arguments: { path: '.' } }],
        } as Message),
  );

const CASES: {
  name: string;
  system: string;
  messages: Message[];
  tools: ToolSpec[];
  factor: number;
}[] = [
  { name: 'empty', system: '', messages: [], tools: [], factor: 1 },
  {
    name: 'plain',
    system: 'You are YuanTu.',
    messages: conversation(),
    tools: [spec('read_file')],
    factor: 1,
  },
  {
    name: 'calibrated',
    system: 'You are YuanTu.',
    messages: conversation(),
    tools: [spec('read_file')],
    factor: 2.5,
  },
  { name: 'damped', system: 'You are YuanTu.', messages: conversation(), tools: [], factor: 0.5 },
  {
    name: 'cjk system and many tools',
    system: '你是 YuanTu，一个编程 agent。'.repeat(40),
    messages: long(12),
    tools: Array.from({ length: 40 }, (_, index) => spec(`tool_${index}`)),
    factor: 1.75,
  },
  {
    name: 'images nested in a tool schema',
    system: 'You are YuanTu.',
    messages: [{ role: 'user', content: 'hi' }],
    // The estimator counts these images in the total; the breakdown's overhead never walked tools, so the two
    // disagree by exactly this allowance — the differential test is what keeps that asymmetry from drifting.
    tools: [
      spec('screenshot', {
        inputSchema: { type: 'object', images: [image('a.png'), image('b.png')] },
      }),
    ],
    factor: 1,
  },
  {
    name: 'long conversation',
    system: 'You are YuanTu.',
    messages: long(200),
    tools: [spec('read_file')],
    factor: 1,
  },
  {
    name: 'only images',
    system: '',
    messages: [{ role: 'user', content: '', images: [image('x.png')] }],
    tools: [],
    factor: 1,
  },
];

for (const scenario of CASES) {
  test(`the measurement matches the algorithm it replaced: ${scenario.name}`, () => {
    const expected = oracle(scenario.system, scenario.messages, scenario.tools, scenario.factor);
    // The measurement the run acts on.
    const measured = measureRequest({
      system: scenario.system,
      messages: scenario.messages,
      tools: scenario.tools,
      factor: scenario.factor,
    });
    assert.equal(measured.rawInputTokens, expected.rawInputTokens, 'raw total');
    assert.equal(measured.inputTokens, expected.inputTokens, 'calibrated total');
    assert.deepEqual(measured.breakdown, expected.breakdown, 'breakdown');
    // And the two functions that had the answer all along, which now delegate to it.
    assert.equal(
      estimateInputTokens(scenario.system, scenario.messages, scenario.tools, scenario.factor),
      expected.inputTokens,
    );
    assert.equal(
      estimateInputTokens(scenario.system, scenario.messages, scenario.tools),
      expected.rawInputTokens,
      'the uncorrected estimate is the factor-1 measurement',
    );
    assert.deepEqual(
      contextBreakdown(scenario.system, scenario.messages, scenario.tools, scenario.factor),
      expected.breakdown,
    );
  });
}

test('measuring the same conversation again, and a copy of it, gives the same numbers', () => {
  /**
   * The per-message cache is keyed by the message *object*, which is what makes a repeated measurement free — and
   * what makes it unsound the moment a message is edited in place. This is the differential statement that goes
   * with that: the same objects measured twice, and structurally equal objects that share no identity with them,
   * must all answer identically. A cache that leaked between two conversations, or that answered for a message it
   * had never seen, would show up here as a difference rather than as a wrong number nobody could attribute.
   */
  const messages = conversation();
  const tools = [spec('read_file')];
  const system = 'You are YuanTu.';
  const first = forecastRequest({ system, messages, tools, maxOutputTokens: 1_000, factor: 1.75 });
  const again = forecastRequest({ system, messages, tools, maxOutputTokens: 1_000, factor: 1.75 });
  assert.deepEqual(again, first, 'the same objects, measured again');
  // A copy: same bytes, no shared identity, so every message is measured from scratch.
  const copy = JSON.parse(JSON.stringify(messages)) as Message[];
  assert.deepEqual(
    forecastRequest({ system, messages: copy, tools, maxOutputTokens: 1_000, factor: 1.75 }),
    first,
    'a structurally equal conversation answers the same',
  );
  // And a genuine difference is still seen: the cache is not answering for the conversation as a whole.
  const longer = [...messages, { role: 'user', content: 'one more turn' } as Message];
  assert.ok(
    forecastRequest({ system, messages: longer, tools, maxOutputTokens: 1_000, factor: 1.75 })
      .inputTokens > first.inputTokens,
    'a conversation with one more message costs more',
  );
});

test('a message is measured without the request’s own margin', () => {
  /**
   * The retention budget sums a cost per message, and it used to sum `estimateInputTokens('', [message], [])` —
   * which adds the *request's* 256-token protocol margin to every message. A two-hundred-byte message, truly about
   * sixty-seven tokens, was measured as three hundred and twenty-three, so a policy asking to keep a tail of N
   * tokens kept a fraction of it.
   */
  const message: Message = { role: 'user', content: 'x'.repeat(200) };
  const one = measureRequest({ system: '', messages: [message], tools: [] });
  const text = Math.ceil(one.bytes.messages / 3);
  assert.equal(estimateMessageTokens(message), text, 'the message’s own bytes, margin-free');
  const difference = one.rawInputTokens - text;
  assert.ok(
    difference >= 256 && difference < 300,
    `the request adds its 256-token margin and its own punctuation, and little else: ${difference}`,
  );
  // The learned correction applies to a message exactly as it does to a request.
  assert.equal(estimateMessageTokens(message, 2), Math.ceil(text * 2));
  // A picture is not a margin: it really does spend the window, so it is counted at the per-image allowance.
  const withImage: Message = { role: 'user', content: 'x', images: [image('a.png')] };
  assert.ok(
    estimateMessageTokens(withImage) - estimateMessageTokens({ role: 'user', content: 'x' }) >=
      4096,
    'a picture is counted in the message',
  );
  assert.ok(
    measureRequest({ system: '', messages: [withImage], tools: [] }).rawInputTokens -
      estimateMessageTokens(withImage) <
      300,
    'and the request adds only its own margin and punctuation on top of it',
  );
});

test('the serialised sizes it reports are the sizes the provider is billed for', () => {
  // The parts are what a caller budgets characters with (`prepareContext` decides whether a summary batch fits,
  // and `contextMessageSize` is the same number), so they are asserted against the real serialisation rather
  // than against a second copy of the arithmetic.
  const messages = conversation();
  const tools = [spec('read_file'), spec('write_file')];
  const system = 'You are YuanTu.';
  const measured = measureRequest({ system, messages, tools, factor: 1 });
  assert.equal(measured.bytes.system, Buffer.byteLength(JSON.stringify(system), 'utf8'));
  assert.equal(
    measured.bytes.tools,
    Buffer.byteLength(
      JSON.stringify(tools, (key, entry) =>
        key === 'change' || key === 'reasoning'
          ? undefined
          : key === 'images' && Array.isArray(entry)
            ? entry.map((image) => ({ mimeType: image.mimeType, name: image.name }))
            : entry,
      ) ?? '',
      'utf8',
    ),
  );
  assert.equal(
    measured.bytes.messages,
    Buffer.byteLength(
      JSON.stringify(messages, (key, entry) => {
        if (key === 'change' || key === 'reasoning') return undefined;
        if (key === 'images' && Array.isArray(entry))
          return entry.map((image) => ({ mimeType: image.mimeType, name: image.name }));
        return entry;
      }) ?? '',
      'utf8',
    ),
  );
});
