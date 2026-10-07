import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createAgent } from '../apps/shared/runtime.ts';
import { parseArgs } from '../apps/shared/args.ts';
import { SessionStore } from '../packages/storage/sqlite.ts';
import { httpFixture, frames, sendFrames } from './http-fixture.ts';
import { discoverAutomaticCapacities } from '../packages/providers/automatic-capacity.ts';
import { listeningHost, connectClient } from './listening-host-fixture.ts';

async function fixture(t: test.TestContext, catalog: unknown, status = 200) {
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-auto-capacity-'));
  const store = new SessionStore(path.join(root, 'sessions.sqlite'));
  let probes = 0;
  const outputs: number[] = [];
  const endpoint = await httpFixture(t, (body, res, headers, url) => {
    assert.equal(headers['x-api-key'], 'synthetic-capacity-key');
    if (url === '/v1/models') {
      probes++;
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(catalog));
    } else {
      assert.equal(url, '/v1/messages');
      outputs.push((body as { max_tokens: number }).max_tokens);
      sendFrames(res, frames('Automatic capacity works'));
    }
  });
  const env = {
    YUANTU_PROTOCOL: 'anthropic',
    YUANTU_BASE_URL: endpoint,
    YUANTU_MODEL: 'synthetic-model',
    YUANTU_API_KEY: 'synthetic-capacity-key',
    YUANTU_MAX_CONTEXT_TOKENS: '',
    YUANTU_MAX_OUTPUT_TOKENS: '',
    YUANTU_MODEL_CAPACITIES: '',
    YUANTU_AUTO_COMPACT_TOKENS: '',
    YUANTU_SANDBOX: 'host',
    YUANTU_PROMPT_CACHE: 'off',
  };
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  t.after(async () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  async function run(flags: string[] = []) {
    const session = store.create(root);
    const agent = await createAgent(
      store,
      root,
      parseArgs(flags, {}).options,
      async () => false,
      () => undefined,
      () => {},
    );
    const result = await agent.run({ sessionId: session.id, prompt: 'Say hello' });
    assert.equal(result.status, 'completed', result.error);
    const envelope = store.events(session.id).find((event) => event.type === 'context.envelope');
    assert.ok(envelope);
    return envelope.data;
  }
  return { run, outputs, probes: () => probes };
}

test('an undeclared connection discovers its window and output cap before a real model request', async (t) => {
  const f = await fixture(t, {
    data: [{ id: 'synthetic-model', context_length: 128000, max_output_tokens: 4096 }],
  });
  const envelope = await f.run();
  assert.equal(envelope.maxContextTokens, 128000);
  assert.equal(f.outputs[0], 4096);
  await f.run();
  assert.equal(f.probes(), 1, 'a later run reuses the bounded discovery cache');
});

test('manual capacity and output settings win and avoid an automatic catalogue request', async (t) => {
  const f = await fixture(t, {
    data: [{ id: 'synthetic-model', context_length: 128000, max_output_tokens: 4096 }],
  });
  const envelope = await f.run(['--max-context-tokens', '96000', '--max-output-tokens', '2048']);
  assert.equal(envelope.maxContextTokens, 96000);
  assert.equal(f.outputs[0], 2048);
  assert.equal(f.probes(), 0);
});

test('missing catalogue capacity uses a local budget and still completes a request', async (t) => {
  const f = await fixture(t, { data: [{ id: 'synthetic-model' }] });
  const envelope = await f.run();
  assert.equal(envelope.maxContextTokens, 1_000_000);
  assert.equal(f.outputs[0], 256_000);
});

test('a failed catalogue does not prevent a model request or override a manual output cap', async (t) => {
  const f = await fixture(t, { error: 'catalogue unavailable' }, 503);
  const envelope = await f.run(['--max-output-tokens', '2048']);
  assert.equal(envelope.maxContextTokens, 1_000_000);
  assert.equal(f.outputs[0], 2048);
});

test('catalogue discovery times out while reading a stalled body', async (t) => {
  const endpoint = await httpFixture(t, (_body, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write('{"data":[');
  });
  const result = await discoverAutomaticCapacities(
    { baseUrl: endpoint, model: 'm', apiKey: 'fake' },
    { timeoutMs: 50 },
  );
  assert.equal(result.size, 0);
});

test('automatic discovery never follows a redirect with model credentials', async (t) => {
  let redirectedRequests = 0;
  const other = await httpFixture(t, (_body, res) => {
    redirectedRequests++;
    res.end('{}');
  });
  const endpoint = await httpFixture(t, (_body, res) => {
    res.writeHead(307, { location: `${other}/v1/models` });
    res.end();
  });
  const result = await discoverAutomaticCapacities({
    baseUrl: endpoint,
    model: 'm',
    apiKey: 'fake',
  });
  assert.equal(result.size, 0);
  assert.equal(redirectedRequests, 0);
});

