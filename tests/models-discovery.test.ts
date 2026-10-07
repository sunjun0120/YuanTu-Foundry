/**
 * Reading a window from the endpoint that owns it.
 *
 * The window is the only ceiling a run has, so the number matters: too small compacts conversations that fit,
 * too large lets the endpoint refuse the first request that outgrows the real limit. This project refuses to
 * guess it per protocol, which leaves exactly two honest sources — the operator, and the endpoint's own
 * catalogue. These tests are about the second one: the field names gateways actually use, the URL conventions
 * they actually serve, and the difference between "the endpoint listed nothing" and "this runtime could not
 * read the answer".
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverModels, discoveryHeaders, modelsUrl } from '../packages/providers/discovery.ts';
import type { ProviderConfig } from '../packages/providers/config.ts';

const config = (over: Partial<ProviderConfig> = {}): ProviderConfig => ({
  apiKey: 'secret',
  model: 'chosen-model',
  ...over,
});
/** A fetch that answers one canned body, and records what it was asked for. */
function stubFetch(payload: unknown, init: { status?: number; body?: string } = {}) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const impl = (async (url: string | URL, options?: { headers?: Record<string, string> }) => {
    calls.push({ url: String(url), headers: options?.headers ?? {} });
    const status = init.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => payload,
      text: async () => init.body ?? JSON.stringify(payload),
    };
  }) as unknown as typeof fetch;
  return { impl, calls };
}

test('the four catalogue envelopes all read, and only the ones this runtime knows', async () => {
  const entries = { id: 'm1', context_length: 128_000, max_output_tokens: 8_192 };
  for (const payload of [
    [entries],
    { data: [entries] },
    { models: [entries] },
    { models: { m1: { context_length: 128_000, max_output_tokens: 8_192 } } },
  ]) {
    const { impl } = stubFetch(payload);
    const result = await discoverModels(config(), { fetch: impl });
    assert.deepEqual(result.models, [
      { id: 'm1', name: 'm1', contextWindow: 128_000, maxOutputTokens: 8_192 },
    ]);
  }
  // An envelope nobody here can read is an error, not an empty list: the two send an operator to completely
  // different next steps, and only one of them is true.
  const { impl } = stubFetch({ unexpected: true });
  await assert.rejects(() => discoverModels(config(), { fetch: impl }), /not a shape/);
});

test('every capacity field family is read, and the first usable one wins', async () => {
  const cases: [Record<string, unknown>, number, number][] = [
    [{ contextWindow: 1, maxOutputTokens: 2 }, 1, 2],
    [{ context_window: 3, max_output_tokens: 4 }, 3, 4],
    [{ context_length: 5, max_tokens: 6 }, 5, 6],
    [{ max_input_tokens: 7, maxTokens: 8 }, 7, 8],
    [{ limit: { context: 9, output: 10 } }, 9, 10],
    [{ top_provider: { max_completion_tokens: 11 }, context_length: 12 }, 12, 11],
    // Gateways that send numbers as strings are common enough that a probe that only accepted numbers would
    // report "not declared" for a catalogue that did declare it.
    [{ context_length: '13', max_output_tokens: '14' }, 13, 14],
    // Junk is skipped rather than trusted: a zero or a negative window is not a window.
    [{ contextWindow: 0, context_length: 15 }, 15, 0],
  ];
  for (const [entry, contextWindow, maxOutputTokens] of cases) {
    const { impl } = stubFetch({ data: [{ id: 'm', ...entry }] });
    const [model] = (await discoverModels(config(), { fetch: impl })).models;
    assert.equal(model?.contextWindow, contextWindow, JSON.stringify(entry));
    if (maxOutputTokens === 0) assert.equal(model?.maxOutputTokens, undefined);
    else assert.equal(model?.maxOutputTokens, maxOutputTokens, JSON.stringify(entry));
  }
});

test('a model with no window is listed, and says so by leaving the field out', async () => {
  const { impl } = stubFetch({
    data: [
      { id: 'small', name: 'Small 1' },
      { id: 'big', context_length: 200_000 },
    ],
  });
  const result = await discoverModels(config(), { fetch: impl });
  assert.deepEqual(result.models, [
    { id: 'small', name: 'Small 1' },
    { id: 'big', name: 'big', contextWindow: 200_000 },
  ]);
});

test('the URL keeps a /v1 base and adds one where the operator did not', async () => {
  assert.equal(
    modelsUrl(config({ baseUrl: 'https://gateway.example' })),
    'https://gateway.example/v1/models',
  );
  assert.equal(
    modelsUrl(config({ baseUrl: 'https://gateway.example/v1' })),
    'https://gateway.example/v1/models',
  );
  assert.equal(
    modelsUrl(config({ baseUrl: 'https://gateway.example/openai/v1/' })),
    'https://gateway.example/openai/v1/models',
  );
  // The defaults match the adapters' own, so a connection that names no base URL probes the protocol's home.
  assert.equal(modelsUrl(config({ protocol: 'openai' })), 'https://api.openai.com/v1/models');
  assert.equal(modelsUrl(config()), 'https://api.anthropic.com/v1/models');
  assert.equal(modelsUrl(config({ protocol: 'anthropic' })), 'https://api.anthropic.com/v1/models');
});

test('the probe authenticates the way the adapter for that protocol does', () => {
  assert.deepEqual(discoveryHeaders(config()), {
    accept: 'application/json',
    'x-api-key': 'secret',
    'anthropic-version': '2023-06-01',
  });
  assert.deepEqual(discoveryHeaders(config({ protocol: 'anthropic' })), {
    accept: 'application/json',
    'x-api-key': 'secret',
    'anthropic-version': '2023-06-01',
  });
  assert.deepEqual(discoveryHeaders(config({ protocol: 'openai' })), {
    accept: 'application/json',
    authorization: 'Bearer secret',
  });
  const { impl, calls } = stubFetch({ data: [] });
  void calls;
  return discoverModels(config({ protocol: 'openai' }), { fetch: impl }).then((result) => {
    assert.equal(result.protocol, 'openai');
  });
});

test('catalogue URLs strip inference suffixes and reject unsafe credential destinations', () => {
  for (const suffix of ['chat/completions', 'responses', 'messages']) {
    assert.equal(
      modelsUrl(config({ baseUrl: `https://gateway.example/v1/${suffix}` })),
      'https://gateway.example/v1/models',
    );
  }
  for (const baseUrl of [
    'http://remote.example/v1',
    'https://user:password@remote.example/v1',
    'https://remote.example/v1?token=x',
    'https://remote.example/v1#fragment',
  ]) {
    assert.throws(() => modelsUrl(config({ baseUrl })));
  }
});

test('a refusal from the endpoint is reported with its status, not as an empty catalogue', async () => {
  const { impl } = stubFetch({}, { status: 401, body: 'invalid x-api-key' });
  await assert.rejects(
    () => discoverModels(config(), { fetch: impl }),
    (error: unknown) =>
      error instanceof Error &&
      /answered 401/.test(error.message) &&
      /invalid x-api-key/.test(error.message),
  );
});

test('a request that never reached the endpoint keeps its own failure', async () => {
  const impl = (async () => {
    throw new Error('fetch failed: getaddrinfo ENOTFOUND gateway.example');
  }) as unknown as typeof fetch;
  await assert.rejects(
    () => discoverModels(config({ baseUrl: 'https://gateway.example' }), { fetch: impl }),
    /ENOTFOUND/,
  );
});
