import type { Message, ToolSpec, Usage } from './index.ts';

/** The wrapper a runtime snapshot is announced in (`packages/core/context/runtime.ts` writes it). */
export const RUNTIME_CONTEXT_TAG = 'runtime-context';
/** The wrapper a compaction summary is written in (`packages/core/context/context.ts` writes it). */
export const COMPACTION_SUMMARY_TAG = 'compacted-summary';
/**
 * Whether a message is a runtime snapshot rather than something a person said. Shared by the
 * desktop transcript, the storage layer and the title path.
 */
export function isRuntimeContext(content: string): boolean {
  return content.startsWith(`<${RUNTIME_CONTEXT_TAG} `);
}
/**
 * Whether a message is machine-written context (runtime snapshot or compaction summary). Neither is
 * a request, so neither may name a session.
 */
export function isMachineContext(content: string): boolean {
  return isRuntimeContext(content) || content.startsWith(`<${COMPACTION_SUMMARY_TAG}>`);
}
/** Cut points only after complete tool-call/result groups. */
export function contextBoundaries(history: Message[]): number[] {
  const pending = new Set<string>(),
    cuts = [0];
  history.forEach((message, index) => {
    if (message.role === 'assistant') for (const call of message.toolCalls) pending.add(call.id);
    if (message.role === 'tool') pending.delete(message.toolCallId);
    if (!pending.size) cuts.push(index + 1);
  });
  return cuts;
}
export function contextTail(history: Message[], covered: number): Message[] {
  const tail = history.slice(covered);
  if (covered && tail[0]?.role !== 'user') {
    for (let i = covered - 1; i >= 0; i--)
      if (history[i]!.role === 'user') {
        tail.unshift(history[i]!);
        break;
      }
  }
  // The current model is request state, so keep its latest announcement even when this request
  // compacts it (including overflow retries). Done before budgeting so it is counted.
  if (covered) {
    const model = history.findLast(
      (message) =>
        message.role === 'user' &&
        message.content.startsWith(`<${RUNTIME_CONTEXT_TAG} source="model">\n`) &&
        message.content.endsWith(`\n</${RUNTIME_CONTEXT_TAG}>`),
    );
    if (model && !tail.includes(model)) tail.unshift(model);
  }
  return tail;
}
/**
 * One recorded surface replacement: which part of the transcript it covers and what replaced it.
 * This event is the only record of a compaction, so the surface is a fold of the log.
 *
 * `startSeq`/`endSeq` are log positions, which can be checked against the records;
 * `coveredMessages` is the count the tail rule cuts at, kept so the two can be compared.
 */
export interface SurfaceOp {
  /** 1-based position in this session's compaction history. Each summary subsumes the one before it. */
  generation: number;
  /** Log position of the first covered message. */
  startSeq: number;
  /** Log position of the last covered message. */
  endSeq: number;
  /** How many messages the op covers — the count `contextTail` cuts at. */
  coveredMessages: number;
  /** What the covered messages were replaced by, merged cumulatively with every earlier summary. */
  summary: string;
  /** What the summary request that produced it cost. */
  usage?: Usage;
  /**
   * The protocol, model and output budget of the summary request. The request envelope itself is
   * recorded as `context.envelope`. Absent on records from older builds.
   */
  protocol?: string;
  model?: string;
  maxTokens?: number;
  /**
   * The model's raw answer, present only when storing changed it; absent means `summary` is
   * verbatim.
   */
  rawOutput?: string;
  /** Characters the surface cost before the op (summary + tail), and after it. */
  replacedChars?: number;
  surfaceChars?: number;
}
/** The surface as a reader needs it: which messages are still shown, and what stands in for the rest. */
export interface Surface {
  generation: number;
  coveredMessages: number;
  summary: string;
}
/** The surface the newest op defines — `null` when the log records no compaction at all. */
export function surfaceOf(ops: readonly SurfaceOp[]): Surface | null {
  const latest = ops.at(-1);
  return latest
    ? {
        generation: latest.generation,
        coveredMessages: latest.coveredMessages,
        summary: latest.summary,
      }
    : null;
}
/**
 * The surface as of one generation, ignoring later ops, so what the model saw at that compaction
 * does not depend on later ones.
 */
export function surfaceAt(ops: readonly SurfaceOp[], generation: number): Surface | null {
  const op = ops.find((entry) => entry.generation === generation);
  return op
    ? { generation: op.generation, coveredMessages: op.coveredMessages, summary: op.summary }
    : null;
}
/**
 * What one round of a run asked the model to read: the system prompt and tool catalogue, as opposed
 * to the conversation. Recorded so a past round can be audited after `AGENTS.md`, memory or skills
 * changed.
 *
 * 1. Identity is a digest: `systemHash`/`toolsHash` answer "same prompt as that round?".
 * 2. The text is carried once per distinct prompt per run; `foldContextEnvelopes` fills in the
 *    rest.
 * 3. The cap is explicit: `systemBytes` is the true size and `systemTruncated` flags a prefix.
 */
