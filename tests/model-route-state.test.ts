import test from 'node:test';
import assert from 'node:assert/strict';
import { assistantHash, nativeState } from '../packages/providers/native-history.ts';

test('native continuation state from another saved connection is not replayed on the same endpoint and model', () => {
  const assistant = { role: 'assistant' as const, content: 'answer', toolCalls: [] };
  const route = {
    protocol: 'openai' as const,
    model: 'same-model',
    endpoint: 'https://example.test/v1/chat/completions',
    connectionId: 'first',
  };
  const message = {
    ...assistant,
    providerState: { ...route, output: [], messageHash: assistantHash(assistant) },
  };
  assert.ok(nativeState(message, route));
  assert.equal(nativeState(message, { ...route, connectionId: 'second' }), undefined);
});
