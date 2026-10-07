import test from 'node:test';
import assert from 'node:assert/strict';
import { AnthropicProvider } from '../packages/providers/anthropic.ts';
import { readConfig } from '../packages/providers/config.ts';
import type { ModelRequest, Provider } from '../packages/protocol/index.ts';
import { RunFailure, failureCodeOf } from '../packages/protocol/failure.ts';
import { httpFixture, sendFrames, frames } from './http-fixture.ts';
import { OpenAIProvider } from '../packages/providers/openai.ts';
import { ResponsesProvider } from '../packages/providers/responses.ts';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AgentHostClient } from '../packages/client/host-client.ts';
import { SessionController } from '../packages/client/session-controller.ts';
import type { MessageDelta, SessionSnapshot } from '../packages/client/session-controller.ts';
import { projectRoot } from './process-fixture.ts';
import { createProvider, registerProvider } from '../packages/providers/index.ts';
import { cacheFields } from '../packages/providers/cache.ts';
import type { ProviderConfig } from '../packages/providers/config.ts';
import {
  PROMPT_CACHE_ALIASES,
  PROMPT_CACHE_MODES,
  routeSupports,
} from '../packages/protocol/cache-modes.ts';
import type { PromptCacheMode } from '../packages/protocol/cache-modes.ts';
import {
  ENVIRONMENT,
  defaultPromptCacheMode,
  promptCacheMode,
} from '../packages/protocol/settings.ts';
import { validateImages } from '../packages/protocol/images.ts';

// ---- merged from provider.test.ts ----

function request(): ModelRequest {
  return {
    system: 'You are YuanTu',
    messages: [{ role: 'user', content: 'Hi' }],
    tools: [],
    maxOutputTokens: 100,
    signal: new AbortController().signal,
    onText: () => {},
  };
}
test('provider HTTP diagnostics preserve safe endpoint reasons and redact configured credentials', async (t) => {
  for (const ProviderClass of [OpenAIProvider, AnthropicProvider, ResponsesProvider]) {
    const secret = 'opaque-fixture-secret';
    const url = await httpFixture(t, (_body, res) => {
      res.writeHead(400, {
        'content-type': 'application/json',
        'x-request-id': 'fixture-request',
        'retry-after': '2',
      });
      res.end(
        JSON.stringify({
          error: {
            message: `Insufficient tool messages. Credential ${secret}. Bearer other-token.\u0000`,
          },
        }),
      );
    });
    await assert.rejects(
      new ProviderClass({ apiKey: secret, model: 'fixture', baseUrl: url }).complete(request()),
      (error: unknown) => {
        assert.ok(error instanceof RunFailure);
        assert.match(error.message, /Insufficient tool messages/);
        assert.ok(!error.message.includes(secret));
        assert.ok(!error.message.includes('other-token'));
        assert.ok(!error.message.includes('\u0000'));
        assert.equal(error.httpStatus, 400);
        assert.equal(error.requestId, 'fixture-request');
        assert.equal(error.retryAfterMs, 2000);
        return true;
      },
    );
  }
});

test('a prompt-cache write is reported separately from the input total it belongs to', async (t) => {
  // Anthropic reports `input_tokens` plus cache creation and cache read, all three billed; the two cache
  // numbers are *parts* of the total. Keeping them apart is what lets a reader answer "is the cache paying
  // for itself?" — a write is expensive and the next call's read is what it buys.
  const url = await httpFixture(t, (_body, res) => {
    const events = frames('Done');
    const start = events[0]!.message as { usage: Record<string, number> };
    start.usage = {
      input_tokens: 100,
      output_tokens: 0,
      cache_creation_input_tokens: 700,
      cache_read_input_tokens: 200,
    };
    sendFrames(res, events);
  });
  const provider = new AnthropicProvider({ apiKey: 'test', model: 'fixture-model', baseUrl: url });
  const result = await provider.complete(request());
  assert.deepEqual(result.usage, {
    inputTokens: 1000,
    outputTokens: 10,
    cachedInputTokens: 200,
    cacheWriteInputTokens: 700,
  });
  // A response that reports no cache detail is not claiming a write of zero.
  const plain = await (async () => {
    const plainUrl = await httpFixture(t, (_body, res) => sendFrames(res, frames('Done')));
    return new AnthropicProvider({
      apiKey: 'test',
      model: 'fixture-model',
      baseUrl: plainUrl,
    }).complete(request());
  })();
  assert.equal(plain.usage.cacheWriteInputTokens, undefined);
  assert.equal(plain.usage.cachedInputTokens, undefined);
});
test('adapter assembles fragmented tool JSON and unicode text before returning a call', async (t) => {
  const url = await httpFixture(t, (body, res, headers) => {
    assert.equal(headers['x-api-key'], 'test-secret');
    assert.equal(body.stream, true);
    assert.equal(body.model, 'fixture-model');
    sendFrames(
      res,
      frames('你好', [{ id: 'call-1', name: 'read_file', input: { path: '你好.ts' } }]),
    );
  });
  const provider = new AnthropicProvider({
    apiKey: 'test-secret',
    model: 'fixture-model',
    baseUrl: url,
  });
  let deltas = '';
  const result = await provider.complete({
    ...request(),
    onText: (text) => {
      deltas += text;
    },
  });
  assert.equal(deltas, '你好');
  assert.equal(result.text, '你好');
  assert.deepEqual(result.toolCalls, [
    { id: 'call-1', name: 'read_file', arguments: { path: '你好.ts' } },
  ]);
  assert.deepEqual(result.usage, { inputTokens: 20, outputTokens: 10 });
});
test('adapter serializes matching tool results and user followup into legal content blocks', async (t) => {
  const url = await httpFixture(t, (body, res) => {
    assert.equal(body.messages[1].content[1].id, 'call-1');
    assert.equal(body.messages[2].content[0].tool_use_id, 'call-1');
    assert.equal(body.messages[2].content[0].is_error, true);
    assert.equal(body.messages[2].content[1].text, 'continue');
    sendFrames(res, frames('Done'));
  });
  const provider = new AnthropicProvider({ apiKey: 'test', model: 'fixture-model', baseUrl: url });
  const messages: ModelRequest['messages'] = [
    { role: 'user', content: 'read' },
    {
      role: 'assistant',
      content: 'Reading',
      toolCalls: [{ id: 'call-1', name: 'read_file', arguments: { path: 'a' } }],
    },
    { role: 'tool', toolCallId: 'call-1', content: 'not found', isError: true },
    { role: 'user', content: 'continue' },
  ];
  assert.equal((await provider.complete({ ...request(), messages })).finishReason, 'stop');
});
test('truncated stream and malformed arguments reject instead of returning executable tools', async (t) => {
  let attempt = 0;
  const url = await httpFixture(t, (_, res) => {
    const events = frames('', [{ id: 'c', name: 'read_file', input: { path: 'a' } }]);
    if (attempt++ === 0) events.pop();
    else {
      const event = events.find((e) => e.type === 'content_block_delta')!;
      (event.delta as any).partial_json = 'not json';
    }
    sendFrames(res, events);
  });
  const provider = new AnthropicProvider({ apiKey: 'test', model: 'fixture-model', baseUrl: url });
  await assert.rejects(provider.complete(request()), /incomplete|terminal/i);
  await assert.rejects(provider.complete(request()), /JSON|argument/i);
});
test('HTTP errors never reflect request credentials or arbitrary response bodies', async (t) => {
  const url = await httpFixture(t, (_, res) => {
    res.writeHead(401);
    res.end('secret test-key should not appear');
  });
  const provider = new AnthropicProvider({
    apiKey: 'test-key',
    model: 'fixture-model',
    baseUrl: url,
  });
  await assert.rejects(provider.complete(request()), (error) => {
    assert.match(String(error), /401/);
    assert.doesNotMatch(String(error), /test-key/);
    return true;
  });
});
test('abort closes an active streaming request', async (t) => {
  let opened!: () => void, closed!: () => void;
  const ready = new Promise<void>((resolve) => {
    opened = resolve;
  });
  const disconnected = new Promise<void>((resolve) => {
    closed = resolve;
  });
  const url = await httpFixture(t, (_, res) => {
    res.on('close', closed);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(': ping\n\n');
    opened();
  });
  const provider = new AnthropicProvider({ apiKey: 'test', model: 'fixture-model', baseUrl: url });
  const controller = new AbortController();
  const result = provider.complete({ ...request(), signal: controller.signal });
  await ready;
  controller.abort();
  await assert.rejects(result, /abort/i);
  await disconnected;
});
test('config reads env without persisting credentials and rejects insecure remote endpoints', () => {
  const config = readConfig({ YUANTU_MODEL: 'chosen-model', ANTHROPIC_API_KEY: 'secret' });
  assert.equal(config.model, 'chosen-model');
  assert.equal(config.apiKey, 'secret');
  assert.throws(() => readConfig({ YUANTU_MODEL: 'a' }), /API_KEY/);
  assert.throws(
    () => new AnthropicProvider({ apiKey: 'a', model: 'b', baseUrl: 'http://remote.example' }),
    /HTTPS/,
  );
  assert.throws(
    () =>
      new AnthropicProvider({ apiKey: 'a', model: 'b', baseUrl: 'https://user:pass@example.com' }),
    /credentials/i,
  );
});

