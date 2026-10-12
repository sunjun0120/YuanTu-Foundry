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
    const text = init.body ?? JSON.stringify(payload);
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => payload,
      text: async () => text,
      // A real `Response` always carries a body, and the probe reads a failed one as a stream so it can bound how
      // much of the endpoint's answer it consumes. A stub without one would test a shape no endpoint sends.
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(text));
          controller.close();
        },
      }),
    };
  }) as unknown as typeof fetch;
  return { impl, calls };
}
/**
 * A fetch whose failed answer keeps producing frames.
 *
 * The stream closes at the end rather than running forever: 200 KiB is already past the bound the probe is
 * allowed to read, and a bounded body makes a regression fail the byte assertions instead of hanging the suite.
 * `text()` is present as well, so the fixture is a fair host for the unbounded read it replaced.
 */
function chunkedErrorFetch(frames: number, size = 1024) {
  const frame = new Uint8Array(size).fill(0x65);
  let pulled = 0;
  let cancelled = false;
  const impl = (async () => {
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulled >= frames) {
          controller.close();
          return;
        }
        pulled += 1;
        controller.enqueue(frame);
      },
      cancel() {
        cancelled = true;
      },
    });
    return {
      ok: false,
      status: 500,
      body,
      text: async () => {
        const reader = body.getReader();
        const decoder = new TextDecoder();
        let out = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return out + decoder.decode();
          out += decoder.decode(value, { stream: true });
        }
      },
    };
  }) as unknown as typeof fetch;
  return { impl, observed: () => ({ pulled, cancelled }) };
}
/** A failed answer whose body opens and then says nothing at all. */
function stalledErrorFetch(status = 503) {
  let cancelled = false;
  const impl = (async () => ({
    ok: false,
    status,
    body: new ReadableStream<Uint8Array>({
      // Never resolving keeps the stream from calling `pull` again in a hot loop, which is also what a socket
      // that has gone quiet looks like from the reader's side.
      pull: () => new Promise<void>(() => {}),
      cancel: () => {
        cancelled = true;
      },
    }),
  })) as unknown as typeof fetch;
  return { impl, observed: () => ({ cancelled }) };
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

test('a failed probe reads a bounded slice of the error body and cancels the rest', async () => {
  const { impl, observed } = chunkedErrorFetch(200);
  await assert.rejects(
    () => discoverModels(config(), { fetch: impl }),
    (error: unknown) =>
      error instanceof Error &&
      /answered 500/.test(error.message) &&
      /e{300}/.test(error.message) &&
      !/e{400}/.test(error.message),
  );
  const { pulled, cancelled } = observed();
  assert.equal(cancelled, true, 'the body is cancelled rather than left open');
  assert.ok(pulled >= 16, 'the documented 16 KiB bound is actually read');
  assert.ok(pulled < 200, 'the reader stopped before the end of a body it will not use');
});

test('a stalled error body is given up on instead of waited out', async () => {
  const { impl, observed } = stalledErrorFetch();
  const started = Date.now();
  await assert.rejects(() => discoverModels(config(), { fetch: impl }), /answered 503/);
  assert.ok(Date.now() - started < 30_000, 'the probe returned on its own deadline');
  assert.equal(observed().cancelled, true, 'the stalled body is released');
});

test('a cancelled probe stops waiting for the error body it was reading', async () => {
  const controller = new AbortController();
  const { impl, observed } = stalledErrorFetch(500);
  const probe = discoverModels(config(), { fetch: impl, signal: controller.signal });
  const cancelled = setTimeout(() => controller.abort(new Error('operator cancelled')), 20);
  try {
    await assert.rejects(probe, /operator cancelled/);
  } finally {
    clearTimeout(cancelled);
  }
  assert.equal(observed().cancelled, true, 'a cancelled read still releases the body');
});
