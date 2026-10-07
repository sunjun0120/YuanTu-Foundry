import type {
  Message,
  ModelRequest,
  ModelResponse,
  Provider,
  ToolCall,
} from '../protocol/index.ts';
import type { ProviderConfig } from './config.ts';
import { assertUsableCredential } from './credentials.ts';
import { failureForStatus, failureFromResponse, fetchModel } from './http.ts';
import { RunFailure, failureCodeOf } from '../protocol/failure.ts';
import { anthropicSystem, anthropicTools, cacheFields, markLastContentBlock } from './cache.ts';
import { readSse } from './sse.ts';
import { anthropicThinkingBudget } from './effort.ts';
import { validateImages } from '../protocol/images.ts';

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid object in model response');
  return value as Record<string, unknown>;
}
function string(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Invalid string in model response');
  return value;
}
function tokens(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new Error('Invalid token usage in model response');
  return value;
}
function serialize(
  messages: Message[],
): { role: 'user' | 'assistant'; content: Record<string, unknown>[] }[] {
  const result: { role: 'user' | 'assistant'; content: Record<string, unknown>[] }[] = [];
  for (const message of messages) {
    const role = message.role === 'assistant' ? 'assistant' : 'user';
    const content: Record<string, unknown>[] = [];
    if (message.role === 'tool') {
      /**
       * A tool result carries its pictures *inside* the result, which is the one shape Anthropic supports
       * natively: `tool_result.content` is a string or a list of blocks, and an image block is one of them.
       * The text stays first so a reader (and a model) sees what the tool said before what it showed.
       */
      const images = validateImages(message.images);
      content.push({
        type: 'tool_result',
        tool_use_id: message.toolCallId,
        content: images.length
          ? [
              ...(message.content ? [{ type: 'text', text: message.content }] : []),
              ...images.map((image) => ({
                type: 'image',
                source: { type: 'base64', media_type: image.mimeType, data: image.data },
              })),
            ]
          : message.content,
        is_error: message.isError,
      });
    } else {
      if (message.content) content.push({ type: 'text', text: message.content });
      if (message.role === 'user')
        for (const image of validateImages(message.images))
          content.push({
            type: 'image',
            source: { type: 'base64', media_type: image.mimeType, data: image.data },
          });
      if (message.role === 'assistant')
        for (const call of message.toolCalls)
          content.push({ type: 'tool_use', id: call.id, name: call.name, input: call.arguments });
    }
    if (!content.length) continue;
    const last = result.at(-1);
    if (last?.role === role) last.content.push(...content);
    else result.push({ role, content });
  }
  return result;
}
export class AnthropicProvider implements Provider {
  private config: ProviderConfig;
  private endpoint: string;
  constructor(config: ProviderConfig) {
    const url = new URL(config.baseUrl ?? 'https://api.anthropic.com');
    if (url.username || url.password || url.search || url.hash)
      throw new Error('Base URL must not contain credentials, query parameters or fragments');
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local))
      throw new Error('Use HTTPS for remote model endpoints');
    const basePath = url.pathname.replace(/\/+$/, '');
    url.pathname = basePath + (basePath.endsWith('/v1') ? '/messages' : '/v1/messages');
    // The credential cannot be fixed later: a key that cannot travel in a header fails inside `fetch`, where the
    // failure no longer says what was wrong with it.
    assertUsableCredential(config.apiKey);
    this.endpoint = url.toString();
    this.config = config;
  }
  async complete(request: ModelRequest): Promise<ModelResponse> {
    request.signal.throwIfAborted();
    /**
     * The cache fields this request gets, decided once by `cacheFields`.
     *
     * The adapter asks one question instead of three: whether breakpoints go in the prefix, whether the last tool
     * definition may carry one, and whether this route caches by key at all. All three are the connection's
     * setting combined with what the protocol declares it can do — see `packages/providers/cache.ts`. The route
     * name is passed explicitly because this adapter is what knows it speaks anthropic, whatever the config says.
     */
    const cache = cacheFields(this.config, request.cacheKey, 'anthropic');
    /**
     * Anthropic's extended thinking, sized by our own documented rule (see `effort.ts`).
     *
     * Computed before the request rather than inline, because the rule can *refuse*: a request whose output
     * limit leaves no room for Anthropic's thinking floor is a request this protocol cannot express, and the
     * caller gets that answer before anything is sent. Omitted entirely when no effort was asked for, which is
     * why every run that does not use the seam behaves exactly as before.
     */
    const thinking = request.reasoningEffort
      ? anthropicThinkingBudget(request.reasoningEffort, request.maxOutputTokens)
      : undefined;
    const messages = serialize(request.messages);
    markLastContentBlock(messages, cache.blocks);
    let response: Response;
    try {
      response = await fetchModel(
        this.endpoint,
        {
          method: 'POST',
          redirect: 'error',
          signal: request.signal,
          headers: {
            'content-type': 'application/json',
            'x-api-key': this.config.apiKey,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model: request.model ?? this.config.model,
            max_tokens: request.maxOutputTokens,
            stream: true,
            ...(thinking === undefined
              ? {}
              : { thinking: { type: 'enabled', budget_tokens: thinking } }),
            system: anthropicSystem(request.system, cache.blocks),
            messages,
            ...(request.tools.length
              ? { tools: anthropicTools(request.tools, cache.blocks, cache.toolBreakpoint) }
              : {}),
          }),
        },
        this.config.streamIdleTimeoutMs ?? 300_000,
      );
    } catch (error) {
      request.signal.throwIfAborted();
      // A timeout we raised is not masked by the generic message: it is the one transport failure whose cause
      // is already known precisely, and the run reports it by code.
      if (failureCodeOf(error) === 'timeout') throw error;
      throw new RunFailure(
        'transport',
        'Model request failed; check endpoint and network configuration',
        {
          cause: error,
        },
      );
    }
    if (!response.ok) {
      throw (
        (await failureFromResponse(response, [this.config.apiKey])) ?? failureForStatus(response)
      );
    }
    if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream')) {
      await response.body?.cancel();
      throw new RunFailure('no-stream', 'Model endpoint did not return an SSE stream');
    }
    const blocks = new Map<
      number,
      {
        kind: string;
        text: string;
        id?: string;
        name?: string;
        json: string;
        input?: Record<string, unknown>;
        closed: boolean;
      }
    >();
    let started = false,
      stopped = false,
      finishReason: ModelResponse['finishReason'] | undefined,
      /**
       * Anthropic names a context overflow as its own stop reason. It arrives in the same `length` shape as
       * `max_tokens`, and only this flag keeps the two apart: one is answered by compressing the conversation
       * and sending the round again, the other is not.
       */
      truncation: ModelResponse['truncation'];
    let inputTokens = 0,
      outputTokens = 0;
    let cachedInputTokens: number | undefined;
    let cacheWriteInputTokens: number | undefined;
    for await (const event of readSse(
      response.body,
      request.signal,
      false,
      this.config.streamIdleTimeoutMs ?? 300_000,
    )) {
      switch (event.type) {
        case 'message_start': {
          if (started) throw new Error('Duplicate message start');
          started = true;
          const usage = object(object(event.message).usage);
          inputTokens =
            tokens(usage.input_tokens) +
            tokens(usage.cache_creation_input_tokens ?? 0) +
            tokens(usage.cache_read_input_tokens ?? 0);
          outputTokens = tokens(usage.output_tokens ?? 0);
          if (usage.cache_read_input_tokens !== undefined)
            cachedInputTokens = tokens(usage.cache_read_input_tokens);
          // Cache writes are part of the reported input total; keeping them separate is what makes the cached
          // read on the *next* call attributable to them.
          if (usage.cache_creation_input_tokens !== undefined)
            cacheWriteInputTokens = tokens(usage.cache_creation_input_tokens);
          break;
        }
        case 'content_block_start': {
          if (
            !started ||
            typeof event.index !== 'number' ||
            !Number.isSafeInteger(event.index) ||
            event.index < 0 ||
            blocks.has(event.index)
          )
            throw new Error('Invalid content block index');
          const block = object(event.content_block),
            kind = string(block.type);
          /**
           * `thinking` and `redacted_thinking` are accepted because we now *ask* for thinking: a request
           * with `thinking: {type: 'enabled'}` streams those blocks, and refusing them would make the feature
           * unusable. A redacted block carries no text (that is what redacted means) and no deltas either, so
           * it is tracked like any other block — started, stopped, empty — rather than as a special case the
           * stream would then contradict.
           */
          if (
            kind !== 'text' &&
            kind !== 'tool_use' &&
            kind !== 'thinking' &&
            kind !== 'redacted_thinking'
          )
            throw new Error('Unsupported model content block; use standard text/tool mode');
          blocks.set(event.index, {
            kind,
            text: kind === 'text' ? string(block.text) : '',
            json: '',
            closed: false,
            ...(kind === 'tool_use'
              ? { id: string(block.id), name: string(block.name), input: object(block.input) }
              : {}),
          });
          if (kind === 'text' && block.text) request.onText(string(block.text));
          break;
        }
        case 'content_block_delta': {
          const block = blocks.get(Number(event.index));
          if (!block || block.closed) throw new Error('Unexpected content delta');
          const delta = object(event.delta);
          if (delta.type === 'text_delta' && block.kind === 'text') {
            const text = string(delta.text);
            block.text += text;
            request.onText(text);
          } else if (delta.type === 'thinking_delta' && block.kind === 'thinking') {
            // Reasoning travels on its own channel: it is shown folded and is never part of the next prompt, so
            // it must not enter `text` (which becomes the answer). `signature_delta` is deliberately ignored —
            // it is only useful for sending thinking back, which this runtime never does.
            const text = string(delta.thinking);
            block.text += text;
            request.onReasoning?.(text);
          } else if (delta.type === 'input_json_delta' && block.kind === 'tool_use')
            block.json += string(delta.partial_json);
          else if (delta.type === 'signature_delta' && block.kind === 'thinking') break;
          else throw new Error('Unsupported content delta');
          break;
        }
        case 'content_block_stop': {
          const block = blocks.get(Number(event.index));
          if (!block || block.closed) throw new Error('Unexpected content block end');
          block.closed = true;
          break;
        }
        case 'message_delta': {
          const reason = object(event.delta).stop_reason;
          if (reason === 'tool_use') finishReason = 'tool_calls';
          else if (reason === 'end_turn' || reason === 'stop_sequence' || reason === 'refusal')
            finishReason = 'stop';
          else if (reason === 'max_tokens') finishReason = 'length';
          else if (reason === 'model_context_window_exceeded') {
            finishReason = 'length';
            truncation = 'context-window';
          } else if (reason !== null && reason !== undefined)
            throw new Error('Unsupported model stop reason');
          const usage = object(event.usage);
          if (usage.output_tokens !== undefined) outputTokens = tokens(usage.output_tokens);
          break;
        }
        case 'message_stop':
          stopped = true;
          break;
        case 'error':
          throw new Error('Model API reported a streaming error; request was not retried');
        default:
          break; // Ignore future metadata and ping events.
      }
      if (stopped) break;
    }
    if (
      !started ||
      !stopped ||
      !finishReason ||
      [...blocks.values()].some((block) => !block.closed)
    )
      /**
       * Named as a transport failure, not an anonymous one. The endpoint stopped talking before it finished
       * answering, which is the same class of event as a socket closing early — and the one failure a *stream*
       * can suffer that re-sending it may fix. Leaving it unnamed made it invisible to the retry policy, which
       * fail-closes on a failure with no code.
       */
      throw new RunFailure(
        'transport',
        'Incomplete model stream: missing terminal event or block end',
      );
    const toolCalls: ToolCall[] = [];
    let text = '';
    for (const [, block] of [...blocks.entries()].sort(([a], [b]) => a - b)) {
      if (block.kind === 'text') text += block.text;
      else if (finishReason !== 'length') {
        let args = block.input ?? {};
        if (block.json) {
          try {
            args = object(JSON.parse(block.json));
          } catch {
            throw new Error('Invalid JSON tool arguments');
          }
        }
        toolCalls.push({ id: block.id!, name: block.name!, arguments: args });
      }
    }
    return {
      text,
      toolCalls,
      finishReason,
      ...(truncation ? { truncation } : {}),
      usage: {
        inputTokens,
        outputTokens,
        ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
        ...(cacheWriteInputTokens === undefined ? {} : { cacheWriteInputTokens }),
      },
    };
  }
}
