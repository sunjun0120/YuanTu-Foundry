/**
 * Offline replay: a whole turn that can be run again and again without a model.
 *
 * Every agent-level test used to describe the model by *behaviour* — a hand-written `Provider` whose
 * `complete()` picks an answer from a counter — so nothing pinned what the run actually sent to the model, and
 * nothing could be re-run against a conversation that really happened. A script closes both halves: the answers
 * are data, the requests are reduced to something a reviewer can diff, and the two are checked against each
 * other.
 *
 * Four pieces, deliberately small:
 *
 * - `replayProvider(script)` answers from the script and refuses to invent an answer it does not have. An
 *   exhausted script is a failure, not a free pass: a run that suddenly asks one more question is exactly the
 *   change this exists to catch.
 * - `fingerprint(request)` keeps the part of a request worth diffing — model, effort, output limit, cache key,
 *   and per-part digests and sizes — while dropping the prose, which the snapshot carries separately (the system
 *   prompt) or which is already in the transcript (the messages).
 * - `recordingProvider(inner, sink)` writes the same shape out of a **real** run, so a script can be captured
 *   from live traffic instead of hand-written. `scriptLines`/`parseScript` are that file format: one JSON object
 *   per line, so a run that dies mid-way still leaves every call that already happened.
 * - `assertConsumed()` at the end is the other half of the check: leftover answers mean the run stopped asking
 *   questions it used to ask, which is as much a behaviour change as a different answer.
 */
import { createHash } from 'node:crypto';
import type {
  Message,
  ModelRequest,
  ModelResponse,
  Provider,
  ProviderState,
  ToolCall,
  Usage,
} from '../packages/protocol/index.ts';
import { RunFailure, type FailureCode } from '../packages/protocol/failure.ts';

/**
 * The usage a scripted answer reports when it does not say.
 *
 * Fixed rather than random so token totals land in a snapshot; the numbers themselves are meaningless and are
 * never compared against a real endpoint's.
 */
export const SCRIPTED_USAGE: Usage = { inputTokens: 10, outputTokens: 5 };

/** One answer in a script: what the model would have said, or the failure it would have raised. */
export interface ScriptedCall {
  text?: string;
  /** The model's own reasoning channel, streamed before the text. */
  reasoning?: string;
  toolCalls?: ToolCall[];
  finishReason?: ModelResponse['finishReason'];
  usage?: Usage;
  /** `'context-window'` when the endpoint named the window rather than the output limit as the reason it stopped. */
  truncation?: 'context-window';
  providerState?: ProviderState;
  /**
   * Fail this request instead of answering it.
   *
   * The reason replay is worth having for failures: a transient 5xx, the retry that follows it and the step
   * boundary the pair produces used to need a socket and a timing race to test. Here they are two lines of data.
   */
  failure?: { code: FailureCode; message: string; retryAfterMs?: number };
  /**
   * What this entry expects of the request it answers, asserted while replaying.
   *
   * The snapshot already records the request, so this is redundant on purpose: it states the *intent* where a
   * reader of the scenario can see it ("this answers the summary request"), and it fails with a sentence that
   * says which expectation was not met instead of "some digest changed".
   *
   * `messageIncludes` matches the **last** message rather than any of them, because that is where the summary
   * instruction rides: the request it identifies is the main request's own prefix plus that instruction, so
   * the instruction is the one part of it that is not also in every other request.
   */
  when?: {
    systemIncludes?: string;
    messageIncludes?: string;
    messageRoles?: Message['role'][];
  };
}

/** A request reduced to what a reviewer can diff: structure, sizes and digests, never the prose itself. */
export interface RequestFingerprint {
  model: string | null;
  reasoningEffort: string | null;
  maxOutputTokens: number;
  cacheKey: string | null;
  system: { chars: number; digest: string };
  tools: { names: string[]; chars: number; digest: string };
  messages: { role: Message['role']; chars: number; digest: string; toolCalls: string[] }[];
}

/** A recorded call: what was asked (fingerprint) and what came back (script). This is the capture format. */
export interface ScriptEntry {
  request: RequestFingerprint;
  response: ScriptedCall;
}

