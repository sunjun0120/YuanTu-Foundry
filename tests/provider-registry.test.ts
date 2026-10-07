/**
 * The provider registry: one table that answers "which protocol names exist".
 *
 * `createProvider` used to be a `switch` with its own copy of the protocol list, the settings table had another
 * copy, and a host embedding the kernel could not add an adapter at all without bypassing the entry point. These
 * tests hold the three claims that make the registry worth having: the names come from one declaration, an
 * unknown name is refused with the list, and a registration is what a factory is looked up by.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { BUILTIN_PROTOCOLS } from '../packages/protocol/index.ts';
import { ENVIRONMENT } from '../packages/protocol/settings.ts';
import { AnthropicProvider } from '../packages/providers/anthropic.ts';
import { OpenAIProvider } from '../packages/providers/openai.ts';
import { ResponsesProvider } from '../packages/providers/responses.ts';
import {
  createProvider,
  hasProvider,
  providerProtocols,
  registerProvider,
} from '../packages/providers/index.ts';
import type { ModelResponse, Provider } from '../packages/protocol/index.ts';

const config = { apiKey: 'test', model: 'fixture' };
const answer: ModelResponse = {
  text: '',
  toolCalls: [],
  finishReason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
};

test('every built-in protocol has an adapter, and the settings table names the same set', () => {
  // The single declaration is `BUILTIN_PROTOCOLS`; a protocol added there without a factory would be accepted
  // by `YUANTU_PROTOCOL` and then fail at request time, which is the drift this asserts against.
  for (const protocol of BUILTIN_PROTOCOLS) assert.ok(hasProvider(protocol), protocol);
  assert.deepEqual(
    [...providerProtocols()].sort(),
    [...BUILTIN_PROTOCOLS].sort(),
    'the registry and the declaration agree',
  );
  const spec = ENVIRONMENT.YUANTU_PROTOCOL as { kind: string; values: readonly string[] };
  assert.equal(spec.kind, 'enum');
  assert.deepEqual([...spec.values], [...BUILTIN_PROTOCOLS]);
});

test('the configured protocol decides which adapter answers, and the default is Anthropic', () => {
  assert.ok(
    createProvider(config) instanceof AnthropicProvider,
    'no protocol means the first built-in',
  );
  assert.ok(createProvider({ ...config, protocol: 'anthropic' }) instanceof AnthropicProvider);
  assert.ok(createProvider({ ...config, protocol: 'openai' }) instanceof OpenAIProvider);
  assert.ok(
    createProvider({ ...config, protocol: 'openai-responses' }) instanceof ResponsesProvider,
  );
});

test('an unknown protocol is refused with the list of names that would work', () => {
  assert.throws(
    () => createProvider({ ...config, protocol: 'gemini' }),
    /Unsupported model protocol: gemini\. Known protocols: anthropic, openai, openai-responses/,
  );
});

test('registering a factory is what makes a new protocol usable, and re-registering replaces', () => {
  // Namespaced so this test cannot collide with a built-in or with a parallel test file's registration.
  const fake: Provider = {
    async complete() {
      return answer;
    },
  };
  let built = 0;
  registerProvider('fixture-protocol', () => {
    built++;
    return fake;
  });
  assert.ok(hasProvider('fixture-protocol'));
  assert.equal(createProvider({ ...config, protocol: 'fixture-protocol' }), fake);
  assert.equal(built, 1);
  // Replacement rather than refusal: a test double and a host overriding one protocol are both "same name,
  // different factory".
  const replacement: Provider = {
    async complete() {
      return answer;
    },
  };
  registerProvider('fixture-protocol', () => replacement);
  assert.equal(createProvider({ ...config, protocol: 'fixture-protocol' }), replacement);
  assert.equal(
    providerProtocols().filter((name) => name === 'fixture-protocol').length,
    1,
    'one entry',
  );
  assert.throws(() => registerProvider('  ', () => fake), /must not be empty/);
});