test('a catalogue over the byte limit is discarded before trusting its capacities', async (t) => {
  const endpoint = await httpFixture(t, (_body, res) => {
    res.end(
      JSON.stringify({
        data: [{ id: 'm', context_length: 100000 }],
        padding: 'x'.repeat(1024 * 1024),
      }),
    );
  });
  const result = await discoverAutomaticCapacities({
    baseUrl: endpoint,
    model: 'm',
    apiKey: 'fake',
  });
  assert.equal(result.size, 0);
});

test('catalogue caches are isolated by credential and serve sibling models from the same response', async (t) => {
  let probes = 0;
  const endpoint = await httpFixture(t, (_body, res, headers) => {
    probes++;
    res.end(
      JSON.stringify({
        data: [
          { id: 'm', context_length: headers['x-api-key'] === 'first' ? 96000 : 128000 },
          { id: 'sibling', context_length: 48000 },
        ],
      }),
    );
  });
  const first = await discoverAutomaticCapacities({
    baseUrl: endpoint,
    model: 'm',
    apiKey: 'first',
  });
  assert.equal(first.get('m')?.contextWindow, 96000);
  const sibling = await discoverAutomaticCapacities({
    baseUrl: endpoint,
    model: 'sibling',
    apiKey: 'first',
  });
  assert.equal(sibling.get('sibling')?.contextWindow, 48000);
  assert.equal(probes, 1);
  const second = await discoverAutomaticCapacities({
    baseUrl: endpoint,
    model: 'm',
    apiKey: 'second',
  });
  assert.equal(second.get('m')?.contextWindow, 128000);
  assert.equal(probes, 2);
});

test(
  'a real Host can cancel during automatic discovery and admit another run afterwards',
  { timeout: 15000 },
  async (t) => {
    let started!: () => void;
    const probeStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let probes = 0;
    let requests = 0;
    const endpoint = await httpFixture(t, (_body, res, _headers, url) => {
      if (url === '/v1/models') {
        probes++;
        if (probes === 1) {
          started();
          return;
        }
        res.end(JSON.stringify({ data: [{ id: 'fixture', context_length: 96000 }] }));
      } else {
        requests++;
        sendFrames(res, frames('After cancellation'));
      }
    });
    const host = await listeningHost(t, {
      YUANTU_BASE_URL: endpoint,
      YUANTU_MAX_CONTEXT_TOKENS: '',
      YUANTU_MAX_OUTPUT_TOKENS: '',
      YUANTU_MODEL_CAPACITIES: '',
    });
    const { client } = await connectClient(host.port);
    t.after(() => client.stop().catch(() => {}));
    await client.start();
    const session = await client.request('session.create', {});
    const pending = client.request('run.start', { sessionId: session.id, prompt: 'First' }).then(
      (result) => ({ result }),
      (error: unknown) => ({ error }),
    );
    await probeStarted;
    const cancelled = await client.request('run.cancel', { sessionId: session.id });
    assert.equal(cancelled.cancelled, true);
    assert.ok('error' in (await pending));
    assert.equal(requests, 0, 'cancelling discovery cannot start a model request');
    const next = await client.request('run.start', { sessionId: session.id, prompt: 'Next' });
    assert.equal(next.status, 'completed');
    assert.equal(requests, 1);
  },
);

test(
  'manual Host compaction shares the automatically discovered output budget',
  { timeout: 15000 },
  async (t) => {
    const outputs: number[] = [];
    const endpoint = await httpFixture(t, (body, res, _headers, url) => {
      if (url === '/v1/models') {
        res.end(
          JSON.stringify({
            data: [{ id: 'fixture', context_length: 96000, max_output_tokens: 4096 }],
          }),
        );
      } else {
        outputs.push(body.max_tokens as number);
        sendFrames(res, frames('A useful summary or reply.'));
      }
    });
    const host = await listeningHost(t, {
      YUANTU_API_KEY: 'synthetic-compaction-key',
      YUANTU_BASE_URL: endpoint,
      YUANTU_MAX_CONTEXT_TOKENS: '',
      YUANTU_MAX_OUTPUT_TOKENS: '',
      YUANTU_MODEL_CAPACITIES: '',
    });
    const { client } = await connectClient(host.port);
    t.after(() => client.stop().catch(() => {}));
    await client.start();
    const session = await client.request('session.create', {});
    for (const prompt of ['First message', 'Second message']) {
      const result = await client.request('run.start', { sessionId: session.id, prompt });
      assert.equal(result.status, 'completed');
    }
    const compact = await client.request('context.compact', { sessionId: session.id });
    assert.equal(compact.compacted, true);
    assert.equal(outputs.length, 3);
    assert.deepEqual(outputs, [4096, 4096, 4096]);
  },
);
