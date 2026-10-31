import type { ToolSpec } from '../../protocol/index.ts';
import type { SessionStore } from '../../storage/sqlite.ts';
import { envelopeEvent } from '../envelope.ts';

/**
 * What each round asked the model to read, recorded after `prepareContext` (which may rewrite the
 * prompt). Once per round, plus once more when an overflow recovery re-sends under a different
 * summary. Retries re-send the same request and are not recorded again.
 */
export class RunEnvelopes {
  private readonly store: SessionStore;
  private readonly sessionId: string;
  private readonly runId: string;
  /**
   * Identities the session's newest envelope already carries, seeded from the log and updated per
   * round, so unchanged prompts and catalogues are not copied again.
   */
  private systemHash: string | undefined;
  private toolsHash: string | undefined;

  constructor(store: SessionStore, sessionId: string, runId: string) {
    this.store = store;
    this.sessionId = sessionId;
    this.runId = runId;
    const recorded = store.newestPayload(sessionId, 'context.envelope');
    this.systemHash = typeof recorded?.systemHash === 'string' ? recorded.systemHash : undefined;
    this.toolsHash = typeof recorded?.toolsHash === 'string' ? recorded.toolsHash : undefined;
  }

  record(input: {
    round: number;
    system: string;
    tools: readonly ToolSpec[];
    model: string | null;
    maxOutputTokens: number;
    maxContextTokens: number | undefined;
    /**
     * The key belongs to the request, so the record keeps the one this request carries: it is part of what the
     * request was, not a transport detail.
     */
    cacheKey: string;
  }): void {
    const written = envelopeEvent({
      runId: this.runId,
      round: input.round,
      system: input.system,
      tools: input.tools,
      model: input.model,
      maxOutputTokens: input.maxOutputTokens,
      ...(input.maxContextTokens === undefined ? {} : { maxContextTokens: input.maxContextTokens }),
      cacheKey: input.cacheKey,
      ...(this.systemHash === undefined ? {} : { previousSystemHash: this.systemHash }),
      ...(this.toolsHash === undefined ? {} : { previousToolsHash: this.toolsHash }),
    });
    this.systemHash = written.systemHash;
    this.toolsHash = written.toolsHash;
    this.store.recordEvent(this.sessionId, 'context.envelope', { ...written.envelope });
  }
}