// ---- merged from provider-retry.test.ts ----
//
// One attempt per call.
//
// The adapter used to carry its own retry loop; it is gone (`packages/providers/http.ts:76`) because that loop
// could only see a status *before* the stream started, left no record, and lost its count with the process.
// Re-sending a round now happens at the step boundary, where the same decision also covers a stream that broke
// mid-flight, the count is read back from the log, and Stop interrupts the backoff too (`tests/retry.test.ts`
// covers that policy). What the transport still owes its caller is one attempt, a failure named by code, and
// the endpoint's own cooldown when it sent one.

function request2(signal = new AbortController().signal): ModelRequest {
  return {
    system: 'YuanTu',
    messages: [{ role: 'user', content: 'hello' }],
    tools: [],
    maxOutputTokens: 100,
    signal,
    onText: () => {},
  };
}
for (const Adapter of [AnthropicProvider, OpenAIProvider]) {
  test(
    Adapter.name + ' sends one request per call and carries the endpoint cooldown',
    async (t) => {
      let calls = 0,
        text = '';
      const url = await httpFixture(t, (_, res) => {
        calls++;
        res.writeHead(503, { 'retry-after': '2' });
        res.end('private server body');
      });
      const started = Date.now();
      const failure: unknown = await new Adapter({ apiKey: 'test', model: 'fixture', baseUrl: url })
        .complete({
          ...request2(),
          onText: (delta) => {
            text += delta;
          },
        })
        .then(
          () => undefined,
          (error: unknown) => error,
        );
      assert.ok(failure instanceof RunFailure, String(failure));
      assert.equal(failure.code, 'server');
      assert.equal(
        failure.retryAfterMs,
        2_000,
        'the cooldown rides on the failure; whether to honor it is the policy decision a layer up',
      );
      assert.match(String(failure), /503/);
      assert.doesNotMatch(String(failure), /private server body/);
      assert.equal(calls, 1, 'the transport does not re-send; the step boundary decides that');
      assert.equal(text, '', 'a rejected attempt must not have shown the user any text');
      assert.ok(Date.now() - started < 2_000, 'the cooldown is reported, not waited out here');
    },
  );
  test(Adapter.name + ' reads an HTTP-date cooldown instead of waiting it out', async (t) => {
    const url = await httpFixture(t, (_, res) => {
      res.writeHead(429, { 'retry-after': new Date(Date.now() + 60_000).toUTCString() });
      res.end();
    });
    const started = Date.now();
    const failure: unknown = await new Adapter({ apiKey: 'test', model: 'fixture', baseUrl: url })
      .complete(request2())
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    assert.ok(failure instanceof RunFailure, String(failure));
    assert.equal(failure.code, 'rate-limit');
    const cooldown = failure.retryAfterMs ?? 0;
    assert.ok(
      cooldown > 55_000 && cooldown <= 60_000,
      `expected ~60s of cooldown, got ${cooldown}`,
    );
    assert.ok(Date.now() - started < 2_000, 'an HTTP-date cooldown is read, not slept through');
  });
  test(
    Adapter.name +
      ' never retries authentication, invalid requests or truncated successful streams',
    async (t) => {
      for (const status of [400, 401, 403, 200]) {
        let calls = 0;
        const url = await httpFixture(t, (_, res) => {
          calls++;
          if (status === 200) {
            res.writeHead(200, { 'content-type': 'text/event-stream' });
            res.end('data: {}\n\n');
          } else {
            res.writeHead(status);
            res.end();
          }
        });
        await assert.rejects(
          new Adapter({ apiKey: 'test', model: 'fixture', baseUrl: url }).complete(request2()),
        );
        assert.equal(calls, 1);
      }
    },
  );
}
test('an unreadable Retry-After is reported as no cooldown rather than guessed at', async (t) => {
  const url = await httpFixture(t, (_, res) => {
    res.writeHead(503, { 'retry-after': 'invalid' });
    res.end();
  });
  const failure: unknown = await new AnthropicProvider({
    apiKey: 'test',
    model: 'fixture',
    baseUrl: url,
  })
    .complete(request2())
    .then(
      () => undefined,
      (error: unknown) => error,
    );
  assert.ok(failure instanceof RunFailure, String(failure));
  assert.equal(failure.code, 'server');
  assert.equal(failure.retryAfterMs, undefined);
});

