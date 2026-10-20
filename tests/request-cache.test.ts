import test from 'node:test';
import assert from 'node:assert/strict';
import { OpenAIProvider } from '../packages/providers/openai.ts';
import { createProviderMeasurement } from '../packages/core/run-provider.ts';
import { emptyStatistics } from '../packages/protocol/statistics.ts';
import type { ModelRequest } from '../packages/protocol/index.ts';
import { httpFixture } from './http-fixture.ts';
import { storeFixture } from './temp-fixture.ts';
import { observedRequestBody } from '../packages/providers/request-observation.ts';
import type { PreparedRequestFingerprint } from '../packages/protocol/request-cache.ts';

test('request cache observations describe each serialized attempt and survive measurement recreation', async (t) => {
  const { store, root } = await storeFixture(t, 'yuantu-request-cache-');
  const sessionId = store.create(root).id;
  const url = await httpFixture(t, (_body, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 90, cache_write_tokens: 4 } } })}\n\ndata: [DONE]\n\n`,
    );
  });
  const provider = new OpenAIProvider({ apiKey: 'fixture-secret', model: 'fixture', baseUrl: url });
  const measured = () =>
    createProviderMeasurement({
      provider,
      store,
      sessionId,
      runId: 'cache-run',
      statistics: emptyStatistics(),
      emit() {},
    });
  const request: ModelRequest = {
    system: 'secret prompt',
    messages: [{ role: 'user', content: 'private input' }],
    tools: [],
    maxOutputTokens: 100,
    signal: new AbortController().signal,
    onText() {},
  };
  const run = measured();
  await run('answer').complete(request);
  await run('answer').complete({
    ...request,
    messages: [
      ...request.messages,
      { role: 'assistant', content: 'ok', toolCalls: [] },
      { role: 'user', content: 'next' },
    ],
  });
  const requests = () =>
    store.events(sessionId).filter((event) => event.type === 'provider.request.finished');
  const first = requests()[0]!.data;
  assert.deepEqual(first.usage, {
    inputTokens: 100,
    outputTokens: 10,
    cachedInputTokens: 90,
    cacheWriteInputTokens: 4,
  });
  assert.equal(first.cacheHitRatio, 0.9);
  assert.equal(first.cacheMissInputTokens, 10);
  assert.deepEqual(first.prefixChanges, ['initial']);
  assert.equal(requests()[1]!.data.historyChange, 'append');
  assert.deepEqual(requests()[1]!.data.prefixChanges, []);
  await measured()('answer').complete(request);
  assert.equal(requests()[2]!.data.historyChange, 'rewritten');
  assert.deepEqual(requests()[2]!.data.prefixChanges, ['history']);
  await run('answer').complete({ ...request, system: 'updated instructions' });
  assert.ok((requests()[3]!.data.prefixChanges as string[]).includes('system'));
  await run('summary').complete(request);
  assert.deepEqual(requests()[4]!.data.prefixChanges, ['initial']);
  await measured()('answer').complete({ ...request, system: 'updated instructions' });
  assert.deepEqual(
    requests()[5]!.data.prefixChanges,
    [],
    'the last summary must not erase the answer baseline',
  );
  await measured()('summary').complete(request);
  assert.deepEqual(
    requests()[6]!.data.prefixChanges,
    [],
    'the last answer must not erase the summary baseline',
  );
  const answerProvider = measured()('answer');
  const separateSummaryProvider = measured()('summary');
  await answerProvider.complete({ ...request, system: 'new answer system' });
  await separateSummaryProvider.complete({ ...request, system: 'new summary system' });
  await measured()('answer').complete({ ...request, system: 'new answer system' });
  assert.deepEqual(
    requests()[9]!.data.prefixChanges,
    [],
    'a separate summary wrapper cannot overwrite a newer answer baseline',
  );
  await measured()('summary').complete({ ...request, system: 'new summary system' });
  assert.deepEqual(requests()[10]!.data.prefixChanges, []);
  for (const event of requests()) {
    const serialized = JSON.stringify(event.data);
    assert.ok(
      !serialized.includes('secret prompt') &&
        !serialized.includes('private input') &&
        !serialized.includes('fixture-secret'),
    );
    assert.ok(
      !serialized.includes('historyPrefixes'),
      'per-message fingerprints remain process-local',
    );
  }
});

test('failed and unknown-usage attempts never invent cache counts', async (t) => {
  const { store, root } = await storeFixture(t, 'yuantu-unknown-cache-');
  const sessionId = store.create(root).id;
  let fail = false;
  const measured = createProviderMeasurement({
    provider: {
      async complete() {
        if (fail) throw new Error('fixture transport failure');
        return {
          text: 'ok',
          toolCalls: [],
          finishReason: 'stop',
          usage: { inputTokens: 100, outputTokens: 10 },
        };
      },
    },
    store,
    sessionId,
    runId: 'run',
    statistics: emptyStatistics(),
    emit() {},
  })('answer');
  const request: ModelRequest = {
    system: '',
    messages: [],
    tools: [],
    maxOutputTokens: 100,
    signal: new AbortController().signal,
    onText() {},
  };
  await measured.complete(request);
  fail = true;
  await assert.rejects(measured.complete(request), /fixture transport failure/);
  const events = store
    .events(sessionId)
    .filter((event) => event.type === 'provider.request.finished');
  assert.deepEqual(events[0]!.data.usage, { inputTokens: 100, outputTokens: 10 });
  assert.equal(events[0]!.data.cacheHitRatio, undefined);
  assert.equal(events[0]!.data.cacheMissInputTokens, undefined);
  assert.equal(events[1]!.data.usage, undefined);
  assert.equal(events[1]!.data.cacheHitRatio, undefined);
  assert.equal(events[1]!.data.failed, true);
});

test('Messages and Responses fingerprints exclude only actual cache annotations', () => {
  const inspect = (protocol: string, body: Record<string, unknown>) => {
    let fingerprint: PreparedRequestFingerprint | undefined;
    const request: ModelRequest = {
      system: '',
      messages: [],
      tools: [],
      maxOutputTokens: 100,
      signal: new AbortController().signal,
      onText() {},
      onRequestFingerprint(value) {
        fingerprint = value;
      },
    };
    const encoded = observedRequestBody(
      request,
      { protocol, endpoint: 'https://example.invalid', model: 'fixture' },
      body,
    );
    assert.deepEqual(
      JSON.parse(encoded),
      body,
      'observation cannot alter the actual transport input',
    );
    assert.ok(fingerprint);
    return fingerprint;
  };
  const first = {
    system: [{ type: 'text', text: 'fixed', cache_control: { type: 'ephemeral' } }],
    messages: [
      {
        role: 'user',
        content: [{ type: 'text', text: 'first', cache_control: { type: 'ephemeral' } }],
      },
    ],
    tools: [
      {
        name: 'tool',
        input_schema: { type: 'object', properties: { cache_control: { type: 'string' } } },
        cache_control: { type: 'ephemeral' },
      },
    ],
  };
  const moved = structuredClone(first);
  delete (moved.messages[0]!.content[0] as { cache_control?: unknown }).cache_control;
  const before = inspect('anthropic', first);
  const after = inspect('anthropic', moved);
  assert.equal(before.historyHash, after.historyHash);
  moved.tools[0]!.input_schema.properties.cache_control.type = 'number';
  assert.notEqual(
    inspect('anthropic', moved).toolsHash,
    before.toolsHash,
    'a schema property named cache_control is input, not an annotation',
  );
  const responses = inspect('openai-responses', {
    instructions: 'fixed',
    input: [{ role: 'user', content: 'hello' }],
    tools: [],
  });
  const appended = inspect('openai-responses', {
    instructions: 'fixed',
    input: [
      { role: 'user', content: 'hello' },
      { type: 'reasoning', encrypted_content: 'opaque' },
    ],
    tools: [],
  });
  assert.equal(appended.historyPrefixes[responses.messageCount], responses.historyHash);
});
