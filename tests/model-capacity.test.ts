/**
 * Where a window may come from, and in what order.
 *
 * The window is the only ceiling a run has, so each number has to be answerable: the operator declared it, this
 * project ships it for an endpoint it knows, or the endpoint's own catalogue has it. These tests pin the
 * *order* and the *scope* — a declaration always wins, and a shipped entry covers exactly one endpoint and
 * exactly the model ids it names, because an entry that answers for the wrong route is worse than no entry:
 * the run is measured against a number nobody checked, and the failure looks like something else.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  KNOWN_CAPACITY,
  catalogCapacity,
  resolveRouteCapacity,
  type KnownCapacity,
} from '../packages/providers/capacity.ts';
import { declaredCapacity, capacityResolver } from '../apps/shared/runtime.ts';
import { parseArgs, type Options } from '../apps/shared/args.ts';
import { Agent } from '../packages/core/agent.ts';
import { HookRegistry, ToolRegistry } from '../packages/tools/registry.ts';
import type { PreStepContext } from '../packages/tools/registry.ts';
import { SessionStore } from '../packages/storage/sqlite.ts';
import type { AgentEvent } from '../packages/protocol/index.ts';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ProviderConfig } from '../packages/providers/config.ts';

const route = (over: Partial<ProviderConfig> = {}): ProviderConfig => ({
  apiKey: 'secret',
  model: 'deepseek-v4-flash',
  baseUrl: 'https://api.deepseek.com/anthropic',
  ...over,
});
/** A run's options as the entry point builds them, plus whatever the case under test adds. */
const runOptions = (over: Partial<Options> = {}): Options => ({
  ...parseArgs([], {}).options,
  ...over,
});
/** What the map held before this suite touched it, so a case can always put the process back. */
const inheritedRouteCapacities = process.env.YUANTU_MODEL_CAPACITIES;
/**
 * Declare the endpoint's other models the way the desktop does, for one case.
 *
 * The resolver reads the declaration from the process environment like every other one, so a case that sets it
 * has to put it back — tests in this file share a process, and a leaked map would answer for the next case's
 * models.
 */
function declareRoutes(t: test.TestContext, routes: string): void {
  process.env.YUANTU_MODEL_CAPACITIES = routes;
  t.after(() => {
    if (inheritedRouteCapacities === undefined) delete process.env.YUANTU_MODEL_CAPACITIES;
    else process.env.YUANTU_MODEL_CAPACITIES = inheritedRouteCapacities;
  });
}

test('a declaration wins over the shipped catalogue, and says so', () => {
  const declared = resolveRouteCapacity({
    model: 'deepseek-v4-flash',
    baseUrl: 'https://api.deepseek.com/anthropic',
    declared: { contextWindow: 200_000, maxOutputTokens: 8_192 },
  });
  assert.deepEqual(declared, {
    contextWindow: 200_000,
    maxOutputTokens: 8_192,
    source: 'declared',
  });
  // The catalogue's own output cap is not silently adopted along with a declared window: the two numbers are
  // separate declarations, and the caller's default applies to the one nobody declared.
  assert.deepEqual(
    resolveRouteCapacity({
      model: 'deepseek-v4-flash',
      baseUrl: 'https://api.deepseek.com/anthropic',
      declared: { contextWindow: 200_000 },
    }),
    { contextWindow: 200_000, source: 'declared' },
  );
});

test('a shipped entry answers only for the endpoint and model family it names', () => {
  const shipped = resolveRouteCapacity({
    model: 'deepseek-v4-flash',
    baseUrl: 'https://api.deepseek.com/anthropic',
  });
  assert.equal(shipped?.source, 'catalog');
  assert.equal(shipped?.contextWindow, 1_000_000);
  // The endpoint's published maximum, not this project's old protocol default: 384K, checked against its
  // Models & Pricing page (see the entry's note). A cap that is too small silently truncates answers.
  assert.equal(shipped?.maxOutputTokens, 384_000);

  for (const input of [
    // A different host that happens to serve a similarly named model.
    { model: 'deepseek-v4-flash', baseUrl: 'https://gateway.example/v1' },
    // The right host, a model family the entry does not cover.
    { model: 'gpt-4.1', baseUrl: 'https://api.deepseek.com' },
    // A base URL this project cannot parse is not an invitation to guess.
    { model: 'deepseek-v4-flash', baseUrl: 'not a url' },
    // No endpoint at all.
    { model: 'deepseek-v4-flash' },
  ])
    assert.equal(resolveRouteCapacity(input), undefined, JSON.stringify(input));
});

