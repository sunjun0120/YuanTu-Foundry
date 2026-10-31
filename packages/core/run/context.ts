import type { Provider, ToolSpec, Usage } from '../../protocol/index.ts';
import type { SessionStatistics } from '../../protocol/statistics.ts';
import { addUsage } from '../../protocol/statistics.ts';
import type { SessionStore } from '../../storage/sqlite.ts';
import { spillResult } from '../../tools/spill.ts';
import { estimateMessageTokens } from '../context/budget.ts';
import type { TokenCalibration } from '../context/calibration.ts';
import { prepareContext } from '../context/context.ts';
import type { RunEmit } from './emit.ts';

/**
 * What one round hands to `prepareContext`, assembled in one place. Pure assembly of this run's
 * ports, the round's resolved numbers and callbacks into the loop's accumulators; `prepareContext`
 * decides. Also builds the shortening and pruning seams and the summary life-cycle callbacks.
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
   * Accumulators owned by the run loop: `usage` (becomes `RunResult.usage`, charged as tokens are
   * spent) and `committedSummaryUsage` (charged only by a completed compression).
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
    // The summary request needs the key of its own prompt, or the provider places no cache
    // breakpoint.
    cacheKeyFor,
    calibration,
    // Checked against the session's write lease before the summary request and at the write.
    runId,
    /**
     * An unperformable compression is reported, not fatal: the round is sent as is, and a provider
     * size refusal is handled by `recoverFromOverflow`.
     */
    compactionFailure: 'send',
    // Recorded with the summary, alongside the protocol. Absent when the embedder declared none.
    ...(model === null ? {} : { model }),
    ...(protocol === undefined ? {} : { protocol }),
    ...contextSeams({
      workspace,
      sessionId,
      calibration,
      toolResultKeepRecent,
      toolResultShrinkTokens,
      contextShrinkPercent,
      toolResultPruneThresholdChars,
      toolResultPruneHeadChars,
      toolResultPruneTailChars,
    }),
    onUsage: (response) => {
      usage.inputTokens += response.usage.inputTokens;
      usage.outputTokens += response.usage.outputTokens;
      /**
       * Include cache fields in `RunResult.usage` too; unreported stays unreported, as in
       * `statistics.ts`.
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
       * A failed compression is announced as failed, never as `context.compacted`. Live only, and
       * its usage is not committed: it bought no summary.
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

/** The policy numbers and ports the two bounded passes are built from. */
export interface ContextSeamOptions {
  /** The execution root, for the spill target a shortened result is written under. */
  workspace: string;
  sessionId: string;
  calibration: TokenCalibration | undefined;
  toolResultKeepRecent: number;
  toolResultShrinkTokens: number;
  contextShrinkPercent: number | undefined;
  toolResultPruneThresholdChars: number;
  toolResultPruneHeadChars: number;
  toolResultPruneTailChars: number;
}

/**
 * The shortening and pruning seams for every caller of `prepareContext` (runs and manual
 * `/compact`), from one factory so both send the same request.
 */
export function contextSeams(
  options: ContextSeamOptions,
): Pick<
  Parameters<typeof prepareContext>[0],
  'shrink' | 'shrinkPercent' | 'prune' | 'prunePercent'
> {
  const {
    workspace,
    sessionId,
    calibration,
    toolResultKeepRecent,
    toolResultShrinkTokens,
    contextShrinkPercent,
    toolResultPruneThresholdChars,
    toolResultPruneHeadChars,
    toolResultPruneTailChars,
  } = options;
  return {
    // Shortening needs a spill target for the full text; without one nothing is shortened.
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
       * Price text as a tool message with the round's estimator, so budgets and overruns use the
       * same arithmetic.
       */
      measure: (text) =>
        estimateMessageTokens(
          { role: 'tool', toolCallId: '', content: text, isError: false },
          calibration?.factor ?? 1,
        ),
    },
    shrinkPercent: contextShrinkPercent,
    /**
     * Pruning needs nothing from the host, so it is always mounted and covers cases shortening
     * declines.
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
  };
}
