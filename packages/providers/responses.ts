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
    throw new Error('Invalid Responses object');
  return value as Record<string, unknown>;
}
function string(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Invalid Responses string');
  return value;
}
function tokens(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new Error('Invalid Responses token usage');
  return value;
}
export class ResponsesProvider implements Provider {
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
    const base = url.pathname.replace(/\/+$/, '');
    url.pathname = base.endsWith('/responses')
      ? base
      : base + (base.endsWith('/v1') ? '/responses' : '/v1/responses');
    // A key that cannot travel in a header fails inside `fetch`, where the failure no longer says what was wrong.
    assertUsableCredential(config.apiKey);
    this.endpoint = url.href;
    this.config = config;
  }
  async complete(request: ModelRequest): Promise<ModelResponse> {
    request.signal.throwIfAborted();
    const cache = cacheFields(this.config, request.cacheKey, 'openai-responses');
    const input: Record<string, unknown>[] = [];
    for (const message of request.messages) {
      if (message.role === 'tool') {
        /**
         * `function_call_output.output` takes a string or a list of input items, so a tool's pictures stay in
         * provider-native content instead of being JSON-stringified into the prompt text (a base64 blob the
         * model cannot see anyway, at full token cost). The plain-string form is kept for text-only results:
         * it is what every existing transcript already sends.
         */
        const images = validateImages(message.images);
        input.push({
          type: 'function_call_output',
          call_id: message.toolCallId,
          output: images.length
            ? [
                ...(message.content ? [{ type: 'input_text', text: message.content }] : []),
                ...images.map((image) => ({
                  type: 'input_image',
                  image_url: `data:${image.mimeType};base64,${image.data}`,
                  detail: 'auto',
                })),
              ]
            : message.content,
        });
        continue;
      }
      if (message.role === 'assistant') {
        const state = message.providerState;
        if (
          state?.protocol === 'openai-responses' &&
          state.model === this.config.model &&
          state.endpoint === this.endpoint
        ) {
          input.push(...state.output);
          continue;
        }
        if (message.content) input.push({ role: 'assistant', content: message.content });
        input.push(
          ...message.toolCalls.map((call) => ({
            type: 'function_call',
            call_id: call.id,
            name: call.name,
            arguments: JSON.stringify(call.arguments),
          })),
        );
        continue;
      }
      const images = validateImages(message.images);
      input.push({
        role: 'user',
        content: [
          { type: 'input_text', text: message.content },
          ...images.map((image) => ({
            type: 'input_image',
            image_url: `data:${image.mimeType};base64,${image.data}`,
            detail: 'auto',
          })),
        ],
      });
    }
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
            authorization: 'Bearer ' + this.config.apiKey,
          },
          body: JSON.stringify({
            model: request.model ?? this.config.model,
            // Same level, nested under `reasoning`. `include: ['reasoning.encrypted_content']` above is already
            // unconditional, which is what makes reasoning usable with `store: false`.
            ...(request.reasoningEffort && request.reasoningEffort !== 'none'
              ? { reasoning: { effort: request.reasoningEffort } }
              : {}),
            instructions: request.system,
            input,
            stream: true,
            store: false,
            include: ['reasoning.encrypted_content'],
            ...(cache.key ? { prompt_cache_key: cache.key } : {}),
            max_output_tokens: request.maxOutputTokens,
            tools: request.tools.map((tool) => ({
              type: 'function',
              name: tool.name,
              description: tool.description,
              parameters: tool.inputSchema,
              strict: false,
            })),
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
    let streamed = '',
      terminal: Record<string, unknown> | undefined,
      incomplete = false;
    for await (const event of readSse(
      response.body,
      request.signal,
      false,
      this.config.streamIdleTimeoutMs ?? 300_000,
    )) {
      if (event.type === 'error' || event.type === 'response.failed')
        throw new Error('Model API reported a streaming error');
      if (
        event.type === 'response.reasoning_summary_text.delta' ||
        event.type === 'response.reasoning_text.delta'
      )
        request.onReasoning?.(string(event.delta));
      if (event.type === 'response.output_text.delta' || event.type === 'response.refusal.delta') {
        const delta = string(event.delta);
        streamed += delta;
        request.onText(delta);
      }
      if (event.type === 'response.completed' || event.type === 'response.incomplete') {
        terminal = object(event.response);
        incomplete = event.type === 'response.incomplete';
        if (terminal.status !== (incomplete ? 'incomplete' : 'completed'))
          throw new Error('Conflicting Responses terminal status');
        break;
      }
    }
    if (!terminal)
      // Named for the same reason the other two adapters name it: the endpoint stopped mid-answer, and only a
      // failure with a code can be re-sent by the step boundary. See `RunFailure('transport')` in
      // `anthropic.ts`. Leaving it anonymous made a truncated Responses stream invisible to the retry policy,
      // which fail-closes on a failure it cannot classify.
      throw new RunFailure('transport', 'Incomplete model stream: missing terminal event');
    const rawUsage = object(terminal.usage);
    const inputDetails = rawUsage.input_tokens_details ? object(rawUsage.input_tokens_details) : {};
    const usage = {
      inputTokens: tokens(rawUsage.input_tokens),
      outputTokens: tokens(rawUsage.output_tokens),
      ...(rawUsage.input_tokens_details && inputDetails.cached_tokens !== undefined
        ? {
            cachedInputTokens: Math.min(
              tokens(rawUsage.input_tokens),
              tokens(inputDetails.cached_tokens),
            ),
          }
        : {}),
      ...(inputDetails.cache_write_tokens !== undefined
        ? { cacheWriteInputTokens: tokens(inputDetails.cache_write_tokens) }
        : {}),
    };
    if (incomplete) return { text: streamed, toolCalls: [], finishReason: 'length', usage };
    if (!Array.isArray(terminal.output) || terminal.output.length > 256)
      throw new Error('Invalid Responses output');
    const output = terminal.output.map(object),
      toolCalls: ToolCall[] = [];
    let text = '';
    const ids = new Set<string>();
    for (const item of output) {
      if (item.status !== undefined && item.status !== 'completed')
        throw new Error('Invalid or unfinished Responses output item status');
      if (item.type === 'message') {
        if (item.role !== 'assistant' || !Array.isArray(item.content))
          throw new Error('Invalid Responses message');
        for (const raw of item.content) {
          const part = object(raw);
          if (part.type === 'output_text') text += string(part.text);
          else if (part.type === 'refusal') text += string(part.refusal);
          else throw new Error('Unsupported Responses content');
        }
      } else if (item.type === 'function_call') {
        const id = string(item.call_id),
          name = string(item.name);
        if (!id || !name || ids.has(id) || toolCalls.length >= 128)
          throw new Error('Invalid or duplicate Responses tool call');
        ids.add(id);
        let args: Record<string, unknown>;
        try {
          args = object(JSON.parse(string(item.arguments)));
        } catch {
          throw new Error('Invalid JSON tool arguments');
        }
        toolCalls.push({ id, name, arguments: args });
      } else if (item.type === 'reasoning') {
        if (typeof item.encrypted_content !== 'string' || !item.encrypted_content)
          throw new Error(
            'Responses endpoint omitted encrypted reasoning required for stateless continuation',
          );
      } else throw new Error('Unsupported Responses output item');
    }
    if (!text.startsWith(streamed))
      throw new Error('Responses terminal text conflicts with stream');
    if (text.length > streamed.length) request.onText(text.slice(streamed.length));
    return {
      text,
      toolCalls,
      finishReason: toolCalls.length ? 'tool_calls' : 'stop',
      usage,
      providerState: {
        protocol: 'openai-responses',
        model: this.config.model,
        endpoint: this.endpoint,
        output,
      },
    };
  }
}