test('the shipped entry list is small, documented, and every entry carries its evidence', () => {
  /**
   * This is the point of the module rather than a formality: an entry is a claim about somebody else's
   * endpoint. One that arrives without a note — or with a model prefix wide enough to cover models it was not
   * checked against — is the guess this project removed from its defaults.
   */
  assert.ok(KNOWN_CAPACITY.length > 0, 'the list exists to be used, or the mechanism is dead code');
  for (const entry of KNOWN_CAPACITY) {
    assert.ok(entry.note.trim().length > 0, `${entry.host} needs a note`);
    assert.ok(Number.isSafeInteger(entry.contextWindow) && entry.contextWindow > 0);
    assert.ok(entry.host.includes('.'), `${entry.host} must be a host name`);
    if (entry.modelPrefix !== undefined)
      assert.equal(entry.modelPrefix, entry.modelPrefix.toLowerCase());
  }
});

test('an injected catalogue is what the resolver consults, so the order is testable', () => {
  const catalog: KnownCapacity[] = [
    { host: 'gateway.example', modelPrefix: 'big', contextWindow: 32_000, note: 'fixture' },
  ];
  const resolved = resolveRouteCapacity({
    model: 'big-1',
    baseUrl: 'https://gateway.example/v1',
    catalog,
  });
  assert.deepEqual(resolved, { contextWindow: 32_000, source: 'catalog' });
  assert.equal(
    resolveRouteCapacity({ model: 'small-1', baseUrl: 'https://gateway.example/v1', catalog }),
    undefined,
  );
  assert.equal(
    catalogCapacity('https://gateway.example/v1', 'big-1', catalog)?.contextWindow,
    32_000,
  );
  // The host is matched, not the URL text: a path or port difference is the same endpoint.
  assert.equal(
    catalogCapacity('https://gateway.example:8443/other', 'big-2', catalog)?.contextWindow,
    32_000,
  );
});

test('a run on an endpoint this project ships numbers for needs no declaration', () => {
  const window = declaredCapacity(
    runOptions(),
    route({ model: 'deepseek-v4-flash', baseUrl: 'https://api.deepseek.com/anthropic' }),
  );
  assert.equal(window, 1_000_000);
  // A declaration still wins, which is what makes the shipped entry a convenience rather than an override.
  assert.equal(
    declaredCapacity(
      runOptions({ maxContextTokens: 64_000 }),
      route({ model: 'deepseek-v4-flash', baseUrl: 'https://api.deepseek.com/anthropic' }),
    ),
    64_000,
  );
});

test('a round re-aimed at another model is measured against that model’s window', async (t) => {
  /**
   * The window belongs to the route, not to the run: a pre-step policy that moves a round onto another model
   * moves it onto that model's ceiling too. Without this, a run declared at 40K would keep compacting a 1M
   * model as if it were small, and a run declared at 1M would let a 128K model be overrun.
   */
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-capacity-'));
  const store = new SessionStore(path.join(root, 'sessions.sqlite'));
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const session = store.create(root);
  const hooks = new HookRegistry();
  hooks.register({
    preStep: (context: PreStepContext) =>
      context.round === 1 ? { model: 'wide-model' } : undefined,
  });
  const tools = new ToolRegistry(hooks);
  let round = 0;
  tools.register({
    name: 'noop',
    description: 'does nothing',
    inputSchema: { type: 'object' },
    async execute() {
      return { content: 'ok', isError: false };
    },
  });
  const events: AgentEvent[] = [];
  const agent = new Agent({
    store,
    provider: {
      async complete() {
        round++;
        return round === 1
          ? {
              text: '',
              finishReason: 'tool_calls',
              toolCalls: [{ id: 'call-1', name: 'noop', arguments: {} }],
              usage: { inputTokens: 10, outputTokens: 5 },
            }
          : {
              text: 'Done',
              toolCalls: [],
              finishReason: 'stop',
              usage: { inputTokens: 10, outputTokens: 5 },
            };
      },
    },
    tools,
    approve: async () => false,
    maxContextTokens: 40_000,
    maxOutputTokens: 1_000,
    // What a host resolves per model: no opinion about this run's own model, 1M for the wide one.
    capacityFor: (model) => (model === 'wide-model' ? { contextWindow: 1_000_000 } : undefined),
    onEvent: (event) => events.push(event),
  });
  const result = await agent.run({ sessionId: session.id, prompt: 'First' });
  assert.equal(result.status, 'completed', result.error);
  const forecasts = events.filter((event) => event.type === 'context.forecast');
  assert.ok(forecasts.length >= 2, `expected two rounds, got ${forecasts.length}`);
  assert.ok(
    Number(forecasts[0]!.data.windowRoom) < 40_000,
    'the first round used the window this run declared',
  );
  assert.ok(
    Number(forecasts[1]!.data.windowRoom) > 900_000,
    `the re-aimed round used the wide model's window, got ${String(forecasts[1]!.data.windowRoom)}`,
  );
});