export interface ReplayProvider extends Provider {
  /** Every request served, in order: the snapshot's evidence of what the run sent. */
  readonly requests: readonly ModelRequest[];
  /** How many scripted answers were used. */
  consumed(): number;
  /** Fails when the run made fewer requests than the script has answers. */
  assertConsumed(): void;
}

/** Digest of a value as it will be compared: 16 hex characters is plenty to notice drift and short enough to read. */
export function digest(value: unknown): string {
  return createHash('sha256')
    .update(typeof value === 'string' ? value : JSON.stringify(value))
    .digest('hex')
    .slice(0, 16);
}

/**
 * A tool catalogue as the snapshot stores it: the names, the bytes and a digest, never the schemas themselves.
 *
 * One function for both places a catalogue shows up — the request the run sent and the envelope it recorded — so
 * the two cannot describe the same catalogue in two shapes. Inlining them would put tens of kilobytes of schemas
 * into every snapshot file, which makes the file unreadable and turns any description tweak into a wall of diff;
 * the digest notices the same drift in one line.
 */
export function toolFingerprint(tools: readonly { name: string }[]): {
  names: string[];
  chars: number;
  digest: string;
} {
  const json = JSON.stringify(tools);
  return { names: tools.map((tool) => tool.name), chars: json.length, digest: digest(json) };
}

/** A request as the snapshot stores it. */
export function fingerprint(request: ModelRequest): RequestFingerprint {
  const system = request.system;
  return {
    model: request.model ?? null,
    reasoningEffort: request.reasoningEffort ?? null,
    maxOutputTokens: request.maxOutputTokens,
    cacheKey: request.cacheKey ?? null,
    system: { chars: system.length, digest: digest(system) },
    tools: toolFingerprint(request.tools),
    messages: request.messages.map((message) => ({
      role: message.role,
      chars: message.content.length,
      digest: digest(visibleMessage(message)),
      toolCalls: message.role === 'assistant' ? message.toolCalls.map((call) => call.name) : [],
    })),
  };
}

/**
 * What the model is shown, with the storage bookkeeping removed.
 *
 * A `Message` carries more than the model sees: a user turn has a `createdAt`, a tool result carries the
 * file-change journal entry it produced (whose `id` is generated per run). Digesting the whole object would make
 * every fingerprint differ between two identical runs, so the digest covers exactly the conversation — the
 * text, the tool calls, the image bytes — and nothing about when or where it was stored. The same text is
 * visible in the snapshot's transcript either way, so nothing is hidden by leaving it out here.
 */
function visibleMessage(message: Message): Record<string, unknown> {
  if (message.role === 'user')
    return {
      role: 'user',
      content: message.content,
      ...(message.displayContent === undefined ? {} : { displayContent: message.displayContent }),
      ...(message.images
        ? {
            images: message.images.map((image) => ({
              mimeType: image.mimeType,
              digest: digest(image.data),
            })),
          }
        : {}),
    };
  if (message.role === 'assistant')
    return { role: 'assistant', content: message.content, toolCalls: message.toolCalls };
  return {
    role: 'tool',
    toolCallId: message.toolCallId,
    content: message.content,
    isError: message.isError,
  };
}

/**
 * Answer from a script, in order, one entry per request.
 *
 * Deliberately positional: the *n*th request gets the *n*th answer. Matching by content would let a run that
 * started asking something new quietly reuse an old answer, which is the failure mode this is here to prevent.
 */