export interface ContextEnvelope {
  /** The run that sent this round. Needed because `round` counts from zero again in every run. */
  runId: string;
  round: number;
  /** The model the round aimed at, or `null` when the embedder declared none. */
  model: string | null;
  maxOutputTokens: number;
  /** The window this round was measured against, when one was declared. */
  maxContextTokens?: number;
  /** The provider cache key the request carried, so two rounds can be compared on their cacheable prefix too. */
  cacheKey?: string;
  systemHash: string;
  systemBytes: number;
  /** The prompt itself, present on the record that carries it. See decision 2 above. */
  system?: string;
  /** True when `system` is a prefix of a prompt longer than `ENVELOPE_SYSTEM_CHARS`. */
  systemTruncated?: boolean;
  toolsHash: string;
  toolsBytes: number;
  toolsCount: number;
  /**
   * The catalogue, under the same one-copy rule as the prompt. Carried in full so manual compaction
   * can replay byte-identical tool schemas and keep the cache prefix.
   */
  tools?: ToolSpec[];
}
/** How much of a system prompt one record keeps. See decision 3 above, and `envelopeEvent` for the policy. */
export const ENVELOPE_SYSTEM_CHARS = 32 * 1024;
/**
 * Every round's envelope, oldest first, with an omitted prompt filled in by hash from the record
 * that carries it. Text that never appears stays absent. Records with damaged identity are refused
 * as corrupt, not skipped.
 */
export function foldContextEnvelopes(
  events: readonly { type: string; data: Record<string, unknown> }[],
): ContextEnvelope[] {
  const carried = new Map<string, { system: string; truncated: boolean }>();
  const catalogues = new Map<string, ToolSpec[]>();
  const envelopes: ContextEnvelope[] = [];
  for (const event of events) {
    if (event.type !== 'context.envelope') continue;
    const record = envelopeOf(event.data);
    if (record.system !== undefined)
      carried.set(record.systemHash, {
        system: record.system,
        truncated: record.systemTruncated === true,
      });
    if (record.tools !== undefined) catalogues.set(record.toolsHash, record.tools);
    const text = carried.get(record.systemHash);
    const tools = catalogues.get(record.toolsHash);
    envelopes.push({
      ...record,
      ...(text ? { system: text.system } : {}),
      ...(text?.truncated ? { systemTruncated: true } : {}),
      ...(tools ? { tools } : {}),
    });
  }
  return envelopes;
}
function envelopeOf(data: Record<string, unknown>): ContextEnvelope {
  const corrupt = (detail: string): never => {
    throw new Error(
      `Session log event context.envelope has ${detail}; the envelope cannot be reconstructed, so the log is corrupt`,
    );
  };
  if (!data || typeof data !== 'object' || Array.isArray(data)) corrupt('an invalid payload');
  const identity = (value: unknown): string | undefined =>
    typeof value === 'string' && value ? value : undefined;
  const systemHash = identity(data.systemHash);
  const toolsHash = identity(data.toolsHash);
  const runId = identity(data.runId);
  if (!systemHash || !toolsHash || !runId)
    throw new Error(
      'Session log event context.envelope has no run, system hash or tool hash; the envelope cannot be reconstructed, so the log is corrupt',
    );
  const count = (field: string): number => {
    // Older records may omit measurements; a present value must remain a count rather than be coerced.
    const value = data[field];
    if (value === undefined) return 0;
    if (!Number.isSafeInteger(value) || (value as number) < 0) corrupt(`an invalid ${field}`);
    return value as number;
  };
  if (
    data.tools !== undefined &&
    (!Array.isArray(data.tools) ||
      !data.tools.every(
        (tool) =>
          tool &&
          typeof tool === 'object' &&
          !Array.isArray(tool) &&
          typeof tool.name === 'string' &&
          typeof tool.description === 'string' &&
          tool.inputSchema &&
          typeof tool.inputSchema === 'object' &&
          !Array.isArray(tool.inputSchema),
      ))
  )
    corrupt('an invalid tool catalogue');
  return {
    runId,
    round: count('round'),
    model: typeof data.model === 'string' ? data.model : null,
    maxOutputTokens: count('maxOutputTokens'),
    ...(data.maxContextTokens === undefined ? {} : { maxContextTokens: count('maxContextTokens') }),
    ...(identity(data.cacheKey) === undefined ? {} : { cacheKey: data.cacheKey as string }),
    systemHash,
    systemBytes: count('systemBytes'),
    ...(typeof data.system === 'string' ? { system: data.system } : {}),
    ...(data.systemTruncated === true ? { systemTruncated: true } : {}),
    toolsHash,
    toolsBytes: count('toolsBytes'),
    toolsCount: count('toolsCount'),
    // Absent catalogues are valid legacy/deduplicated records; malformed present catalogues are corruption.
    ...(Array.isArray(data.tools) ? { tools: data.tools as ToolSpec[] } : {}),
  };
}
