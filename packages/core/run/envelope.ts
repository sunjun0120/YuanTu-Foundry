import type { ToolSpec } from '../../protocol/index.ts';
import type { SessionStore } from '../../storage/sqlite.ts';
import { envelopeEvent } from '../envelope.ts';

/**
 * What each round of a run asked the model to read, recorded once per request the round decided on.
 *
 * The record is `context.system` rather than the compose step's own text, and that is not a detail:
 * `prepareContext` is free to change what it is given — it is the call that decides whether to compress, and that
 * decision can rewrite the prompt — so the prompt the request carries is only knowable after it. A record taken
 * earlier would name a prompt nobody was ever sent.
 *
 * Once per round, plus once more when a provider-confirmed overflow re-prepares the context and re-sends under a
 * different summary — that round really did send two envelopes, and the log says so rather than keeping only the
 * first. Retries are deliberately not recorded again: they re-send the same request, so a second record would be
 * a second answer to a question that has one.
 */
export class RunEnvelopes {
  private readonly store: SessionStore;
  private readonly sessionId: string;
  private readonly runId: string;
  /**
   * The identities the session's newest envelope already carries, so this run records rather than re-copies.
   *
   * Seeded from the log rather than from an empty hand: a reopened session whose prompt and catalogue have not
   * changed since the last run would otherwise write a second copy of each — and the catalogue is the large
   * half, so that is the copy worth avoiding. Within the run these are updated as rounds go, so a prompt that
   * changes mid-run still arrives with its own text.
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
