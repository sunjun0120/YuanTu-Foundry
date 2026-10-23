import type { ModelRequest, ModelResponse, Provider, ToolCall } from '../protocol/index.ts';
import type { ProviderConfig } from './config.ts';
import { assertUsableCredential } from './credentials.ts';
import { failureForStatus, failureFromResponse, fetchModel } from './http.ts';
import { RunFailure, failureCodeOf } from '../protocol/failure.ts';
import { cacheFields } from './cache.ts';
import { validateImages } from '../protocol/images.ts';
import { readSse } from './sse.ts';
import {
  assistantHash,
  deepseekCapabilities,
  nativeState,
  projectNativeSystem,
} from './native-history.ts';
import { observedRequestBody } from './request-observation.ts';
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
    const model = request.model ?? this.config.model;
    const capabilities = deepseekCapabilities(this.config, this.endpoint, model);
    const route = { protocol: 'openai' as const, model, endpoint: this.endpoint };
    const prompt = projectNativeSystem(request, route, capabilities.systemUpdates);
    const toolImages: Record<string, unknown>[] = [];
    const messages: Record<string, unknown>[] = [
      { role: 'system', content: prompt.system },
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
        if (message.role === 'assistant') {
          const replay = capabilities.reasoning ? nativeState(message, route) : undefined;
          if (replay)
            return [
              ...(prompt.updates.has(index)
                ? [{ role: 'system', content: prompt.updates.get(index) }]
                : []),
              ...structuredClone(replay.output),
            ];
          return {
            role: 'assistant',
            content: message.content || null,
            // Old or foreign messages have no trusted native thought. Keep DeepSeek's field present without
            // treating display-only reasoning as output from this route.
            ...(capabilities.reasoning ? { reasoning_content: '' } : {}),
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
        }
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
    if (prompt.pending !== undefined) messages.push({ role: 'system', content: prompt.pending });
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
          body: observedRequestBody(request, route, {
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
            ...(cache.key && !capabilities.reasoning ? { prompt_cache_key: cache.key } : {}),
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
                  ...(request.toolChoice === 'none' ? { tool_choice: 'none' } : {}),
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
      reasoning = '',
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
        const inputTokens = tokens(value.prompt_tokens);
        const reportedCache =
          promptDetails.cached_tokens !== undefined
            ? promptDetails.cached_tokens
            : value.prompt_cache_hit_tokens;
        const cachedTokens =
          reportedCache !== undefined
            ? tokens(reportedCache)
            : value.prompt_cache_miss_tokens !== undefined
              ? inputTokens - tokens(value.prompt_cache_miss_tokens)
              : undefined;
        if (cachedTokens !== undefined && (cachedTokens < 0 || cachedTokens > inputTokens))
          throw new Error('Invalid model cache token usage');
        usage = {
          inputTokens,
          outputTokens: tokens(value.completion_tokens),
          ...(cachedTokens === undefined ? {} : { cachedInputTokens: cachedTokens }),
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
          reasoning += part;
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
            /**
             * Some compatible endpoints repeat the id field on every fragment of a call — Qwen sends the id once
             * and then `"id": ""` with each argument chunk. An empty id, or the same id again, adds nothing; a
             * *different* id for the same index is still two calls folded into one, and is refused.
             */
            if (tool.id !== undefined && tool.id !== '') {
              const id = string(tool.id);
              if (value.id && value.id !== id) throw new Error('Duplicate tool ID fragment');
              value.id = id;
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
          if (choice.finish_reason === 'stop') reason = 'stop';
          // The endpoint's own policy, not an answer and not a budget: see `ModelResponse.finishReason`.
          else if (choice.finish_reason === 'content_filter') reason = 'content-filter';
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
    // A truncated call is half a JSON document and a filtered one was never allowed to run: neither is a call.
    if (reason !== 'length' && reason !== 'content-filter')
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
    // Several OpenAI-compatible servers (Ollama, some vLLM and gateway builds) finish a turn that called tools with
    // `stop`. The calls are complete and parsed, so the turn is a tool turn; the reverse — `tool_calls` with no
    // call — is still refused, because there is nothing to run.
    if (reason === 'stop' && toolCalls.length) reason = 'tool_calls';
    if ((reason === 'tool_calls') !== Boolean(toolCalls.length) && reason !== 'length')
      throw new Error('Model finish reason conflicts with tool calls');
    return {
      text,
      toolCalls,
      ...(capabilities.reasoning && reason !== 'length' && reason !== 'content-filter'
        ? {
            providerState: {
              ...route,
              messageHash: assistantHash({ content: text, toolCalls }),
              systemToolsHash: prompt.toolsHash,
              ...(prompt.snapshot ? { systemPrompt: prompt.snapshot } : {}),
              output: [
                {
                  role: 'assistant',
                  content: text || null,
                  reasoning_content: reasoning,
                  ...(toolCalls.length
                    ? {
                        tool_calls: toolCalls.map((call) => ({
                          id: call.id,
                          type: 'function',
                          function: {
                            name: call.name,
                            arguments:
                              [...calls.values()].find((native) => native.id === call.id)!.json ||
                              '{}',
                          },
                        })),
                      }
                    : {}),
                },
              ],
            },
          }
        : {}),
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