// ---- merged from cache.test.ts ----

const base = (): ModelRequest => ({
  system: 'You are YuanTu',
  messages: [{ role: 'user', content: 'Hi' }],
  tools: [],
  maxOutputTokens: 100,
  signal: new AbortController().signal,
  onText: () => {},
});
const toolSpecs = [
  { name: 'read_file', description: 'read a file', inputSchema: { type: 'object' } },
  { name: 'write_file', description: 'write a file', inputSchema: { type: 'object' } },
];
const ephemeral = { type: 'ephemeral' };

function openAiStream(res: import('node:http').ServerResponse) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.end(
    [
      'data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: 'ok' } }] }),
      'data: ' +
        JSON.stringify({
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 2 },
        }),
      'data: [DONE]',
    ]
      .map((frame) => frame + '\n\n')
      .join(''),
  );
}
function responsesStream(res: import('node:http').ServerResponse) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.end(
    'data: ' +
      JSON.stringify({
        type: 'response.completed',
        response: {
          status: 'completed',
          output: [
            {
              type: 'message',
              id: 'msg',
              role: 'assistant',
              status: 'completed',
              content: [{ type: 'output_text', text: 'ok', annotations: [] }],
            },
          ],
          usage: { input_tokens: 10, output_tokens: 2 },
        },
      }) +
      '\n\n',
  );
}

test('anthropic caches the stable prefix and the newest message when given a cache key', async (t) => {
  const url = await httpFixture(t, (body, res) => {
    assert.deepEqual(body.system, [
      { type: 'text', text: 'You are YuanTu', cache_control: ephemeral },
    ]);
    assert.equal(body.tools.length, 2);
    assert.equal(body.tools[0].cache_control, undefined, 'only the last tool closes the prefix');
    assert.deepEqual(body.tools[1].cache_control, ephemeral);
    assert.equal(body.tools[0].input_schema.type, 'object', 'tool schema is unchanged');
    assert.deepEqual(body.messages[0].content.at(-1).cache_control, ephemeral);
    sendFrames(res, frames('ok'));
  });
  const provider = new AnthropicProvider({ apiKey: 'k', model: 'm', baseUrl: url });
  const result = await provider.complete({ ...base(), tools: toolSpecs, cacheKey: 'run-prefix' });
  assert.equal(result.finishReason, 'stop');
});

test('anthropic sends the original request shape when no cache key is supplied', async (t) => {
  const url = await httpFixture(t, (body, res) => {
    assert.equal(body.system, 'You are YuanTu', 'system stays a plain string');
    assert.equal(body.tools[1].cache_control, undefined);
    assert.equal(body.messages[0].content[0].cache_control, undefined);
    sendFrames(res, frames('ok'));
  });
  const provider = new AnthropicProvider({ apiKey: 'k', model: 'm', baseUrl: url });
  await provider.complete({ ...base(), tools: toolSpecs });
});

test('YUANTU_PROMPT_CACHE=off disables every cache field even when a key is supplied', async (t) => {
  const url = await httpFixture(t, (body, res) => {
    assert.equal(body.system, 'You are YuanTu');
    assert.equal(body.tools[1].cache_control, undefined);
    assert.equal(body.messages[0].content[0].cache_control, undefined);
    sendFrames(res, frames('ok'));
  });
  const provider = new AnthropicProvider({
    apiKey: 'k',
    model: 'm',
    baseUrl: url,
    promptCache: 'off',
  });
  await provider.complete({ ...base(), tools: toolSpecs, cacheKey: 'run-prefix' });
});

/**
 * The four modes, on a route whose protocol claims block support.
 *
 * `auto` and `blocks` are asserted to produce *the same request*, which is the compatibility claim this whole
 * change rests on: a connection that says nothing gets what it always got. `key-only` is the mode the old
 * boolean could not express — an Anthropic-shaped route that wants no `cache_control` at all, and the assertion
 * that it is byte-identical to `off` here is the point: on this protocol the key has nothing to ride on, and
 * inventing a field for it would be the bug this mode exists to avoid.
 */
test('the cache mode decides which fields an anthropic route gets, and the default is unchanged', async (t) => {
  const seen: Array<{ system: unknown; tool: unknown; message: unknown }> = [];
  const url = await httpFixture(t, (body, res) => {
    seen.push({
      system: body.system,
      tool: body.tools[1].cache_control,
      message: body.messages[0].content.at(-1).cache_control,
    });
    sendFrames(res, frames('ok'));
  });
  const provider = (promptCache?: PromptCacheMode) =>
    new AnthropicProvider({
      apiKey: 'k',
      model: 'm',
      baseUrl: url,
      ...(promptCache ? { promptCache } : {}),
    });
  const request = { ...base(), tools: toolSpecs, cacheKey: 'run-prefix' };
  await provider().complete(request);
  await provider('auto').complete(request);
  await provider('blocks').complete(request);
  await provider('key-only').complete(request);
  await provider('off').complete(request);
  const [bare, auto, blocks, keyOnly, off] = seen;
  assert.ok(bare && auto && blocks && keyOnly && off);
  assert.deepEqual(auto, bare, 'auto is what a connection that says nothing has always sent');
  assert.deepEqual(blocks, auto, 'the explicit spelling of the same policy is the same request');
  assert.notEqual(bare.system, 'You are YuanTu', 'blocks: the system prompt carries a breakpoint');
  const plain = { system: 'You are YuanTu', tool: undefined, message: undefined };
  assert.deepEqual(
    keyOnly,
    plain,
    'key-only sends no breakpoint on a route that has nowhere to put the key',
  );
  assert.deepEqual(off, plain);
});

