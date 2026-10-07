import type { Message, ToolSpec } from '../protocol/index.ts';
import { RunFailure } from '../protocol/failure.ts';
import type { PartFactors } from './calibration.ts';
/**
 * The conversation or the current request does not fit the model's window, with room left for it to answer.
 *
 * One wall, so one code. It used to carry a second one for "this run has spent its own token allowance", and
 * a reader had to tell them apart because the two wanted different next steps: a smaller task for the window,
 * a bigger limit for the allowance. There is no allowance any more — a per-request window is the only ceiling,
 * and "make the request smaller" is the only answer — so the distinction would be a branch with one branch.
 */
export class ContextLimitError extends RunFailure {
  constructor(message: string, code: 'context-window-exceeded' = 'context-window-exceeded') {
    super(code, message);
    this.name = 'ContextLimitError';
  }
}
/** The three parts of a request, as the bytes the provider is billed for. */
export interface RequestBytes {
  system: number;
  tools: number;
  messages: number;
}
/** One request, measured once: the totals, the breakdown, and the serialised size of each part. */
export interface RequestMeasure {
  rawInputTokens: number;
  inputTokens: number;
  breakdown: ContextBreakdown;
  bytes: RequestBytes;
}
/** The replacer both the estimator and the breakdown use, so "what is sent" has one definition. */
function counted(value: unknown, onImages: (count: number) => void): string {
  return JSON.stringify(value, (key, entry) => {
    // A tool result's journal entry is storage bookkeeping, and reasoning is display-only: neither is sent, and
    // counting either would make the estimate grow with text the provider never receives.
    if (key === 'change' || key === 'reasoning') return undefined;
    if (key === 'images' && Array.isArray(entry)) {
      onImages(entry.length);
      return entry.map((image) => ({ mimeType: image.mimeType, name: image.name }));
    }
    return entry;
  });
}
/**
 * The parts' serialised sizes and image counts, computed once each and reused for the total and the breakdown.
 *
 * `messages` is measured as the array minus its own punctuation: `JSON.stringify` of an array is `[`, the parts
 * joined by `,`, and `]`, and each part is exactly what `counted` returns for that message. That identity is what
 * lets the whole-request size be assembled from the parts instead of serialising the request a second time — and
 * it is asserted, part by part, in `tests/token-measure.test.ts` against the real serialisation.
 *
 * The two image counts are kept apart because the two answers used them apart: the total counts every image in the
 * request (a tool schema can carry one), while the breakdown's overhead counted only what is reachable from the
 * messages. `measureRequest` says why that asymmetry is preserved rather than fixed here.
 */
/**
 * What one message costs to serialise, remembered by identity.
 *
 * A round asks the same question several times about overlapping conversations: does the request fit, what is the
 * forecast it acts on, what would the retained tail cost, would this summary batch fit, what did the compaction
 * free. Every one of those walks and re-serialises every message, so the cost of a round is proportional to the
 * whole conversation rather than to what the round added — the wrong shape for a long session, and the reason this
 * file exists in the shape it does.
 *
 * The cache is keyed by the message *object*, so it is sound exactly while messages are immutable. They are: the
 * store's fold returns frozen messages (`reads are frozen, because they are the store's own fold`), and every
 * transformation in this package builds a new message rather than editing one (`shortenMessages`, `withSummary`,
 * the summary snapshot, the compaction surface). Identity is what makes "unchanged" free to check; a caller that
 * mutated a message in place would get the size the object used to have, which is why the freeze matters and why
 * this is a `WeakMap` on the object rather than a digest of its content.
 */
