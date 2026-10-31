import type { Message, ToolSpec } from '../../protocol/index.ts';
import { RunFailure } from '../../protocol/failure.ts';
import type { PartFactors } from './calibration.ts';
/**
 * The conversation or current request does not fit the model's window with room to answer. The only
 * ceiling; the remedy is always a smaller request.
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
    // Journal entries and reasoning are never sent, so they are not counted.
    if (key === 'change' || key === 'reasoning') return undefined;
    if (key === 'images' && Array.isArray(entry)) {
      onImages(entry.length);
      return entry.map((image) => ({ mimeType: image.mimeType, name: image.name }));
    }
    return entry;
  });
}
/**
 * What one message costs to serialise, cached by identity. A round asks overlapping size questions
 * many times; caching keeps the cost proportional to what changed. Sound because messages are
 * immutable (the store's fold is frozen and every transformation builds new messages).
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
/**
 * Each part's serialised size and image counts, computed once. `messages` is the array's size assembled from
 * cached per-message sizes plus its punctuation, asserted against real serialisation in
 * `tests/token-measure.test.ts`. Image counts stay split because the total and the breakdown use them
 * differently (see `measureRequest`).
 */
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
 * The blend of per-part weights over a request's bytes. Exported so the calibration knows exactly
 * what a request was sized with.
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
 * The measurement of one request in one traversal: uncorrected estimate, calibrated estimate and
 * breakdown, all from the same three part sizes. `factors` (per-part weights) or `factor` (whole
 * request); with neither, the single-ratio arithmetic applies.
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
   * The request size assembled from the parts: `JSON.stringify({system, messages, tools})` adds
   * exactly 32 characters of punctuation and keys.
   */
  const requestBytesTotal = 32 + partBytes.system + partBytes.messages + partBytes.tools;
  const text = Math.ceil(requestBytesTotal / 3);
  const overhead = 256 + (measured.messageImages + measured.toolImages) * 4096;
  const rawInputTokens = Math.max(1, text) + overhead;
  const inputTokens = Math.max(1, Math.ceil(text * factor)) + overhead;
  /**
   * The breakdown's overhead counts only images reachable from messages, while the total counts all
   * images. Preserved as-is.
   */
  const breakdownOverhead = Math.max(0, 256 + measured.messageImages * 4096);
  /** Split by corrected belief about each part, not raw bytes; equal weights give byte shares. */
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
 * What one message costs the window, without the request's 256-token margin (which belongs to the
 * request). Image allowances stay. `factor` is the learned correction.
 */
export function estimateMessageTokens(message: Message, factor = 1): number {
  const counted_ = requestBytes('', [message], []);
  const text = Math.ceil(counted_.bytes.messages / 3);
  return Math.max(1, Math.ceil(text * factor)) + counted_.messageImages * 4096;
}
/**
 * Local estimate, not a tokenizer or a spending guarantee. `factor` (from `TokenCalibration`)
 * scales only the byte-derived part; the protocol margin and per-image allowances are left alone.
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
 * The same estimate, split by part so a reader can see what is spending it (tool schemas can
 * outweigh the conversation).
 *
 * - `total` is exactly `estimateInputTokens`.
 * - Text tokens are split by serialised bytes; margin and images go to `overhead`.
 * - Rounding settles on `messages`, so the four terms sum to `total`.
 */
export function contextBreakdown(
  system: string,
  messages: Message[],
  tools: ToolSpec[],
  factor = 1,
): ContextBreakdown {
  return measureRequest({ system, messages, tools, factor }).breakdown;
}