test('an adapter this build has never heard of sends no cache field unless told which one', async () => {
  /**
   * The half of "the route declares what it supports" that is easy to get wrong, tested through the thing that
   * actually registers a route rather than through the helper alone.
   *
   * A fourth adapter is a name this build has never heard of, and silence is not a declaration: `auto` gives it
   * the request it would have sent with caching switched off, rather than a field its endpoint may reject. The
   * operator who knows the endpoint accepts one still gets it — naming a mode is the whole point of the setting.
   */
  const calls: Array<{ fields: ReturnType<typeof cacheFields> }> = [];
  let seen: ProviderConfig | undefined;
  const fake: Provider = {
    async complete(request) {
      calls.push({ fields: cacheFields(seen!, request.cacheKey, 'acme') });
      return {
        text: 'ok',
        toolCalls: [],
        finishReason: 'stop',
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    },
  };
  registerProvider('acme', (config) => {
    seen = config;
    return fake;
  });
  const request = { ...base(), cacheKey: 'run-prefix' };
  await createProvider({ apiKey: 'k', model: 'm', protocol: 'acme' }).complete(request);
  await createProvider({
    apiKey: 'k',
    model: 'm',
    protocol: 'acme',
    promptCache: 'blocks',
  }).complete(request);
  assert.deepEqual(calls[0]?.fields, { blocks: false, key: undefined, toolBreakpoint: false });
  assert.deepEqual(calls[1]?.fields, { blocks: true, key: undefined, toolBreakpoint: true });
  assert.equal(
    routeSupports('acme', 'prompt-cache-blocks'),
    false,
    'the declaration itself is what says so',
  );
  assert.equal(routeSupports('acme', 'prompt-cache-key'), false);
  assert.equal(defaultPromptCacheMode('acme'), 'off');
  assert.equal(
    defaultPromptCacheMode('anthropic'),
    'blocks',
    'a built-in is what makes the compatibility claim hold',
  );
  assert.equal(defaultPromptCacheMode('openai'), 'key-only');
});

test('openai chat completions forwards the cache key only when one is supplied', async (t) => {
  const seen: (string | undefined)[] = [];
  const url = await httpFixture(t, (body, res) => {
    seen.push(body.prompt_cache_key);
    openAiStream(res);
  });
  const provider = new OpenAIProvider({ apiKey: 'k', model: 'm', baseUrl: url });
  await provider.complete({ ...base(), cacheKey: 'run-prefix' });
  await provider.complete({ ...base() });
  assert.deepEqual(seen, ['run-prefix', undefined]);
});

test('responses forwards the cache key only when one is supplied', async (t) => {
  const seen: (string | undefined)[] = [];
  const url = await httpFixture(t, (body, res) => {
    seen.push(body.prompt_cache_key);
    assert.equal(body.store, false);
    responsesStream(res);
  });
  const provider = new ResponsesProvider({ apiKey: 'k', model: 'm', baseUrl: url });
  await provider.complete({ ...base(), cacheKey: 'run-prefix' });
  await provider.complete({ ...base() });
  assert.deepEqual(seen, ['run-prefix', undefined]);
});

test('the cache setting takes four modes, keeps the two spellings of its boolean past, and refuses the rest', () => {
  const env = { YUANTU_MODEL: 'm', ANTHROPIC_API_KEY: 'k' };
  const mode = (value: string) => readConfig({ ...env, YUANTU_PROMPT_CACHE: value }).promptCache;
  // A connection that says nothing is `auto`, which is the route's own protocol deciding -- what the boolean's
  // `true` used to mean.
  assert.equal(readConfig(env).promptCache, 'auto');
  assert.equal(readConfig({ ...env, YUANTU_PROMPT_CACHE: '' }).promptCache, 'auto');
  assert.equal(promptCacheMode(undefined), undefined, 'an absent setting is absent, not a default');
  for (const value of ['auto', 'blocks', 'key-only', 'off']) assert.equal(mode(value), value);
  // The aliases: `YUANTU_PROMPT_CACHE` was documented as `0` / `1` and shipped that way, so a deployment that
  // set it must not start failing an environment check because the vocabulary grew.
  assert.equal(mode('0'), 'off');
  assert.equal(mode('false'), 'off');
  assert.equal(mode('1'), 'auto');
  assert.equal(mode('true'), 'auto');
  assert.equal(mode(' OFF '), 'off', 'case and padding are not a configuration error');
  // The two vocabularies, kept apart on purpose: the *parse* answers in modes, and the config stores what it
  // means, so nothing downstream has to know that `0` was ever legal.
  assert.equal(promptCacheMode('0'), 'off');
  assert.equal(promptCacheMode('false'), 'off');
  assert.equal(promptCacheMode('1'), 'auto');
  assert.equal(promptCacheMode('true'), 'auto');
  assert.equal(promptCacheMode(''), undefined, 'an empty value is not set, not a mode');
  assert.equal(promptCacheMode('nonsense'), undefined);
  // The refusal is the settings table's, so the environment check catches the same value at startup -- and it
  // says what it accepts, which is the promise every name in that table makes. The key is named by the caller
  // that reports it (`environmentProblems`), not repeated inside the rule.
  assert.throws(
    () => readConfig({ ...env, YUANTU_PROMPT_CACHE: 'yes' }),
    /must be one of auto, blocks, key-only, off \(or 0 \/ 1 \/ false \/ true\); got "yes"/,
  );
});
test('the settings table names every mode the parser accepts, so the two owners cannot drift', () => {
  /**
   * Why this is a test and not a comment: the table's description is what the README's generated settings table
   * and the CLI's `env` print, and the parser is what decides. A fifth mode added to one of them and not the
   * other would be documented-but-refused (or accepted-but-invisible), and nothing else would notice.
   */
  const description = ENVIRONMENT.YUANTU_PROMPT_CACHE.description;
  for (const value of PROMPT_CACHE_MODES) assert.ok(description.includes(value), value);
  for (const alias of Object.keys(PROMPT_CACHE_ALIASES))
    assert.ok(description.includes(alias), `the alias ${alias} is accepted and must be documented`);
});

test('only a route that declares block support gets blocks by default', () => {
  /**
   * The rule that makes the compatibility claim hold, and the one a gateway breaks on.
   *
   * Two halves, and the difference between them is why there are four modes rather than a switch: `auto` asks the
   * route (silence is not a declaration, so an unknown name gets nothing), while an explicit mode is obeyed —
   * the operator is the one who knows what their endpoint accepts.
   */
  assert.deepEqual(cacheFields({ apiKey: 'k', model: 'm', promptCache: 'blocks' }, 'key'), {
    blocks: true,
    key: undefined,
    toolBreakpoint: true,
  });
  // `auto` on the same route is the same decision, which is what keeps the default behaviour unchanged.
  assert.deepEqual(cacheFields({ apiKey: 'k', model: 'm', promptCache: 'auto' }, 'key'), {
    blocks: true,
    key: undefined,
    toolBreakpoint: true,
  });
  // An OpenAI-shaped route caches by key and has no blocks to put a breakpoint in.
  assert.deepEqual(
    cacheFields({ apiKey: 'k', model: 'm', protocol: 'openai', promptCache: 'auto' }, 'key'),
    { blocks: false, key: 'key', toolBreakpoint: false },
  );
  // `auto` on a route whose protocol declares nothing sends nothing -- not even the key.
  assert.deepEqual(
    cacheFields({ apiKey: 'k', model: 'm', protocol: 'acme', promptCache: 'auto' }, 'key'),
    { blocks: false, key: undefined, toolBreakpoint: false },
  );
  // ...but the operator who says `key-only` there gets the key, and the one who says `blocks` gets breakpoints.
  assert.deepEqual(
    cacheFields({ apiKey: 'k', model: 'm', protocol: 'acme', promptCache: 'key-only' }, 'key'),
    { blocks: false, key: 'key', toolBreakpoint: false },
  );
  assert.deepEqual(
    cacheFields({ apiKey: 'k', model: 'm', protocol: 'acme', promptCache: 'blocks' }, 'key'),
    { blocks: true, key: undefined, toolBreakpoint: true },
  );
  // An explicit `key-only` is obeyed even where no protocol declared the key: the operator is the one who knows
  // the endpoint accepts it, and "we do not recognise this route" is not a reason to drop an instruction.
  assert.deepEqual(cacheFields({ apiKey: 'k', model: 'm', promptCache: 'key-only' }, 'key'), {
    blocks: false,
    key: 'key',
    toolBreakpoint: false,
  });
  assert.deepEqual(
    cacheFields({ apiKey: 'k', model: 'm', protocol: 'acme', promptCache: 'key-only' }, 'key'),
    { blocks: false, key: 'key', toolBreakpoint: false },
  );
  // No cache key, no cache: the key is what makes a prefix identifiable, so a one-off request pays no write.
  assert.deepEqual(cacheFields({ apiKey: 'k', model: 'm', promptCache: 'auto' }, undefined), {
    blocks: false,
    key: undefined,
    toolBreakpoint: false,
  });
  /**
   * The two identifiers are alternatives, and the *mode* is what picks between them.
   *
   * `auto` on an OpenAI-shaped route resolves to key-only, which is how that connection keeps the request it has
   * always sent. An explicit `blocks` is the operator asking for breakpoints instead, on any route, so the key
   * goes: sending both would be this code choosing a combination nobody asked for.
   */
  assert.deepEqual(
    cacheFields({ apiKey: 'k', model: 'm', protocol: 'openai', promptCache: 'blocks' }, 'key'),
    { blocks: true, key: undefined, toolBreakpoint: true },
  );
  assert.deepEqual(
    cacheFields({ apiKey: 'k', model: 'm', protocol: 'openai', promptCache: 'auto' }, 'key'),
    { blocks: false, key: 'key', toolBreakpoint: false },
  );
});

// ---- merged from responses.test.ts ----

const request3 = (): ModelRequest => ({
  system: 'system',
  messages: [{ role: 'user', content: 'hello' }],
  tools: [],
  maxOutputTokens: 128,
  signal: new AbortController().signal,
  onText: () => {},
});
const message = {
  type: 'message',
  id: 'msg',
  role: 'assistant',
  status: 'completed',
  content: [{ type: 'output_text', text: 'Hello', annotations: [] }],
};
const terminal = (output: unknown[], status = 'completed') => ({
  type: 'response.' + status,
  response: {
    status,
    output,
    usage: { input_tokens: 10, output_tokens: 5 },
    ...(status === 'incomplete' ? { incomplete_details: { reason: 'max_output_tokens' } } : {}),
  },
});
function events(res: import('node:http').ServerResponse, values: unknown[]) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.end(values.map((event) => 'data: ' + JSON.stringify(event) + '\n\n').join(''));
}
test('Responses streams text and sends native functions with stateless continuation', async (t) => {
  let calls = 0;
  const reasoning = { id: 'rs', type: 'reasoning', summary: [], encrypted_content: 'opaque-test' };
  const fn = {
    id: 'fc',
    type: 'function_call',
    call_id: 'call1',
    name: 'read_file',
    arguments: '{"path":"a.txt"}',
    status: 'completed',
  };
  const url = await httpFixture(t, (body, res) => {
    assert.equal(body.store, false);
    assert.equal(body.stream, true);
    assert.deepEqual(body.include, ['reasoning.encrypted_content']);
    assert.equal(body.tools[0].strict, false);
    assert.equal(body.tools[0].name, 'read_file');
    if (calls++ === 0)
      events(res, [
        { type: 'response.output_text.delta', delta: 'Hel' },
        { type: 'response.output_text.delta', delta: 'lo' },
        terminal([reasoning, message, fn]),
      ]);
    else {
      assert.deepEqual(body.input.slice(1, 4), [reasoning, message, fn]);
      assert.equal(body.input[4].type, 'function_call_output');
      events(res, [terminal([message])]);
    }
  });
  const provider = new ResponsesProvider({ apiKey: 'fixture', model: 'fixture', baseUrl: url });
  let text = '';
  const input = {
    ...request3(),
    tools: [
      {
        name: 'read_file',
        description: 'read',
        inputSchema: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
        },
      },
    ],
    onText: (part: string) => {
      text += part;
    },
  };
  const result = await provider.complete(input);
  assert.equal(text, 'Hello');
  assert.equal(result.finishReason, 'tool_calls');
  assert.deepEqual(result.toolCalls, [
    { id: 'call1', name: 'read_file', arguments: { path: 'a.txt' } },
  ]);
  await provider.complete({
    ...input,
    messages: [
      ...input.messages,
      {
        role: 'assistant',
        content: result.text,
        toolCalls: result.toolCalls,
        providerState: result.providerState,
      },
      { role: 'tool', toolCallId: 'call1', content: 'a', isError: false },
    ],
  });
});
for (const mode of ['missing', 'failed', 'usage', 'incomplete', 'invalid-json'])
  test('Responses handles ' + mode + ' without partial tool execution', async (t) => {
    const url = await httpFixture(t, (_body, res) => {
      const call = {
        type: 'function_call',
        id: 'fc',
        call_id: 'call',
        name: 'write_file',
        arguments: mode === 'invalid-json' ? '{broken' : '{}',
      };
      if (mode === 'missing')
        events(res, [{ type: 'response.output_text.delta', delta: 'partial' }]);
      else if (mode === 'failed')
        events(res, [
          {
            type: 'response.failed',
            response: { status: 'failed', error: { message: 'private raw server error' } },
          },
        ]);
      else {
        const event = terminal([call], mode === 'incomplete' ? 'incomplete' : 'completed');
        if (mode === 'usage') delete (event.response as Record<string, unknown>).usage;
        events(res, [event]);
      }
    });
    const provider = new ResponsesProvider({ apiKey: 'fixture', model: 'fixture', baseUrl: url });
    if (mode === 'incomplete') {
      const result = await provider.complete(request3());
      assert.equal(result.finishReason, 'length');
      assert.deepEqual(result.toolCalls, []);
    } else {
      const error = await provider.complete(request3()).then(
        () => undefined,
        (cause: unknown) => cause,
      );
      assert.ok(error instanceof Error && !error.message.includes('private raw'));
      /**
       * A stream that stops before its terminal event is a *transport* failure, and it has to say so: the step
       * boundary only re-sends a failure it can classify, so an anonymous error here makes a truncated stream
       * unretryable. Only this mode truncates; the others fail for reasons of their own.
       */
      if (mode === 'missing') assert.equal(failureCodeOf(error), 'transport');
    }
  });