test('the host resolver answers per model: the declaration for its own, the catalogue for another', () => {
  const options = runOptions({ maxContextTokens: 40_000 });
  const config = route({
    model: 'configured-model',
    baseUrl: 'https://api.deepseek.com/anthropic',
  });
  const resolve = capacityResolver(options, config);
  assert.deepEqual(resolve('configured-model'), { contextWindow: 40_000, source: 'declared' });
  // A declaration is a statement about *this* connection's model, so another model gets the catalogue instead.
  assert.deepEqual(resolve('deepseek-v4-flash'), {
    contextWindow: 1_000_000,
    maxOutputTokens: 384_000,
    source: 'catalog',
  });
  // Neither knows it: no answer, and the round keeps the run's own window rather than inventing one.
  assert.equal(resolve('mystery-model'), undefined);
});

test('a run on any other endpoint still has to declare or discover one', () => {
  assert.throws(
    () =>
      declaredCapacity(
        runOptions(),
        route({ model: 'mystery-model', baseUrl: 'https://gateway.example/v1' }),
      ),
    (error: unknown) =>
      error instanceof Error &&
      /No context window is declared/.test(error.message) &&
      /yuantu-agent models/.test(error.message),
  );
});

test('a saved window for the endpoint’s other models answers for them, one model at a time', (t) => {
  /**
   * The desktop saves a window per model row, so the honest question is not "what did the operator declare for
   * this connection" but "what did the operator declare for *this model*". Without the map, a round re-aimed at
   * a sibling falls through to the catalogue — right for the one endpoint this project ships knowledge about,
   * and no answer at all for every other endpoint, which is where a re-aimed round would silently keep
   * measuring against the run's own window.
   */
  declareRoutes(
    t,
    JSON.stringify({
      'cheap-model': { contextWindow: 64_000, maxOutputTokens: 4_000 },
      'wide-model': { contextWindow: 2_000_000 },
      // A saved number is the operator's, so it also beats the catalogue for a model the catalogue covers.
      'deepseek-v4-flash': { contextWindow: 128_000 },
    }),
  );
  const config = route({ model: 'configured-model', baseUrl: 'https://gateway.example/v1' });
  const resolve = capacityResolver(runOptions({ maxContextTokens: 40_000 }), config);
  assert.deepEqual(resolve('configured-model'), { contextWindow: 40_000, source: 'declared' });
  assert.deepEqual(resolve('cheap-model'), {
    contextWindow: 64_000,
    maxOutputTokens: 4_000,
    source: 'declared',
  });
  assert.deepEqual(resolve('wide-model'), { contextWindow: 2_000_000, source: 'declared' });
  assert.deepEqual(resolve('deepseek-v4-flash'), { contextWindow: 128_000, source: 'declared' });
  // A sibling the map says nothing about gets no answer: the run's own declaration is not stretched over it.
  assert.equal(resolve('mystery-model'), undefined);
  // The map is also what the *starting* model may be declared by, so the two readers agree about one route.
  assert.equal(
    declaredCapacity(
      runOptions(),
      route({ model: 'cheap-model', baseUrl: 'https://gateway.example/v1' }),
    ),
    64_000,
  );
});

test('a map the runtime cannot read is an error, not a declaration dropped in silence', (t) => {
  // Dropping it quietly would leave a re-aimed round measured against this run's own window — the failure the
  // map exists to prevent — and the run would look configured while measuring against a number nobody declared.
  declareRoutes(t, '{"cheap-model": {}}');
  assert.throws(
    () => capacityResolver(runOptions(), route()),
    /no usable contextWindow for "cheap-model"/,
  );
  declareRoutes(t, '{"cheap-model": {"contextWindow": 64000, "maxOutputTokens": 0}}');
  assert.throws(
    () => capacityResolver(runOptions(), route()),
    /no usable maxOutputTokens for "cheap-model"/,
  );
  declareRoutes(t, 'not json');
  assert.throws(() => capacityResolver(runOptions(), route()), /must be a JSON object/);
  // An empty string is "nothing declared", which is not an error: a carrier with no map to send leaves the
  // variable empty rather than absent.
  declareRoutes(t, '   ');
  assert.equal(capacityResolver(runOptions({ maxContextTokens: 40_000 }), route())('x'), undefined);
});
