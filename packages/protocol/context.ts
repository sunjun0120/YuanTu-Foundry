import type { Message, ToolSpec, Usage } from './index.ts';

/** The wrapper a runtime snapshot is announced in (`packages/core/runtime-context.ts` writes it). */
export const RUNTIME_CONTEXT_TAG = 'runtime-context';
/** The wrapper a compaction summary is written in (`packages/core/context.ts` writes it). */
export const COMPACTION_SUMMARY_TAG = 'compacted-summary';
/**
 * Whether a message is a runtime snapshot rather than something a person said.
 *
 * The wrapper is the runtime's, so the tag lives here — with the readers that have to agree about it: the
 * desktop's transcript (what to draw), the storage layer (which message may name a session) and the title path
 * (whether a session has been asked anything yet). Each of them used to answer by matching text of its own.
 */
export function isRuntimeContext(content: string): boolean {
  return content.startsWith(`<${RUNTIME_CONTEXT_TAG} `);
}
/**
 * Whether a message is machine-written context of any kind, rather than somebody's words.
 *
 * Both wrappers say "this is not a person talking", which is the whole answer a reader needs: a runtime
 * snapshot is bookkeeping the model must see, and a compaction summary is the conversation compressed. Neither
 * is a request, so neither may name a session.
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
  return tail;
}
/**
 * One recorded surface replacement: which part of the transcript it covers, and what replaced it.
 *
 * This is the *only* record of what a compaction did. It used to be a row in its own table, which meant the
 * question "what did the model see?" had two answers — the row and the log — and the row was the one readers
 * trusted, so a compaction history could not be replayed, compared or branched: each new summary overwrote
 * the previous one and only the last cut survived. As an event it is ordered and permanent, so the surface
 * is a fold of the log like every other derived view.
 *
 * `startSeq`/`endSeq` are log positions of the covered messages, not counts. A count says "the first N
 * messages" and silently re-points if the transcript ever changes under it; a range says which *records* were
 * replaced and can be checked against them. `coveredMessages` is still carried because the tail rule needs a
 * count, and having both is what lets the two be compared instead of assumed to agree.
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
   * The protocol and model that answered the summary, and the output budget that request was given.
   *
   * The request's *envelope* — the system prompt and tool catalogue it replayed — is recorded per round as
   * `context.envelope`, so these fields are what complete the picture: a reader can say which prompt, which
   * adapter, which model and which budget produced the summary standing in for the conversation. `protocol` is
   * this runtime's word for the provider (the wire adapter that answered). Absent for a record written by a build
   * that did not keep them, which is the only honest reading of silence here.
   */
  protocol?: string;
  model?: string;
  maxTokens?: number;
  /**
   * The model's answer exactly as it arrived, present only when storing it changed something.
   *
   * `summary` is what the next request carries; this is what came back before the wrapper the transcript shows
   * was taken off it. Silence is therefore a fact rather than a gap: the stored summary is the model's own text,
   * verbatim. A record that kept both would be carrying the same paragraph twice to say nothing new.
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
 * The surface as of one generation: what a reader (or a branch) that stopped there would see.
 *
 * Later ops are not applied, so the messages they covered are still part of the tail. That is the point —
 * "what did the model see when the conversation was last compacted" has an answer that does not depend on
 * how many compactions happened afterwards.
 */
