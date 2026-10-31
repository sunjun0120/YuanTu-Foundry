import { createHash } from 'node:crypto';
import { ENVELOPE_SYSTEM_CHARS, type ContextEnvelope } from '../protocol/context.ts';
import type { ToolSpec } from '../protocol/index.ts';

/**
 * The envelope record a round writes to the log. Shape and reader live in
 * `packages/protocol/context.ts`; the digest and copy policy live here because they need
 * `node:crypto`.
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
   * The system hash already recorded (seeded from the session's newest record), so an unchanged
   * prompt writes only its identity.
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
   * The copy, capped in characters; `systemBytes` records the real size so truncation is visible.
   */
  if (input.previousSystemHash !== systemHash) {
    if (input.system.length <= ENVELOPE_SYSTEM_CHARS) envelope.system = input.system;
    else {
      envelope.system = input.system.slice(0, ENVELOPE_SYSTEM_CHARS);
      envelope.systemTruncated = true;
    }
  }
  /**
   * The catalogue, under the same one-copy rule but uncapped: it is replayed, and a shortened one
   * would break the prefix.
   */
  if (input.previousToolsHash !== toolsHash) envelope.tools = [...input.tools];
  return { envelope, systemHash, toolsHash };
}

/** The identity of one part of the envelope. Full length: this is a record to audit, not a cache key to route. */
function digest(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}