test('Responses encodes images and excludes opaque state from another endpoint or model', async (t) => {
  const png =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/5u8AAAAASUVORK5CYII=';
  const url = await httpFixture(t, (body, res, _headers, route) => {
    assert.equal(route, '/v1/responses');
    assert.equal(body.input[0].content[1].type, 'input_image');
    assert.equal(body.input[0].content[1].image_url, 'data:image/png;base64,' + png);
    assert.ok(!JSON.stringify(body).includes('foreign-opaque'));
    events(res, [terminal([message])]);
  });
  const provider = new ResponsesProvider({ apiKey: 'fixture', model: 'fixture', baseUrl: url });
  for (const [model, endpoint] of [
    ['other', url + '/v1/responses'],
    ['fixture', 'https://other.example/v1/responses'],
  ]) {
    await provider.complete({
      ...request3(),
      messages: [
        { role: 'user', content: 'image', images: [{ mimeType: 'image/png', data: png }] },
        {
          role: 'assistant',
          content: 'visible',
          toolCalls: [],
          providerState: {
            protocol: 'openai-responses',
            model: model!,
            endpoint: endpoint!,
            output: [{ type: 'reasoning', encrypted_content: 'foreign-opaque' }],
          },
        },
      ],
    });
  }
});

for (const status of ['in_progress', 'incomplete', 'unexpected'])
  test(
    'Responses rejects unfinished tool item ' + status + ' inside completed response',
    async (t) => {
      const url = await httpFixture(t, (_body, res) =>
        events(res, [
          terminal([
            {
              type: 'function_call',
              id: 'fc',
              call_id: 'call',
              name: 'write_file',
              arguments: '{}',
              status,
            },
          ]),
        ]),
      );
      const provider = new ResponsesProvider({ apiKey: 'fixture', model: 'fixture', baseUrl: url });
      await assert.rejects(provider.complete(request3()), /status|unfinished/i);
    },
  );

