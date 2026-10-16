import type { Provider, ToolSpec, Usage } from '../protocol/index.ts';
import type { SessionStatistics } from '../protocol/statistics.ts';
import { addUsage } from '../protocol/statistics.ts';
import type { SessionStore } from '../storage/sqlite.ts';
import { spillResult } from '../tools/spill.ts';
import { estimateMessageTokens } from './budget.ts';
import type { TokenCalibration } from './calibration.ts';
import { prepareContext } from './context.ts';
import type { RunEmit } from './run-emit.ts';

/**
 * What one round hands to `prepareContext`, assembled in one place.
 *
 * The literal used to be written inside the round loop, ~125 lines of it, and it is pure assembly: every field is
 * either a port of this run, a number this round resolved, or a callback that writes into one of two accumulators
 * the loop owns. Nothing in it decides anything — the decision is `prepareContext`'s — which is why it can live
 * here as a function of what the round knows, and why the loop keeps the accumulators rather than this file
 * keeping a copy of them.
 *
 * The ports are read at call time, not captured at construction: `store`, `sessionId`, `signal` and the `emit`
 * seam have to be the ones in force for the round being built, and the policy numbers are the caller's resolved
 * limits rather than a second set of defaults.
 *
 * Three seams are built here rather than passed in, because they are policy plus those ports and nothing else:
 * the shortening target a spilled result is written to, its prune-only counterpart, and the two callbacks that
 * report a summary's life cycle and charge the accumulators the caller owns.
 */
export interface BuildContextInputOptions {
  store: SessionStore;
  sessionId: string;
  /** The prompt this round will be sent, already composed for the tools and policy in force. */
  system: string;
  /** The tool catalogue this round offers. */
  tools: ToolSpec[];
  /** The provider a summary request goes through: the measured one, so its cost is attributed like any other. */
  provider: Provider;
  limit: number;
  signal: AbortSignal;
  /** The output reservation of this round, which the estimate has to leave room for. */
  maxOutputTokens: number;
  /** The window of the route this round will actually use. */
  maxContextTokens: number | undefined;
  autoCompactTokens: number | undefined;
  summaryTimeoutMs: number;
  onSummaryRetry: (details: Record<string, unknown>) => void;
  /** How to name the prefix a summary request replays; see `prepareContext`'s own note on the key. */
  cacheKeyFor: (system: string, tools: readonly ToolSpec[]) => string | undefined;
  calibration: TokenCalibration | undefined;
  /** The run this compaction belongs to, which is what the session's write lease is checked against. */
  runId: string;
  /** The model this round aims at, when one is named at all (`null` means the embedder declared none). */
  model: string | null;
  /** The adapter this round goes over, when the embedder declared one; see `prepareContext`. */
  protocol?: string | undefined;
  /** The execution root, for the spill target a shortened result is written under. */
  workspace: string;
  toolResultKeepRecent: number;
  toolResultShrinkTokens: number;
  /** Share of the window at which the two bounded passes run, or `undefined` when the operator set none. */
  contextShrinkPercent: number | undefined;
  toolResultPruneThresholdChars: number;
  toolResultPruneHeadChars: number;
  toolResultPruneTailChars: number;
  /**
   * The two accumulators the callbacks built below write into, owned by the run loop.
   *
   * `usage` is what `RunResult.usage` ends up being, so the summary request's own tokens must be added to it as
   * they are spent rather than reconciled afterwards; `committedSummaryUsage` is the session's aggregate, and only
   * a compression that actually finished may charge it.
   */
  usage: Usage;
  committedSummaryUsage: SessionStatistics;
  emit: RunEmit;
}

