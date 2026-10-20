import { createHash } from 'node:crypto';
import type { ModelRequest } from '../protocol/index.ts';

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function blocks(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  return value.map((block: Record<string, unknown>) => {
    const { cache_control: _annotation, ...content } = block;
    return content.type === 'tool_result'
      ? { ...content, content: blocks(content.content) }
      : content;
  });
}

/** Serialize once and observe only the actual wire input, excluding movable cache annotations. */
export function observedRequestBody(
  request: ModelRequest,
  route: { protocol: string; endpoint: string; model: string },
  body: Record<string, unknown>,
): string {
  if (request.onRequestFingerprint) {
    const native = (body.messages ?? body.input ?? []) as Record<string, unknown>[];
    const leadingSystem =
      body.system === undefined && body.instructions === undefined && native[0]?.role === 'system';
    const system = body.system ?? body.instructions ?? (leadingSystem ? native[0] : '');
    const messages = (leadingSystem ? native.slice(1) : native).map((message) => ({
      ...message,
      ...(Array.isArray(message.content) ? { content: blocks(message.content) } : {}),
    }));
    const tools = ((body.tools as Record<string, unknown>[] | undefined) ?? []).map((tool) => {
      const { cache_control: _annotation, ...definition } = tool;
      return definition;
    });
    const omitted = new Set([
      'model',
      'messages',
      'input',
      'system',
      'instructions',
      'tools',
      'stream',
      'stream_options',
      'max_completion_tokens',
      'max_tokens',
      'max_output_tokens',
      'prompt_cache_key',
      'store',
      'include',
    ]);
    const configuration = Object.fromEntries(
      Object.entries(body).filter(([key]) => !omitted.has(key)),
    );
    const history = createHash('sha256');
    const historyPrefixes = [history.copy().digest('hex')];
    for (const message of messages) {
      const encoded = JSON.stringify(message);
      history
        .update(String(Buffer.byteLength(encoded)))
        .update(':')
        .update(encoded);
      historyPrefixes.push(history.copy().digest('hex'));
    }
    request.onRequestFingerprint({
      routeHash: hash(route),
      systemHash: hash(blocks(system)),
      toolsHash: hash(tools),
      configurationHash: hash(configuration),
      historyHash: history.digest('hex'),
      messageCount: messages.length,
      historyPrefixes,
    });
  }
  return JSON.stringify(body);
}
