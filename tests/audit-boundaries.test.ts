import test from 'node:test';
import assert from 'node:assert/strict';
import { assertPrunePolicy, codePointLength, pruneContent } from '../packages/core/prune.ts';
import { resolveRunLimits, RUN_DEFAULTS } from '../packages/protocol/settings.ts';
import { PRUNE_NOTICE_MAX_CHARS } from '../packages/protocol/prune-policy.ts';
import type { ImageAttachment, ToolContext, ToolResult } from '../packages/protocol/index.ts';
import { ToolRegistry } from '../packages/tools/registry.ts';

const image: ImageAttachment = {
  mimeType: 'image/png',
  data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  name: 'pixel.png',
};
const context = (): ToolContext => ({
  signal: new AbortController().signal,
  approve: async () => true,
});
const call = { id: 'extension-image', name: 'extension_image', arguments: {} };
function imageTool(result: ToolResult): ToolRegistry {
  const registry = new ToolRegistry();
  registry.registerExtension([
    {
      name: call.name,
      description: 'Return third-party image attachments',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      execute: async () => result,
    },
  ]);
  return registry;
}

test('run limit resolution rejects prune head and tail that cannot fit with the marker', () => {
  assert.throws(
    () =>
      resolveRunLimits({
        toolResultPruneThresholdChars: 1_000,
        toolResultPruneHeadChars: 600,
        toolResultPruneTailChars: 400,
      }),
    /Prune policy.*marker.*does not fit/,
  );
});

test('startup reserves the full explanatory notice in a pruned result', () => {
  const policy = { thresholdChars: 1_000, headChars: 600, tailChars: 373 };
  const content = pruneContent('x'.repeat(2_000), policy);
  assert.ok(content && codePointLength(content) > policy.thresholdChars);
  assert.throws(
    () =>
      resolveRunLimits({
        toolResultPruneThresholdChars: policy.thresholdChars,
        toolResultPruneHeadChars: policy.headChars,
        toolResultPruneTailChars: policy.tailChars,
      }),
    /does not fit/,
  );
});

test('run limit resolution accepts the exact prune fit and preserves defaults and individual floors', () => {
  assert.deepEqual(resolveRunLimits(), RUN_DEFAULTS);
  const resolved = resolveRunLimits({
    toolResultPruneThresholdChars: 1_000,
    toolResultPruneHeadChars: 600,
    toolResultPruneTailChars: 400 - PRUNE_NOTICE_MAX_CHARS,
  });
  assert.equal(resolved.toolResultPruneTailChars, 400 - PRUNE_NOTICE_MAX_CHARS);
  const policy = {
    thresholdChars: 1_000,
    headChars: 600,
    tailChars: resolved.toolResultPruneTailChars,
  };
  for (const size of [2_000, 100_000]) {
    const pruned = pruneContent('😀'.repeat(size), policy);
    assert.ok(pruned && codePointLength(pruned) <= policy.thresholdChars);
    assert.equal(pruneContent(pruned, policy), null);
  }
  assert.doesNotThrow(() => assertPrunePolicy(policy));
  assert.throws(() => resolveRunLimits({ toolResultPruneHeadChars: 0 }), /Invalid/);
  assert.throws(() => resolveRunLimits({ toolResultPruneTailChars: 0 }), /Invalid/);
  assert.throws(
    () => assertPrunePolicy({ ...policy, tailChars: policy.tailChars + 1 }),
    /does not fit/,
  );
});

for (const [name, images] of [
  ['five images', Array.from({ length: 5 }, () => image)],
  ['fake signature', [{ ...image, data: Buffer.from('not an image').toString('base64') }]],
  ['malformed base64', [{ ...image, data: 'invalid base64!' }]],
  ['oversized image', [{ ...image, data: image.data + 'A'.repeat(7_000_000) }]],
] as const) {
  test(`third-party tool ${name} becomes a normal tool failure before hooks and persistence`, async () => {
    const registry = imageTool({
      isError: false,
      content: 'unsafe-image-output',
      images: [...images],
    });
    const observed: ToolResult[] = [];
    registry.registerHooks({
      postExecute: (_execution, result) => {
        observed.push(result);
        return { action: 'accept' };
      },
      afterTool: (_call, result) => void observed.push(result),
      finalizeContent: (_execution, result) => result.content + '\nfinalized',
    });
    const result = await registry.execute(call, context());
    assert.equal(result.isError, true);
    assert.equal(result.images, undefined);
    assert.match(result.content, /Invalid tool result images/);
    assert.match(result.content, /finalized$/);
    assert.ok(result.content.length < 512, 'diagnostic must not copy the image payload');
    assert.doesNotMatch(result.content, /unsafe-image-output|not an image|iVBORw0/);
    assert.equal(observed.length, 2);
    for (const seen of observed) {
      assert.equal(seen.isError, true);
      assert.equal(seen.images, undefined);
    }
    assert.equal(registry.pipelineInvariant.violations.length, 0);
    assert.deepEqual(registry.pipelineInvariant.history.at(-1)?.stages.slice(-3), [
      'post-execute',
      'finalize',
      'result',
    ]);
  });
}

test('valid third-party image is preserved through hooks and final result normalization', async () => {
  const registry = imageTool({ isError: false, content: 'look at pixel', images: [image] });
  registry.registerHooks({
    finalizeContent: (_execution, result) => result.content + '\nfinalized',
  });
  const result = await registry.execute(call, context());
  assert.equal(result.isError, false);
  assert.deepEqual(result.images, [image]);
  assert.equal(result.content, 'look at pixel\nfinalized');
});

test('invalid images from a post-execute replacement cannot reach the final result', async () => {
  const registry = imageTool({ isError: false, content: 'original' });
  registry.registerHooks({
    postExecute: () => ({
      action: 'replace',
      result: {
        isError: false,
        content: 'replacement',
        images: Array.from({ length: 5 }, () => image),
      },
    }),
  });
  const result = await registry.execute(call, context());
  assert.equal(result.isError, true);
  assert.equal(result.images, undefined);
  assert.match(result.content, /Invalid tool result images/);
});

test('existing tool errors without images retain normal hook semantics', async () => {
  const registry = imageTool({ isError: true, content: 'original failure' });
  registry.registerHooks({
    postExecute: () => ({ action: 'add-context', context: 'helpful context' }),
    afterTool: () => {
      throw new Error('observer failed');
    },
  });
  const result = await registry.execute(call, context());
  assert.equal(result.isError, true);
  assert.match(result.content, /^original failure/);
  assert.match(result.content, /Extension observer failed/);
  assert.deepEqual(result.additionalContext, ['helpful context']);
});
