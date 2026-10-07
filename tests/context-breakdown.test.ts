import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { contextBreakdown, estimateInputTokens } from '../packages/core/budget.ts';
import type { ContextBreakdown } from '../packages/core/budget.ts';
import { forecastRequest } from '../packages/core/forecast.ts';
import { Agent } from '../packages/core/agent.ts';
import { SessionStore } from '../packages/storage/sqlite.ts';
import { ToolRegistry } from '../packages/tools/registry.ts';
import type { Message, ToolSpec } from '../packages/protocol/index.ts';

/**
 * Where a request's estimated input goes.
 *
 * "The request is too big" is only actionable if the reader can see which part is big: a catalog of tool schemas
 * can cost more than the whole conversation, and a run that keeps compressing its history while sending tens of
 * kilobytes of schemas is optimising the wrong half. What these tests pin is that the split is the *same*
 * estimate the run decides on, not a second opinion:
 *
 * - the parts add up to the total, exactly (rounding included);
 * - the fixed margin and the image allowance are attributed to `overhead` rather than to a part;
 * - a big catalog shows up as a big `tools` share;
 * - and the round's own `context.forecast` event carries it, so a client can show what the run paid.
 */

const message = (content: string): Message => ({ role: 'user', content });
const tool = (name: string, padding: number): ToolSpec => ({
  name,
  description: 'x'.repeat(padding),
  inputSchema: { type: 'object', properties: {} },
});

test('the parts add up to the total the run decides on', () => {
  const system = 'You are a careful agent. '.repeat(20);
  const messages = [message('hello'), message('world')];
  const tools = [tool('a', 200), tool('b', 40)];
  for (const factor of [1, 0.5, 2]) {
    const split = contextBreakdown(system, messages, tools, factor);
    assert.equal(
      split.system + split.tools + split.messages + split.overhead,
      split.total,
      `the parts sum to the total (factor ${factor})`,
    );
    assert.equal(
      split.total,
      estimateInputTokens(system, messages, tools, factor),
      'and the total is the estimate the run decides on, not a second one',
    );
  }
});

test('a large catalog is visible as a large tools share', () => {
  const system = 'short prompt';
  const messages = [message('a question')];
  const small = contextBreakdown(system, messages, [tool('one', 100)]);
  const large = contextBreakdown(
    system,
    messages,
    Array.from({ length: 40 }, (_, index) => tool(`tool_${index}`, 400)),
  );
  assert.ok(
    large.tools > large.messages * 5,
    `the catalog dominates the request: tools ${large.tools} vs messages ${large.messages}`,
  );
  assert.ok(small.tools < large.tools / 5, 'and a small one does not');
  assert.equal(large.system, small.system, 'the system prompt is unaffected by the catalog');
});

test('the fixed margin and image allowance are avoided, not attributed', () => {
  const split = contextBreakdown('', [], []);
  assert.equal(split.overhead, 256, 'the protocol margin belongs to no part');
  assert.equal(split.system + split.tools + split.messages, split.total - 256);
  const withImage = contextBreakdown(
    '',
    [
      {
        role: 'user',
        content: 'look',
        images: [{ mimeType: 'image/png', name: 'a.png' }],
      } as Message,
    ],
    [],
  );
  assert.equal(
    withImage.overhead,
    256 + 4096,
    'an image is a provider-side allowance, so it is overhead rather than message text',
  );
  assert.equal(
    withImage.system + withImage.tools + withImage.messages + withImage.overhead,
    withImage.total,
  );
});

test('the forecast carries the breakdown, because that is the number being decided on', () => {
  const forecast = forecastRequest({
    system: 's',
    messages: [message('m')],
    tools: [tool('t', 500)],
    maxOutputTokens: 100,
  });
  assert.deepEqual(forecast.breakdown, contextBreakdown('s', [message('m')], [tool('t', 500)]));
  assert.equal(forecast.breakdown.total, forecast.inputTokens);
});

test('a round emits the breakdown with its forecast', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-breakdown-'));
  const store = new SessionStore(path.join(root, 'sessions.sqlite'));
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const session = store.create(root);
  const forecasts: Record<string, unknown>[] = [];
  const agent = new Agent({
    store,
    provider: {
      async complete() {
        return {
          text: 'Done',
          toolCalls: [],
          finishReason: 'stop',
          usage: { inputTokens: 10, outputTokens: 5 },
        };
      },
    },
    // A registry with real schemas, because the point of the breakdown is that they are visible in it.
    tools: new ToolRegistry(),
    approve: async () => true,
    onEvent: (event) => {
      if (event.type === 'context.forecast') forecasts.push(event.data);
    },
  });
  assert.equal((await agent.run({ sessionId: session.id, prompt: 'Hi' })).status, 'completed');
  assert.equal(forecasts.length, 1, 'one forecast per round');
  const breakdown = forecasts[0]?.breakdown as ContextBreakdown | undefined;
  assert.ok(breakdown, 'the event carries the breakdown');
  assert.equal(
    breakdown.system + breakdown.tools + breakdown.messages + breakdown.overhead,
    breakdown.total,
    'and it is internally consistent',
  );
  assert.equal(breakdown.total, forecasts[0]?.inputTokens);
  assert.ok(
    (breakdown.tools ?? 0) >= 256,
    `the kernel's own tools are visible in the split: ${JSON.stringify(breakdown)}`,
  );
});