export function replayProvider(
  script: readonly ScriptedCall[],
  options: { onRequest?: (request: ModelRequest, index: number) => void } = {},
): ReplayProvider {
  const requests: ModelRequest[] = [];
  return {
    requests,
    consumed: () => Math.min(requests.length, script.length),
    assertConsumed() {
      if (requests.length >= script.length) return;
      const unused = script
        .slice(requests.length)
        .map((call, index) => `${requests.length + index}${expectationOf(call)}`)
        .join(', ');
      throw new Error(
        `replay script was not consumed: the run made ${requests.length} request(s) but the script has ${script.length} answer(s); unused: ${unused}`,
      );
    },
    async complete(request: ModelRequest): Promise<ModelResponse> {
      const index = requests.length;
      requests.push(request);
      options.onRequest?.(request, index);
      const scripted = script[index];
      if (!scripted)
        throw new Error(
          `replay script exhausted: request ${index + 1} has no answer (script has ${script.length}); the run asked something the recording does not cover`,
        );
      assertWhen(scripted, request, index);
      if (scripted.failure)
        throw new RunFailure(scripted.failure.code, scripted.failure.message, {
          ...(scripted.failure.retryAfterMs === undefined
            ? {}
            : { retryAfterMs: scripted.failure.retryAfterMs }),
        });
      if (scripted.reasoning) request.onReasoning?.(scripted.reasoning);
      if (scripted.text) request.onText(scripted.text);
      const toolCalls = scripted.toolCalls ?? [];
      return {
        text: scripted.text ?? '',
        toolCalls,
        finishReason: scripted.finishReason ?? (toolCalls.length ? 'tool_calls' : 'stop'),
        usage: scripted.usage ?? SCRIPTED_USAGE,
        ...(scripted.truncation ? { truncation: scripted.truncation } : {}),
        ...(scripted.providerState ? { providerState: scripted.providerState } : {}),
      };
    },
  };
}

/**
 * How an unused answer names the request it was waiting for.
 *
 * Whichever expectation the script stated, in the script's own words: an unused entry reported as "1" alone
 * makes the reader open the scenario to find out what it was for.
 */
function expectationOf(call: ScriptedCall): string {
  if (call.when?.messageIncludes) return ` (message: ${call.when.messageIncludes})`;
  if (call.when?.systemIncludes) return ` (system: ${call.when.systemIncludes})`;
  return '';
}

function assertWhen(scripted: ScriptedCall, request: ModelRequest, index: number): void {
  const expected = scripted.when;
  if (!expected) return;
  const at = `replay script entry ${index + 1}`;
  if (expected.systemIncludes && !request.system.includes(expected.systemIncludes))
    throw new Error(
      `${at} expected a request whose system prompt contains ${JSON.stringify(expected.systemIncludes)}, but this one does not`,
    );
  if (expected.messageIncludes) {
    const last = String(request.messages.at(-1)?.content ?? '');
    if (!last.includes(expected.messageIncludes))
      throw new Error(
        `${at} expected a request whose last message contains ${JSON.stringify(expected.messageIncludes)}, but this one does not`,
      );
  }
  if (expected.messageRoles) {
    const roles = request.messages.map((message) => message.role);
    if (roles.join(',') !== expected.messageRoles.join(','))
      throw new Error(
        `${at} expected messages [${expected.messageRoles.join(', ')}] but got [${roles.join(', ')}]`,
      );
  }
}

/** Wrap a provider so every call is captured in the shape a script can replay. */
export function recordingProvider(inner: Provider, sink: (entry: ScriptEntry) => void): Provider {
  return {
    async complete(request: ModelRequest): Promise<ModelResponse> {
      const response = await inner.complete(request);
      sink({ request: fingerprint(request), response: scriptedFrom(response) });
      return response;
    },
  };
}

/** The part of a response a script can hold. */
export function scriptedFrom(response: ModelResponse): ScriptedCall {
  return {
    text: response.text,
    ...(response.toolCalls.length ? { toolCalls: response.toolCalls } : {}),
    finishReason: response.finishReason,
    usage: response.usage,
    ...(response.truncation ? { truncation: response.truncation } : {}),
    ...(response.providerState ? { providerState: response.providerState } : {}),
  };
}

/** One JSON object per line: appendable, greppable, and survives a run that dies in the middle. */
export function scriptLines(entries: readonly ScriptEntry[]): string {
  return entries.map((entry) => JSON.stringify(entry)).join('\n') + (entries.length ? '\n' : '');
}

/** Read a captured script back, refusing anything that is not one. */
export function parseScript(text: string): ScriptEntry[] {
  const entries: ScriptEntry[] = [];
  for (const [index, line] of text.split('\n').entries()) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (cause) {
      throw new Error(`script line ${index + 1} is not JSON: ${String(cause)}`);
    }
    if (!parsed || typeof parsed !== 'object' || !('request' in parsed) || !('response' in parsed))
      throw new Error(`script line ${index + 1} is not a {request, response} entry`);
    entries.push(parsed as ScriptEntry);
  }
  return entries;
}