const messageSizes = new WeakMap<Message, { bytes: number; images: number }>();
function messageSize(message: Message): { bytes: number; images: number } {
  const cached = messageSizes.get(message);
  if (cached) return cached;
  let images = 0;
  const size = {
    bytes: Buffer.byteLength(
      counted(message, (count) => (images += count)),
      'utf8',
    ),
    images,
  };
  messageSizes.set(message, size);
  return size;
}
function requestBytes(
  system: string,
  messages: Message[],
  tools: ToolSpec[],
): { bytes: RequestBytes; messageImages: number; toolImages: number } {
  let messageImages = 0;
  let messageBytes = 0;
  for (const message of messages) {
    const size = messageSize(message);
    messageBytes += size.bytes;
    messageImages += size.images;
  }
  let toolImages = 0;
  const toolsBytes = Buffer.byteLength(
    counted(tools, (count) => (toolImages += count)),
    'utf8',
  );
  return {
    bytes: {
      system: Buffer.byteLength(JSON.stringify(system), 'utf8'),
      tools: toolsBytes,
      messages: 2 + messageBytes + Math.max(0, messages.length - 1),
    },
    messageImages,
    toolImages,
  };
}
/**
 * The correction a request made of these parts is sized with: the blend of the per-part weights over its bytes.
 *
 * Exported because the arithmetic has two sides — the estimate applies it, and the calibration that learns the
 * weights has to know which correction the request it is observing was actually sized against. One function, so
 * "what this request was measured with" has one answer.
 */
export function blendFactors(factors: PartFactors, bytes: RequestBytes): number {
  const total = bytes.system + bytes.tools + bytes.messages;
  if (total <= 0) return factors.messages;
  return (
    (bytes.system * factors.system +
      bytes.tools * factors.tools +
      bytes.messages * factors.messages) /
    total
  );
}
/**
 * The measurement of one request, in one traversal.
 *
 * Everything about a request's size is derived from the same three part sizes: the uncorrected estimate, the
 * calibrated one, and the breakdown that says which part is spending the window. Computing those separately is
 * what made a round cost about six serialisations of the whole conversation — the estimator ran twice (once per
 * factor) and the breakdown serialised the parts again — and this is the one place that answers all of it.
 *
 * `factor` corrects the request as a whole; `factors` corrects each part by its own learned weight (see
 * `TokenCalibration`), and the two are the same number of multiplications either way because a request's
 * correction is the *blend* of the per-part weights over its own bytes. A caller with no per-part measurement
 * passes nothing and gets the arithmetic a single ratio always produced.
 */