// ---- merged from streaming-delta.test.ts ----

const TOKENS = 40;

/** One text delta per token, so the per-token cost of the delivery path is observable. */
function streamingEvents(): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = [
    {
      type: 'message_start',
      message: {
        id: 'msg_stream',
        type: 'message',
        role: 'assistant',
        content: [],
        model: 'fixture-model',
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 20, output_tokens: 0 },
      },
    },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  ];
  for (let i = 0; i < TOKENS; i++)
    events.push({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: token(i) },
    });
  events.push({ type: 'content_block_stop', index: 0 });
  events.push({
    type: 'message_delta',
    delta: { stop_reason: 'end_turn', stop_sequence: null },
    usage: { output_tokens: TOKENS },
  });
  events.push({ type: 'message_stop' });
  return events;
}
const token = (index: number) => `t${index} `;
const expectedText = Array.from({ length: TOKENS }, (_, i) => token(i)).join('');

/** A real base64 PNG, padded to ~1MB so an attached image dominates a snapshot's size. */
function largePngBase64(): string {
  const png =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
  const core = png.replace(/=+$/, '');
  const target = 1_400_000;
  assert.ok(core.length < target);
  const padded = core + 'A'.repeat(target - core.length);
  return padded.slice(0, padded.length - (padded.length % 4));
}

test('streamed tokens arrive as incremental deltas, never as full snapshots', async (t) => {
  const url = await httpFixture(t, (_body, res) => sendFrames(res, streamingEvents()));
  const root = await mkdtemp(path.join(tmpdir(), 'yuantu-stream-'));
  const client = new AgentHostClient({
    nodePath: process.execPath,
    hostPath: path.join(projectRoot, 'apps/agent-host/main.ts'),
    workspace: root,
    env: {
      YUANTU_SESSION_TITLES: '0',
      YUANTU_BASE_URL: url,
      YUANTU_MODEL: 'fixture',
      YUANTU_API_KEY: 'test',
      YUANTU_PROTOCOL: 'anthropic',
      // The window is the one ceiling a run will not guess (see `resolveModelCapacity`): a connection that
      // declares none is refused rather than measured against an invented number.
      YUANTU_MAX_CONTEXT_TOKENS: '200000',
    },
  });
  const controller = new SessionController(client);
  t.after(async () => {
    controller.dispose();
    await client.stop();
    await rm(root, { recursive: true, force: true });
  });
  await client.start();
  await controller.create();

  const snapshots: SessionSnapshot[] = [];
  const deltas: MessageDelta[] = [];
  controller.subscribe((state) => snapshots.push(state));
  controller.subscribeDelta((delta) => deltas.push(delta));

  // Attach a hefty image: under the old design every one of these tokens re-cloned and re-sent it.
  const image = { mimeType: 'image/png' as const, data: largePngBase64(), name: 'large.png' };
  const result = await controller.send('stream please', [image]);
  assert.equal(result.status, 'completed');

  // Every token was delivered incrementally, in order, with nothing lost or duplicated.
  assert.equal(deltas.length, TOKENS, `expected one delta per token, saw ${deltas.length}`);
  assert.equal(deltas.map((delta) => delta.text).join(''), expectedText);

  // A delta carries text and an identity — nothing else. An image cannot structurally ride along.
  for (const delta of deltas)
    assert.deepEqual(Object.keys(delta).sort(), ['messageId', 'text'], 'delta must be text-only');

  // The decisive assertion: the number of snapshots carrying live text must not scale with the token
  // count. A structural snapshot taken mid-stream may legitimately carry the text accumulated so far
  // — that is what lets the renderer recover a partial reply — but it must stay O(1). Under the old
  // design the controller published once per token, so this count was TOKENS.
  const streamingSnapshots = snapshots.filter((state) => Boolean(state.liveMessage?.text));
  assert.ok(
    streamingSnapshots.length <= 3,
    `${TOKENS} tokens produced ${streamingSnapshots.length} text-carrying snapshots (of ${snapshots.length})`,
  );
  assert.ok(
    streamingSnapshots.length < TOKENS / 4,
    'snapshot volume must be independent of the token count',
  );

  // Quantify the win: the image lives in snapshots (once per structural change) but is nowhere in
  // the per-token traffic, which is the traffic that used to dominate.
  const snapshotBytes = Math.max(...snapshots.map((state) => JSON.stringify(state).length));
  const deltaBytes = deltas.reduce((total, delta) => total + delta.text.length, 0);
  assert.ok(
    snapshotBytes > 1_000_000,
    `expected a snapshot to carry the image, saw ${snapshotBytes}`,
  );
  assert.ok(deltaBytes < 2000, `streamed text should be small, saw ${deltaBytes}`);
  assert.ok(
    snapshotBytes / deltaBytes > 1000,
    `per-token traffic should be negligible beside a snapshot (${deltaBytes} vs ${snapshotBytes})`,
  );

  // The finished message is still correct in history, so the delta path did not cost us content.
  const assistant = controller.snapshot.messages.filter((message) => message.role === 'assistant');
  assert.equal(assistant.length, 1);
  assert.equal((assistant[0] as { content: string }).content, expectedText);
});

