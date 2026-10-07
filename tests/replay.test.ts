/**
 * The replay seam on its own: what an answer script guarantees, and what it refuses to paper over.
 *
 * The snapshot tests are the ones that use this on a whole turn; these pin the guarantees they rely on — order,
 * consumption, a failure that arrives as the code it names, and a fingerprint that notices a changed request
 * without carrying the prose.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SCRIPTED_USAGE,
  fingerprint,
  parseScript,
  recordingProvider,
  replayProvider,
  scriptLines,
  type ScriptEntry,
  type ScriptedCall,
} from './replay.ts';
import type { ModelRequest, ModelResponse, Provider } from '../packages/protocol/index.ts';
import { RunFailure } from '../packages/protocol/failure.ts';

function request(overrides: Partial<ModelRequest> = {}): {
  request: ModelRequest;
  text: string[];
  reasoning: string[];
} {
  const text: string[] = [];
  const reasoning: string[] = [];
  return {
    text,
    reasoning,
    request: {
      system: 'You are a fixture.',
      messages: [{ role: 'user', content: 'hello' }],
      tools: [{ name: 'read_file', description: 'read', inputSchema: { type: 'object' } }],
      maxOutputTokens: 1024,
      signal: new AbortController().signal,
      onText: (chunk) => text.push(chunk),
      onReasoning: (chunk) => reasoning.push(chunk),
      ...overrides,
    },
  };
}

test('answers are served in order, streaming both channels and reporting the scripted usage', async () => {
  const script: ScriptedCall[] = [
    {
      text: 'first',
      reasoning: 'thinking',
      toolCalls: [{ id: 'call-1', name: 'read_file', arguments: { path: 'a.txt' } }],
      usage: { inputTokens: 3, outputTokens: 4 },
    },
    { text: 'second' },
  ];
  const provider = replayProvider(script);
  const first = request();
  const answer = await provider.complete(first.request);
  assert.equal(answer.text, 'first');
  assert.equal(answer.finishReason, 'tool_calls');
  assert.deepEqual(answer.usage, { inputTokens: 3, outputTokens: 4 });
  assert.deepEqual(first.text, ['first']);
  assert.deepEqual(first.reasoning, ['thinking']);
  assert.equal(answer.toolCalls[0]?.name, 'read_file');
  assert.equal(provider.consumed(), 1);

  const second = request();
  const plain = await provider.complete(second.request);
  assert.equal(plain.text, 'second');
  // A script entry with no tool calls ends the turn: `stop` rather than the `tool_calls` a caller forgot to set.
  assert.equal(plain.finishReason, 'stop');
  assert.deepEqual(plain.usage, SCRIPTED_USAGE);
  assert.deepEqual(second.reasoning, []);
  assert.equal(provider.requests.length, 2);
  provider.assertConsumed();
});

test('a scripted failure arrives as the failure it names, cooldown included', async () => {
  const provider = replayProvider([
    { failure: { code: 'rate-limit', message: 'slow down', retryAfterMs: 5_000 } },
    { text: 'recovered' },
  ]);
  await assert.rejects(
    () => provider.complete(request().request),
    (cause: unknown) => {
      assert.ok(cause instanceof RunFailure);
      assert.equal(cause.code, 'rate-limit');
      assert.equal(cause.retryAfterMs, 5_000);
      return true;
    },
  );
  assert.equal((await provider.complete(request().request)).text, 'recovered');
  provider.assertConsumed();
});

test('an exhausted script fails the run instead of inventing an answer, and leftovers are reported', async () => {
  const provider = replayProvider([{ text: 'only' }]);
  await provider.complete(request().request);
  await assert.rejects(
    () => provider.complete(request().request),
    /replay script exhausted: request 2 has no answer \(script has 1\)/,
  );

  const unconsumed = replayProvider([
    { text: 'a' },
    { when: { messageIncludes: 'context summary' }, text: 'b' },
  ]);
  await unconsumed.complete(request().request);
  assert.throws(
    () => unconsumed.assertConsumed(),
    /not consumed[\s\S]*unused: 1 \(message: context summary\)/,
  );
});

test('an entry states what it answers, and says so in words when the request disagrees', async () => {
  const summary = replayProvider([
    { when: { messageIncludes: 'context summary' }, text: 'summary' },
  ]);
  await assert.rejects(
    () => summary.complete(request().request),
    /replay script entry 1 expected a request whose last message contains "context summary", but this one does not/,
  );

  const roles = replayProvider([
    { when: { messageRoles: ['user', 'assistant', 'tool'] }, text: 'ok' },
  ]);
  await assert.rejects(
    () => roles.complete(request().request),
    /entry 1 expected messages \[user, assistant, tool\] but got \[user\]/,
  );
});

test('a fingerprint keeps the structure and digests a reviewer needs, never the prose', () => {
  const one = fingerprint(request().request);
  const same = fingerprint(request().request);
  assert.deepEqual(one, same);
  assert.deepEqual(one.system, { chars: 'You are a fixture.'.length, digest: one.system.digest });
  assert.deepEqual(one.tools.names, ['read_file']);
  assert.deepEqual(
    one.messages.map((message) => message.role),
    ['user'],
  );
  assert.equal(one.model, null);
  assert.equal(one.maxOutputTokens, 1024);
  assert.ok(
    !JSON.stringify(one).includes('You are a fixture.'),
    'the prose stays out of the fingerprint',
  );

  const changedSystem = fingerprint(request({ system: 'You are a different fixture.' }).request);
  assert.notEqual(changedSystem.system.digest, one.system.digest);
  assert.notEqual(changedSystem.system.chars, one.system.chars);

  const changedMessage = fingerprint(
    request({ messages: [{ role: 'user', content: 'HELLO' }] }).request,
  );
  assert.notEqual(changedMessage.messages[0]!.digest, one.messages[0]!.digest);
  assert.equal(changedMessage.messages[0]!.chars, one.messages[0]!.chars);

  const changedTools = fingerprint(request({ tools: [] }).request);
  assert.deepEqual(changedTools.tools.names, []);
  assert.notEqual(changedTools.tools.digest, one.tools.digest);
});

test('a conversation captured from a live provider replays into the same calls', async () => {
  // Stands in for a real endpoint: it answers from its own state, streams into the request, and knows nothing
  // about scripts. `recordingProvider` is what turns its traffic into one.
  let live = 0;
  const inner: Provider = {
    async complete(modelRequest: ModelRequest): Promise<ModelResponse> {
      live++;
      modelRequest.onText(`answer ${live}`);
      return {
        text: `answer ${live}`,
        toolCalls:
          live === 1 ? [{ id: 'call-1', name: 'read_file', arguments: { path: 'a.txt' } }] : [],
        finishReason: live === 1 ? 'tool_calls' : 'stop',
        usage: { inputTokens: live, outputTokens: live * 2 },
      };
    },
  };
  const entries: ScriptEntry[] = [];
  const recorded = recordingProvider(inner, (entry) => entries.push(entry));
  const firstRequest = request();
  const first = await recorded.complete(firstRequest.request);
  const secondRequest = request({
    messages: [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'answer 1', toolCalls: [] },
    ],
  });
  const second = await recorded.complete(secondRequest.request);
  assert.equal(first.text, 'answer 1');
  assert.equal(second.text, 'answer 2');

  // The recording survives the file format, and the fingerprints it carries are the requests that were really sent.
  const replayed = parseScript(scriptLines(entries));
  assert.equal(replayed.length, 2);
  assert.deepEqual(replayed[0]!.request, fingerprint(firstRequest.request));
  assert.deepEqual(replayed[1]!.request, fingerprint(secondRequest.request));

  const provider = replayProvider(replayed.map((entry) => entry.response));
  const again = request();
  assert.equal((await provider.complete(again.request)).text, 'answer 1');
  assert.equal((await provider.complete(request().request)).text, 'answer 2');
  provider.assertConsumed();
  assert.equal(live, 2, 'replaying does not touch the live provider');
});

test('the script file format refuses what it cannot replay', () => {
  assert.deepEqual(parseScript(''), []);
  assert.deepEqual(parseScript('\n\n'), []);
  assert.throws(() => parseScript('{not json'), /script line 1 is not JSON/);
  assert.throws(
    () => parseScript('{"request":{}}'),
    /script line 1 is not a \{request, response\} entry/,
  );
});
