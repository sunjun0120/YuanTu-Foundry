import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AdaptiveConcurrency,
  endpointGate,
  gatedProvider,
} from '../packages/providers/rate-gate.ts';
import { RunFailure } from '../packages/protocol/failure.ts';
import type { ModelRequest, ModelResponse } from '../packages/protocol/index.ts';

const limited = () => new RunFailure('rate-limit', 'HTTP 429', { httpStatus: 429 });
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
};

test('nothing is throttled until the endpoint objects', async () => {
  const gate = new AdaptiveConcurrency(64);
  let peak = 0;
  let running = 0;
  await Promise.all(
    Array.from({ length: 20 }, () =>
      gate.run(async () => {
        peak = Math.max(peak, ++running);
        await new Promise((done) => setTimeout(done, 5));
        running--;
      }),
    ),
  );
  assert.equal(peak, 20);
  assert.equal(gate.limit, 64);
});

test('a 429 halves the limit from what was in flight, and successes raise it back', async () => {
  const gate = new AdaptiveConcurrency(64);
  const hold = deferred();
  const inFlight = Array.from({ length: 7 }, () => gate.run(() => hold.promise));
  await assert.rejects(
    gate.run(async () => {
      throw limited();
    }),
    /HTTP 429/,
  );
  assert.equal(gate.limit, 4, 'eight in flight when it failed, so four');
  hold.resolve();
  await Promise.all(inFlight);
  // Seven successes after the cut: four raise it to five, and the count starts over.
  assert.equal(gate.limit, 5);
  for (let index = 0; index < 5; index++) await gate.run(async () => undefined);
  assert.equal(gate.limit, 6);
});

test('eight concurrent 429 responses halve the limit only once per recovery window', async () => {
  const gate = new AdaptiveConcurrency(64);
  const hold = deferred();
  const requests = Array.from({ length: 8 }, () =>
    gate.run(async () => {
      await hold.promise;
      throw limited();
    }),
  );
  const results = Promise.allSettled(requests);
  hold.resolve();
  assert.ok((await results).every((result) => result.status === 'rejected'));
  assert.equal(gate.limit, 4);
  const next = deferred();
  const retries = Array.from({ length: 4 }, () =>
    gate.run(async () => {
      await next.promise;
      throw limited();
    }),
  );
  const retried = Promise.allSettled(retries);
  next.resolve();
  assert.ok((await retried).every((result) => result.status === 'rejected'));
  assert.equal(gate.limit, 2, 'new requests may start the next recovery window');
});

test('requests over the limit wait in order, and a waiting request honours its abort signal', async () => {
  const gate = new AdaptiveConcurrency(64);
  await assert.rejects(
    gate.run(async () => {
      throw limited();
    }),
  );
  assert.equal(gate.limit, 1);
  const hold = deferred();
  const order: string[] = [];
  const first = gate.run(async () => {
    order.push('first');
    await hold.promise;
  });
  const controller = new AbortController();
  const aborted = gate.run(async () => order.push('aborted'), controller.signal);
  const second = gate.run(async () => order.push('second'));
  controller.abort(new Error('stopped'));
  await assert.rejects(aborted, /stopped/);
  hold.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(order, ['first', 'second']);
});

test('a gated provider keeps the provider it wraps and passes requests through the gate', async () => {
  const gate = new AdaptiveConcurrency(64);
  const response: ModelResponse = {
    text: 'ok',
    toolCalls: [],
    finishReason: 'stop',
    usage: { inputTokens: 1, outputTokens: 1 },
  };
  class Fake {
    label = 'fake';
    async complete(_request: ModelRequest): Promise<ModelResponse> {
      return { ...response, text: this.label };
    }
  }
  const inner = new Fake();
  const provider = gatedProvider(inner, gate);
  assert.ok(provider instanceof Fake);
  const result = await provider.complete({ signal: new AbortController().signal } as ModelRequest);
  assert.equal(result.text, 'fake');
});

test('runs against one endpoint and key share one gate; another endpoint or key gets its own', () => {
  const endpoint = { protocol: 'openai', baseUrl: 'https://gate.test/v1', apiKey: 'key-a' };
  // Two sessions build their runs separately; a 429 seen by one must slow the other.
  assert.equal(endpointGate({ ...endpoint }), endpointGate({ ...endpoint }));
  assert.notEqual(endpointGate(endpoint), endpointGate({ ...endpoint, apiKey: 'key-b' }));
  assert.notEqual(
    endpointGate(endpoint),
    endpointGate({ ...endpoint, baseUrl: 'https://other.test/v1' }),
  );
  assert.notEqual(endpointGate(endpoint), endpointGate({ ...endpoint, protocol: 'anthropic' }));
});