export function measureRequest(input: {
  system: string;
  messages: Message[];
  tools: ToolSpec[];
  factor?: number;
  factors?: PartFactors;
}): RequestMeasure {
  const measured = requestBytes(input.system, input.messages, input.tools);
  const partBytes = measured.bytes;
  const factor = input.factors ? blendFactors(input.factors, partBytes) : (input.factor ?? 1);
  /**
   * The request's own size, assembled from the parts.
   *
   * `JSON.stringify({system, messages, tools})` writes exactly `{"system":`, the serialised system, `,"messages":`,
   * the serialised array, `,"tools":`, the serialised tools and `}` — 32 characters of punctuation and key names
   * around the three sizes measured above. No second serialisation, and no second answer.
   */
  const requestBytesTotal = 32 + partBytes.system + partBytes.messages + partBytes.tools;
  const text = Math.ceil(requestBytesTotal / 3);
  const overhead = 256 + (measured.messageImages + measured.toolImages) * 4096;
  const rawInputTokens = Math.max(1, text) + overhead;
  const inputTokens = Math.max(1, Math.ceil(text * factor)) + overhead;
  /**
   * The breakdown's overhead counts only what is reachable from the *messages*, which is how it was computed
   * before: the estimator walks the whole request (so an `images` array inside a tool schema counts towards the
   * total) while the breakdown's own walk covered the conversation. The asymmetry is preserved rather than fixed
   * here — this change is an optimisation, and a differential test means nothing while the numbers move.
   */
  const breakdownOverhead = Math.max(0, 256 + measured.messageImages * 4096);
  /**
   * The split follows the *corrected* belief about each part, not its raw bytes: a route whose catalogue is
   * overestimated and whose conversation is underestimated should show the catalogue carrying the larger share
   * of what it is charged for, which is the whole point of separating the weights. With three equal weights the
   * shares are the byte shares, so this is the number every reader already had.
   */
  const weighted = input.factors
    ? {
        system: partBytes.system * input.factors.system,
        tools: partBytes.tools * input.factors.tools,
        messages: partBytes.messages * input.factors.messages,
      }
    : partBytes;
  const textBytes = Math.max(1, weighted.system + weighted.tools + weighted.messages);
  const textTokens = Math.max(0, inputTokens - breakdownOverhead);
  const share = (part: number): number => Math.round((textTokens * part) / textBytes);
  const systemTokens = share(weighted.system);
  const toolsTokens = share(weighted.tools);
  return {
    rawInputTokens,
    inputTokens,
    breakdown: {
      system: systemTokens,
      tools: toolsTokens,
      // Whatever rounding left over is settled here, so the parts sum to the total exactly.
      messages: Math.max(0, textTokens - systemTokens - toolsTokens),
      overhead: breakdownOverhead,
      total: inputTokens,
    },
    bytes: partBytes,
  };
}
/**
 * What one message costs the window, without the request's own margin.
 *
 * `estimateInputTokens` answers "what does this *request* cost", and its 256-token protocol margin belongs to the
 * request rather than to any message in it. Summing that answer over messages therefore charged every message for
 * the whole request's margin — a two-hundred-byte message, truly about sixty-seven tokens, measured as three
 * hundred and twenty-three — which is how a retention budget ended up keeping far less verbatim history than the
 * policy asked for. The image allowance is *not* a margin: a picture really does spend that window, so it stays.
 *
 * `factor` is the same learned correction the request estimate applies, because a message's cost is measured in
 * the same tokens the window is counted in.
 */
export function estimateMessageTokens(message: Message, factor = 1): number {
  const counted_ = requestBytes('', [message], []);
  const text = Math.ceil(counted_.bytes.messages / 3);
  return Math.max(1, Math.ceil(text * factor)) + counted_.messageImages * 4096;
}
/**
 * Local estimate, not a tokenizer or a supplier-side spending guarantee.
 *
 * `factor` is the learned correction from TokenCalibration. It scales only the
 * byte-derived part: the fixed protocol margin stays a margin, and image tokens are
 * already a per-image provider-side allowance that a text ratio must not distort.
 */
export function estimateInputTokens(
  system: string,
  messages: Message[],
  tools: ToolSpec[],
  factor = 1,
): number {
  return measureRequest({ system, messages, tools, factor }).inputTokens;
}
/** Where one request's estimated input goes. The four numbers add up to `total`, by construction. */
export interface ContextBreakdown {
  system: number;
  tools: number;
  messages: number;
  /** The fixed protocol margin and the per-image allowance, which belong to no part of the request. */
  overhead: number;
  total: number;
}
/**
 * The same estimate, split by what is spending it.
 *
 * "The request is too big" is only actionable if the reader can see *which* part is big: a catalog of sixty tool
 * schemas costs more than most conversations, and a run that keeps compressing its history while sending 30 KB of
 * schemas is optimising the wrong half. The breakdown answers that without a second estimator to drift from the
 * first one:
 *
 * - `total` is exactly `estimateInputTokens` — the number the run is actually deciding on;
 * - the text part of that total is split **in proportion to each part's serialised bytes**, and the fixed
 *   margin plus any image allowance go to `overhead` (attributing them to a part would be inventing a number);
 * - rounding is settled on `messages`, so the four terms always add up to `total` — a breakdown whose parts do
 *   not sum to its own total is worse than no breakdown.
 */
export function contextBreakdown(
  system: string,
  messages: Message[],
  tools: ToolSpec[],
  factor = 1,
): ContextBreakdown {
  return measureRequest({ system, messages, tools, factor }).breakdown;
}
