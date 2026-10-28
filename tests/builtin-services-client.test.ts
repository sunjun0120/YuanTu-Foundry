// tests/builtin-services-client.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { resolveBuiltinService } from '../packages/builtin-services/manifest.ts';
import { ServiceRequester } from '../packages/builtin-services/service-request.ts';
import { AnalysisClient } from '../packages/builtin-services/client.ts';
import { readToolCache, writeToolCache } from '../packages/builtin-services/tool-cache.ts';
import { analysisServiceFixture } from './analysis-service-fixture.ts';
import { tempRoot } from './temp-fixture.ts';

const schema = {
  type: 'object',
  properties: { project_id: { type: 'string' } },
  additionalProperties: false,
};

test('the client lists the backend tools and calls one', async (t) => {
  const { baseUrl, state } = await analysisServiceFixture(t);
  state.tools = [
    { name: 'license_analyze', inputSchema: schema, annotations: { readOnlyHint: true } },
  ];
  state.call = (name, args) => ({
    content: [{ type: 'text', text: `${name}:${JSON.stringify(args)}` }],
  });
  const client = new AnalysisClient(
    new ServiceRequester(resolveBuiltinService({ YUANTU_BUILTIN_SERVICES_URL: baseUrl })!),
  );
  t.after(() => client.close());
  const signal = AbortSignal.timeout(10_000);
  const tools = await client.listTools(signal);
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ['license_analyze'],
  );
  assert.equal(tools[0]?.annotations?.readOnlyHint, true);
  const result = await client.callTool('license_analyze', { project_id: 'p-1' }, signal);
  assert.deepEqual(result.content, [
    { type: 'text', text: 'license_analyze:{"project_id":"p-1"}' },
  ]);
  assert.equal(state.methods.filter((method) => method === 'initialize').length, 1);
});

test('the cache round-trips and is ignored for another address', async (t) => {
  const root = await tempRoot(t);
  const env = { YUANTU_STATE_DIR: root, YUANTU_BUILTIN_SERVICES_URL: 'http://127.0.0.1:4100' };
  const manifest = resolveBuiltinService(env)!;
  assert.equal(readToolCache(manifest, env), undefined);
  await writeToolCache(manifest, [{ name: 'license_analyze', inputSchema: schema }], env);
  assert.deepEqual(
    readToolCache(manifest, env)?.tools.map((tool) => tool.name),
    ['license_analyze'],
  );
  const other = resolveBuiltinService({
    ...env,
    YUANTU_BUILTIN_SERVICES_URL: 'http://127.0.0.1:4200',
  })!;
  assert.equal(readToolCache(other, env), undefined);
});

test('a cache whose timestamp cannot be parsed is ignored rather than trusted forever', async (t) => {
  const root = await tempRoot(t);
  const env = { YUANTU_STATE_DIR: root, YUANTU_BUILTIN_SERVICES_URL: 'http://127.0.0.1:4100' };
  const manifest = resolveBuiltinService(env)!;
  const file = path.join(root, 'builtin-services', `${manifest.id}.tools.json`);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(
    file,
    JSON.stringify({ baseUrl: manifest.baseUrl, savedAt: 'yesterday', tools: [] }),
  );
  assert.equal(readToolCache(manifest, env), undefined);
});

test('a failed call never leaves the connection unusable for the next one', async (t) => {
  const { baseUrl, state } = await analysisServiceFixture(t);
  state.tools = [{ name: 'license_analyze', inputSchema: schema }];
  const client = new AnalysisClient(
    new ServiceRequester(resolveBuiltinService({ YUANTU_BUILTIN_SERVICES_URL: baseUrl })!),
  );
  t.after(() => client.close());
  const signal = AbortSignal.timeout(10_000);
  state.call = () => {
    throw new Error('backend exploded');
  };
  await assert.rejects(client.callTool('license_analyze', {}, signal));
  state.call = () => ({ content: [{ type: 'text', text: 'recovered' }] });
  const result = await client.callTool('license_analyze', {}, signal);
  assert.deepEqual(result.content, [{ type: 'text', text: 'recovered' }]);
  assert.equal(state.methods.filter((method) => method === 'initialize').length, 2);
});

test('cancelling one caller during the shared handshake does not abort the other', async (t) => {
  const { baseUrl, state } = await analysisServiceFixture(t);
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  state.beforeInitialize = async () => {
    entered();
    await barrier;
  };
  const client = new AnalysisClient(
    new ServiceRequester(resolveBuiltinService({ YUANTU_BUILTIN_SERVICES_URL: baseUrl })!),
  );
  t.after(() => client.close());
  const firstAbort = new AbortController();
  const first = client.listTools(firstAbort.signal);
  await started;
  const second = client.listTools(AbortSignal.timeout(10_000));
  firstAbort.abort();
  release();
  await assert.rejects(first);
  assert.deepEqual(await second, []);
});