export function surfaceAt(ops: readonly SurfaceOp[], generation: number): Surface | null {
  const op = ops.find((entry) => entry.generation === generation);
  return op
    ? { generation: op.generation, coveredMessages: op.coveredMessages, summary: op.summary }
    : null;
}
/**
 * What one round of one run asked the model to read: the *envelope*, as opposed to the conversation.
 *
 * The durable log's headline property is "model-visible ⇒ recorded", and the transcript half of it was already
 * true — every message the model was given is an event. The envelope half was not. The system prompt and the tool
 * catalogue were request fields and nothing else (`run.started` carries `{runId, ownerPid}`), so a session
 * reopened after the workspace's `AGENTS.md`, memory or skills had changed could not answer the only question
 * worth asking about a past round: what was this request actually made of? The compaction summary *was* in the
 * log, and the prompt it was produced under was not, which is exactly why a summary could not be audited against
 * the request that produced it.
 *
 * Three decisions make the record worth keeping:
 *
 * 1. **Identity is a digest.** `systemHash`/`toolsHash` are what a reader compares to answer "was this the same
 *    prompt as that round?" — cheaply, and without the text being carried twice.
 * 2. **The text is carried once per distinct prompt per run.** A round whose system prompt is unchanged records
 *    the identity and nothing else, so a hundred-round run on one prompt costs one copy of it; a prompt that
 *    changed — a new goal, an approved plan, a fresh compaction summary — arrives with its own copy. The reader
 *    in `foldContextEnvelopes` puts the two halves back together.
 * 3. **The cap is stated and the truncation is flagged.** `systemBytes` is the prompt's true size and
 *    `systemTruncated` says the copy is a prefix of it, so a shortened record can never be mistaken for the whole
 *    prompt — the failure the tool path's `[output truncated]` marker exists to prevent, and one this record must
 *    not reintroduce for the one artifact a reader has no other copy of.
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
   * The catalogue itself, present on the record that carries it — the same one-copy rule as the prompt.
   *
   * It is carried rather than only digested because the catalogue is what a *replayed* request needs to be byte
   * identical to the round it replays: manual compaction compresses a session outside any run, and without the
   * exact schemas its summary request would share no prefix with the conversation it is summarising, which is the
   * cache hit the request's whole shape exists for. Recording it is what lets that path use the real envelope
   * instead of an empty one.
   */
  tools?: ToolSpec[];
}
/** How much of a system prompt one record keeps. See decision 3 above, and `envelopeEvent` for the policy. */
export const ENVELOPE_SYSTEM_CHARS = 32 * 1024;
/**
 * Every round's envelope in a log, oldest first, with an omitted prompt filled in from the record that carries it.
 *
 * The fill-in is the reader's half of decision 2: a record without `system` means "the same prompt as the last
 * record that named this hash", so the text is looked up by hash rather than repeated. A record whose text never
 * appears anywhere is left as it is — identity without content is a real state (an older build's log, a record a
 * cap truncated), and inventing text for it would be worse than reporting the gap by omission.
 *
 * Damaged identity is refused rather than skipped, the way `foldPendingInputs` refuses a `queued` record with no
 * id: an envelope record that cannot say what it was is not a smaller fact, it is a corrupt one, and quietly
 * dropping it would leave an audit that looks complete and is not.
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
  const identity = (value: unknown): string | undefined =>
    typeof value === 'string' && value ? value : undefined;
  const systemHash = identity(data.systemHash);
  const toolsHash = identity(data.toolsHash);
  const runId = identity(data.runId);
  if (!systemHash || !toolsHash || !runId)
    throw new Error(
      'Session log event context.envelope has no run, system hash or tool hash; the envelope cannot be reconstructed, so the log is corrupt',
    );
  return {
    runId,
    round: Number(data.round ?? 0),
    model: typeof data.model === 'string' ? data.model : null,
    maxOutputTokens: Number(data.maxOutputTokens ?? 0),
    ...(data.maxContextTokens === undefined
      ? {}
      : { maxContextTokens: Number(data.maxContextTokens) }),
    ...(identity(data.cacheKey) === undefined ? {} : { cacheKey: data.cacheKey as string }),
    systemHash,
    systemBytes: Number(data.systemBytes ?? 0),
    ...(typeof data.system === 'string' ? { system: data.system } : {}),
    ...(data.systemTruncated === true ? { systemTruncated: true } : {}),
    toolsHash,
    toolsBytes: Number(data.toolsBytes ?? 0),
    toolsCount: Number(data.toolsCount ?? 0),
    // Only the array-ness is checked here: the catalogue is this runtime's own shape, and the digest above is
    // what identifies it. A payload that is not an array is treated as absent, which the fold then resolves by
    // hash from a record that has it.
    ...(Array.isArray(data.tools) ? { tools: data.tools as ToolSpec[] } : {}),
  };
}
