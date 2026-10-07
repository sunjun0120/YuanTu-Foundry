import { createHash } from 'node:crypto';
import { ENVELOPE_SYSTEM_CHARS, type ContextEnvelope } from '../protocol/context.ts';
import type { ToolSpec } from '../protocol/index.ts';

/**
 * The envelope record a round writes into the session log.
 *
 * The record's *shape* and its reader live in `packages/protocol/context.ts`; the digest and the copy policy live
 * here because they need `node:crypto` and the protocol modules are imported by the renderer, which has none. The
 * split is the same one `cacheKeyFor` keeps: the protocol states what a thing is, the kernel computes it.
 */
export function envelopeEvent(input: {
  runId: string;
  round: number;
  system: string;
  tools: readonly ToolSpec[];
  model: string | null;
  maxOutputTokens: number;
  maxContextTokens?: number;
  cacheKey?: string;
  /**
   * The system hash this run has already recorded, when it has one.
   *
   * It is what makes the record cost one copy of a prompt rather than one copy per round: an unchanged prompt
   * writes its identity and nothing else, and `foldContextEnvelopes` reads the text back from the record that
   * carried it. The caller seeds it from the session's newest record, so a *reopened* session does not pay for a
   * second copy either.
   */
  previousSystemHash?: string;
  /** The same rule for the tool catalogue, seeded and updated the same way. */
  previousToolsHash?: string;
}): { envelope: ContextEnvelope; systemHash: string; toolsHash: string } {
  const toolsJson = JSON.stringify(input.tools);
  const systemHash = digest(input.system);
  const toolsHash = digest(toolsJson);
  const envelope: ContextEnvelope = {
    runId: input.runId,
    round: input.round,
    model: input.model,
    maxOutputTokens: input.maxOutputTokens,
    ...(input.maxContextTokens === undefined ? {} : { maxContextTokens: input.maxContextTokens }),
    ...(input.cacheKey === undefined ? {} : { cacheKey: input.cacheKey }),
    systemHash,
    systemBytes: Buffer.byteLength(input.system, 'utf8'),
    toolsHash,
    toolsBytes: Buffer.byteLength(toolsJson, 'utf8'),
    toolsCount: input.tools.length,
  };
  /**
   * The copy, when this record is the one that carries it.
   *
   * The cap is in characters because a character slice is what bounds the copy — a byte cap would cut a CJK
   * prompt at a third of the characters for the same bytes and is not a thing a reader can be told the size of.
   * `systemBytes` above records the prompt's real size either way, so a truncated copy is reported as one rather
   * than passed off as the whole prompt.
   */
  if (input.previousSystemHash !== systemHash) {
    if (input.system.length <= ENVELOPE_SYSTEM_CHARS) envelope.system = input.system;
    else {
      envelope.system = input.system.slice(0, ENVELOPE_SYSTEM_CHARS);
      envelope.systemTruncated = true;
    }
  }
  /**
   * The catalogue, under the same one-copy rule, and without a cap of its own.
   *
   * A cap is right for the prompt and wrong for the schemas: the prompt is read, so a prefix is useful, while the
   * catalogue is *replayed* — a shortened one produces a request that shares no prefix with the round it replays,
   * which is worse than not recording it at all. Deduplication is what bounds it instead, and the catalogue is the
   * stable half of a run: a session that changes it changes it for a reason, and pays one copy for that reason.
   */
  if (input.previousToolsHash !== toolsHash) envelope.tools = [...input.tools];
  return { envelope, systemHash, toolsHash };
}

/** The identity of one part of the envelope. Full length: this is a record to audit, not a cache key to route. */
function digest(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}