// ---- merged from openai-images.test.ts ----

const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/5u8AAAAASUVORK5CYII=';
const image = { mimeType: 'image/png' as const, data: png, name: 'pixel.png' };
const request4 = (): ModelRequest => ({
  system: 'test',
  messages: [{ role: 'user', content: 'Describe', images: [image] }],
  tools: [],
  maxOutputTokens: 30,
  signal: new AbortController().signal,
  onText: () => {},
});

test('OpenAI publishes tool images after all results, preserving each batch and call identity', async (t) => {
  const url = await httpFixture(t, (body, res) => {
    assert.deepEqual(
      body.messages.map((message: { role: string }) => message.role),
      ['system', 'user', 'assistant', 'tool', 'tool', 'user', 'assistant', 'tool', 'user', 'user'],
    );
    assert.deepEqual(
      body.messages.slice(3, 5).map((message: { tool_call_id: string }) => message.tool_call_id),
      ['a', 'b'],
    );
    const pictures = body.messages[5].content;
    assert.equal(pictures.filter((part: { type: string }) => part.type === 'image_url').length, 2);
    assert.match(JSON.stringify(pictures), /a.*output A.*b.*output B/);
    assert.equal(
      body.messages[8].content.filter((part: { type: string }) => part.type === 'image_url').length,
      1,
    );
    assert.match(JSON.stringify(body.messages[8].content), /c.*output C/);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(
      'data: {"choices":[{"index":0,"delta":{"content":"OK"},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":1}}\n\ndata: [DONE]\n\n',
    );
  });
  const input = request4();
  input.messages = [
    { role: 'user', content: 'Read fixtures' },
    {
      role: 'assistant',
      content: '',
      toolCalls: ['a', 'b'].map((id) => ({ id, name: 'read_image', arguments: {} })),
    },
    { role: 'tool', toolCallId: 'a', isError: false, content: 'output A', images: [image] },
    { role: 'tool', toolCallId: 'b', isError: false, content: 'output B', images: [image] },
    { role: 'assistant', content: '', toolCalls: [{ id: 'c', name: 'read_image', arguments: {} }] },
    { role: 'tool', toolCallId: 'c', isError: false, content: 'output C', images: [image] },
    { role: 'user', content: 'Next request' },
  ];
  assert.equal(
    (await new OpenAIProvider({ apiKey: 'test', model: 'test', baseUrl: url }).complete(input))
      .text,
    'OK',
  );
});

