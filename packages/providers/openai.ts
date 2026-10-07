import type { ModelRequest, ModelResponse, Provider, ToolCall } from '../protocol/index.ts';
import type { ProviderConfig } from './config.ts';
import { assertUsableCredential } from './credentials.ts';
import { failureForStatus, failureFromResponse, fetchModel } from './http.ts';
import { RunFailure, failureCodeOf } from '../protocol/failure.ts';
import { cacheFields } from './cache.ts';
import { validateImages } from '../protocol/images.ts';
import { readSse } from './sse.ts';
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid model stream object');
  return value as Record<string, unknown>;
}
function string(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Invalid model stream string');
  return value;
}
function tokens(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new Error('Invalid model token usage');
  return value;
}
export class OpenAIProvider implements Provider {
  private config: ProviderConfig;
  private endpoint: string;
  constructor(config: ProviderConfig) {
    const url = new URL(config.baseUrl ?? 'https://api.openai.com');
    if (url.username || url.password || url.search || url.hash)
      throw new Error('Base URL must not contain credentials, query parameters or fragments');
    if (
      url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
    )
      throw new Error('Use HTTPS for remote model endpoints');
    const basePath = url.pathname.replace(/\/+$/, '');
    url.pathname = basePath.endsWith('/chat/completions')
      ? basePath
      : basePath + (basePath.endsWith('/v1') ? '/chat/completions' : '/v1/chat/completions');
    // A key that cannot travel in a header fails inside `fetch`, where the failure no longer says what was wrong.
    assertUsableCredential(config.apiKey);
    this.endpoint = url.toString();
    this.config = config;
  }
  async complete(request: ModelRequest): Promise<ModelResponse> {
    request.signal.throwIfAborted();
    const cache = cacheFields(this.config, request.cacheKey, 'openai');
    const toolImages: Record<string, unknown>[] = [];
    const messages: Record<string, unknown>[] = [
      { role: 'system', content: request.system },
      ...request.messages.flatMap((message, index) => {
        if (message.role === 'tool') {
          const images = validateImages(message.images);
          const messages: Record<string, unknown>[] = [
            { role: 'tool', tool_call_id: message.toolCallId, content: message.content },
          ];
          /**
           * A `tool` message can only hold text here — the chat API rejects content parts in it — so a picture a
           * tool produced rides in a user message after the whole tool batch. Inserting it between results
           * leaves outstanding tool calls and causes the chat API to reject the request. The label matters
           * as much as the image: without it the model reads the
           * pictures as a *new instruction from the user* rather than as the output of the call above, and
           * every screenshot would look like a request.
           *
           * This is a translation, not a second turn in the transcript: the session log records one tool
           * message, and only this protocol sees it split in two.
           */
          if (images.length) {
            toolImages.push(
              {
                type: 'text',
                text: `Images returned by tool call ${message.toolCallId} (its output, not a new request): ${message.content}`,
              },
              ...images.map((image) => ({
                type: 'image_url',
                image_url: { url: `data:${image.mimeType};base64,${image.data}` },
              })),
            );
          }
          if (toolImages.length && request.messages[index + 1]?.role !== 'tool') {
            messages.push({
              role: 'user',
              content: toolImages.splice(0),
            } as Record<string, unknown>);
          }
          return messages;
        }
        if (message.role === 'assistant')
          return {
            role: 'assistant',
            content: message.content || null,
            ...(message.toolCalls.length
              ? {
                  tool_calls: message.toolCalls.map((call) => ({
                    id: call.id,
                    type: 'function',
                    function: { name: call.name, arguments: JSON.stringify(call.arguments) },
                  })),
                }
              : {}),
          };
        const images = validateImages(message.images);
        return {
          role: 'user',
          content: images.length
            ? [
                { type: 'text', text: message.content },
                ...images.map((image) => ({
                  type: 'image_url',
                  image_url: { url: `data:${image.mimeType};base64,${image.data}` },
                })),
              ]
            : message.content,
        };
      }),
    ];
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
            authorization: `Bearer ${this.config.apiKey}`,
          },
          body: JSON.stringify({
            model: request.model ?? this.config.model,
            // The protocol's own field, passed through unchanged: a level is what this API takes, so there is
            // nothing to translate and nothing to invent. `none` sends no field at all, which is how a policy
            // undoes an earlier policy's choice.
            ...(request.reasoningEffort && request.reasoningEffort !== 'none'
              ? { reasoning_effort: request.reasoningEffort }
              : {}),
            messages,
            stream: true,
            stream_options: { include_usage: true },
            max_completion_tokens: request.maxOutputTokens,
            ...(cache.key ? { prompt_cache_key: cache.key } : {}),
            ...(request.tools.length
              ? {
                  tools: request.tools.map((tool) => ({
                    type: 'function',
                    function: {
                      name: tool.name,
                      description: tool.description,
                      parameters: tool.inputSchema,
                    },
                  })),
                }
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
    let text = '',
      reason: ModelResponse['finishReason'] | undefined,
      done = false,
      usage: ModelResponse['usage'] | undefined,
      reasoningTokens: number | undefined,
      reasoningChars = 0,
      toolArgumentChars = 0;
    const calls = new Map<number, { id: string; name: string; json: string }>();
    for await (const event of readSse(
      response.body,
      request.signal,
      true,
      this.config.streamIdleTimeoutMs ?? 300_000,
    )) {
      if (event.type === 'stream.done') {
        done = true;
        break;
      }
      if (event.error) throw new Error('Model API reported a streaming error');
      if (event.usage) {
        const value = object(event.usage);
        if (value.completion_tokens_details) {
          const details = object(value.completion_tokens_details);
          if (details.reasoning_tokens !== undefined)
            reasoningTokens = tokens(details.reasoning_tokens);
        }
        const promptDetails = value.prompt_tokens_details
          ? object(value.prompt_tokens_details)
          : {};
        usage = {
          inputTokens: tokens(value.prompt_tokens),
          outputTokens: tokens(value.completion_tokens),
          ...(value.prompt_tokens_details && promptDetails.cached_tokens !== undefined
            ? {
                cachedInputTokens: Math.min(
                  tokens(value.prompt_tokens),
                  tokens(promptDetails.cached_tokens),
                ),
              }
            : {}),
          // Reported by the newer usage shape; older responses simply omit it, which is not a zero.
          ...(promptDetails.cache_write_tokens !== undefined
            ? { cacheWriteInputTokens: tokens(promptDetails.cache_write_tokens) }
            : {}),
        };
      }
      if (!Array.isArray(event.choices)) throw new Error('Invalid model choices');
      for (const raw of event.choices) {
        const choice = object(raw);
        if (choice.index !== 0) throw new Error('Unexpected model choice index');
        const delta = object(choice.delta ?? {});
        if (reason && (delta.content || delta.reasoning_content || delta.tool_calls))
          throw new Error('Model data arrived after finish reason');
        if (delta.reasoning_content !== undefined && delta.reasoning_content !== null) {
          const part = string(delta.reasoning_content);
          reasoningChars += part.length;
          // The text goes to its own channel. Progress keeps carrying counts only, so a status line can
          // never become a place where the model's scratch work leaks out.
          request.onReasoning?.(part);
          request.onProgress?.({
            phase: 'reasoning',
            reasoningChars,
            toolArgumentChars,
            visibleChars: text.length,
          });
        }
        if (delta.content !== undefined && delta.content !== null) {
          const part = string(delta.content);
          text += part;
          request.onText(part);
          if (part)
            request.onProgress?.({
              phase: 'text',
              reasoningChars,
              toolArgumentChars,
              visibleChars: text.length,
            });
        }
        if (delta.refusal) {
          const part = string(delta.refusal);
          text += part;
          request.onText(part);
          if (part)
            request.onProgress?.({
              phase: 'text',
              reasoningChars,
              toolArgumentChars,
              visibleChars: text.length,
            });
        }
        if (delta.tool_calls !== undefined) {
          if (!Array.isArray(delta.tool_calls)) throw new Error('Invalid tool deltas');
          for (const rawTool of delta.tool_calls) {
            const tool = object(rawTool);
            const index = tool.index;
            if (
              typeof index !== 'number' ||
              !Number.isSafeInteger(index) ||
              index < 0 ||
              index > 127
            )
              throw new Error('Invalid tool index');
            const value = calls.get(index) ?? { id: '', name: '', json: '' };
            if (tool.id !== undefined) {
              if (value.id) throw new Error('Duplicate tool ID fragment');
              value.id = string(tool.id);
            }
            if (tool.type !== undefined && tool.type !== 'function')
              throw new Error('Unsupported tool type');
            if (tool.function) {
              const fn = object(tool.function);
              if (fn.name !== undefined) value.name += string(fn.name);
              if (fn.arguments !== undefined) {
                const fragment = string(fn.arguments);
                value.json += fragment;
                toolArgumentChars += fragment.length;
              }
            }
            calls.set(index, value);
          }
          request.onProgress?.({
            phase: 'tool_call',
            reasoningChars,
            toolArgumentChars,
            visibleChars: text.length,
          });
        }
        if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
          if (reason) throw new Error('Duplicate model finish reason');
          if (choice.finish_reason === 'stop' || choice.finish_reason === 'content_filter')
            reason = 'stop';
          else if (choice.finish_reason === 'tool_calls') reason = 'tool_calls';
          else if (choice.finish_reason === 'length') reason = 'length';
          else throw new Error('Unsupported model finish reason');
        }
      }
    }
    if (!done || !reason)
      // Named for the same reason the Anthropic adapter names it: the endpoint stopped mid-answer, and only a
      // failure with a code can be re-sent by the step boundary. See `RunFailure('transport')` there.
      throw new RunFailure('transport', 'Incomplete model stream: missing terminal event');
    if (!usage)
      throw new Error('Model endpoint omitted token usage; enable streaming usage support');
    const toolCalls: ToolCall[] = [];
    if (reason !== 'length')
      for (const [, call] of [...calls].sort(([a], [b]) => a - b)) {
        if (!call.id || !call.name) throw new Error('Incomplete model tool call');
        let args: Record<string, unknown>;
        try {
          args = object(JSON.parse(call.json || '{}'));
        } catch {
          throw new Error('Invalid JSON tool arguments');
        }
        toolCalls.push({ id: call.id, name: call.name, arguments: args });
      }
    if ((reason === 'tool_calls') !== Boolean(toolCalls.length) && reason !== 'length')
      throw new Error('Model finish reason conflicts with tool calls');
    return {
      text,
      toolCalls,
      finishReason: reason,
      usage,
      outputDiagnostics: {
        ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
        reasoningChars,
        toolArgumentChars,
        visibleChars: text.length,
      },
    };
  }
}