export function buildContextInput(
  options: BuildContextInputOptions,
): Parameters<typeof prepareContext>[0] {
  const {
    store,
    sessionId,
    system,
    tools,
    provider,
    limit,
    signal,
    maxOutputTokens,
    maxContextTokens,
    autoCompactTokens,
    summaryTimeoutMs,
    onSummaryRetry,
    cacheKeyFor,
    calibration,
    runId,
    model,
    protocol,
    workspace,
    toolResultKeepRecent,
    toolResultShrinkTokens,
    contextShrinkPercent,
    toolResultPruneThresholdChars,
    toolResultPruneHeadChars,
    toolResultPruneTailChars,
    usage,
    committedSummaryUsage,
    emit,
  } = options;
  return {
    store,
    sessionId,
    system,
    tools,
    provider,
    limit,
    signal,
    maxOutputTokens,
    maxContextTokens,
    autoCompactTokens,
    summaryTimeoutMs,
    onSummaryRetry,
    // The summary request replays the prefix of the prompt it is given, so it asks for the key of *that*
    // prompt: without a key the provider places no cache breakpoint at all, and the replay would be
    // byte-identical and unread.
    cacheKeyFor,
    calibration,
    // The run this compaction is for: it is what the session's write lease is checked against, before the
    // summary request and again at the write.
    runId,
    /**
     * A compression this round cannot produce is reported, not fatal.
     *
     * The estimate that decided to compress is a character heuristic, and the endpoint is the authority on
     * whether a request fits: a run that died here never reached `recoverFromOverflow`, which is the path
     * that answers a *provider-confirmed* refusal by compressing harder. So the round is sent as it stands
     * with the reason attached, and the provider's own verdict — accepted, or refused for size — is what
     * the user finally sees.
     */
    compactionFailure: 'send',
    // The model this round aims at, so a compaction records which one produced the summary. Absent when the
    // embedder declared none, which the record then does not claim to know. The provider is recorded beside
    // it for the same reason: a summary is a model answer, and the model name alone does not say which
    // adapter it came back over.
    ...(model === null ? {} : { model }),
    ...(protocol === undefined ? {} : { protocol }),
    // Shortening needs somewhere to put the full text. Without a spill seam nothing is shortened: a
    // shortened result whose "read it here" path does not exist is worse than a long result.
    shrink: {
      policy: { keepRecent: toolResultKeepRecent, tokens: toolResultShrinkTokens },
      spill: ({ message, content }) =>
        spillResult({
          workspace,
          sessionId,
          key: message.role === 'tool' ? message.toolCallId : 'message',
          content,
        }),
      /**
       * The round's own price for text, which is what turns the policy's token budget into a character cut.
       *
       * A tool message rather than the raw string: that is the shape the estimator prices everywhere else,
       * images and protocol margin included, and building it here means "shortened to a 400-token budget"
       * and "this request is 4,000 tokens over" are answers from the same arithmetic.
       */
      measure: (text) =>
        estimateMessageTokens(
          { role: 'tool', toolCallId: '', content: text, isError: false },
          calibration?.factor ?? 1,
        ),
    },
    shrinkPercent: contextShrinkPercent,
    /**
     * Dropping the middle of an oversized result needs nothing from the host, so this seam is mounted
     * unconditionally: no spill target to write to, no calibrated measure to convert a budget with, and no
     * workspace to reach. It is what keeps a session bounded in the cases the shortening seam declines —
     * a read-only workspace, a full disk, or a spill directory that is gone.
     */
    prune: {
      policy: {
        thresholdChars: toolResultPruneThresholdChars,
        headChars: toolResultPruneHeadChars,
        tailChars: toolResultPruneTailChars,
      },
      keepRecent: toolResultKeepRecent,
    },
    prunePercent: contextShrinkPercent,
    onUsage: (response) => {
      usage.inputTokens += response.usage.inputTokens;
      usage.outputTokens += response.usage.outputTokens;
      /**
       * The cache fields belong here too, or the result lies by omission.
       *
       * `statistics` gets them through `addUsage`, but this object is what `RunResult.usage` carries — on
       * the wire, in `--json`, into the persisted run row, and into a reader like the CLI's usage line.
       * Hand-summing two fields silently dropped what the provider reported: a fixture whose
       * `cache_read_input_tokens` moved the input total to 200 arrived at the result with
       * `cachedInputTokens` undefined. "Unreported" stays unreported (`?? 0` on the accumulator, the field
       * only exists once something reported it) — the same rule `statistics.ts` keeps with `cacheKnown`.
       */
      if (response.usage.cachedInputTokens !== undefined)
        usage.cachedInputTokens = (usage.cachedInputTokens ?? 0) + response.usage.cachedInputTokens;
      if (response.usage.cacheWriteInputTokens !== undefined)
        usage.cacheWriteInputTokens =
          (usage.cacheWriteInputTokens ?? 0) + response.usage.cacheWriteInputTokens;
    },
    onCompaction: (state, coveredMessages, summaryUsage, reason) => {
      if (state === 'finished' && summaryUsage) addUsage(committedSummaryUsage, summaryUsage);
      /**
       * A failed compression is announced as one, and never as a completed one.
       *
       * The two states were the whole vocabulary, so a compression that could not be performed had to be
       * reported as either "started" forever or "compacted" — and the run only reaches here after deciding
       * what to do about it, which is why the news is live rather than durable: the session log records
       * compressions that happened, and this one did not. `context.compacted` must not be emitted for it
       * either: a reader that treats it as "the conversation was replaced" would be told a surface exists
       * that the store does not have. `summaryUsage` is deliberately not committed: tokens a failed
       * attempt spent are real, but they bought no summary, and `committedSummaryUsage` is what the
       * session's aggregates claim was *stored*.
       */
      if (state === 'failed') {
        emit('context.compaction.failed', {
          ...(coveredMessages === undefined ? {} : { coveredMessages }),
          ...(reason === undefined ? {} : { reason }),
        });
        return;
      }
      emit(state === 'started' ? 'context.compacting' : 'context.compacted', {
        coveredMessages,
      });
    },
  };
}
