import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { capacityResolver, createAgent } from '../apps/shared/runtime.ts';
import { parseArgs } from '../apps/shared/args.ts';
import { catalogCapacity } from '../packages/providers/capacity.ts';
import { resolveCompactionSpec } from '../packages/core/compaction-policy.ts';
import { SessionStore } from '../packages/storage/sqlite.ts';
import { httpFixture, frames, sendFrames } from './http-fixture.ts';
import type { AgentEvent } from '../packages/protocol/index.ts';

const options = () => parseArgs([], {}).options;
const config = {
  apiKey: 'unused',
  model: 'private-default-model',
  baseUrl: 'https://budget.invalid/v1',
};

test('an unknown connection uses the requested unified defaults with valid proactive compaction', () => {
  const capacity = capacityResolver(options(), config)(config.model);
  assert.equal(capacity.contextWindow, 1_000_000);
  assert.equal(capacity.maxOutputTokens, 256_000);
  const spec = resolveCompactionSpec({
    contextWindow: capacity.contextWindow,
    reservedCompletionTokens: capacity.maxOutputTokens!,
  });
  assert.equal(spec.thresholdTokens, 678_464);
});

test('the DeepSeek default request cap is separate from its catalog capability', () => {
  const deepseek = {
    ...config,
    model: 'deepseek-flash',
    baseUrl: 'https://api.deepseek.com/anthropic',
  };
  assert.equal(catalogCapacity(deepseek.baseUrl, deepseek.model)?.maxOutputTokens, 384_000);
  const capacity = capacityResolver(options(), deepseek)(deepseek.model);
  assert.equal(capacity.contextWindow, 1_000_000);
  assert.equal(capacity.maxOutputTokens, 256_000);
  assert.equal(
    capacityResolver({ ...options(), maxOutputTokens: 384_000 }, deepseek)(deepseek.model)
      .maxOutputTokens,
    384_000,
  );
});

test('a manually declared smaller window gets an output budget instead of the kernel legacy fallback', () => {
  const capacity = capacityResolver(options(), { ...config, maxContextTokens: 128_000 })(
    config.model,
  );
  assert.equal(capacity.maxOutputTokens, 32_000);
  assert.doesNotThrow(() =>
    resolveCompactionSpec({
      contextWindow: capacity.contextWindow,
      reservedCompletionTokens: capacity.maxOutputTokens!,
    }),
  );
});

test('discovered capacities bound defaults while explicit active and sibling caps remain authoritative', (t) => {
  const previous = process.env.YUANTU_MODEL_CAPACITIES;
  process.env.YUANTU_MODEL_CAPACITIES = JSON.stringify({
    sibling: { contextWindow: 1_000_000, maxOutputTokens: 400_000 },
  });
  t.after(() => {
    if (previous === undefined) delete process.env.YUANTU_MODEL_CAPACITIES;
    else process.env.YUANTU_MODEL_CAPACITIES = previous;
  });
  const automatic = new Map([
    [
      config.model,
      { contextWindow: 128_000, maxOutputTokens: 4096, source: 'discovered' as const },
    ],
  ]);
  assert.equal(capacityResolver(options(), config, automatic)(config.model).maxOutputTokens, 4096);
  const resolve = capacityResolver({ ...options(), maxOutputTokens: 2048 }, config, automatic);
  assert.equal(resolve(config.model).maxOutputTokens, 2048);
  assert.equal(resolve('sibling').maxOutputTokens, 400_000);
});

for (const { manualWindow, catalog, expectedOutput } of [
  { manualWindow: undefined, catalog: undefined, expectedOutput: 256_000 },
  { manualWindow: 128_000, catalog: undefined, expectedOutput: 32_000 },
  {
    manualWindow: undefined,
    catalog: { data: [{ id: config.model, max_output_tokens: 4096 }] },
    expectedOutput: 4096,
  },
]) {
  test(`a real provider request uses output ${expectedOutput} with window ${manualWindow ?? 'automatic'}`, async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), 'yuantu-default-budget-'));
    const store = new SessionStore(path.join(root, 'sessions.sqlite'));
    let requestOutput: unknown;
    const endpoint = await httpFixture(t, (body, res, _headers, url) => {
      if (url === '/v1/models') {
        res.writeHead(catalog === undefined ? 404 : 200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(catalog ?? {}));
      } else {
        requestOutput = body.max_tokens;
        sendFrames(res, frames('Resolved budget'));
      }
    });
    const env = {
      YUANTU_PROTOCOL: 'anthropic',
      YUANTU_BASE_URL: endpoint,
      YUANTU_MODEL: config.model,
      YUANTU_API_KEY: 'default-test-key',
      YUANTU_MAX_CONTEXT_TOKENS: manualWindow?.toString() ?? '',
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
    const session = store.create(root);
    const forecasts: AgentEvent[] = [];
    const agent = await createAgent(
      store,
      root,
      options(),
      async () => false,
      () => undefined,
      (event) => {
        if (event.type === 'context.forecast') forecasts.push(event);
      },
    );
    const result = await agent.run({ sessionId: session.id, prompt: 'Say hello' });
    assert.equal(result.status, 'completed', result.error);
    assert.equal(requestOutput, expectedOutput);
    const events = store.events(session.id);
    const envelope = events.find((event) => event.type === 'context.envelope');
    assert.equal(envelope?.data.maxContextTokens, manualWindow ?? 1_000_000);
    const forecast = forecasts[0];
    assert.ok(forecast);
    assert.equal(forecast.data.policyProblem, undefined);
  });
}