test('image validation rejects malformed or oversized data before provider calls', () => {
  assert.deepEqual(validateImages([image]), [image]);
  assert.throws(() => validateImages([{ ...image, data: 'not-base64' }]), /image|base64/i);
  assert.throws(() => validateImages([{ ...image, mimeType: 'image/jpeg' }]), /image|signature/i);
  assert.throws(() => validateImages(Array(5).fill(image)), /4|images/i);
  assert.throws(
    () => validateImages([{ ...image, data: 'A'.repeat(7_000_000) }]),
    /size|large|5MB/i,
  );
});
test('Anthropic encodes validated images as base64 content blocks', async (t) => {
  const url = await httpFixture(t, (body, res, _headers, requestPath) => {
    assert.equal(requestPath, '/v1/messages');
    assert.equal(body.messages[0].content[1].source.data, png);
    assert.equal(body.messages[0].content[1].source.media_type, 'image/png');
    sendFrames(res, frames('pixel'));
  });
  const provider = createProvider({ apiKey: 'test', model: 'test', baseUrl: url });
  assert.equal((await provider.complete(request4())).text, 'pixel');
});
test('OpenAI streams text and fragmented tool calls with image and usage wire contracts', async (t) => {
  const url = await httpFixture(t, (body, res, headers, requestPath) => {
    assert.equal(requestPath, '/v1/chat/completions');
    assert.equal(headers.authorization, 'Bearer test');
    assert.equal(body.messages[1].content[1].image_url.url, `data:image/png;base64,${png}`);
    assert.equal(body.stream_options.include_usage, true);
    assert.equal(body.messages[2].tool_calls[0].id, 'previous');
    assert.equal(body.messages[3].tool_call_id, 'previous');
    assert.equal(body.messages[3].content, 'Permission denied');
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const value of [
      {
        choices: [
          {
            index: 0,
            delta: {
              content: 'Inspect',
              tool_calls: [
                {
                  index: 0,
                  id: 'call_1',
                  type: 'function',
                  function: { name: 'read_file', arguments: '{"pa' },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      {
        choices: [
          {
            index: 0,
            delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"a.txt"}' } }] },
            finish_reason: 'tool_calls',
          },
        ],
      },
      { choices: [], usage: { prompt_tokens: 12, completion_tokens: 7 } },
    ])
      res.write(`data: ${JSON.stringify(value)}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  const provider = createProvider({
    protocol: 'openai',
    apiKey: 'test',
    model: 'test',
    baseUrl: url,
  });
  const input = request4();
  input.messages.push(
    {
      role: 'assistant',
      content: '',
      toolCalls: [
        { id: 'previous', name: 'write_file', arguments: { path: 'a.txt', content: 'no' } },
      ],
    },
    { role: 'tool', toolCallId: 'previous', content: 'Permission denied', isError: true },
    { role: 'user', content: 'Read only' },
  );
  const result = await provider.complete(input);
  assert.equal(result.text, 'Inspect');
  assert.deepEqual(result.toolCalls, [
    { id: 'call_1', name: 'read_file', arguments: { path: 'a.txt' } },
  ]);
  assert.deepEqual(result.usage, { inputTokens: 12, outputTokens: 7 });
});
test('OpenAI rejects truncated streams instead of executing partial tools', async (t) => {
  const url = await httpFixture(t, (_body, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(
      'data: {"choices":[{"index":0,"delta":{"content":"partial"},"finish_reason":null}]}\n\n',
    );
  });
  await assert.rejects(
    createProvider({ protocol: 'openai', apiKey: 'test', model: 'test', baseUrl: url }).complete(
      request4(),
    ),
    /Incomplete/,
  );
});

test('OpenAI refuses a completed stream without token usage', async (t) => {
  const url = await httpFixture(t, (_body, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(
      'data: {"choices":[{"index":0,"delta":{"content":"done"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
    );
  });
  await assert.rejects(
    createProvider({ protocol: 'openai', apiKey: 'test', model: 'test', baseUrl: url }).complete(
      request4(),
    ),
    /omitted token usage/,
  );
});

test('OpenAI cancellation closes an active streaming response', async (t) => {
  let ready!: () => void;
  const started = new Promise<void>((resolve) => {
    ready = resolve;
  });
  let closed!: () => void;
  const finished = new Promise<void>((resolve) => {
    closed = resolve;
  });
  const url = await httpFixture(t, (_body, res) => {
    res.on('close', closed);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(
      'data: {"choices":[{"index":0,"delta":{"content":"partial"},"finish_reason":null}]}\n\n',
    );
  });
  const aborter = new AbortController();
  const input = request4();
  input.signal = aborter.signal;
  input.onText = ready;
  const result = createProvider({
    protocol: 'openai',
    apiKey: 'test',
    model: 'test',
    baseUrl: url,
  }).complete(input);
  await started;
  aborter.abort();
  await assert.rejects(result, /abort/i);
  await finished;
});

test('OpenAI reports hidden reasoning and partial tool progress without exposing their contents', async (t) => {
  const hidden = 'private thought';
  const partial = '{"path":"abc';
  const url = await httpFixture(t, (_body, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const value of [
      {
        choices: [
          { index: 0, delta: { reasoning_content: hidden, content: '' }, finish_reason: null },
        ],
      },
      {
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call-1',
                  type: 'function',
                  function: { name: 'read_file', arguments: partial },
                },
              ],
            },
            finish_reason: 'length',
          },
        ],
      },
      {
        choices: [],
        usage: {
          prompt_tokens: 9,
          completion_tokens: 100,
          completion_tokens_details: { reasoning_tokens: 95 },
        },
      },
    ])
      res.write('data: ' + JSON.stringify(value) + '\n\n');
    res.end('data: [DONE]\n\n');
  });
  const phases: unknown[] = [];
  const result = await createProvider({
    protocol: 'openai',
    apiKey: 'test',
    model: 'test',
    baseUrl: url,
  }).complete({ ...request4(), onProgress: (progress) => phases.push(progress) });
  assert.equal(result.finishReason, 'length');
  assert.equal(result.text, '');
  assert.deepEqual(result.toolCalls, []);
  assert.deepEqual(result.outputDiagnostics, {
    reasoningTokens: 95,
    reasoningChars: hidden.length,
    toolArgumentChars: partial.length,
    visibleChars: 0,
  });
  assert.deepEqual(
    phases.map((value: any) => value.phase),
    ['reasoning', 'tool_call'],
  );
  assert.doesNotMatch(JSON.stringify(phases), /private thought|read_file|abc/);
});

test('a credential that cannot travel in a header is refused where the connection is built', () => {
  /**
   * The failure this replaces: a key with a line break in it reaches `fetch`, which throws
   * `TypeError: ... is an invalid header value`, and every adapter wraps that in "Model request failed; check
   * endpoint and network configuration" — an operator sent to the network for a defect in their credential, with
   * nothing in the record naming the real cause.
   *
   * All three adapters, because all three are constructed with the same kind of config from the same three places
   * (the environment, the desktop's settings, an embedding host), and all three carry the same generic wrapper.
   * The key below has its line break *inside* it, which is the case that survives: every entry point trims the
   * value it was given, so only an inner one reaches the header.
   */
  const key = 'sk-test\nbroken';
  const configs = [
    { Provider: AnthropicProvider, baseUrl: 'https://example.com' },
    { Provider: OpenAIProvider, baseUrl: 'https://example.com' },
    { Provider: ResponsesProvider, baseUrl: 'https://example.com' },
  ];
  for (const { Provider, baseUrl } of configs) {
    assert.throws(
      () => new Provider({ apiKey: key, model: 'm', baseUrl }),
      (error: unknown) =>
        error instanceof RunFailure &&
        error.code === 'auth' &&
        /control character/.test(error.message) &&
        !/endpoint and network/.test(error.message),
      `${Provider.name} must name the credential rather than the network`,
    );
  }
  // And the run's own vocabulary agrees: this is a failure, not a limit, and a retry gets the same answer.
  assert.equal(failureCodeOf(new RunFailure('auth', 'x')), 'auth');
  /**
   * The boundary, asserted so it is a decision rather than an oversight: a *space* inside a key is allowed. It
   * travels in the header perfectly well, and the endpoint's 401 is then answered with "check credentials", which
   * is the right advice. Only characters a header cannot carry are refused here.
   */
  assert.doesNotThrow(
    () =>
      new AnthropicProvider({ apiKey: 'sk test key', model: 'm', baseUrl: 'https://example.com' }),
  );
  // The environment path reaches the same refusal, which is what makes it one rule rather than three.
  const fromEnv = readConfig({ YUANTU_API_KEY: key, YUANTU_MODEL: 'm' });
  assert.throws(
    () => createProvider(fromEnv),
    (error: unknown) => failureCodeOf(error) === 'auth',
  );
});
